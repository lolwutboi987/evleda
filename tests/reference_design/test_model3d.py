"""Contracts for the isolated, fail-closed reference-board 3D model catalog."""

from __future__ import annotations

from dataclasses import replace
from hashlib import sha256
from pathlib import Path

import pytest

from backend.reference_design.model3d import (
    IDENTITY_TRANSFORM,
    KICAD10_3DMODEL_DIR,
    MODEL3D_BY_COMPONENT_ID,
    Model3DError,
    ModelConfidence,
    ModelStatus,
    ModelTransform,
    catalog,
    model_for_component_id,
    model_for_reference,
    model_root_from_environment,
    resolve_model,
)
from backend.reference_design.specification import components


def test_catalog_covers_all_23_exact_component_and_footprint_ids() -> None:
    expected = components()
    entries = catalog()
    assert len(entries) == len(expected) == 23
    assert tuple(entry.component_id for entry in entries) == tuple(
        component.component_id for component in expected
    )
    assert {
        (entry.component_id, entry.reference, entry.footprint_id, entry.source_sha256)
        for entry in entries
    } == {
        (
            component.component_id,
            component.reference,
            component.footprint_id,
            component.datasheet_sha256,
        )
        for component in expected
    }
    assert set(MODEL3D_BY_COMPONENT_ID) == {component.component_id for component in expected}


def test_all_renderable_models_are_portable_explicit_and_digest_pinned() -> None:
    for entry in catalog():
        assert entry.transform == IDENTITY_TRANSFORM
        assert entry.repository == "kicad/libraries/kicad-packages3d"
        assert len(entry.snapshot) == 40
        if entry.confidence is ModelConfidence.UNAVAILABLE:
            assert entry.kicad_reference is None
            assert entry.model_relative_path is None
            assert entry.model_sha256 is None
        else:
            model_path = entry.model_relative_path
            assert model_path is not None
            assert entry.kicad_reference == "${KICAD10_3DMODEL_DIR}/" + model_path
            assert model_path.endswith(".step")
            assert entry.model_sha256 is not None
            assert len(entry.model_sha256) == 64


def test_confidence_categories_and_known_exact_body_are_truthful() -> None:
    assert model_for_reference("J1").confidence is ModelConfidence.EXACT_COMPONENT
    assert model_for_reference("U1").confidence is ModelConfidence.PACKAGE_SPECIFIC_CASE
    assert model_for_reference("C3").confidence is ModelConfidence.PACKAGE_SPECIFIC_CASE
    assert model_for_reference("R1").confidence is ModelConfidence.PACKAGE_CLASS
    assert model_for_reference("C4").confidence is ModelConfidence.PACKAGE_CLASS


def test_u1_uses_only_the_reviewed_kicad10_filename_migration() -> None:
    u1 = model_for_reference("U1")
    assert u1.component_id == "efuse-u1"
    assert u1.footprint_id == "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm"
    assert u1.source_sha256 == (
        "66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9"
    )
    assert u1.model_relative_path == (
        "Package_SO.3dshapes/HTSOP-8-1EP_3.9x4.9mm_P1.27mm.step"
    )
    assert u1.model_sha256 == (
        "801dd3a2b815a7eb830be234b2f0a2c87fadd58bb8db7b1f2d50f17e9dcaf732"
    )
    assert u1.transform == IDENTITY_TRANSFORM
    assert "Reviewed filename migration" in (u1.reason or "")
    assert "does not establish exact component marking" in (u1.reason or "")


def test_u1_does_not_fall_back_to_the_missing_historical_filename(tmp_path: Path) -> None:
    u1 = model_for_reference("U1")
    current = tmp_path / "Package_SO.3dshapes" / "HTSOP-8-1EP_3.9x4.9mm_P1.27mm.step"
    current.parent.mkdir()
    current.write_bytes(b"current reviewed filename")

    historical_name = replace(
        u1,
        model_relative_path=(
            "Package_SO.3dshapes/HTSOP-8-1EP_3.9x4.9mm_Pitch1.27mm.step"
        ),
        model_sha256=sha256(current.read_bytes()).hexdigest(),
    )
    receipt = resolve_model(historical_name, tmp_path)
    assert receipt.status is ModelStatus.MISSING_FILE
    assert receipt.path is None


