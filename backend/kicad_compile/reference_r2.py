"""Sealed compilation-profile evidence for the reviewed USB-C 3V3 R2 board."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from backend.design_kernel import DesignGraph, FootprintPad, stable_hash
from backend.evidence import reference_sources
from backend.kicad_compile.model import CompilationProfileEvidence
from backend.reference_design.assembly_geometry import (
    REFERENCE_PROFILE_RECORDS,
    AssemblyPlacement,
    BoardOverhang,
    all_profiles,
    board_overhangs,
    courtyard_collisions,
    resolve_placed_profiles,
    validate_reference_inventory,
)
from backend.reference_design.model3d import IDENTITY_TRANSFORM, ModelConfidence, catalog
from backend.reference_design.silkscreen import (
    FINAL_PLACEMENTS,
    FittedPart,
    PlannerInput,
    RectNm,
    plan_silkscreen,
)
from backend.reference_design.specification import BOARD_HEIGHT_NM, BOARD_WIDTH_NM, PROJECT_ID

PROFILE_ID = "flux-reference-usb-c-3v3-r2"
PROFILE_VERSION = "1.1.0"
R2_GRAPH_SHA256 = "4b4e91e04078276aecd6e9d4f084871c49377c59d5c7a53edb714a96c6c228ee"
SILKSCREEN_PLAN_SHA256 = "22599058e3c54a14d7db12f2be490947eddd3518226ddf008f60510238f2a379"
# Filled with semantic digests for the reviewed R2 input.  Keeping these
# separate makes an upstream sidecar/source mutation a hard error, not a new
# implicit profile version.
_ASSEMBLY_CATALOG_SHA256 = "5e99ed6e76ec2b94e320495cda15576d448f932c57ab67bc065181d18e556128"
_ASSEMBLY_PLACEMENT_SHA256 = "c4a831d7d91902ee562c71728703e85adfd217b8b6cd5cc7ad67dd7175b46319"
_MODEL_CATALOG_SHA256 = "6a8da26c25aa9d9360b29e7cd6cfbbaf9b0471f0d437f1dc2685cc3d93fb9f78"
_MODEL_EMITTED_MANIFEST_SHA256 = "e3593ca657d3336027171de451065658f9be4e9a4706779533e2a87034360490"
_MODEL_OMITTED_MANIFEST_SHA256 = "f275597bb302ead53373402aa6cf4753ae855edf6d4b94f3bed60c7dfdb3dc17"
_SOURCE_RECEIPT_MANIFEST_SHA256 = "61c4de84fa359101073b4cce6aa020c36d5c7e9ff23257cfa39bd50d3b931361"


class R2CompilationProfileError(ValueError):
    """Raised when a subject falls outside the sealed R2 compilation profile."""


@dataclass(frozen=True, slots=True)
class AssemblyArtworkRecord:
    """One source-backed Fab or courtyard outline transformed to board coordinates."""

    component_id: str
    reference: str
    footprint_id: str
    profile_id: str
    layer: str
    dimension_status: str
    vertices_nm: tuple[tuple[int, int], ...]


@dataclass(frozen=True, slots=True)
class SilkscreenRecord:
    """One reviewed F.SilkS primitive with its collision-search receipt."""

    identifier: str
    role: str
    owner_reference: str | None
    kicad: str
    accepted: bool
    clearance_nm: int
    collider_identifier: str | None


@dataclass(frozen=True, slots=True)
class ModelRecord:
    """One safe 3D emission or intentional omission for a fitted component."""

    component_id: str
    reference: str
    footprint_id: str
    source_sha256: str
    confidence: str
    emitted: bool
    model_relative_path: str | None
    kicad_reference: str | None
    model_sha256: str | None
    omission_reason: str | None
    repository: str
    snapshot: str
    license: str
    license_url: str


@dataclass(frozen=True, slots=True)
class R2CompilationProfile:
    """Immutable, exact R2 sidecar records and their compiler evidence binding."""

    evidence: CompilationProfileEvidence
    fab_records: tuple[AssemblyArtworkRecord, ...]
    courtyard_records: tuple[AssemblyArtworkRecord, ...]
    silkscreen_records: tuple[SilkscreenRecord, ...]
    emitted_model_records: tuple[ModelRecord, ...]
    omitted_model_records: tuple[ModelRecord, ...]
    overhangs: tuple[BoardOverhang, ...]

    @property
    def model_records(self) -> tuple[ModelRecord, ...]:
        """Return all model decisions in deterministic component-ID order."""

        return tuple(
            sorted(
                self.emitted_model_records + self.omitted_model_records,
                key=lambda item: item.component_id,
            )
        )


def _sealed(actual: str, expected: str, label: str) -> str:
    if not expected or actual != expected:
        raise R2CompilationProfileError(f"sealed R2 {label} changed")
    return actual


def _transform(point: tuple[int, int], placement: AssemblyPlacement) -> tuple[int, int]:
    x_nm, y_nm = point
    if placement.rotation_udeg == 0:
        dx_nm, dy_nm = x_nm, y_nm
    elif placement.rotation_udeg == 90_000_000:
        dx_nm, dy_nm = -y_nm, x_nm
    elif placement.rotation_udeg == 180_000_000:
        dx_nm, dy_nm = -x_nm, -y_nm
    else:
        dx_nm, dy_nm = y_nm, -x_nm
    return placement.x_nm + dx_nm, placement.y_nm + dy_nm


def _pad_bounds(pad: FootprintPad) -> RectNm:
    if pad.rotation_udeg in {0, 180_000_000}:
        half_x_nm, half_y_nm = pad.size_x_nm // 2, pad.size_y_nm // 2
    else:
        half_x_nm, half_y_nm = pad.size_y_nm // 2, pad.size_x_nm // 2
    return RectNm(
        pad.center.x - half_x_nm,
        pad.center.y - half_y_nm,
        pad.center.x + half_x_nm,
        pad.center.y + half_y_nm,
    )


def _build_assembly_records(
    graph: DesignGraph,
) -> tuple[
    tuple[AssemblyArtworkRecord, ...],
    tuple[AssemblyArtworkRecord, ...],
    tuple[BoardOverhang, ...],
    str,
    str,
]:
    validate_reference_inventory()
    profiles = all_profiles()
    records = REFERENCE_PROFILE_RECORDS
    if len(records) != 23 or len(profiles) != 12:
        raise R2CompilationProfileError("sealed R2 assembly inventory count changed")
    component_by_id = {component.component_id: component for component in graph.components}
    if {
        (record.component_id, record.reference, record.footprint_id)
        for record in records
    } != {
        (component.component_id, component.reference, component.footprint_id)
        for component in graph.components
    }:
        raise R2CompilationProfileError("sealed R2 assembly component inventory changed")
    record_by_id = {record.component_id: record for record in records}
    placements = tuple(
        AssemblyPlacement(
            placement.component_id,
            record_by_id[placement.component_id].footprint_id,
            placement.position.x,
            placement.position.y,
            placement.rotation_udeg,
        )
        for placement in graph.placements
    )
    if len(placements) != 23 or len({item.subject_id for item in placements}) != 23:
        raise R2CompilationProfileError("sealed R2 assembly placement count changed")
    final_positions = tuple(
        (
            reference,
            component_id,
            next(item for item in placements if item.subject_id == component_id).x_nm,
            next(item for item in placements if item.subject_id == component_id).y_nm,
        )
        for reference, component_id, _x_nm, _y_nm in FINAL_PLACEMENTS
    )
    if final_positions != FINAL_PLACEMENTS:
        raise R2CompilationProfileError("sealed R2 final placement changed")
    placed = resolve_placed_profiles(placements)
    collisions = courtyard_collisions(placed)
    if collisions:
        raise R2CompilationProfileError("sealed R2 courtyard collision state changed")
    overhangs = board_overhangs(placed, (0, 0, BOARD_WIDTH_NM, BOARD_HEIGHT_NM))
    if overhangs != (
        BoardOverhang("usb-j1", "usb4105", (-505_000, 9_680_000, 8_435_000, 20_320_000), True),
    ):
        raise R2CompilationProfileError("sealed R2 board-overhang state changed")
    fab: list[AssemblyArtworkRecord] = []
    courtyard: list[AssemblyArtworkRecord] = []
    for item in placed:
        component = component_by_id[item.placement.subject_id]
        for outline, destination in (
            (item.profile.fab_outline, fab),
            (item.profile.courtyard_outline, courtyard),
        ):
            destination.append(
                AssemblyArtworkRecord(
                    component.component_id,
                    component.reference,
                    component.footprint_id,
                    item.profile.profile_id,
                    outline.layer,
                    outline.status,
                    tuple(_transform(point, item.placement) for point in outline.vertices),
                )
            )
    fab_records = tuple(fab)
    courtyard_records = tuple(courtyard)
    catalog_digest = stable_hash(
        {"profiles": profiles, "records": records},
        domain="flux-clone-r2-compilation-assembly-catalog-v1",
    )
    placement_digest = stable_hash(
        {
            "placements": placements,
            "fab_records": fab_records,
            "courtyard_records": courtyard_records,
            "collisions": collisions,
            "overhangs": overhangs,
        },
        domain="flux-clone-r2-compilation-assembly-placement-v1",
    )
    return (
        fab_records,
        courtyard_records,
        overhangs,
        _sealed(catalog_digest, _ASSEMBLY_CATALOG_SHA256, "assembly catalog"),
        _sealed(placement_digest, _ASSEMBLY_PLACEMENT_SHA256, "assembly placement"),
    )


def _build_silkscreen_records(
    graph: DesignGraph,
) -> tuple[tuple[SilkscreenRecord, ...], str]:
    placements = {item.component_id: item for item in graph.placements}
    records = {item.component_id: item for item in REFERENCE_PROFILE_RECORDS}
    assembly_placements = tuple(
        AssemblyPlacement(
            component_id,
            records[component_id].footprint_id,
            placements[component_id].position.x,
            placements[component_id].position.y,
            placements[component_id].rotation_udeg,
        )
        for _reference, component_id, _x_nm, _y_nm in FINAL_PLACEMENTS
    )
    placed = {
        item.placement.subject_id: item
        for item in resolve_placed_profiles(assembly_placements)
    }

    def body_bounds(component_id: str) -> RectNm:
        points = tuple(
            _transform(point, placed[component_id].placement)
            for point in placed[component_id].profile.fab_outline.vertices
        )
        return RectNm(
            min(point[0] for point in points),
            min(point[1] for point in points),
            max(point[0] for point in points),
            max(point[1] for point in points),
        )

    parts = tuple(
        FittedPart(
            reference,
            component_id,
            x_nm,
            y_nm,
            body_bounds(component_id),
            body_bounds(component_id),
            RectNm(*placed[component_id].courtyard_bounds_nm),
            tuple(_pad_bounds(pad) for pad in graph.pads if pad.component_id == component_id),
            connector_or_probe=reference in {"J1", "J2", "TP1", "TP2", "TP3", "TP4"},
        )
        for reference, component_id, x_nm, y_nm in FINAL_PLACEMENTS
    )
    plan = plan_silkscreen(
        PlannerInput(RectNm(0, 0, BOARD_WIDTH_NM, BOARD_HEIGHT_NM), parts)
    )
    if (
        len(plan.primitives) != 46
        or len(plan.reports) != 46
        or plan.digest != SILKSCREEN_PLAN_SHA256
        or any(not report.accepted or report.clearance_nm < 0 for report in plan.reports)
    ):
        raise R2CompilationProfileError("sealed R2 silkscreen plan changed")
    return (
        tuple(
            SilkscreenRecord(
                primitive.identifier,
                primitive.role,
                primitive.owner_reference,
                primitive.kicad(),
                report.accepted,
                report.clearance_nm,
                report.collider_identifier,
            )
            for primitive, report in zip(plan.primitives, plan.reports, strict=True)
        ),
        plan.digest,
    )


def _build_model_records() -> tuple[
    tuple[ModelRecord, ...], tuple[ModelRecord, ...], str, str, str
]:
    bindings = catalog()
    if len(bindings) != 23:
        raise R2CompilationProfileError("sealed R2 3D catalog count changed")
    records = tuple(
        ModelRecord(
            binding.component_id,
            binding.reference,
            binding.footprint_id,
            binding.source_sha256,
            binding.confidence.value,
            binding.confidence is not ModelConfidence.UNAVAILABLE,
            binding.model_relative_path,
            binding.kicad_reference,
            binding.model_sha256,
            binding.reason,
            binding.repository,
            binding.snapshot,
            binding.license,
            binding.license_url,
        )
        for binding in bindings
    )
    emitted = tuple(item for item in records if item.emitted)
    omitted = tuple(item for item in records if not item.emitted)
    if (
        len(emitted) != 16
        or len(omitted) != 7
        or any(binding.transform != IDENTITY_TRANSFORM for binding in bindings)
        or any(item.kicad_reference is None or item.model_sha256 is None for item in emitted)
        or any(
            item.kicad_reference is not None or item.model_sha256 is not None for item in omitted
        )
    ):
        raise R2CompilationProfileError("sealed R2 safe 3D emission state changed")
    catalog_digest = stable_hash(records, domain="flux-clone-r2-compilation-model-catalog-v1")
    emitted_digest = stable_hash(emitted, domain="flux-clone-r2-compilation-model-emitted-v1")
    omitted_digest = stable_hash(omitted, domain="flux-clone-r2-compilation-model-omitted-v1")
    return (
        emitted,
        omitted,
        _sealed(catalog_digest, _MODEL_CATALOG_SHA256, "3D catalog"),
        _sealed(emitted_digest, _MODEL_EMITTED_MANIFEST_SHA256, "3D emitted manifest"),
        _sealed(omitted_digest, _MODEL_OMITTED_MANIFEST_SHA256, "3D omitted manifest"),
    )


def _source_manifest_digest(
    manifest_path: Path | None = None,
    content_root: Path | None = None,
) -> str:
    """Verify the location-independent, byte-sealed R2 source receipt.

    A source checkout and an installed wheel intentionally place the public
    manifest in different directories.  Authority comes from the exact
    manifest bytes and the immutable source layout, never from either physical
    path.  Retained source bytes remain private and are verified under the
    explicit cache root resolved by :mod:`backend.evidence.reference_sources`.
    """

    selected_manifest = (
        reference_sources.DEFAULT_MANIFEST_PATH if manifest_path is None else manifest_path
    )
    if selected_manifest.is_symlink() or not selected_manifest.is_file():
        raise R2CompilationProfileError("sealed R2 source manifest path is unsafe")
    try:
        manifest_bytes = selected_manifest.read_bytes()
        payload = json.loads(manifest_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise R2CompilationProfileError("sealed R2 source manifest is unreadable") from error
    if hashlib.sha256(manifest_bytes).hexdigest() != reference_sources.IMMUTABLE_MANIFEST_SHA256:
        raise R2CompilationProfileError("sealed R2 source manifest bytes changed")
    if not isinstance(payload, dict):
        raise R2CompilationProfileError("sealed R2 source manifest is malformed")
    manifest = cast(dict[str, object], payload)
    if manifest.get("source_evidence_count") != 20:
        raise R2CompilationProfileError("sealed R2 source manifest count changed")
    entries_value: object = manifest.get("sources")
    if type(entries_value) is not list:
        raise R2CompilationProfileError("sealed R2 source manifest changed")
    entries = cast(list[object], entries_value)
    resolved_content_root = reference_sources.resolve_content_root(
        selected_manifest,
        content_root,
    )
    if len(entries) != 20 or reference_sources.verify_manifest(
        selected_manifest,
        content_root=resolved_content_root,
    ):
        raise R2CompilationProfileError("sealed R2 source manifest changed")
    digest = stable_hash(manifest, domain="flux-clone-r2-compilation-source-receipts-v1")
    return _sealed(digest, _SOURCE_RECEIPT_MANIFEST_SHA256, "source receipt manifest")


def build_r2_compilation_profile(
    graph: DesignGraph,
    *,
    human_plan_sha256: str,
    human_symbol_catalog_sha256: str,
    human_emission_sha256: str,
) -> R2CompilationProfile:
    """Build the sole reviewed R2 profile, rejecting any subject-side mutation."""

    if type(graph) is not DesignGraph:
        raise TypeError("R2 compilation profile requires an exact DesignGraph")
    if graph.project_id != PROJECT_ID or graph.project_id != "reference-usb-c-3v3-r2":
        raise R2CompilationProfileError("sealed R2 project ID changed")
    if graph.graph_hash != R2_GRAPH_SHA256:
        raise R2CompilationProfileError("sealed R2 graph changed")
    fab, courtyard, overhangs, assembly_catalog, assembly_placement = _build_assembly_records(graph)
    silk, silk_digest = _build_silkscreen_records(graph)
    emitted, omitted, model_catalog, emitted_digest, omitted_digest = _build_model_records()
    source_digest = _source_manifest_digest()
    evidence = CompilationProfileEvidence.create(
        profile_id=PROFILE_ID,
        profile_version=PROFILE_VERSION,
        subject_graph_sha256=graph.graph_hash,
        assembly_catalog_sha256=assembly_catalog,
        assembly_placement_sha256=assembly_placement,
        silkscreen_plan_sha256=silk_digest,
        model_catalog_sha256=model_catalog,
        model_emitted_manifest_sha256=emitted_digest,
        model_omitted_manifest_sha256=omitted_digest,
        model_emitted_count=len(emitted),
        model_omitted_count=len(omitted),
        human_plan_sha256=human_plan_sha256,
        human_symbol_catalog_sha256=human_symbol_catalog_sha256,
        human_emission_sha256=human_emission_sha256,
        source_receipt_manifest_sha256=source_digest,
    )
    return R2CompilationProfile(evidence, fab, courtyard, silk, emitted, omitted, overhangs)


__all__ = (
    "AssemblyArtworkRecord",
    "ModelRecord",
    "PROFILE_ID",
    "PROFILE_VERSION",
    "R2CompilationProfile",
    "R2CompilationProfileError",
    "SilkscreenRecord",
    "build_r2_compilation_profile",
)
