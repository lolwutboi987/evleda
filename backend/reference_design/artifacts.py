"""Deterministic, explicitly non-release artifact package for the reference PCB."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import stat
from contextlib import suppress
from dataclasses import asdict, dataclass, is_dataclass
from decimal import Decimal
from enum import Enum
from fractions import Fraction
from io import StringIO
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any, cast
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

from backend.design_kernel import stable_hash
from backend.kicad_compile import (
    CompilationManifest,
    CompiledProject,
    compile_design_graph,
    verify_compiled_project,
)
from evleda.legal import load_legal_payloads

from .audit import audit_reference_board
from .builder import ReferenceBoardBuild, build_reference_board
from .model import ReferenceDesignResult, ReferenceDesignViolation
from .specification import OUTPUT_MARKING, PROJECT_ID, SCHEMATIC_REVISION, bom, constraints, sources

PROJECT_STEM = "reference_usb_c_3v3_r2"
PACKAGE_MANIFEST_FILENAME = f"{PROJECT_STEM}.package-manifest.json"
PUBLICATION_MANIFEST_FILENAME = f"{PROJECT_STEM}.publication.json"
_MANUFACTURING_BLOCKERS = (
    "assembly-process-and-manufacturer-approval-not-recorded",
    "pcb-stackup-fabricator-approval-and-drill-tolerances-not-recorded",
    "c2-effective-capacitance-and-high-temperature-leakage-not-guaranteed",
    "c3-r9-full-temperature-capacitance-esr-and-stability-not-qualified",
    "j2-output-only-reverse-current-policy-not-approved-or-validated",
    "lp38692-board-specific-thermal-evidence-not-recorded",
    "lp38692-repeated-enable-brownout-and-bounce-not-qualified",
    "tps2596-loaded-startup-over-temperature-not-qualified",
    "usb-type-c-compliance-and-end-product-certification-not-recorded",
    "manifest-only-usb-if-keystone-sources-not-retained-release-evidence",
    "usb4105-mechanical-mating-and-board-thickness-unqualified",
    "independent-kicad-oracle-evidence-not-bound-into-this-package",
    "exact-source-board-is-unfilled-and-cam-derivative-is-not-release-approved",
    "u1-tps259620-dda-stencil-thermal-and-assembler-approval-not-recorded",
    "d1-ptvs-0p10mm-stencil-and-assembler-approval-not-recorded",
    "usb-c-shell-stake-pin-in-paste-or-secondary-solder-process-not-approved",
    "human-design-review-not-recorded",
    "manufacturing-capability-review-not-recorded",
    "release-approval-not-recorded",
)


def _primitive(value: object) -> object:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value) and not isinstance(value, type):
        fields: dict[str, Any] = asdict(cast(Any, value))
        return {key: _primitive(item) for key, item in fields.items()}
    if isinstance(value, tuple):
        tuple_items = cast(tuple[object, ...], value)
        return [_primitive(item) for item in tuple_items]
    if isinstance(value, list):
        list_items = cast(list[object], value)
        return [_primitive(item) for item in list_items]
    if isinstance(value, dict):
        mapping_items = cast(dict[object, object], value)
        return {str(key): _primitive(item) for key, item in mapping_items.items()}
    return value


def _json(value: object) -> bytes:
    return (
        json.dumps(_primitive(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        + "\n"
    ).encode("utf-8")


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _result_artifact_hash(
    *,
    build: ReferenceBoardBuild,
    result_bom: tuple[object, ...],
    result_constraints: tuple[object, ...],
    result_sources: tuple[object, ...],
    compiler: CompiledProject,
    compiler_reparse_hash: str,
    board_audit_hash: str,
) -> str:
    return stable_hash(
        {
            "design_id": PROJECT_ID,
            "graph_hash": build.graph_hash,
            "revision_hash": build.revision_hash,
            "bom_hash": stable_hash(result_bom, domain="flux-clone-reference-bom-v1"),
            "constraints_hash": stable_hash(
                result_constraints, domain="flux-clone-reference-constraints-v1"
            ),
            "sources_hash": stable_hash(result_sources, domain="flux-clone-reference-sources-v1"),
            "native_report_hash": build.native_report.report_hash,
            "compiler_manifest_hash": compiler.manifest_sha256,
            "compiler_bundle_hash": compiler.manifest.output_bundle_sha256,
            "compiler_reparse_hash": compiler_reparse_hash,
            "board_audit_hash": board_audit_hash,
            "preview_gate_passed": build.preview_gate_passed,
            "commit_gate_passed": build.commit_gate_passed,
            "manufacturing_release_passed": False,
            "manufacturing_blockers": _MANUFACTURING_BLOCKERS,
        },
        domain="flux-clone-reference-design-artifact-v1",
    )


@dataclass(frozen=True, slots=True)
class ReferenceArtifactSet:
    """The immutable subject and byte-exact compiler payloads used for export."""

    result: ReferenceDesignResult
    compiled: CompiledProject

    def __post_init__(self) -> None:
        if type(self) is not ReferenceArtifactSet or type(self.result) is not ReferenceDesignResult:
            raise ReferenceDesignViolation("artifact set must bind exact reference result")
        if type(self.compiled) is not CompiledProject:
            raise ReferenceDesignViolation("artifact set must bind exact compiled project")
        if self.result.compiler_manifest != self.compiled.manifest:
            raise ReferenceDesignViolation(
                "result compiler manifest differs from emitted compiler subject"
            )


def build_reference_artifact_set() -> ReferenceArtifactSet:
    """Build and reparse every native KiCad file before any filesystem write."""

    build = build_reference_board()
    board_audit = audit_reference_board(build)
    compiled = compile_design_graph(build.graph, PROJECT_STEM)
    verification = verify_compiled_project(build.graph, compiled)
    result_bom = bom()
    result_constraints = constraints()
    result_sources = sources()
    result = ReferenceDesignResult(
        PROJECT_ID,
        build.graph,
        build.revision,
        result_bom,
        result_constraints,
        result_sources,
        build.native_report,
        compiled.manifest,
        verification,
        board_audit,
        build.graph_hash,
        build.revision_hash,
        stable_hash(result_bom, domain="flux-clone-reference-bom-v1"),
        stable_hash(result_constraints, domain="flux-clone-reference-constraints-v1"),
        stable_hash(result_sources, domain="flux-clone-reference-sources-v1"),
        build.native_report.report_hash,
        compiled.manifest_sha256,
        compiled.manifest.output_bundle_sha256,
        verification.reparsed_bundle_ir_sha256,
        _result_artifact_hash(
            build=build,
            result_bom=result_bom,
            result_constraints=result_constraints,
            result_sources=result_sources,
            compiler=compiled,
            compiler_reparse_hash=verification.reparsed_bundle_ir_sha256,
            board_audit_hash=board_audit.audit_hash,
        ),
        build.preview_gate_passed,
        build.commit_gate_passed,
        False,
        _MANUFACTURING_BLOCKERS,
    )
    return ReferenceArtifactSet(result, compiled)


def _bom_csv(result: ReferenceDesignResult) -> bytes:
    output = StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(
        (
            "reference",
            "manufacturer",
            "manufacturer_part_number",
            "value",
            "package",
            "assembly_role",
            "source_evidence_ids",
        )
    )
    for line in result.bom:
        writer.writerow(
            (
                line.reference,
                line.manufacturer,
                line.manufacturer_part_number,
                line.value,
                line.package,
                line.assembly_role,
                ";".join(line.source_evidence_ids),
            )
        )
    return output.getvalue().encode("utf-8")


def _calculation_bound(
    result: ReferenceDesignResult,
    section_id: str,
    quantity_id: str,
    bound: str,
) -> Fraction:
    """Read one explicit audit bound so prose cannot silently drift from its receipt."""

    section = next(
        (
            candidate
            for candidate in result.board_audit.electrical_calculations.sections
            if candidate.section_id == section_id
        ),
        None,
    )
    if section is None:
        raise ReferenceDesignViolation(f"readme calculation section is absent: {section_id}")
    quantity = next(
        (candidate for candidate in section.quantities if candidate.quantity_id == quantity_id),
        None,
    )
    if quantity is None:
        raise ReferenceDesignViolation(f"readme calculation quantity is absent: {quantity_id}")
    value = {
        "minimum": quantity.minimum,
        "typical": quantity.typical,
        "maximum": quantity.maximum,
    }.get(bound)
    if value is None:
        raise ReferenceDesignViolation(
            f"readme calculation bound is absent: {section_id}/{quantity_id}/{bound}"
        )
    return Fraction(value.numerator, value.denominator)


def _decimal(value: Fraction, places: int) -> str:
    """Display an audit rational without introducing a second numerical source of truth."""

    if type(places) is not int or places < 0:
        raise ReferenceDesignViolation("readme decimal precision must be a nonnegative integer")
    return f"{Decimal(value.numerator) / Decimal(value.denominator):.{places}f}"


def _readme(result: ReferenceDesignResult) -> bytes:
    fitted_downstream_capacitance_uf = _calculation_bound(
        result, "startup", "downstream-capacitance-assumption", "typical"
    )
    capacitive_inrush_min_ma = _calculation_bound(
        result, "startup", "capacitive-inrush", "minimum"
    )
    capacitive_inrush_typ_ma = _calculation_bound(
        result, "startup", "capacitive-inrush", "typical"
    )
    capacitive_inrush_max_ma = _calculation_bound(
        result, "startup", "capacitive-inrush", "maximum"
    )
    protected_path_static_ma = _calculation_bound(
        result, "current-budget", "protected-path-static-load", "typical"
    )
    startup_max_ma = _calculation_bound(
        result, "current-budget", "startup-capacitive-plus-static-load", "maximum"
    )
    startup_margin_ma = _calculation_bound(
        result, "current-budget", "startup-margin-to-engineering-ilim-floor", "minimum"
    )
    return (
        "# USB-C 5 V sink to 3.3 V reference PCB\n\n"
        "This is a deterministic engineering reference package, not a production release. "
        f"It identifies `{PROJECT_ID}` / `{SCHEMATIC_REVISION}` and implements a USB-C "
        "5 V sink, protected 5 V path, and a 3.3 V output "
        "with a design target of at most 100 mA. The 100 mA target is not a "
        "production-qualified current guarantee. The required interface marking is "
        f"`{OUTPUT_MARKING}`.\n\n"
        "Qualified input is only a compliant USB Type-C default 5 V source from 4.75 V to "
        "5.50 V. It makes no sustained 9/12/19/21 V survival claim; TPS259620 component ratings "
        "are not a product input rating.\n\n"
        f"- Canonical graph: `{result.graph_hash}`\n"
        f"- Genesis revision: `{result.revision_hash}`\n"
        f"- Native technical report: `{result.native_report_hash}`\n"
        f"- Compiler manifest: `{result.compiler_manifest_hash}`\n"
        f"- Compiler bundle: `{result.compiler_bundle_hash}`\n"
        f"- Board audit: `{result.board_audit.audit_hash}`\n"
        f"- Reference design identity: `{result.artifact_hash}`\n\n"
        "## Included\n\n"
        "The `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb` files are byte-generated by the "
        "canonical compiler and were reparsed for semantic parity. The BOM, declared source "
        "evidence identities, "
        "constraint inventory, route provenance, and native deterministic report are included.\n\n"
        "The standalone package carries its applicable hardware licence and third-party "
        "attribution as an exact, manifest-bound five-file inventory under `legal/`.\n\n"
        "The build authority retained and rehashed seventeen official primary-source blobs. "
        "Those copyrighted evidence bytes are not redistributed in this package; it carries "
        "their source identities and SHA-256 receipts instead. The historical AP2112 blob "
        "remains content-addressed for audit history but is not a live R2 source. The USB-IF "
        "release archive and Keystone catalog remain explicitly manifest-only and are not "
        "treated as retained release evidence. USB4105 land geometry is bound only to the "
        "exact public KiCad footprint commit and raw-file SHA-256; it does not qualify "
        "board-thickness compatibility or mechanical mating.\n\n"
        "## Release status\n\n"
        "The canonical compiler deliberately does **not** invoke KiCad; its job is to emit and "
        "reparse the exact project bytes. Independent KiCad 10.0.6 evidence was obtained from "
        "a separate, manifest-bound working copy (ERC 0 and DRC 0 for the exact unfilled source; "
        "DRC 0 again after the filled CAM derivative), but that receipt is not embedded in this "
        "source-only package. This package does not claim fabrication capability, a completed "
        "human release review, or manufacturing authorization. Required blockers:\n\n"
        + "".join(f"- `{item}`\n" for item in result.manufacturing_blockers)
        + (
            "\nThe frozen 23-component placement and content-addressed 13-net route are compiler "
            "inputs with semantic parity checks. The route has passed the deterministic audit and "
            "the independent KiCad reopen/ERC/DRC checks described above; neither substitutes for "
            "release review or fabrication approval.\n"
        )
        + (
            "\nThe compiler emits source-backed F.Fab and F.CrtYd geometry, board silkscreen, "
            "and conservative model decisions (15 trusted models and 8 explicit omissions). "
            "KiCad renders and a 3D review asset exist in the independent evidence set. They are "
            "review artifacts rather than an approved fabrication/assembly drawing: assembler, "
            "stencil, voiding, and process approvals remain required before release.\n"
        )
        + (
            "\nU1 emits a 2.95 x 4.90 mm copper EP plus separate 2.40 x 3.10 mm "
            "mask and paste apertures from the TPS2596 DDA land-pattern example. D1 emits "
            "0.70 x 1.20 mm copper, 0.60 x 1.10 mm mask, and 0.35 x 1.00 mm paste "
            "per terminal from the Nexperia reflow footprint. The source stencil examples "
            "assume 0.127 mm for U1 and 0.10 mm for D1. The two U1 ground stitches are "
            "outside the EP; stencil, voiding, thermal performance, and assembly-process "
            "approval remain explicit blockers. J1's plated shell stakes likewise require "
            "an approved pin-in-paste or secondary-solder process.\n"
        )
        + (
            "\nThe compiled board emits a nominal compiler-owned 0.80 mm two-layer stackup: "
            "35 um copper on each side, a 0.71 mm FR-4 core, 0.01 mm green mask on each "
            "side, and ENIG finish. These values have not been accepted by a fabricator, and "
            "no drill-tolerance table, controlled fabrication drawing, or manufacturing "
            "capability receipt is bound.\n"
        )
        + (
            "\nThe included A4 landscape schematic is a human-readable functional-block drawing "
            "with 23 instances, local net labels, wires, explicit NC markers, and source-aware "
            "symbol definitions. It is also parsed for exact logical pin/net parity. The external "
            "KiCad ERC receipt is intentionally kept outside this source-only package, so a "
            "release packet must bind its own revision-specific evidence.\n"
        )
        + (
            "\nThis package contains 23 component-unique footprint modules, one generated symbol "
            "library, and both project-local library tables. Use "
            "`materialize_reference_kicad_working_copy(sealed_package, session_directory)` to "
            "copy only compiler-manifest-bound project bytes into a disposable KiCad session; "
            "that isolation rejects UI state, locks, backups, and caches in the sealed package. "
            "The isolated KiCad oracle evidence remains external to this source-only package.\n"
        )
        + (
            "\nThe 100 mA J2 output value is a design target in addition to onboard LED and "
            "qualified overhead. TPS2596 directly specifies 224/247/269 mA at RILM=3.83 "
            "kOhm. The tolerance/TCR engineering extension is approximately 220.350 to "
            "273.500 mA and is not another TI guarantee. LP38692 loaded IQ is at most "
            "100 uA over its stated loaded range. The canonical audit retains the complete "
            f"{_decimal(protected_path_static_ma, 6)} mA static, "
            f"{_decimal(capacitive_inrush_max_ma, 5)} mA maximum fitted-nominal-capacitance "
            f"inrush, {_decimal(startup_max_ma, 6)} mA startup, and "
            f"{_decimal(startup_margin_ma, 6)} mA margin receipts rather than only a hash.\n"
        )
        + (
            "\nC2 remains C0805C475K3RACTU with a 2.827 uF typical K-SIM input screen. "
            "C3 is polarized T598B226M010ATE070, 22 uF +/-20 percent, behind only "
            "WSLP0603R0100FEA R9 on `3V3 -> R9 -> COUT_DAMPED -> C3(+) -> GND`. "
            "R9's resistance screen is 9.829215 to 10.172215 mOhm; C3's 70 mOhm "
            "maximum is only at +25 C/100 kHz. Full-temperature ESR/capacitance and "
            "LP38692 stability/transients remain qualification blockers.\n"
        )
        + (
            "\nC4 is C1206C104J3GACTU, 100 nF +/-5 percent, 25 V C0G on U1 dVdt. "
            "Its 94.715 to 105.315 nF screen gives 0.3645 to 0.5289 mV/us. The fitted "
            f"C2+C3 nominal is exactly {_decimal(fitted_downstream_capacitance_uf, 1)} uF, "
            f"yielding {_decimal(capacitive_inrush_min_ma, 5)}/"
            f"{_decimal(capacitive_inrush_typ_ma, 5)}/"
            f"{_decimal(capacitive_inrush_max_ma, 5)} mA minimum/typical/maximum capacitive "
            "inrush. This nominal-only screen excludes "
            "tolerance/effective capacitance, attachments, active startup load, ESR/ESL, "
            "prebias, source droop, and temperature; those still require measurement.\n"
        )
        + (
            "\nJ2 and TP3 remain directly on 3V3. R9 is not in the load path. No LM66100 "
            "or U3 is fitted, and LP38692 does not block sustained reverse current. J2 is "
            "output-only: `3V3 OUT 100mA MAX / DO NOT APPLY POWER`. Any permitted "
            "external drive is an architecture blocker.\n"
        )
        + (
            "\nThe LP38692 0.25733 W worst-corner screen requires assembled-board thetaJA "
            "below 174.87 C/W at +80 C ambient with margin. TI's 68.5 C/W High-K-board "
            "figure is not evidence for this PCB; the NDC tab copper, thermal stitches, "
            "assembly, and board-specific thermal result must be reviewed and measured.\n"
        )
        + (
            "\nThe exact compiler source board intentionally retains unfilled B.Cu GND-zone "
            "intent so its bytes and audit remain reproducible. A separately generated filled "
            "CAM derivative has a clean DRC result, but it is not the exact source board and is "
            "not a manufacturing release. When an interactive 3D PDF cannot be displayed, use "
            "the matching static top-view PNG from the independent render evidence as the visual "
            "fallback; it does not replace opening the KiCad working copy for review.\n"
        )
    ).encode("utf-8")


def _zip_bytes(files: dict[str, bytes]) -> bytes:
    output = __import__("io").BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(files):
            info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, files[name])
    return output.getvalue()


def _media_type(filename: str) -> str:
    exact_names = {
        "fp-lib-table": "application/x-kicad-library-table",
        "sym-lib-table": "application/x-kicad-library-table",
    }
    if filename in exact_names:
        return exact_names[filename]
    suffixes = {
        ".json": "application/json",
        ".csv": "text/csv",
        ".kicad_dru": "application/x-kicad-design-rules",
        ".kicad_mod": "application/x-kicad-footprint",
        ".kicad_pcb": "application/x-kicad-pcb",
        ".kicad_pro": "application/json",
        ".kicad_sch": "application/x-kicad-schematic",
        ".kicad_sym": "application/x-kicad-symbol-library",
        ".md": "text/markdown",
    }
    for suffix, media_type in suffixes.items():
        if filename.endswith(suffix):
            return media_type
    raise ReferenceDesignViolation(f"no reviewed package media type for {filename}")


def _file_inventory(
    files: dict[str, bytes], media_types: dict[str, str]
) -> tuple[dict[str, object], ...]:
    if set(files) != set(media_types) or any(
        type(media_type) is not str or not media_type for media_type in media_types.values()
    ):
        raise ReferenceDesignViolation("package file/media-type inventory is incomplete")
    return tuple(
        {
            "filename": name,
            "media_type": media_types[name],
            "byte_length": len(files[name]),
            "sha256": _sha256(files[name]),
        }
        for name in sorted(files)
    )


def _package_manifest(
    result: ReferenceDesignResult, files: dict[str, bytes], media_types: dict[str, str]
) -> bytes:
    return _json(
        {
            "schema_version": 1,
            "kind": "flux-clone-reference-package-manifest",
            "project_stem": PROJECT_STEM,
            "reference_design_artifact_sha256": result.artifact_hash,
            "compiler_manifest_sha256": result.compiler_manifest_hash,
            "files": _file_inventory(files, media_types),
        }
    )


def _publication_manifest(
    files: dict[str, bytes], media_types: dict[str, str], zip_payload: bytes
) -> bytes:
    return _json(
        {
            "schema_version": 1,
            "kind": "flux-clone-reference-publication-complete",
            "project_stem": PROJECT_STEM,
            "files": _file_inventory(files, media_types),
            "zip": {
                "filename": f"{PROJECT_STEM}.zip",
                "media_type": "application/zip",
                "byte_length": len(zip_payload),
                "sha256": _sha256(zip_payload),
            },
        }
    )


def _managed_names(files: dict[str, bytes]) -> set[str]:
    return {
        *files,
        f"{PROJECT_STEM}.zip",
        PUBLICATION_MANIFEST_FILENAME,
    }


def _safe_output_path(root: Path, relative_name: str) -> Path:
    path = PurePosixPath(relative_name)
    if (
        not relative_name
        or "\\" in relative_name
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise ReferenceDesignViolation(f"unsafe package relative path: {relative_name!r}")
    return root.joinpath(*path.parts)


_FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_DIRECTORY_OPEN_FLAGS = (
    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
)
_EXCLUSIVE_FILE_FLAGS = (
    os.O_WRONLY
    | os.O_CREAT
    | os.O_EXCL
    | getattr(os, "O_BINARY", 0)
    | getattr(os, "O_NOFOLLOW", 0)
)
_SECURE_DIRECTORY_FDS = os.open in os.supports_dir_fd and os.mkdir in os.supports_dir_fd


def _metadata(path: Path, label: str) -> os.stat_result | None:
    """Read one directory entry without following links or Windows reparse points."""

    try:
        return path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ReferenceDesignViolation(f"{label} could not be inspected safely") from exc


def _is_link_or_reparse(metadata: os.stat_result) -> bool:
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT
    )


def _entry_identity(metadata: os.stat_result) -> tuple[int, int]:
    return metadata.st_dev, metadata.st_ino


def _validate_absolute_directory_path(path: Path, label: str) -> None:
    if not path.is_absolute() or ".." in path.parts:
        raise ReferenceDesignViolation(f"{label} must be an absolute normalized path")


def _directory_components(path: Path) -> tuple[Path, ...]:
    current = Path(path.anchor)
    result = [current]
    for part in path.parts[1:]:
        current /= part
        result.append(current)
    return tuple(result)


def _validate_plain_directory_chain(
    path: Path,
    label: str,
    *,
    allow_missing: bool,
) -> Path | None:
    """Reject links, reparse points, and non-directories in an absolute path chain."""

    _validate_absolute_directory_path(path, label)
    missing = False
    deepest: Path | None = None
    for component in _directory_components(path):
        metadata = _metadata(component, label)
        if metadata is None:
            missing = True
            continue
        if missing:
            raise ReferenceDesignViolation(f"{label} has an inconsistent directory chain")
        if _is_link_or_reparse(metadata):
            raise ReferenceDesignViolation(f"{label} cannot contain a symlink or reparse point")
        if not stat.S_ISDIR(metadata.st_mode):
            raise ReferenceDesignViolation(f"{label} cannot contain a special or non-directory")
        deepest = component
    if missing and not allow_missing:
        raise ReferenceDesignViolation(f"{label} must be an existing directory")
    return deepest


def _assert_resolved_within(root: Path, path: Path, label: str, *, strict: bool) -> None:
    try:
        resolved = path.resolve(strict=strict)
    except (OSError, RuntimeError) as exc:
        raise ReferenceDesignViolation(f"{label} could not be resolved safely") from exc
    if resolved != root and root not in resolved.parents:
        raise ReferenceDesignViolation(f"{label} escapes its resolved root")


def _open_plain_directory(path: Path, label: str) -> int:
    """Open and identity-bind a directory after a no-follow path-chain check."""

    _validate_plain_directory_chain(path, label, allow_missing=False)
    before = _metadata(path, label)
    assert before is not None
    try:
        descriptor = os.open(path, _DIRECTORY_OPEN_FLAGS)
    except OSError as exc:
        raise ReferenceDesignViolation(f"{label} could not be opened safely") from exc
    opened = os.fstat(descriptor)
    current = _metadata(path, label)
    if (
        _is_link_or_reparse(opened)
        or not stat.S_ISDIR(opened.st_mode)
        or current is None
        or _is_link_or_reparse(current)
        or _entry_identity(before) != _entry_identity(opened)
        or _entry_identity(current) != _entry_identity(opened)
    ):
        os.close(descriptor)
        raise ReferenceDesignViolation(f"{label} changed while it was being opened")
    return descriptor


def _ensure_plain_directory(path: Path, label: str) -> Path:
    """Create a directory chain without following an existing link or reparse point."""

    deepest = _validate_plain_directory_chain(path, label, allow_missing=True)
    if deepest is None:
        raise ReferenceDesignViolation(f"{label} has no existing filesystem anchor")
    components = _directory_components(path)
    first_missing = components.index(deepest) + 1
    if first_missing < len(components) and _SECURE_DIRECTORY_FDS:
        descriptor = _open_plain_directory(deepest, label)
        try:
            for component in components[first_missing:]:
                name = component.name
                with suppress(FileExistsError):
                    os.mkdir(name, dir_fd=descriptor)
                try:
                    child = os.open(name, _DIRECTORY_OPEN_FLAGS, dir_fd=descriptor)
                except OSError as exc:
                    raise ReferenceDesignViolation(
                        f"{label} acquired a symlink, reparse point, or special entry"
                    ) from exc
                child_metadata = os.fstat(child)
                if _is_link_or_reparse(child_metadata) or not stat.S_ISDIR(
                    child_metadata.st_mode
                ):
                    os.close(child)
                    raise ReferenceDesignViolation(
                        f"{label} acquired a symlink, reparse point, or special entry"
                    )
                os.close(descriptor)
                descriptor = child
        finally:
            os.close(descriptor)
    elif first_missing < len(components):
        for component in components[first_missing:]:
            with suppress(FileExistsError):
                component.mkdir()
            metadata = _metadata(component, label)
            if (
                metadata is None
                or _is_link_or_reparse(metadata)
                or not stat.S_ISDIR(metadata.st_mode)
            ):
                raise ReferenceDesignViolation(
                    f"{label} acquired a symlink, reparse point, or special entry"
                )
    _validate_plain_directory_chain(path, label, allow_missing=False)
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ReferenceDesignViolation(f"{label} could not be resolved safely") from exc
    _validate_plain_directory_chain(resolved, label, allow_missing=False)
    return resolved


def _resolved_plain_directory(path: Path, label: str) -> Path:
    _validate_plain_directory_chain(path, label, allow_missing=False)
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ReferenceDesignViolation(f"{label} could not be resolved safely") from exc
    _validate_plain_directory_chain(resolved, label, allow_missing=False)
    return resolved


def _plain_regular_file(root: Path, relative_name: str, label: str) -> Path:
    path = _safe_output_path(root, relative_name)
    _assert_resolved_within(root, path, label, strict=False)
    _validate_plain_directory_chain(path.parent, label, allow_missing=False)
    metadata = _metadata(path, label)
    if metadata is None:
        raise ReferenceDesignViolation(f"{label} is missing")
    if _is_link_or_reparse(metadata) or not stat.S_ISREG(metadata.st_mode):
        raise ReferenceDesignViolation(f"{label} must be a plain regular file")
    _assert_resolved_within(root, path, label, strict=True)
    return path


def _read_plain_file(root: Path, relative_name: str, label: str) -> bytes:
    """Read a regular file with no-follow and before/after identity checks."""

    path = _plain_regular_file(root, relative_name, label)
    before = _metadata(path, label)
    assert before is not None
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ReferenceDesignViolation(f"{label} could not be opened safely") from exc
    try:
        opened = os.fstat(descriptor)
        current = _metadata(path, label)
        if (
            _is_link_or_reparse(opened)
            or not stat.S_ISREG(opened.st_mode)
            or current is None
            or _is_link_or_reparse(current)
            or _entry_identity(before) != _entry_identity(opened)
            or _entry_identity(current) != _entry_identity(opened)
        ):
            raise ReferenceDesignViolation(f"{label} changed while it was being opened")
        with os.fdopen(descriptor, "rb") as stream:
            descriptor = -1
            payload = stream.read()
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    after = _metadata(path, label)
    if (
        after is None
        or _is_link_or_reparse(after)
        or _entry_identity(after) != _entry_identity(before)
        or after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
        or after.st_ctime_ns != before.st_ctime_ns
    ):
        raise ReferenceDesignViolation(f"{label} changed while it was being read")
    _validate_plain_directory_chain(root, label, allow_missing=False)
    _assert_resolved_within(root, path, label, strict=True)
    return payload


def _write_all(descriptor: int, payload: bytes, label: str) -> None:
    remaining = memoryview(payload)
    while remaining:
        try:
            written = os.write(descriptor, remaining)
        except OSError as exc:
            raise ReferenceDesignViolation(f"{label} could not be written safely") from exc
        if written <= 0:
            raise ReferenceDesignViolation(f"{label} write made no progress")
        remaining = remaining[written:]
    os.fsync(descriptor)


def _open_relative_parent(
    root_descriptor: int,
    relative_name: str,
    label: str,
) -> tuple[int, str]:
    parts = PurePosixPath(relative_name).parts
    descriptor = os.dup(root_descriptor)
    try:
        for part in parts[:-1]:
            with suppress(FileExistsError):
                os.mkdir(part, dir_fd=descriptor)
            try:
                child = os.open(part, _DIRECTORY_OPEN_FLAGS, dir_fd=descriptor)
            except OSError as exc:
                raise ReferenceDesignViolation(
                    f"{label} parent is a symlink, reparse point, or special entry"
                ) from exc
            child_metadata = os.fstat(child)
            if _is_link_or_reparse(child_metadata) or not stat.S_ISDIR(
                child_metadata.st_mode
            ):
                os.close(child)
                raise ReferenceDesignViolation(
                    f"{label} parent is a symlink, reparse point, or special entry"
                )
            os.close(descriptor)
            descriptor = child
        return descriptor, parts[-1]
    except BaseException:
        os.close(descriptor)
        raise


def _write_exclusive_files(
    root: Path,
    files: tuple[tuple[str, bytes], ...],
    label: str,
) -> None:
    """Write new files only, anchored below one verified directory where supported."""

    resolved_root = _resolved_plain_directory(root, label)
    for relative_name, payload in files:
        _safe_output_path(resolved_root, relative_name)
        if type(payload) is not bytes:
            raise ReferenceDesignViolation(f"{label} payload must use exact bytes")
    if _SECURE_DIRECTORY_FDS:
        root_descriptor = _open_plain_directory(resolved_root, label)
        try:
            for relative_name, payload in files:
                parent_descriptor, filename = _open_relative_parent(
                    root_descriptor, relative_name, label
                )
                try:
                    descriptor = os.open(
                        filename,
                        _EXCLUSIVE_FILE_FLAGS,
                        0o644,
                        dir_fd=parent_descriptor,
                    )
                except OSError as exc:
                    os.close(parent_descriptor)
                    raise ReferenceDesignViolation(
                        f"{label} target already exists or is unsafe: {relative_name}"
                    ) from exc
                try:
                    opened = os.fstat(descriptor)
                    if _is_link_or_reparse(opened) or not stat.S_ISREG(opened.st_mode):
                        raise ReferenceDesignViolation(
                            f"{label} target is not a plain regular file: {relative_name}"
                        )
                    _write_all(descriptor, payload, label)
                finally:
                    os.close(descriptor)
                    os.close(parent_descriptor)
        finally:
            os.close(root_descriptor)
    else:
        root_metadata = _metadata(resolved_root, label)
        assert root_metadata is not None
        root_identity = _entry_identity(root_metadata)
        for relative_name, payload in files:
            path = _safe_output_path(resolved_root, relative_name)
            _ensure_plain_directory(path.parent, label)
            _assert_resolved_within(resolved_root, path, label, strict=False)
            try:
                with path.open("xb") as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
            except OSError as exc:
                raise ReferenceDesignViolation(
                    f"{label} target already exists or is unsafe: {relative_name}"
                ) from exc
            current_root = _metadata(resolved_root, label)
            if current_root is None or _entry_identity(current_root) != root_identity:
                raise ReferenceDesignViolation(f"{label} root changed during publication")
            _plain_regular_file(resolved_root, relative_name, label)
    _directory_inventory(resolved_root, label)


def _assert_no_unmanaged_files(destination: Path, managed_names: set[str]) -> None:
    if _metadata(destination, "publication directory") is None:
        return
    files, directories = _directory_inventory(destination, "publication directory")
    unexpected = (files - managed_names) | (
        directories - _expected_directories(managed_names)
    )
    if unexpected:
        names = ", ".join(sorted(unexpected))
        raise ReferenceDesignViolation(
            "publication directory has unmanaged or KiCad UI state files: " + names
        )


def _verify_file_inventory(directory: Path, files: dict[str, bytes]) -> None:
    for name, payload in files.items():
        actual = _read_plain_file(directory, name, f"staged package file {name!r}")
        if actual != payload:
            raise ReferenceDesignViolation(f"staged package file drifted: {name}")


def _verify_published_completion(destination: Path) -> None:
    if _metadata(destination, "publication directory") is None:
        return
    destination = _resolved_plain_directory(destination, "publication directory")
    completion_path = _safe_output_path(destination, PUBLICATION_MANIFEST_FILENAME)
    if _metadata(completion_path, "publication completion manifest") is None:
        return
    try:
        decoded = json.loads(
            _read_plain_file(
                destination,
                PUBLICATION_MANIFEST_FILENAME,
                "publication completion manifest",
            ).decode("utf-8", errors="strict")
        )
    except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReferenceDesignViolation("publication completion manifest is malformed") from exc
    if not isinstance(decoded, dict):
        raise ReferenceDesignViolation("publication completion manifest has invalid root")
    completion = cast(dict[str, object], decoded)
    entries = completion.get("files")
    zip_entry = completion.get("zip")
    if not isinstance(entries, list) or not isinstance(zip_entry, dict):
        raise ReferenceDesignViolation("publication completion manifest has invalid shapes")
    zip_fields = cast(dict[str, object], zip_entry)
    for raw_entry in cast(list[object], entries):
        if not isinstance(raw_entry, dict):
            raise ReferenceDesignViolation("publication completion manifest has invalid file entry")
        entry = cast(dict[str, object], raw_entry)
        name = entry.get("filename")
        media_type = entry.get("media_type")
        if type(name) is not str or type(media_type) is not str or not media_type:
            raise ReferenceDesignViolation("publication completion manifest file name is invalid")
        payload = _read_plain_file(destination, name, f"published package file {name!r}")
        if len(payload) != entry.get("byte_length") or _sha256(payload) != entry.get("sha256"):
            raise ReferenceDesignViolation(
                f"published package file does not match completion: {name}"
            )
    zip_name = zip_fields.get("filename")
    if type(zip_name) is not str:
        raise ReferenceDesignViolation("publication completion ZIP name is invalid")
    zip_payload = _read_plain_file(destination, zip_name, "published package ZIP")
    if (
        len(zip_payload) != zip_fields.get("byte_length")
        or _sha256(zip_payload) != zip_fields.get("sha256")
        or zip_fields.get("media_type") != "application/zip"
    ):
        raise ReferenceDesignViolation("published ZIP does not match completion manifest")


def _verify_exact_publication(
    destination: Path,
    files: dict[str, bytes],
    zip_payload: bytes,
    completion_payload: bytes,
) -> None:
    """Verify the complete recursive inventory and every expected publication byte."""

    destination = _resolved_plain_directory(destination, "publication directory")
    expected_files = {
        *files,
        f"{PROJECT_STEM}.zip",
        PUBLICATION_MANIFEST_FILENAME,
    }
    observed_files, observed_directories = _directory_inventory(
        destination, "publication directory"
    )
    if (
        observed_files != expected_files
        or observed_directories != _expected_directories(expected_files)
    ):
        raise ReferenceDesignViolation(
            "publication directory has missing, unmanaged, or recursive inventory drift"
        )
    for name, payload in files.items():
        if _read_plain_file(destination, name, f"published package file {name!r}") != payload:
            raise ReferenceDesignViolation(f"published package file is not exact: {name}")
    if (
        _read_plain_file(
            destination,
            f"{PROJECT_STEM}.zip",
            "published package ZIP",
        )
        != zip_payload
    ):
        raise ReferenceDesignViolation("published package ZIP is not exact")
    if (
        _read_plain_file(
            destination,
            PUBLICATION_MANIFEST_FILENAME,
            "publication completion manifest",
        )
        != completion_payload
    ):
        raise ReferenceDesignViolation("publication completion manifest is not exact")


def _prepare_empty_directory(path: Path, label: str) -> Path:
    metadata = _metadata(path, label)
    if metadata is None:
        return _ensure_plain_directory(path, label)
    resolved = _resolved_plain_directory(path, label)
    files, directories = _directory_inventory(resolved, label)
    if files or directories:
        raise ReferenceDesignViolation(f"{label} must be empty before publication")
    return resolved


_WORKING_COPY_RUNTIME_SUFFIXES = (
    ".kicad_prl",
    ".bak",
    ".lck",
    ".lock",
    "-bak",
)
_WORKING_COPY_RUNTIME_NAMES = frozenset({"fp-info-cache", "__pycache__", "cache"})


def _working_copy_path(root: Path, relative_name: str) -> Path:
    """Resolve a compiler-owned project filename below one disposable session root."""

    output = _safe_output_path(root, relative_name)
    path = PurePosixPath(relative_name)
    name = path.name.casefold()
    if (
        any(part.casefold() in {"cache", "__pycache__"} for part in path.parts)
        or name in _WORKING_COPY_RUNTIME_NAMES
        or name.endswith(_WORKING_COPY_RUNTIME_SUFFIXES)
    ):
        raise ReferenceDesignViolation(
            f"KiCad runtime state cannot enter a working copy: {relative_name!r}"
        )
    return output


def _is_sha256(value: object) -> bool:
    return (
        type(value) is str
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _sealed_inventory(
    payload: bytes, label: str
) -> tuple[dict[str, object], dict[str, dict[str, object]]]:
    """Decode one closed package/publication manifest and index its file inventory."""

    try:
        decoded = json.loads(payload.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReferenceDesignViolation(f"{label} is not valid JSON") from exc
    if type(decoded) is not dict:
        raise ReferenceDesignViolation(f"{label} root is invalid")
    document = cast(dict[str, object], decoded)
    entries = document.get("files")
    if type(entries) is not list:
        raise ReferenceDesignViolation(f"{label} file inventory is invalid")
    inventory: dict[str, dict[str, object]] = {}
    folded_names: set[str] = set()
    for entry in cast(list[object], entries):
        if type(entry) is not dict:
            raise ReferenceDesignViolation(f"{label} file entry is invalid")
        fields = cast(dict[str, object], entry)
        if set(fields) != {"filename", "media_type", "byte_length", "sha256"}:
            raise ReferenceDesignViolation(f"{label} file entry shape is invalid")
        filename = fields["filename"]
        if (
            type(filename) is not str
            or type(fields["media_type"]) is not str
            or not fields["media_type"]
            or type(fields["byte_length"]) is not int
            or fields["byte_length"] < 0
            or not _is_sha256(fields["sha256"])
        ):
            raise ReferenceDesignViolation(f"{label} file entry values are invalid")
        _safe_output_path(Path("/sealed-package-validation"), filename)
        if filename in inventory or filename.casefold() in folded_names:
            raise ReferenceDesignViolation(f"{label} has duplicate or case-colliding files")
        inventory[filename] = fields
        folded_names.add(filename.casefold())
    return document, inventory


def _expected_directories(names: set[str]) -> set[str]:
    return {
        parent.as_posix()
        for name in names
        for parent in PurePosixPath(name).parents
        if parent != PurePosixPath(".")
    }


def _directory_inventory(directory: Path, label: str) -> tuple[set[str], set[str]]:
    """Return an exact recursive inventory while failing closed on links and special nodes."""

    root = _resolved_plain_directory(directory, label)
    files: set[str] = set()
    directories: set[str] = set()

    def walk(current: Path) -> None:
        before = _metadata(current, label)
        if (
            before is None
            or _is_link_or_reparse(before)
            or not stat.S_ISDIR(before.st_mode)
        ):
            raise ReferenceDesignViolation(
                f"{label} contains a symlink, reparse point, or special filesystem node"
            )
        _assert_resolved_within(root, current, label, strict=True)
        try:
            with os.scandir(current) as iterator:
                entries = tuple(iterator)
        except OSError as exc:
            raise ReferenceDesignViolation(f"{label} could not be inventoried safely") from exc
        for entry in entries:
            path = current / entry.name
            metadata = _metadata(path, label)
            if metadata is None:
                raise ReferenceDesignViolation(f"{label} changed during inventory")
            relative_name = path.relative_to(root).as_posix()
            if _is_link_or_reparse(metadata):
                raise ReferenceDesignViolation(
                    f"{label} contains a symlink or reparse point: {relative_name}"
                )
            _assert_resolved_within(root, path, label, strict=True)
            if stat.S_ISREG(metadata.st_mode):
                files.add(relative_name)
            elif stat.S_ISDIR(metadata.st_mode):
                directories.add(relative_name)
                walk(path)
            else:
                raise ReferenceDesignViolation(
                    f"{label} contains a special filesystem node: {relative_name}"
                )
        after = _metadata(current, label)
        if after is None or _entry_identity(after) != _entry_identity(before):
            raise ReferenceDesignViolation(f"{label} changed during inventory")

    walk(root)
    _validate_plain_directory_chain(root, label, allow_missing=False)
    return files, directories


def _sealed_project_files(sealed_package: Path) -> tuple[dict[str, bytes], dict[str, str]]:
    """Verify a completed sealed package and return only compiler-bound project bytes."""

    sealed_package = _resolved_plain_directory(sealed_package, "sealed package")
    files, directories = _directory_inventory(sealed_package, "sealed package")
    if PUBLICATION_MANIFEST_FILENAME not in files:
        raise ReferenceDesignViolation("sealed package has no completion manifest")
    completion_payload = _read_plain_file(
        sealed_package,
        PUBLICATION_MANIFEST_FILENAME,
        "sealed publication completion manifest",
    )
    completion, publication_files = _sealed_inventory(
        completion_payload, "publication completion manifest"
    )
    if (
        set(completion) != {"schema_version", "kind", "project_stem", "files", "zip"}
        or completion.get("schema_version") != 1
        or completion.get("kind") != "flux-clone-reference-publication-complete"
        or completion.get("project_stem") != PROJECT_STEM
    ):
        raise ReferenceDesignViolation("publication completion manifest subject is invalid")
    zip_entry = completion["zip"]
    if type(zip_entry) is not dict:
        raise ReferenceDesignViolation("publication completion ZIP entry is invalid")
    zip_fields = cast(dict[str, object], zip_entry)
    if set(zip_fields) != {
        "filename",
        "media_type",
        "byte_length",
        "sha256",
    }:
        raise ReferenceDesignViolation("publication completion ZIP entry is invalid")
    zip_name = zip_fields["filename"]
    if (
        type(zip_name) is not str
        or zip_fields["media_type"] != "application/zip"
        or type(zip_fields["byte_length"]) is not int
        or zip_fields["byte_length"] < 0
        or not _is_sha256(zip_fields["sha256"])
    ):
        raise ReferenceDesignViolation("publication completion ZIP values are invalid")
    _safe_output_path(sealed_package, zip_name)
    expected_files = {*publication_files, zip_name, PUBLICATION_MANIFEST_FILENAME}
    if files != expected_files or directories != _expected_directories(expected_files):
        raise ReferenceDesignViolation("sealed package has missing or unmanaged files")
    for name, entry in publication_files.items():
        payload = _read_plain_file(sealed_package, name, f"sealed package file {name!r}")
        if len(payload) != entry["byte_length"] or _sha256(payload) != entry["sha256"]:
            raise ReferenceDesignViolation(
                f"sealed package file does not match publication: {name}"
            )
    zip_payload = _read_plain_file(sealed_package, zip_name, "sealed package ZIP")
    if (
        len(zip_payload) != zip_fields["byte_length"]
        or _sha256(zip_payload) != zip_fields["sha256"]
    ):
        raise ReferenceDesignViolation("sealed package ZIP does not match publication")

    package_payload = _read_plain_file(
        sealed_package,
        PACKAGE_MANIFEST_FILENAME,
        "sealed package manifest",
    )
    package, package_files = _sealed_inventory(package_payload, "package manifest")
    if (
        set(package)
        != {
            "schema_version",
            "kind",
            "project_stem",
            "reference_design_artifact_sha256",
            "compiler_manifest_sha256",
            "files",
        }
        or package.get("schema_version") != 1
        or package.get("kind") != "flux-clone-reference-package-manifest"
        or package.get("project_stem") != PROJECT_STEM
        or not _is_sha256(package.get("reference_design_artifact_sha256"))
        or not _is_sha256(package.get("compiler_manifest_sha256"))
    ):
        raise ReferenceDesignViolation("package manifest subject is invalid")
    if set(package_files) != set(publication_files) - {PACKAGE_MANIFEST_FILENAME}:
        raise ReferenceDesignViolation("package and publication inventories do not agree")
    for name, entry in package_files.items():
        if publication_files[name] != entry:
            raise ReferenceDesignViolation(f"package inventory does not match publication: {name}")

    compiler_name = f"{PROJECT_STEM}.flux-compile.json"
    compiler_entry = package_files.get(compiler_name)
    if compiler_entry is None or compiler_entry["sha256"] != package["compiler_manifest_sha256"]:
        raise ReferenceDesignViolation("package manifest does not bind its compiler manifest")
    try:
        compiler = CompilationManifest.from_primitive(
            json.loads(
                _read_plain_file(
                    sealed_package,
                    compiler_name,
                    "sealed compiler manifest",
                ).decode("utf-8", errors="strict")
            )
        )
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ReferenceDesignViolation("sealed compiler manifest is invalid") from exc
    if compiler.project_stem != PROJECT_STEM:
        raise ReferenceDesignViolation("sealed compiler manifest project stem is invalid")

    project_files: dict[str, bytes] = {}
    for item in compiler.files:
        _working_copy_path(sealed_package, item.filename)
        entry = package_files.get(item.filename)
        if entry is None or entry != {
            "filename": item.filename,
            "media_type": item.media_type,
            "byte_length": item.byte_length,
            "sha256": item.sha256,
        }:
            raise ReferenceDesignViolation(
                f"compiler manifest file is not package-bound exactly: {item.filename}"
            )
        project_files[item.filename] = _read_plain_file(
            sealed_package,
            item.filename,
            f"sealed compiler project file {item.filename!r}",
        )
    required_primaries = {
        f"{PROJECT_STEM}.kicad_pro",
        f"{PROJECT_STEM}.kicad_sch",
        f"{PROJECT_STEM}.kicad_pcb",
    }
    if not required_primaries <= set(project_files):
        raise ReferenceDesignViolation("sealed compiler manifest has no complete KiCad project")
    seals = {
        "package_manifest_sha256": _sha256(package_payload),
        "publication_manifest_sha256": _sha256(completion_payload),
    }
    return project_files, seals


def _verify_or_prepare_working_copy(destination: Path, project_files: dict[str, bytes]) -> bool:
    """Return whether an existing exact working copy can be reused; reject all other state."""

    if _metadata(destination, "KiCad working-copy directory") is not None:
        files, directories = _directory_inventory(destination, "KiCad working-copy directory")
        expected_files = set(project_files)
        if not files and not directories:
            return False
        if files != expected_files or directories != _expected_directories(expected_files):
            raise ReferenceDesignViolation("KiCad working-copy directory has unmanaged files")
        for name, payload in project_files.items():
            _working_copy_path(destination, name)
            if (
                _read_plain_file(
                    destination,
                    name,
                    f"KiCad working-copy file {name!r}",
                )
                != payload
            ):
                raise ReferenceDesignViolation(
                    f"KiCad working-copy file does not match source: {name}"
                )
        return True
    _ensure_plain_directory(destination.parent, "KiCad working-copy parent")
    return False


def materialize_reference_kicad_working_copy(
    sealed_package: Path, session_directory: Path
) -> dict[str, str]:
    """Copy the sealed compiler project into a separate, KiCad-writable session directory.

    This intentionally copies only files bound by the sealed compiler manifest.  KiCad may create
    UI state, locks, backups, and caches in ``session_directory``; none can be written into or
    accepted from ``sealed_package``.  This function does not locate or launch KiCad.
    """

    if type(sealed_package) is not type(Path()) or type(session_directory) is not type(Path()):
        raise ReferenceDesignViolation("working-copy paths must be exact Path instances")
    if not sealed_package.is_absolute() or not session_directory.is_absolute():
        raise ReferenceDesignViolation("working-copy paths must be absolute")
    if session_directory.parent == session_directory or not session_directory.name:
        raise ReferenceDesignViolation("KiCad working-copy directory cannot be a filesystem root")
    source_root = _resolved_plain_directory(sealed_package, "sealed package")
    session_parent = _ensure_plain_directory(
        session_directory.parent, "KiCad working-copy parent"
    )
    session_root = session_parent / session_directory.name
    if _metadata(session_root, "KiCad working-copy directory") is not None:
        session_root = _resolved_plain_directory(session_root, "KiCad working-copy directory")
    if (
        source_root == session_root
        or source_root in session_root.parents
        or session_root in source_root.parents
    ):
        raise ReferenceDesignViolation(
            "KiCad working-copy directory must be separate from sealed package"
        )
    project_files, seals = _sealed_project_files(source_root)
    reused = _verify_or_prepare_working_copy(session_root, project_files)
    if not reused:
        session_root = _prepare_empty_directory(
            session_root, "KiCad working-copy directory"
        )
        _write_exclusive_files(
            session_root,
            tuple((name, project_files[name]) for name in sorted(project_files)),
            "KiCad working-copy directory",
        )
        _verify_or_prepare_working_copy(session_root, project_files)
    _, current_seals = _sealed_project_files(source_root)
    if current_seals != seals:
        raise ReferenceDesignViolation("sealed package changed while materializing working copy")
    return {name: _sha256(payload) for name, payload in sorted(project_files.items())}


def materialize_reference_artifacts(destination: Path) -> dict[str, str]:
    """Write a deterministic package to an explicit empty-or-managed directory.

    Only named package files are written.  Callers choose the destination; this
    function never discovers a KiCad installation or invokes an external tool.
    """

    if type(destination) is not type(Path()) or not destination.is_absolute():
        raise ReferenceDesignViolation("publication destination must be an absolute exact Path")
    if destination.parent == destination or not destination.name:
        raise ReferenceDesignViolation("publication destination cannot be a filesystem root")
    _validate_plain_directory_chain(
        destination.parent,
        "publication destination parent",
        allow_missing=True,
    )
    if _metadata(destination, "publication directory") is not None:
        # Inspect without following any entry before the expensive artifact build.
        _directory_inventory(destination, "publication directory")
    package = build_reference_artifact_set()
    result, compiled = package.result, package.compiled
    legal_payloads = load_legal_payloads()
    legal_files = {item.archive_filename: item.payload for item in legal_payloads}
    legal_media_types = {item.archive_filename: item.media_type for item in legal_payloads}
    payload_files = {item.relative_name: item.payload for item in compiled.bundle.all_files}
    payload_media_types = {
        item.relative_name: item.media_type for item in compiled.bundle.all_files
    }
    payload_files = {
        **payload_files,
        compiled.compiler_manifest_filename: compiled.manifest_payload,
        f"{PROJECT_STEM}.bom.json": _json(result.bom),
        f"{PROJECT_STEM}.bom.csv": _bom_csv(result),
        f"{PROJECT_STEM}.audit.json": _json(result.board_audit),
        f"{PROJECT_STEM}.native-report.json": _json(result.native_report),
        f"{PROJECT_STEM}.result.json": _json(result),
        "README.md": _readme(result),
        **legal_files,
    }
    payload_media_types = {
        **payload_media_types,
        compiled.compiler_manifest_filename: _media_type(compiled.compiler_manifest_filename),
        f"{PROJECT_STEM}.bom.json": _media_type(f"{PROJECT_STEM}.bom.json"),
        f"{PROJECT_STEM}.bom.csv": _media_type(f"{PROJECT_STEM}.bom.csv"),
        f"{PROJECT_STEM}.audit.json": _media_type(f"{PROJECT_STEM}.audit.json"),
        f"{PROJECT_STEM}.native-report.json": _media_type(f"{PROJECT_STEM}.native-report.json"),
        f"{PROJECT_STEM}.result.json": _media_type(f"{PROJECT_STEM}.result.json"),
        "README.md": _media_type("README.md"),
        **legal_media_types,
    }
    files = {
        **payload_files,
        PACKAGE_MANIFEST_FILENAME: _package_manifest(result, payload_files, payload_media_types),
    }
    media_types = {**payload_media_types, PACKAGE_MANIFEST_FILENAME: "application/json"}
    zip_name = f"{PROJECT_STEM}.zip"
    zip_payload = _zip_bytes(files)
    completion_payload = _publication_manifest(files, media_types, zip_payload)
    managed_names = _managed_names(files)
    _assert_no_unmanaged_files(destination, managed_names)
    _verify_published_completion(destination)
    if _metadata(destination, "publication directory") is not None:
        observed_files, observed_directories = _directory_inventory(
            destination, "publication directory"
        )
        if PUBLICATION_MANIFEST_FILENAME in observed_files:
            _verify_exact_publication(destination, files, zip_payload, completion_payload)
            return {
                **{name: _sha256(payload) for name, payload in files.items()},
                "zip_sha256": _sha256(zip_payload),
                "publication_manifest_sha256": _sha256(completion_payload),
            }
        if observed_files or observed_directories:
            raise ReferenceDesignViolation(
                "publication directory is an incomplete or unmanaged prior publication"
            )

    destination_parent = _ensure_plain_directory(
        destination.parent, "publication destination parent"
    )
    destination = destination_parent / destination.name
    with TemporaryDirectory(prefix=f".{PROJECT_STEM}-", dir=destination_parent) as temporary:
        staging = _resolved_plain_directory(Path(temporary), "publication staging directory")
        _assert_resolved_within(
            destination_parent,
            staging,
            "publication staging directory",
            strict=True,
        )
        staged_files = tuple((name, files[name]) for name in sorted(files)) + (
            (zip_name, zip_payload),
        )
        _write_exclusive_files(staging, staged_files, "publication staging directory")
        _verify_file_inventory(staging, files)
        if _read_plain_file(staging, zip_name, "staged package ZIP") != zip_payload:
            raise ReferenceDesignViolation("staged package ZIP drifted")
        if _zip_bytes(files) != zip_payload:
            raise ReferenceDesignViolation("staged ZIP is not deterministic")
        # This marker is staged and published last: its presence certifies the
        # named payload and ZIP bytes as one coherent package generation.
        _write_exclusive_files(
            staging,
            ((PUBLICATION_MANIFEST_FILENAME, completion_payload),),
            "publication staging directory",
        )
        _verify_exact_publication(staging, files, zip_payload, completion_payload)

        destination = _prepare_empty_directory(destination, "publication directory")
        _write_exclusive_files(
            destination,
            staged_files + ((PUBLICATION_MANIFEST_FILENAME, completion_payload),),
            "publication directory",
        )
    _verify_published_completion(destination)
    _verify_exact_publication(destination, files, zip_payload, completion_payload)
    result_hashes = {name: _sha256(payload) for name, payload in files.items()}
    result_hashes["zip_sha256"] = _sha256(zip_payload)
    result_hashes["publication_manifest_sha256"] = _sha256(completion_payload)
    return result_hashes


__all__ = (
    "PROJECT_STEM",
    "PACKAGE_MANIFEST_FILENAME",
    "PUBLICATION_MANIFEST_FILENAME",
    "ReferenceArtifactSet",
    "build_reference_artifact_set",
    "materialize_reference_kicad_working_copy",
    "materialize_reference_artifacts",
)