@pytest.mark.parametrize(
    "component_id",
    ("ldo-u2", "tvs-d1", "cout-esr-r9", "tp-1", "tp-2", "tp-3", "tp-4"),
)
def test_no_unsafe_substitution_for_missing_bodies(component_id: str, tmp_path: Path) -> None:
    binding = model_for_component_id(component_id)
    receipt = resolve_model(binding, tmp_path)
    assert binding.confidence is ModelConfidence.UNAVAILABLE
    assert binding.kicad_reference is None
    assert receipt.status is ModelStatus.UNAVAILABLE
    assert receipt.path is None
    assert receipt.diagnostic is not None


def test_missing_u2_and_r9_do_not_accept_generic_lookalikes() -> None:
    u2 = model_for_reference("U2")
    r9 = model_for_reference("R9")
    assert "SOT-223-8" in (u2.reason or "")
    assert "generic R0603" in (r9.reason or "")
    assert u2.footprint_id == "Package_TO_SOT_SMD:SOT-223-5_TabPin5"
    assert r9.footprint_id == "Resistor_SMD:R_0603_1608Metric"


def test_exact_lookup_rejects_unknown_component_and_reference() -> None:
    with pytest.raises(KeyError, match="unknown reference-board component ID"):
        model_for_component_id("not-a-component")
    with pytest.raises(KeyError, match="unknown reference-board reference"):
        model_for_reference("X1")


def test_model_root_uses_only_the_portable_kicad_variable(tmp_path: Path) -> None:
    assert model_root_from_environment({KICAD10_3DMODEL_DIR: str(tmp_path)}) == tmp_path
    with pytest.raises(Model3DError, match="is required"):
        model_root_from_environment({})
    with pytest.raises(Model3DError, match="absolute path"):
        model_root_from_environment({KICAD10_3DMODEL_DIR: "relative-model-root"})


def test_resolver_requires_the_exact_path_and_digest(tmp_path: Path) -> None:
    body = b"approved model bytes"
    path = tmp_path / "Fixture.3dshapes" / "body.step"
    path.parent.mkdir()
    path.write_bytes(body)
    fixture = replace(
        model_for_reference("J1"),
        model_relative_path="Fixture.3dshapes/body.step",
        model_sha256=sha256(body).hexdigest(),
    )
    available = resolve_model(fixture, tmp_path)
    assert available.status is ModelStatus.AVAILABLE
    assert available.path == path.resolve()
    assert available.kicad_reference == "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step"

    path.write_bytes(b"changed model bytes")
    mismatched = resolve_model(fixture, tmp_path)
    assert mismatched.status is ModelStatus.DIGEST_MISMATCH
    assert mismatched.path is None

    missing = resolve_model(
        replace(fixture, model_relative_path="Fixture.3dshapes/missing.step"), tmp_path
    )
    assert missing.status is ModelStatus.MISSING_FILE
    assert missing.path is None


@pytest.mark.parametrize(
    "kwargs",
    (
        {"model_relative_path": "../outside.step"},
        {"model_relative_path": "Fixture.3dshapes\\body.step"},
        {"model_relative_path": "Fixture.3dshapes/body.obj"},
        {"model_sha256": "A" * 64},
    ),
)
def test_binding_rejects_unsafe_paths_and_noncanonical_digests(kwargs: dict[str, str]) -> None:
    original = model_for_reference("J1")
    with pytest.raises(Model3DError):
        replace(original, **kwargs)


@pytest.mark.parametrize(
    ("offset_mm", "scale"),
    (
        ((float("inf"), 0.0, 0.0), (1.0, 1.0, 1.0)),
        ((0.0, 0.0, 0.0), (0.0, 1.0, 1.0)),
    ),
)
def test_transform_rejects_nonfinite_or_nonpositive_values(
    offset_mm: tuple[float, float, float], scale: tuple[float, float, float]
) -> None:
    with pytest.raises(Model3DError):
        ModelTransform(offset_mm=offset_mm, scale=scale)
