#!/usr/bin/env python3
"""Run the bounded static checks that protect published EvlEDA code.

The repository contains historical prototypes that are intentionally outside the
public distribution.  A whole-tree lint/type-check would therefore turn legacy
style debt into a misleading release claim.  This command checks every Python
file in the explicit release-critical scope below instead.  It is called by
both pull-request CI and tag-release CI.

Ruff is deliberately restricted to parser, import, and undefined-name rules:
these are correctness gates, not a claim that the legacy monorepo satisfies a
single formatting policy.  It covers the focused release tests as well as the
runtime.  Pyright's matching ``pyright.release.json`` scope type-checks the
shipped runtime and release scripts, treating missing imports, undefined
variables, and type errors as errors.

``prototypes/project_host.py`` is intentionally excluded. It is an unfinished
development prototype outside the installable packages, not a supported
EvlEDA MCP runtime.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PYRIGHT_CONFIG = ROOT / "pyright.release.json"

# Every release-critical Python path: runtime, public release tooling, and the
# focused tests that exercise them.  This is intentionally not ``backend`` or
# ``tests``; those broad trees include historical work outside the distribution.
RELEASE_RUFF_PATHS = (
    "evleda",
    "backend/design_kernel",
    "backend/evidence",
    "backend/kicad_compile",
    "backend/kicad_io",
    "backend/kicad_manufacturing_candidate",
    "backend/kicad_project",
    "backend/kicad_worker",
    "backend/mcp_gateway",
    "backend/mcp_server",
    "backend/reference_design",
    "backend/verification",
    "scripts/build_packaged_reference.py",
    "scripts/check_release_static.py",
    "scripts/smoke_wheel.py",
    "scripts/verify_public_distribution.py",
    "scripts/cloud",
    ".github/scripts",
    "tests/cloud",
    "tests/evidence",
    "tests/kicad_compile",
    "tests/kicad_manufacturing_candidate",
    "tests/mcp_server",
    "tests/test_legal_payloads.py",
    "tests/test_verify_public_distribution.py",
)

# Runtime and release tooling whose types must be sound.  The list is exactly
# mirrored in ``pyright.release.json`` and deliberately excludes test fixtures
# that are correctness-linted above but retain unrelated legacy type debt.
RELEASE_PYRIGHT_PATHS = (
    "evleda",
    "backend/design_kernel",
    "backend/evidence",
    "backend/kicad_compile",
    "backend/kicad_io",
    "backend/kicad_manufacturing_candidate",
    "backend/kicad_project",
    "backend/kicad_worker",
    "backend/mcp_gateway",
    "backend/mcp_server",
    "backend/reference_design",
    "backend/verification",
    "scripts/build_packaged_reference.py",
    "scripts/check_release_static.py",
    "scripts/smoke_wheel.py",
    "scripts/verify_public_distribution.py",
    "scripts/cloud",
    ".github/scripts",
)

# E9/F63/F7/F82 fail on syntax and invalid control flow; F821 catches an
# undefined name.  Do not broaden this into the repository's optional style
# policy without making the corresponding public claim and fixing that scope.
RUFF_CORRECTNESS_RULES = "E9,F63,F7,F82,F821"


def fail(message: str) -> None:
    raise SystemExit(f"release static check failed: {message}")


def command(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        fail(f"required tool is unavailable: {name}")
    # ``fail`` always raises SystemExit, but narrowing keeps strict type
    # checkers honest about the process-lookup result.
    assert executable is not None
    return executable


def checked_paths(paths_to_check: tuple[str, ...]) -> list[str]:
    paths: list[str] = []
    for relative in paths_to_check:
        path = ROOT / relative
        if not path.exists():
            fail(f"release-critical path is missing: {relative}")
        paths.append(relative)
    return paths


def verify_pyright_scope(paths: list[str]) -> None:
    """Reject a config edit that silently narrows the release type-check."""
    try:
        payload = json.loads(PYRIGHT_CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read pyright.release.json: {error}")
    if payload.get("include") != list(RELEASE_PYRIGHT_PATHS):
        fail("pyright.release.json include list differs from the documented release scope")
    excluded = payload.get("exclude")
    if not isinstance(excluded, list) or "prototypes/project_host.py" not in excluded:
        fail("pyright.release.json must exclude only the experimental project host by name")


def run(argv: list[str]) -> None:
    print("+", " ".join(argv), flush=True)
    completed = subprocess.run(argv, cwd=ROOT, check=False)
    if completed.returncode:
        raise SystemExit(completed.returncode)


def main() -> None:
    ruff_paths = checked_paths(RELEASE_RUFF_PATHS)
    pyright_paths = checked_paths(RELEASE_PYRIGHT_PATHS)
    if not PYRIGHT_CONFIG.is_file():
        fail("pyright.release.json is missing")
    verify_pyright_scope(pyright_paths)

    run([command("ruff"), "check", f"--select={RUFF_CORRECTNESS_RULES}", *ruff_paths])
    run([command("pyright"), "--project", str(PYRIGHT_CONFIG)])
    print(
        "release static checks passed for "
        f"{len(ruff_paths)} Ruff paths and {len(pyright_paths)} Pyright paths"
    )


if __name__ == "__main__":
    main()
