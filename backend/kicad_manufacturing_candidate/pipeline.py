"""Shell-free KiCad 10 pipeline for derivative, non-release CAM candidates."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import replace
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import cast

from backend.kicad_compile import FileDigest
from backend.kicad_worker.reports import KiCadReportError, parse_kicad_report
from backend.kicad_worker.runner import (
    CommandLaunchError,
    CommandOutputLimitError,
    CommandRunner,
    CommandTimeoutError,
    CompletedCommand,
    SubprocessRunner,
)
from backend.kicad_worker.runtime_support import (
    RUNTIME_SUPPORT_POLICY_VERSION,
    RUNTIME_SUPPORT_TEMPLATE_SHA256,
    project_preferences_payload,
    runtime_support_manifest_sha256,
)

from .bom import candidate_bom_evidence_payload, extract_candidate_bom
from .filled_board_semantics import analyze_filled_board, filled_board_evidence_payload
from .model import (
    NON_FABRICATION_NOTICE_FILENAME,
    NON_FABRICATION_NOTICE_SHA256,
    ArtifactDigest,
    CandidateArtifact,
    CandidateContractError,
    CandidateGenerationError,
    CandidateHostConfiguration,
    CandidatePolicy,
    CandidateReceipt,
    CandidateSource,
    CommandReceipt,
    ManufacturingCandidate,
    canonical_bytes,
    receipt_sha256,
    stable_sha256,
)
from .source_zone_identity import (
    compare_source_zone_identity,
    source_authored_zone_count,
)

_VERSION = re.compile(r"10\.0\.[0-9]+")
_LAYERS = (
    "F.Cu",
    "B.Cu",
    "F.Mask",
    "B.Mask",
    "F.Paste",
    "B.Paste",
    "F.SilkS",
    "B.SilkS",
    "Edge.Cuts",
)
_GERBER_FILE_FUNCTIONS = {
    "F_Cu": "Copper,L1,Top",
    "B_Cu": "Copper,L2,Bot",
    "F_Paste": "SolderPaste,Top",
    "B_Paste": "SolderPaste,Bot",
    "F_Silkscreen": "Legend,Top",
    "B_Silkscreen": "Legend,Bot",
    "F_Mask": "SolderMask,Top",
    "B_Mask": "SolderMask,Bot",
    "Edge_Cuts": "Profile",
}
_GERBER_HEADER_FUNCTIONS = {
    **_GERBER_FILE_FUNCTIONS,
    "F_Paste": "Paste,Top",
    "B_Paste": "Paste,Bot",
    "F_Mask": "Soldermask,Top",
    "B_Mask": "Soldermask,Bot",
    "Edge_Cuts": "Profile,NP",
}


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _compiler_bundle_sha256(files: tuple[FileDigest, ...]) -> str:
    body = canonical_bytes(
        tuple(
            {
                "filename": item.filename,
                "byteLength": item.byte_length,
                "sha256": item.sha256,
            }
            for item in files
        )
    ) + b"\n"
    return hashlib.sha256(b"flux-clone-compiled-bundle-v1\x00" + body).hexdigest()


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise CandidateGenerationError("cam_content_invalid", "CAM JSON has duplicate keys")
        result[key] = value
    return result


def _utf8(payload: bytes, label: str) -> str:
    try:
        text = payload.decode("utf-8", errors="strict").replace("\r\n", "\n")
    except UnicodeError as exc:
        raise CandidateGenerationError(
            "cam_content_invalid", f"{label} is not strict UTF-8"
        ) from exc
    if any(ord(character) < 32 and character not in "\n\t" for character in text):
        raise CandidateGenerationError(
            "cam_content_invalid", f"{label} contains unsupported control bytes"
        )
    return text


def _cam_relative_inventory(stem: str) -> tuple[str, ...]:
    gerbers = tuple(
        f"gerbers/{stem}-{layer}.gbr" for layer in sorted(_GERBER_FILE_FUNCTIONS)
    )
    return tuple(
        sorted(
            (
                *gerbers,
                f"gerbers/{stem}-job.gbrjob",
                f"drill/{stem}-PTH.drl",
                f"drill/{stem}-NPTH.drl",
                f"drill/{stem}-PTH-drl_map.gbr",
                f"drill/{stem}-NPTH-drl_map.gbr",
                f"drill/{stem}-drill.rpt",
                f"assembly/{stem}-pos.csv",
                f"ipc/{stem}-ipc2581.xml",
                f"ipc/{stem}.d356",
            )
        )
    )


def _media_type(filename: str) -> str:
    if filename.endswith(".gbr"):
        return "application/vnd.gerber"
    if filename.endswith(".gbrjob"):
        return "application/json"
    if filename.endswith(".drl"):
        return "application/x-excellon"
    if filename.endswith(".csv"):
        return "text/csv"
    if filename.endswith(".xml"):
        return "application/xml"
    return "text/plain"


def _decimal(value: str, label: str) -> str:
    try:
        parsed = Decimal(value)
    except InvalidOperation as exc:
        raise CandidateGenerationError(
            "cam_content_invalid", f"{label} is not a decimal number"
        ) from exc
    if not parsed.is_finite():
        raise CandidateGenerationError(
            "cam_content_invalid", f"{label} is not a finite decimal number"
        )
    return format(parsed, "f")


def _validate_cam_content(
    filename: str,
    payload: bytes,
    *,
    stem: str,
    kicad_version: str,
) -> dict[str, object]:
    """Validate format identity and semantic role without removing run timestamps."""

    if filename.endswith(".gbr"):
        text = _utf8(payload, filename)
        if not text.rstrip().endswith("M02*"):
            raise CandidateGenerationError("cam_content_invalid", f"{filename} is not complete")
        generation = f"%TF.GenerationSoftware,KiCad,Pcbnew,{kicad_version}*%"
        if generation not in text:
            raise CandidateGenerationError(
                "cam_content_invalid", f"{filename} does not bind the pinned KiCad generator"
            )
        basename = Path(filename).name
        if basename.endswith("-drl_map.gbr"):
            function = "Drillmap"
        else:
            key = basename.removeprefix(f"{stem}-").removesuffix(".gbr")
            function = _GERBER_HEADER_FUNCTIONS.get(key)
            if function is None:
                raise CandidateGenerationError(
                    "cam_content_invalid", f"{filename} has no declared Gerber role"
                )
        if f"%TF.FileFunction,{function}*%" not in text:
            raise CandidateGenerationError(
                "cam_content_invalid", f"{filename} has the wrong Gerber FileFunction"
            )
        return {"filename": filename, "format": "gerber", "file_function": function}

    if filename.endswith(".gbrjob"):
        text = _utf8(payload, filename)
        try:
            root = json.loads(text, object_pairs_hook=_unique_json_object)
        except (json.JSONDecodeError, CandidateGenerationError) as exc:
            raise CandidateGenerationError(
                "cam_content_invalid", "Gerber job file is not strict JSON"
            ) from exc
        if type(root) is not dict:
            raise CandidateGenerationError(
                "cam_content_invalid", "Gerber job root must be an object"
            )
        obj = cast(dict[str, object], root)
        header = obj.get("Header")
        attributes = obj.get("FilesAttributes")
        if type(header) is not dict or type(attributes) is not list:
            raise CandidateGenerationError(
                "cam_content_invalid", "Gerber job lacks Header or FilesAttributes"
            )
        software = cast(dict[str, object], header).get("GenerationSoftware")
        if (
            type(software) is not dict
            or cast(dict[str, object], software).get("Version") != kicad_version
        ):
            raise CandidateGenerationError(
                "cam_content_invalid", "Gerber job generator version is not pinned"
            )
        observed: dict[str, str] = {}
        for value in cast(list[object], attributes):
            if type(value) is not dict:
                raise CandidateGenerationError(
                    "cam_content_invalid", "Gerber job file attributes must be objects"
                )
            record = cast(dict[str, object], value)
            path = record.get("Path")
            function = record.get("FileFunction")
            if type(path) is not str or type(function) is not str or path in observed:
                raise CandidateGenerationError(
                    "cam_content_invalid", "Gerber job file attributes are ambiguous"
                )
            observed[path] = function
        expected = {
            f"{stem}-{key}.gbr": function
            for key, function in _GERBER_FILE_FUNCTIONS.items()
        }
        if observed != expected:
            raise CandidateGenerationError(
                "cam_content_invalid", "Gerber job inventory does not match required layers"
            )
        return {
            "filename": filename,
            "format": "gerber-job",
            "file_functions": tuple(sorted(observed.items())),
        }

    if filename.endswith(".drl"):
        text = _utf8(payload, filename)
        if not text.startswith("M48\n") or not text.rstrip().endswith("M30"):
            raise CandidateGenerationError("cam_content_invalid", f"{filename} is not Excellon")
        if f"TF.GenerationSoftware,Kicad,Pcbnew,{kicad_version}" not in text:
            raise CandidateGenerationError(
                "cam_content_invalid", f"{filename} does not bind the pinned KiCad generator"
            )
        expected_function = "Plated,1,2,PTH" if "-PTH.drl" in filename else "NonPlated,1,2,NPTH"
        if f"TF.FileFunction,{expected_function}" not in text:
            raise CandidateGenerationError(
                "cam_content_invalid", f"{filename} has the wrong drill function"
            )
        return {"filename": filename, "format": "excellon", "file_function": expected_function}

    if filename.endswith("-drill.rpt"):
        text = _utf8(payload, filename)
        if not text.startswith(f"Drill report for {stem}.kicad_pcb\nCreated on "):
            raise CandidateGenerationError("cam_content_invalid", "drill report source is wrong")
        for required in ("Copper Layer Stackup:", f"{stem}-PTH.drl", f"{stem}-NPTH.drl"):
            if required not in text:
                raise CandidateGenerationError(
                    "cam_content_invalid", f"drill report is missing {required}"
                )
        return {"filename": filename, "format": "drill-report", "source": f"{stem}.kicad_pcb"}

    if filename.endswith("-pos.csv"):
        text = _utf8(payload, filename)
        rows = list(csv.reader(text.splitlines(), strict=True))
        if not rows or rows[0] != ["Ref", "Val", "Package", "PosX", "PosY", "Rot", "Side"]:
            raise CandidateGenerationError("cam_content_invalid", "position CSV header is invalid")
        references: list[str] = []
        for index, row in enumerate(rows[1:]):
            if len(row) != 7 or not row[0] or row[6] not in {"top", "bottom"}:
                raise CandidateGenerationError(
                    "cam_content_invalid", f"position CSV row {index + 2} is invalid"
                )
            for column in (3, 4, 5):
                _decimal(row[column], f"position CSV row {index + 2} column {column + 1}")
            references.append(row[0])
        if len(references) != len(set(references)):
            raise CandidateGenerationError(
                "cam_content_invalid", "position CSV contains duplicate references"
            )
        return {
            "filename": filename,
            "format": "component-positions-csv",
            "references": tuple(sorted(references)),
        }

    if filename.endswith("-ipc2581.xml"):
        if b"<!DOCTYPE" in payload.upper():
            raise CandidateGenerationError("cam_content_invalid", "IPC-2581 may not contain a DTD")
        try:
            root = ET.fromstring(payload)
        except ET.ParseError as exc:
            raise CandidateGenerationError(
                "cam_content_invalid", "IPC-2581 XML is invalid"
            ) from exc
        if (
            root.tag != "{http://webstds.ipc.org/2581}IPC-2581"
            or root.attrib.get("revision") != "C"
        ):
            raise CandidateGenerationError(
                "cam_content_invalid", "IPC-2581 root or revision is not the pinned contract"
            )
        return {"filename": filename, "format": "ipc-2581", "revision": "C"}

    if filename.endswith(".d356"):
        text = _utf8(payload, filename)
        lines = text.splitlines()
        if len(lines) < 4 or lines[:3] != ["P  CODE 00", "P  UNITS CUST 0", "P  arrayDim   N"]:
            raise CandidateGenerationError("cam_content_invalid", "IPC-D-356 header is invalid")
        if lines[-1] != "999":
            raise CandidateGenerationError("cam_content_invalid", "IPC-D-356 terminator is missing")
        return {"filename": filename, "format": "ipc-d-356", "terminator": "999"}

    raise CandidateGenerationError("cam_content_invalid", f"{filename} has no content validator")


class KiCadManufacturingCandidatePipeline:
    """Produce a content-addressed derivative candidate without release authority."""

    def __init__(
        self,
        configuration: CandidateHostConfiguration,
        *,
        policy: CandidatePolicy | None = None,
        runner: CommandRunner | None = None,
    ) -> None:
        if type(configuration) is not CandidateHostConfiguration:
            raise CandidateGenerationError("configuration_invalid", "host configuration is invalid")
        selected_policy = CandidatePolicy() if policy is None else policy
        if type(selected_policy) is not CandidatePolicy:
            raise CandidateGenerationError("configuration_invalid", "candidate policy is invalid")
        executable = configuration.executable
        temp_root = configuration.temp_root
        try:
            if executable.is_symlink() or not executable.is_file():
                raise CandidateGenerationError(
                    "configuration_invalid", "pinned KiCad executable is unavailable"
                )
            resolved_executable = executable.resolve(strict=True)
            if _sha256(resolved_executable.read_bytes()) != configuration.executable_sha256:
                raise CandidateGenerationError(
                    "configuration_invalid", "pinned KiCad executable hash does not match"
                )
            temp_root.mkdir(parents=True, exist_ok=True)
            if temp_root.is_symlink() or not temp_root.is_dir():
                raise CandidateGenerationError(
                    "configuration_invalid", "candidate temp root is not a regular directory"
                )
            resolved_temp_root = temp_root.resolve(strict=True)
        except OSError as exc:
            raise CandidateGenerationError(
                "configuration_invalid", "candidate host paths are not readable"
            ) from exc
        self._configuration = configuration
        self._policy = selected_policy
        self._runner = SubprocessRunner() if runner is None else runner
        self._executable = resolved_executable
        self._temp_root = resolved_temp_root

    @contextmanager
    def _operation_directory(self) -> Generator[Path, None, None]:
        with tempfile.TemporaryDirectory(prefix="cam-candidate-", dir=self._temp_root) as value:
            root = Path(value).resolve(strict=True)
            if root.parent != self._temp_root:
                raise CandidateGenerationError(
                    "temp_containment_failed", "candidate operation escaped its host temp root"
                )
            yield root

    def _environment(self, root: Path) -> dict[str, str]:
        values = {
            "APPDATA": root / "appdata",
            "HOME": root / "home",
            "KICAD_CONFIG_HOME": root / "kicad-config",
            "LOCALAPPDATA": root / "localappdata",
            "TEMP": root / "tmp",
            "TMP": root / "tmp",
            "USERPROFILE": root / "home",
        }
        for path in sorted(set(values.values())):
            path.mkdir(exist_ok=False)
        system_root = os.environ.get("SYSTEMROOT", os.environ.get("WINDIR", r"C:\Windows"))
        return {
            **{key: str(path) for key, path in values.items()},
            "PATH": str(self._executable.parent),
            "SYSTEMROOT": system_root,
            "WINDIR": system_root,
        }

    def _logical_argv(self, argv: tuple[str, ...], root: Path) -> tuple[str, ...]:
        result = ["kicad-cli"]
        for item in argv[1:]:
            normalized = item.replace(str(root), "<WORKDIR>").replace(
                root.as_posix(), "<WORKDIR>"
            )
            result.append(normalized.replace("\\", "/"))
        return tuple(result)

    def _run(
        self,
        stage: str,
        argv: tuple[str, ...],
        *,
        root: Path,
        environment: Mapping[str, str],
        allowed_exit_codes: frozenset[int],
    ) -> tuple[CompletedCommand, CommandReceipt]:
        try:
            result = self._runner.run(
                argv,
                cwd=root,
                environment=environment,
                timeout_seconds=self._policy.timeout_seconds,
                max_stdout_bytes=self._policy.max_stdout_bytes,
                max_stderr_bytes=self._policy.max_stderr_bytes,
            )
        except CommandTimeoutError as exc:
            raise CandidateGenerationError("kicad_timeout", "KiCad command timed out") from exc
        except CommandOutputLimitError as exc:
            raise CandidateGenerationError(
                "kicad_output_oversize", f"KiCad {exc.stream} exceeded its byte cap"
            ) from exc
        except CommandLaunchError as exc:
            raise CandidateGenerationError(
                "kicad_launch_failed", "KiCad command could not be launched"
            ) from exc
        if type(result) is not CompletedCommand or result.argv != argv:
            raise CandidateGenerationError(
                "runner_contract_invalid", "command runner returned a substituted result"
            )
        _utf8(result.stdout, f"{stage} stdout")
        _utf8(result.stderr, f"{stage} stderr")
        logical = self._logical_argv(argv, root)
        receipt = CommandReceipt(
            stage=stage,
            logical_argv=logical,
            argv_sha256=stable_sha256(logical, domain="kicad-cam-candidate-argv-v1"),
            exit_code=result.exit_code,
            stdout_sha256=_sha256(result.stdout),
            stderr_sha256=_sha256(result.stderr),
        )
        if result.exit_code not in allowed_exit_codes:
            raise CandidateGenerationError(
                "kicad_tool_error", f"KiCad stage {stage} returned exit code {result.exit_code}"
            )
        return result, receipt

    @staticmethod
    def _bundle_files(source: CandidateSource) -> tuple[tuple[str, bytes], ...]:
        return tuple(
            sorted(
                (item.relative_name, item.payload)
                for item in source.compiled_project.bundle.all_files
            )
        )

    def _validate_source(self, source: CandidateSource) -> tuple[tuple[str, bytes], ...]:
        if type(source) is not CandidateSource:
            raise CandidateGenerationError("source_invalid", "candidate source uses the wrong type")
        project = source.compiled_project
        all_files = self._bundle_files(source)
        if len(all_files) > self._policy.max_source_files or sum(
            len(payload) for _, payload in all_files
        ) > self._policy.max_source_bundle_bytes:
            raise CandidateGenerationError(
                "source_bundle_oversize",
                "compiled source exceeds its file-count or aggregate byte cap",
            )
        if any(filename.casefold().endswith(".kicad_prl") for filename, _ in all_files):
            raise CandidateGenerationError(
                "source_runtime_state_forbidden",
                "compiled source may not contain active KiCad PRL runtime state",
            )
        if source.expected_source_bundle_sha256 != project.manifest.output_bundle_sha256:
            raise CandidateGenerationError(
                "source_hash_mismatch", "expected source hash does not match compiler manifest"
            )
        if source.expected_manifest_sha256 != project.manifest_sha256:
            raise CandidateGenerationError(
                "manifest_hash_mismatch", "expected manifest hash does not match compiler result"
            )
        if _sha256(project.manifest_payload) != source.expected_manifest_sha256:
            raise CandidateGenerationError(
                "manifest_hash_mismatch", "compiler manifest bytes changed"
            )
        if len(project.manifest_payload) > self._policy.max_source_file_bytes:
            raise CandidateGenerationError(
                "manifest_oversize", "compiler manifest exceeds its byte cap"
            )
        if _compiler_bundle_sha256(project.manifest.files) != source.expected_source_bundle_sha256:
            raise CandidateGenerationError(
                "source_hash_mismatch", "compiler file inventory does not reproduce bundle hash"
            )
        payloads = dict(all_files)
        manifest_files = {item.filename: item for item in project.manifest.files}
        if frozenset(payloads) != frozenset(manifest_files):
            raise CandidateGenerationError(
                "source_inventory_invalid", "compiler manifest and bundle filenames differ"
            )
        for filename, payload in payloads.items():
            item = manifest_files[filename]
            if (
                type(item) is not FileDigest
                or type(payload) is not bytes
                or not payload
                or len(payload) > self._policy.max_source_file_bytes
                or len(payload) != item.byte_length
                or _sha256(payload) != item.sha256
            ):
                raise CandidateGenerationError(
                    "source_file_invalid", f"compiled source file failed its binding: {filename}"
                )
        if source.bom_result is not None:
            bom_by_name = {item.filename: item.payload for item in source.bom_result.artifacts}
            stem = project.bundle.stem
            try:
                verified_bom = extract_candidate_bom(
                    replace(source, bom_result=None),
                    source_csv_payload=bom_by_name[f"assembly/{stem}.bom.csv"],
                    source_json_payload=bom_by_name[f"assembly/{stem}.bom.json"],
                )
            except (KeyError, CandidateContractError, CandidateGenerationError) as exc:
                if isinstance(exc, CandidateGenerationError):
                    detail = exc.detail
                else:
                    detail = "candidate BOM inventory is incomplete"
                raise CandidateGenerationError("bom_source_invalid", detail) from exc
            if verified_bom != source.bom_result:
                raise CandidateGenerationError(
                    "bom_source_invalid",
                    "candidate BOM payloads or evidence changed after validation",
                )
        if project.bundle.stem == "reference_usb_c_3v3_r2":
            if len(all_files) != 29:
                raise CandidateGenerationError(
                    "r2_source_inventory_invalid",
                    "R2 candidate requires the exact 29-file compiler source inventory",
                )
            if source.bom_result is None:
                raise CandidateGenerationError(
                    "r2_bom_missing",
                    "R2 candidate requires exact source-bound BOM CSV and JSON",
                )
        return tuple(sorted(payloads.items()))

    @staticmethod
    def _write_exact(root: Path, files: tuple[tuple[str, bytes], ...]) -> None:
        for filename, payload in files:
            relative = Path(filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise CandidateGenerationError(
                    "source_materialization_failed", "managed source filename failed containment"
                )
            destination = root / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if (
                destination.parent.resolve(strict=True) != root
                and root not in destination.parent.resolve(strict=True).parents
            ) or destination.exists():
                raise CandidateGenerationError(
                    "source_materialization_failed", "managed source filename failed containment"
                )
            try:
                with destination.open("xb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError as exc:
                raise CandidateGenerationError(
                    "source_materialization_failed", "managed source bytes could not be written"
                ) from exc
            if destination.is_symlink() or destination.read_bytes() != payload:
                raise CandidateGenerationError(
                    "source_materialization_failed", "managed source bytes changed while writing"
                )

    @staticmethod
    def _assert_exact_source(root: Path, files: tuple[tuple[str, bytes], ...]) -> None:
        expected = {filename: payload for filename, payload in files}
        expected_directories = {
            parent.as_posix()
            for filename in expected
            for parent in Path(filename).parents
            if parent != Path(".")
        }
        observed_directories: set[str] = set()
        for path in root.rglob("*"):
            if path.is_symlink():
                raise CandidateGenerationError(
                    "canonical_source_mutated", "canonical source contains a symlink"
                )
            if path.is_dir():
                observed_directories.add(path.relative_to(root).as_posix())
        if observed_directories != expected_directories:
            raise CandidateGenerationError(
                "canonical_source_mutated", "canonical source directory inventory changed"
            )
        observed = tuple(
            sorted(
                path.relative_to(root).as_posix()
                for path in root.rglob("*")
                if path.is_file()
            )
        )
        if observed != tuple(sorted(expected)):
            raise CandidateGenerationError(
                "canonical_source_mutated", "canonical source filename inventory changed"
            )
        for filename, payload in expected.items():
            path = root / filename
            if path.is_symlink() or not path.is_file() or path.read_bytes() != payload:
                raise CandidateGenerationError(
                    "canonical_source_mutated", "canonical source bytes changed"
                )

    @staticmethod
    def _read_regular(path: Path, *, cap: int, label: str) -> bytes:
        try:
            if path.is_symlink() or not path.is_file():
                raise CandidateGenerationError("output_missing", f"{label} is not a regular file")
            size = path.stat().st_size
            if size < 1 or size > cap:
                raise CandidateGenerationError("output_oversize", f"{label} violates its byte cap")
            payload = path.read_bytes()
        except OSError as exc:
            raise CandidateGenerationError("output_unreadable", f"{label} is unreadable") from exc
        if len(payload) != size:
            raise CandidateGenerationError("output_mutated", f"{label} changed while reading")
        return payload

    @staticmethod
    def _commands(
        stem: str, derivative: Path, cam: Path
    ) -> tuple[tuple[str, tuple[str, ...]], ...]:
        board = derivative / f"{stem}.kicad_pcb"
        drc = derivative / "drc.json"
        return (
            (
                "drc-fill",
                (
                    "pcb",
                    "drc",
                    "--format",
                    "json",
                    "--units",
                    "mm",
                    "--severity-all",
                    "--schematic-parity",
                    "--all-track-errors",
                    "--exit-code-violations",
                    "--refill-zones",
                    "--save-board",
                    "--output",
                    str(drc),
                    str(board),
                ),
            ),
            (
                "gerbers",
                (
                    "pcb",
                    "export",
                    "gerbers",
                    "--output",
                    str(cam / "gerbers"),
                    "--layers",
                    ",".join(_LAYERS),
                    "--no-protel-ext",
                    "--precision",
                    "6",
                    str(board),
                ),
            ),
            (
                "drill",
                (
                    "pcb",
                    "export",
                    "drill",
                    "--output",
                    str(cam / "drill"),
                    "--format",
                    "excellon",
                    "--drill-origin",
                    "absolute",
                    "--excellon-zeros-format",
                    "decimal",
                    "--excellon-oval-format",
                    "route",
                    "--excellon-units",
                    "mm",
                    "--excellon-separate-th",
                    "--generate-map",
                    "--map-format",
                    "gerberx2",
                    "--generate-report",
                    "--report-path",
                    str(cam / "drill" / f"{stem}-drill.rpt"),
                    str(board),
                ),
            ),
            (
                "positions",
                (
                    "pcb",
                    "export",
                    "pos",
                    "--output",
                    str(cam / "assembly" / f"{stem}-pos.csv"),
                    "--side",
                    "both",
                    "--format",
                    "csv",
                    "--units",
                    "mm",
                    "--exclude-dnp",
                    str(board),
                ),
            ),
            (
                "ipc2581",
                (
                    "pcb",
                    "export",
                    "ipc2581",
                    "--output",
                    str(cam / "ipc" / f"{stem}-ipc2581.xml"),
                    "--precision",
                    "6",
                    "--version",
                    "C",
                    "--units",
                    "mm",
                    str(board),
                ),
            ),
            (
                "ipcd356",
                (
                    "pcb",
                    "export",
                    "ipcd356",
                    "--output",
                    str(cam / "ipc" / f"{stem}.d356"),
                    str(board),
                ),
            ),
        )

    def generate(self, source: CandidateSource) -> ManufacturingCandidate:
        files = self._validate_source(source)
        board_filename = source.compiled_project.bundle.board_filename
        source_board = dict(files)[board_filename]
        source_board_sha256 = _sha256(source_board)
        source_zone_count = source_authored_zone_count(source_board)
        if _sha256(self._executable.read_bytes()) != self._configuration.executable_sha256:
            raise CandidateGenerationError("executable_changed", "pinned KiCad executable changed")
        with self._operation_directory() as root:
            environment = self._environment(root)
            source_root = root / "source"
            derivative = root / "derivative"
            cam = root / "cam"
            for directory in (
                source_root,
                derivative,
                cam,
                cam / "gerbers",
                cam / "drill",
                cam / "assembly",
                cam / "ipc",
            ):
                directory.mkdir(exist_ok=False)
            self._write_exact(source_root, files)
            self._write_exact(derivative, files)
            stem = source.compiled_project.bundle.stem
            runtime_prl_name = f"{stem}.kicad_prl"
            runtime_prl_payload = project_preferences_payload(stem)
            runtime_prl_sha256 = _sha256(runtime_prl_payload)
            self._write_exact(
                derivative,
                ((runtime_prl_name, runtime_prl_payload),),
            )
            self._assert_exact_source(source_root, files)

            command_receipts: list[CommandReceipt] = []
            version_argv = (str(self._executable), "version")
            version_result, version_receipt = self._run(
                "version",
                version_argv,
                root=root,
                environment=environment,
                allowed_exit_codes=frozenset({0}),
            )
            try:
                version = version_result.stdout.decode("utf-8", errors="strict").strip()
                version_stderr = version_result.stderr.decode("utf-8", errors="strict").strip()
            except UnicodeError as exc:
                raise CandidateGenerationError(
                    "version_invalid", "KiCad version output is not strict UTF-8"
                ) from exc
            if (
                version_stderr
                or _VERSION.fullmatch(version) is None
                or version != self._configuration.kicad_version
            ):
                raise CandidateGenerationError(
                    "version_invalid", "live KiCad version does not match its exact pin"
                )
            command_receipts.append(version_receipt)

            commands = self._commands(source.compiled_project.bundle.stem, derivative, cam)
            drc_result: CompletedCommand | None = None
            for stage, suffix in commands:
                result, receipt = self._run(
                    stage,
                    (str(self._executable), *suffix),
                    root=root,
                    environment=environment,
                    allowed_exit_codes=frozenset({0, 5})
                    if stage == "drc-fill"
                    else frozenset({0}),
                )
                command_receipts.append(receipt)
                if stage == "drc-fill":
                    drc_result = result
                    break
            if drc_result is None:
                raise CandidateGenerationError("drc_missing", "DRC stage did not execute")

            filled_board = self._read_regular(
                derivative / board_filename,
                cap=self._policy.max_filled_board_bytes,
                label="filled derivative board",
            )
            filled_board_evidence = analyze_filled_board(filled_board)
            filled_board_semantic_payload = filled_board_evidence_payload(
                filled_board_evidence
            )
            filled_board_semantic_evidence_sha256 = _sha256(
                filled_board_semantic_payload
            )
            authored_zone_evidence = None
            if source_zone_count != filled_board_evidence.zone_count:
                raise CandidateGenerationError(
                    "authored_zone_mismatch",
                    "filled derivative zone count differs from exact authored source",
                )
            if source_zone_count:
                try:
                    authored_zone_evidence = compare_source_zone_identity(
                        source_board,
                        filled_board,
                        source_bundle_sha256=source.expected_source_bundle_sha256,
                    )
                except CandidateContractError as exc:
                    raise CandidateGenerationError(
                        "authored_zone_mismatch",
                        "filled derivative changed exact authored zone or board intent",
                    ) from exc
            authored_zone_payload = (
                b""
                if authored_zone_evidence is None
                else canonical_bytes(authored_zone_evidence) + b"\n"
            )
            authored_zone_evidence_sha256 = (
                None if not authored_zone_payload else _sha256(authored_zone_payload)
            )
            bom_result = source.bom_result
            bom_evidence_payload = (
                b""
                if bom_result is None
                else candidate_bom_evidence_payload(bom_result.evidence)
            )
            bom_evidence_sha256 = (
                None if not bom_evidence_payload else _sha256(bom_evidence_payload)
            )
            drc_payload = self._read_regular(
                derivative / "drc.json",
                cap=self._policy.max_report_bytes,
                label="DRC report",
            )
            try:
                parsed = parse_kicad_report(
                    "drc",
                    drc_payload,
                    expected_source=board_filename,
                    expected_version=version,
                )
            except KiCadReportError as exc:
                raise CandidateGenerationError(
                    "drc_report_invalid", "KiCad DRC report violated the pinned JSON schema"
                ) from exc
            ignored_keys = tuple(
                sorted(cast(str, item["key"]) for item in parsed.ignored_checks)
            )
            if any(
                key not in self._policy.acknowledged_ignored_check_keys
                for key in ignored_keys
            ):
                raise CandidateGenerationError(
                    "drc_ignored_checks",
                    "KiCad DRC report contains checks not explicitly acknowledged by host policy",
                )
            expected_exit = 5 if parsed.findings else 0
            if drc_result.exit_code != expected_exit:
                raise CandidateGenerationError(
                    "drc_exit_mismatch", "DRC report and process exit code disagree"
                )
            observed_types = tuple(
                sorted({cast(str, finding["type"]) for finding in parsed.findings})
            )
            unexpected = tuple(
                item
                for item in observed_types
                if item not in self._policy.allowed_library_only_types
            )
            if unexpected:
                raise CandidateGenerationError(
                    "drc_blocking_findings",
                    "DRC contains findings outside the explicit library-only classification: "
                    + ", ".join(unexpected),
                )

            for stage, suffix in commands[1:]:
                _, receipt = self._run(
                    stage,
                    (str(self._executable), *suffix),
                    root=root,
                    environment=environment,
                    allowed_exit_codes=frozenset({0}),
                )
                command_receipts.append(receipt)

            persisted_runtime_prl = self._read_regular(
                derivative / runtime_prl_name,
                cap=self._policy.max_report_bytes,
                label="runtime PRL support file",
            )
            if persisted_runtime_prl != runtime_prl_payload:
                raise CandidateGenerationError(
                    "runtime_prl_mutated",
                    "KiCad changed the policy-bound runtime PRL support file",
                )

            self._assert_exact_source(source_root, files)
            if self._validate_source(source) != files:
                raise CandidateGenerationError(
                    "canonical_source_mutated", "host-owned in-memory source changed"
                )

            expected_inventory = _cam_relative_inventory(stem)
            observed_inventory: list[str] = []
            for path in cam.rglob("*"):
                if path.is_symlink():
                    raise CandidateGenerationError(
                        "cam_inventory_invalid", "CAM inventory contains a symlink"
                    )
                if path.is_file():
                    observed_inventory.append(path.relative_to(cam).as_posix())
                elif not path.is_dir():
                    raise CandidateGenerationError(
                        "cam_inventory_invalid", "CAM inventory contains a special file"
                    )
            if tuple(sorted(observed_inventory)) != expected_inventory:
                raise CandidateGenerationError(
                    "cam_inventory_invalid", "KiCad CAM filename inventory is not the closed set"
                )

            artifacts: list[CandidateArtifact] = []
            validations: list[dict[str, object]] = []
            total_bytes = (
                len(filled_board)
                + len(drc_payload)
                + len(authored_zone_payload)
                + len(bom_evidence_payload)
                + sum(
                    len(item.payload)
                    for item in (() if bom_result is None else bom_result.artifacts)
                )
            )
            if total_bytes > self._policy.max_candidate_bytes:
                raise CandidateGenerationError(
                    "candidate_oversize", "candidate exceeds its total byte cap"
                )
            for filename in expected_inventory:
                payload = self._read_regular(
                    cam / Path(filename),
                    cap=self._policy.max_artifact_bytes,
                    label=filename,
                )
                total_bytes += len(payload)
                if total_bytes > self._policy.max_candidate_bytes:
                    raise CandidateGenerationError(
                        "candidate_oversize", "candidate exceeds its total byte cap"
                    )
                validations.append(
                    _validate_cam_content(
                        filename,
                        payload,
                        stem=stem,
                        kicad_version=version,
                    )
                )
                artifacts.append(
                    CandidateArtifact(filename, _media_type(filename), payload, _sha256(payload))
                )
            artifacts_tuple = tuple(sorted(artifacts, key=lambda item: item.filename))
            artifact_digests = tuple(item.digest for item in artifacts_tuple)
            source_digests = tuple(
                sorted(
                    ArtifactDigest(
                        f"source/{filename}",
                        "application/octet-stream",
                        len(payload),
                        _sha256(payload),
                    )
                    for filename, payload in files
                )
            )
            normalized_drc_sha256 = stable_sha256(
                parsed.normalized_report,
                domain="kicad-cam-candidate-normalized-drc-v1",
            )
            normalized_drc_payload = canonical_bytes(parsed.normalized_report) + b"\n"
            normalized_drc_evidence_sha256 = _sha256(normalized_drc_payload)
            inventory_sha256 = stable_sha256(
                artifact_digests,
                domain="kicad-cam-candidate-inventory-v1",
            )
            validation_sha256 = stable_sha256(
                tuple(sorted(validations, key=lambda item: cast(str, item["filename"]))),
                domain="kicad-cam-candidate-content-validation-v1",
            )
            bom_artifact_digests = (
                () if bom_result is None else bom_result.evidence.candidate_artifacts
            )
            bom_component_count = (
                0 if bom_result is None else bom_result.evidence.component_count
            )
            authored_zone_intent_sha256 = (
                None
                if authored_zone_evidence is None
                else authored_zone_evidence.authored_zone_intent_sha256
            )
            generated_fill_node_count = (
                0
                if authored_zone_evidence is None
                else authored_zone_evidence.generated_fill_node_count
            )
            candidate_sha256 = stable_sha256(
                {
                    "source_bundle_sha256": source.expected_source_bundle_sha256,
                    "source_manifest_sha256": source.expected_manifest_sha256,
                    "reference_design_artifact_sha256": (
                        source.reference_design_artifact_sha256
                    ),
                    "reference_package_manifest_sha256": (
                        source.reference_package_manifest_sha256
                    ),
                    "reference_publication_manifest_sha256": (
                        source.reference_publication_manifest_sha256
                    ),
                    "source_board_sha256": source_board_sha256,
                    "bom_evidence_sha256": bom_evidence_sha256,
                    "bom_component_count": bom_component_count,
                    "bom_artifacts": bom_artifact_digests,
                    "filled_board_sha256": _sha256(filled_board),
                    "filled_board_normalizer_id": filled_board_evidence.normalizer_id,
                    "filled_board_normalizer_version": (
                        filled_board_evidence.normalizer_version
                    ),
                    "filled_board_semantic_sha256": (
                        filled_board_evidence.normalized_semantic_sha256
                    ),
                    "filled_board_semantic_evidence_sha256": (
                        filled_board_semantic_evidence_sha256
                    ),
                    "filled_copper_geometry_sha256": (
                        filled_board_evidence.filled_copper_geometry_sha256
                    ),
                    "authored_zone_evidence_sha256": (
                        authored_zone_evidence_sha256
                    ),
                    "authored_zone_intent_sha256": authored_zone_intent_sha256,
                    "authored_zone_count": source_zone_count,
                    "generated_fill_node_count": generated_fill_node_count,
                    "drc_report_sha256": _sha256(drc_payload),
                    "normalized_drc_sha256": normalized_drc_sha256,
                    "normalized_drc_evidence_sha256": normalized_drc_evidence_sha256,
                    "cam_inventory_sha256": inventory_sha256,
                    "cam_content_validation_sha256": validation_sha256,
                },
                domain="kicad-cam-candidate-v3",
            )
            filled_board_sha256 = _sha256(filled_board)
            drc_report_sha256 = _sha256(drc_payload)
            command_receipts_tuple = tuple(command_receipts)
            receipt_fields: dict[str, object] = {
                "schema_version": 3,
                "receipt_kind": "non-release-kicad-cam-candidate",
                "manufacturing_release_eligible": False,
                "source_bundle_sha256": source.expected_source_bundle_sha256,
                "source_manifest_sha256": source.expected_manifest_sha256,
                "reference_design_artifact_sha256": source.reference_design_artifact_sha256,
                "reference_package_manifest_sha256": (
                    source.reference_package_manifest_sha256
                ),
                "reference_publication_manifest_sha256": (
                    source.reference_publication_manifest_sha256
                ),
                "source_file_digests": source_digests,
                "source_board_sha256": source_board_sha256,
                "non_fabrication_notice_filename": NON_FABRICATION_NOTICE_FILENAME,
                "non_fabrication_notice_sha256": NON_FABRICATION_NOTICE_SHA256,
                "bom_evidence_sha256": bom_evidence_sha256,
                "bom_component_count": bom_component_count,
                "bom_artifacts": bom_artifact_digests,
                "canonical_source_unchanged": True,
                "runtime_prl_unchanged": True,
                "runtime_support_policy_version": RUNTIME_SUPPORT_POLICY_VERSION,
                "runtime_support_template_sha256": RUNTIME_SUPPORT_TEMPLATE_SHA256,
                "runtime_support_manifest_sha256": runtime_support_manifest_sha256(stem),
                "runtime_prl_sha256": runtime_prl_sha256,
                "kicad_executable_sha256": self._configuration.executable_sha256,
                "kicad_version": version,
                "policy_sha256": self._policy.policy_sha256,
                "filled_board_sha256": filled_board_sha256,
                "filled_board_bytes": len(filled_board),
                "filled_board_normalizer_id": filled_board_evidence.normalizer_id,
                "filled_board_normalizer_version": filled_board_evidence.normalizer_version,
                "filled_board_semantic_sha256": (
                    filled_board_evidence.normalized_semantic_sha256
                ),
                "filled_board_semantic_evidence_sha256": (
                    filled_board_semantic_evidence_sha256
                ),
                "filled_copper_geometry_sha256": (
                    filled_board_evidence.filled_copper_geometry_sha256
                ),
                "filled_zone_count": filled_board_evidence.zone_count,
                "filled_polygon_count": filled_board_evidence.filled_polygon_count,
                "filled_vertex_count": filled_board_evidence.filled_vertex_count,
                "filled_area2_nm2": filled_board_evidence.filled_area2_nm2,
                "volatile_property_uuid_count": (
                    filled_board_evidence.volatile_property_uuid_count
                ),
                "volatile_property_paths_sha256": (
                    filled_board_evidence.volatile_property_paths_sha256
                ),
                "authored_zone_unchanged": True,
                "authored_zone_evidence_sha256": authored_zone_evidence_sha256,
                "authored_zone_intent_sha256": authored_zone_intent_sha256,
                "authored_zone_count": source_zone_count,
                "generated_fill_node_count": generated_fill_node_count,
                "drc_report_sha256": drc_report_sha256,
                "normalized_drc_sha256": normalized_drc_sha256,
                "normalized_drc_evidence_sha256": normalized_drc_evidence_sha256,
                "drc_finding_count": len(parsed.findings),
                "library_only_finding_types": observed_types,
                "ignored_check_keys": ignored_keys,
                "cam_output_determinism": "run-specific-content-addressed",
                "commands": command_receipts_tuple,
                "cam_artifacts": artifact_digests,
                "cam_inventory_sha256": inventory_sha256,
                "cam_content_validation_sha256": validation_sha256,
                "candidate_sha256": candidate_sha256,
            }
            receipt_hash = stable_sha256(receipt_fields, domain="kicad-cam-candidate-receipt-v3")
            receipt = CandidateReceipt(
                schema_version=3,
                receipt_kind="non-release-kicad-cam-candidate",
                manufacturing_release_eligible=False,
                source_bundle_sha256=source.expected_source_bundle_sha256,
                source_manifest_sha256=source.expected_manifest_sha256,
                reference_design_artifact_sha256=source.reference_design_artifact_sha256,
                reference_package_manifest_sha256=source.reference_package_manifest_sha256,
                reference_publication_manifest_sha256=(
                    source.reference_publication_manifest_sha256
                ),
                source_file_digests=source_digests,
                source_board_sha256=source_board_sha256,
                non_fabrication_notice_filename=NON_FABRICATION_NOTICE_FILENAME,
                non_fabrication_notice_sha256=NON_FABRICATION_NOTICE_SHA256,
                bom_evidence_sha256=bom_evidence_sha256,
                bom_component_count=bom_component_count,
                bom_artifacts=bom_artifact_digests,
                canonical_source_unchanged=True,
                runtime_prl_unchanged=True,
                runtime_support_policy_version=RUNTIME_SUPPORT_POLICY_VERSION,
                runtime_support_template_sha256=RUNTIME_SUPPORT_TEMPLATE_SHA256,
                runtime_support_manifest_sha256=runtime_support_manifest_sha256(stem),
                runtime_prl_sha256=runtime_prl_sha256,
                kicad_executable_sha256=self._configuration.executable_sha256,
                kicad_version=version,
                policy_sha256=self._policy.policy_sha256,
                filled_board_sha256=filled_board_sha256,
                filled_board_bytes=len(filled_board),
                filled_board_normalizer_id=filled_board_evidence.normalizer_id,
                filled_board_normalizer_version=filled_board_evidence.normalizer_version,
                filled_board_semantic_sha256=(
                    filled_board_evidence.normalized_semantic_sha256
                ),
                filled_board_semantic_evidence_sha256=(
                    filled_board_semantic_evidence_sha256
                ),
                filled_copper_geometry_sha256=(
                    filled_board_evidence.filled_copper_geometry_sha256
                ),
                filled_zone_count=filled_board_evidence.zone_count,
                filled_polygon_count=filled_board_evidence.filled_polygon_count,
                filled_vertex_count=filled_board_evidence.filled_vertex_count,
                filled_area2_nm2=filled_board_evidence.filled_area2_nm2,
                volatile_property_uuid_count=(
                    filled_board_evidence.volatile_property_uuid_count
                ),
                volatile_property_paths_sha256=(
                    filled_board_evidence.volatile_property_paths_sha256
                ),
                authored_zone_unchanged=True,
                authored_zone_evidence_sha256=authored_zone_evidence_sha256,
                authored_zone_intent_sha256=authored_zone_intent_sha256,
                authored_zone_count=source_zone_count,
                generated_fill_node_count=generated_fill_node_count,
                drc_report_sha256=drc_report_sha256,
                normalized_drc_sha256=normalized_drc_sha256,
                normalized_drc_evidence_sha256=normalized_drc_evidence_sha256,
                drc_finding_count=len(parsed.findings),
                library_only_finding_types=observed_types,
                ignored_check_keys=ignored_keys,
                cam_output_determinism="run-specific-content-addressed",
                commands=command_receipts_tuple,
                cam_artifacts=artifact_digests,
                cam_inventory_sha256=inventory_sha256,
                cam_content_validation_sha256=validation_sha256,
                candidate_sha256=candidate_sha256,
                receipt_sha256=receipt_hash,
            )
            # Keep this assertion adjacent to construction.  It prevents a field
            # being added to CandidateReceipt without also entering the receipt
            # preimage above.
            if receipt_sha256(receipt) != receipt_hash:
                raise CandidateGenerationError(
                    "receipt_hash_invalid", "candidate receipt hash preimage drifted"
                )
            return ManufacturingCandidate(
                filled_board_payload=filled_board,
                filled_board_semantic_evidence=filled_board_evidence,
                authored_zone_evidence=authored_zone_evidence,
                bom_result=bom_result,
                drc_report_payload=drc_payload,
                normalized_drc_payload=normalized_drc_payload,
                artifacts=artifacts_tuple,
                receipt=receipt,
            )


__all__ = ("KiCadManufacturingCandidatePipeline",)
