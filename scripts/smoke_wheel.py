"""Prove a fresh wheel can inspect its immutable reference over MCP stdio.

The isolated runtime starts from an unrelated working directory with no private
source-evidence cache. The wheel must contain only the sanitized generated
reference resource and must complete a real initialize/list/inspect dialogue.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


def _run(
    argv: list[str],
    *,
    cwd: Path,
    check: bool = True,
    input_text: str | None = None,
    environment: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        check=check,
        text=True,
        input=input_text,
        capture_output=True,
        env=environment,
    )


def _mcp_wire(*, native_verify: bool = False) -> str:
    messages: list[dict[str, object]] = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": {"name": "isolated-wheel-smoke", "version": "1"},
            },
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "inspect_project",
                "arguments": {
                    "project_id": "reference-usb-c-3v3-r2",
                    "expected_project_revision": (
                        "rev_209cc052da07cc27cf79c367547cff5b414b28d30972ca9985e3bed5a4722edd"
                    ),
                },
            },
        },
    ]
    if native_verify:
        messages.append(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "kicad_verify",
                    "arguments": {
                        "project_id": "reference-usb-c-3v3-r2",
                        "expected_project_revision": (
                            "rev_209cc052da07cc27cf79c367547cff5b414b28d30972ca9985e3bed5a4722edd"
                        ),
                        "checks": ["drc", "erc"],
                    },
                    "_meta": {"com.fluxclone/idempotencyKey": "isolated-wheel-native-1"},
                },
            }
        )
    return "".join(
        json.dumps(message, sort_keys=True, separators=(",", ":")) + "\n"
        for message in messages
    )


def _native_kicad_candidate() -> Path | None:
    configured = os.environ.get("EVLEDA_TEST_KICAD_CLI")
    local_app_data = os.environ.get("LOCALAPPDATA")
    program_files = os.environ.get("PROGRAMFILES")
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    if local_app_data:
        candidates.append(
            Path(local_app_data)
            / "Programs"
            / "KiCad"
            / "10.0"
            / "bin"
            / "kicad-cli.exe"
        )
    if program_files:
        candidates.append(
            Path(program_files) / "KiCad" / "10.0" / "bin" / "kicad-cli.exe"
        )
    candidates.extend(
        (
        Path("/usr/bin/kicad-cli"),
        Path("/usr/local/bin/kicad-cli"),
        Path("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"),
        )
    )
    return next(
        (
            candidate
            for candidate in candidates
            if candidate.is_file() and not candidate.is_symlink()
        ),
        None,
    )


def _assert_wheel_contents(wheel: Path) -> None:
    with zipfile.ZipFile(wheel, "r") as archive:
        names = archive.namelist()
    required = {
        "evleda/reference/manifest.json",
        "evleda/reference/reference_usb_c_3v3_r2.zip",
    }
    if not required.issubset(names):
        raise RuntimeError("wheel omitted the authenticated packaged reference resources")
    forbidden_fragments = (
        "/reference_sources/blobs/",
        "/private-evidence/",
        "/docs/evidence/reference_sources/blobs/",
    )
    if any(
        any(fragment in f"/{name.casefold()}" for fragment in forbidden_fragments)
        for name in names
    ):
        raise RuntimeError("wheel contains forbidden private source-evidence blobs")


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="evleda-wheel-") as raw:
        temporary = Path(raw)
        wheel_dir = temporary / "wheel"
        environment = temporary / "venv"
        unrelated = temporary / "unrelated-working-directory"
        unrelated.mkdir()
        _run(
            [sys.executable, "-m", "pip", "wheel", ".", "--no-deps", "--wheel-dir", str(wheel_dir)],
            cwd=root,
        )
        wheel = next(wheel_dir.glob("evleda-*.whl"), None)
        if wheel is None:
            raise RuntimeError("wheel build produced no evleda wheel")
        _assert_wheel_contents(wheel)
        _run([sys.executable, "-m", "venv", str(environment)], cwd=unrelated)
        python = environment / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
        command = [str(python), "-m", "evleda"]
        _run(
            [str(python), "-m", "pip", "install", "--disable-pip-version-check", str(wheel)],
            cwd=unrelated,
        )
        module_locations = _run(
            [
                str(python),
                "-c",
                "import backend, evleda; print(evleda.__file__); print(backend.__file__)",
            ],
            cwd=unrelated,
        )
        entry_points = _run(
            [
                str(python),
                "-c",
                (
                    "import importlib.metadata as m; "
                    "print('\\n'.join(sorted(e.name for e in "
                    "m.distribution('evleda').entry_points if e.group == 'console_scripts')))"
                ),
            ],
            cwd=unrelated,
        ).stdout.splitlines()
        installed_paths = [Path(line).resolve() for line in module_locations.stdout.splitlines()]
        site_packages = next(
            (path.resolve() for path in environment.rglob("site-packages") if path.is_dir()),
            None,
        )
        if (
            site_packages is None
            or len(installed_paths) != 2
            or any(not path.is_relative_to(site_packages) for path in installed_paths)
        ):
            raise RuntimeError("wheel imported a package outside its isolated site-packages")
        version = _run([*command, "--version"], cwd=unrelated)
        doctor = _run([*command, "doctor"], cwd=unrelated)
        smoke = _run([*command, "smoke"], cwd=unrelated)
        state_root = temporary / "external-runtime-state"
        clean_environment = dict(os.environ)
        clean_environment.pop("EVLEDA_REFERENCE_EVIDENCE_ROOT", None)
        dialogue = _run(
            [*command, "serve", "--no-kicad", "--state-root", str(state_root)],
            cwd=unrelated,
            input_text=_mcp_wire(),
            environment=clean_environment,
        )
        try:
            responses = [json.loads(line) for line in dialogue.stdout.splitlines()]
            tools = responses[1]["result"]["tools"]
            inspection = responses[2]["result"]
            structured = inspection["structuredContent"]
            payload = json.loads(structured["payload_json"])
        except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("installed wheel MCP dialogue was malformed") from exc
        if (
            version.stdout.strip() != "evleda 0.2.0"
            or "evleda-mcp doctor" not in doctor.stdout
            or "evleda-mcp smoke: passed" not in smoke.stdout
            or entry_points != ["evleda-fetch-reference-sources", "evleda-mcp"]
            or [response.get("id") for response in responses] != [1, 2, 3]
            or responses[0]["result"]["protocolVersion"] != "2025-11-25"
            or [tool["name"] for tool in tools] != ["inspect_project"]
            or inspection.get("isError") is not False
            or payload["snapshot"]["project_id"] != "reference-usb-c-3v3-r2"
            or payload["snapshot"]["component_count"] != 23
            or payload["snapshot"]["net_count"] != 13
            or payload["snapshot"]["operation_count"] != 163
            or state_root.exists()
            or dialogue.stderr
            or "Traceback" in dialogue.stdout
        ):
            raise RuntimeError("installed wheel console contract changed")
        print(
            "isolated wheel MCP passed: initialize -> tools/list -> "
            "inspect_project (packaged non-release reference)"
        )
        native_kicad = _native_kicad_candidate()
        if native_kicad is not None:
            native_state = temporary / "external-native-runtime-state"
            native_dialogue = _run(
                [
                    *command,
                    "serve",
                    "--kicad-cli",
                    str(native_kicad),
                    "--state-root",
                    str(native_state),
                ],
                cwd=unrelated,
                input_text=_mcp_wire(native_verify=True),
                environment=clean_environment,
            )
            try:
                native_responses = [
                    json.loads(line) for line in native_dialogue.stdout.splitlines()
                ]
                native_tools = native_responses[1]["result"]["tools"]
                native_verification = native_responses[3]["result"]
            except (IndexError, KeyError, TypeError, json.JSONDecodeError) as exc:
                raise RuntimeError("installed wheel native MCP dialogue was malformed") from exc
            if (
                [response.get("id") for response in native_responses] != [1, 2, 3, 4]
                or [tool["name"] for tool in native_tools]
                != ["inspect_project", "kicad_verify"]
                or native_responses[2]["result"].get("isError") is not False
                or native_verification.get("isError") is not False
                or native_verification["structuredContent"]["payload"]["passed"] is not True
                or native_verification["structuredContent"]["payload"]["blocking_findings"]
                != 0
                or not native_state.is_dir()
                or native_dialogue.stderr
            ):
                raise RuntimeError("installed wheel native verification contract changed")
            print(
                "isolated wheel native MCP passed: packaged reference -> "
                "KiCad ERC/DRC zero findings"
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
