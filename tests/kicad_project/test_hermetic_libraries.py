from __future__ import annotations

from dataclasses import FrozenInstanceError, replace

import pytest

from backend.kicad_io import PointNm
from backend.kicad_project import (
    BundleLimits,
    ProjectAuxiliaryFile,
    ProjectBundleInput,
    ProjectInvariantError,
    ProjectSyntaxError,
    export_project_bundle,
    import_project_bundle,
    parse_hermetic_project_libraries,
    round_trip_project_bundle,
)

from .test_bundle import supported_source


def _file(name: str, payload: bytes = b"x") -> ProjectAuxiliaryFile:
    return ProjectAuxiliaryFile(name, "application/octet-stream", payload)


def _hermetic_files() -> tuple[ProjectAuxiliaryFile, ...]:
    table = (
        b'(lib (name "FluxGenerated")(type "KiCad")(uri "URI")'
        b'(options "")(descr ""))'
    )
    files = (
        _file(
            "FluxGenerated.kicad_sym",
            b'(kicad_symbol_lib (version 20240529)(generator "flux_clone")'
            b'(generator_version "10.0"))',
        ),
        _file(
            "FluxGenerated.pretty/fp_one.kicad_mod",
            b'(footprint "fp_one" (version 20240108)(generator "flux_clone")'
            b'(generator_version "10.0")(layer "F.Cu")'
            b'(pad "1" smd rect (at 0 0)(size 1 1)(layers "F.Cu")'
            b'(uuid "00000000-0000-4000-8000-000000000001")))',
        ),
        _file(
            "fp-lib-table",
            b'(fp_lib_table (version 7)'
            + table.replace(b"URI", b"${KIPRJMOD}/FluxGenerated.pretty")
            + b")",
        ),
        _file(
            "sym-lib-table",
            b'(sym_lib_table (version 7)'
            + table.replace(b"URI", b"${KIPRJMOD}/FluxGenerated.kicad_sym")
            + b")",
        ),
    )
    return tuple(
        sorted(files, key=lambda item: (item.relative_name.casefold(), item.relative_name))
    )


def _with_module(payload: bytes) -> tuple[ProjectAuxiliaryFile, ...]:
    return tuple(
        replace(item, payload=payload)
        if item.relative_name == "FluxGenerated.pretty/fp_one.kicad_mod"
        else item
        for item in _hermetic_files()
    )


def _presentation_module() -> bytes:
    return b"""(footprint "fp_one"
      (version 20240108)(generator "flux_clone")(generator_version "10.0")
      (layer "F.Cu")
      (fp_line (start -1 0)(end 1 0)
        (stroke (width 0.1)(type default))(layer "F.Fab")
        (uuid 00000000-0000-4000-8000-000000000010))
      (model "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step"
        (offset (xyz -1.25 0 2))(scale (xyz 1 2 0.5))(rotate (xyz 0 -90 45)))
      (fp_text user "REF" (at 0 -2 90)(layer "F.SilkS")
        (effects (font (size 1 0.8)(thickness 0.15)))
        (uuid 00000000-0000-4000-8000-000000000011))
      (fp_rect (start -2 -1)(end 2 1)
        (stroke (width 0.05)(type dash))(fill none)(layer "F.CrtYd")
        (uuid 00000000-0000-4000-8000-000000000012))
      (fp_poly (pts (xy -1 -1)(xy 1 -1)(xy 0 1))
        (stroke (width 0.1)(type solid))(fill solid)(layer "F.Fab")
        (uuid 00000000-0000-4000-8000-000000000013))
      (pad "1" smd rect (at 0 0)(size 1 1)(layers "F.Cu")
        (uuid 00000000-0000-4000-8000-000000000001)))"""


@pytest.mark.parametrize(
    "name",
    (
        "../escape",
        "/absolute",
        r"folder\file",
        "C:/drive",
        "folder/./file",
        "folder/../file",
        "CON",
        "aux.txt",
        "LPT9.kicad_mod",
        "segment.",
        "segment ",
    ),
)
def test_auxiliary_names_reject_portability_and_windows_alias_hazards(name: str) -> None:
    with pytest.raises(ProjectInvariantError):
        _file(name)


def test_bundle_rejects_casefold_collisions_primary_shadows_and_runtime_prl() -> None:
    with pytest.raises(ProjectInvariantError, match="case-insensitively"):
        ProjectBundleInput(
            "demo",
            b"{}",
            b"()",
            b"()",
            (_file("A"), _file("a")),
        )
    with pytest.raises(ProjectInvariantError, match="case-insensitively"):
        ProjectBundleInput(
            "demo",
            b"{}",
            b"()",
            b"()",
            (_file("DEMO.KICAD_PCB"),),
        )
    with pytest.raises(ProjectInvariantError, match="runtime support"):
        ProjectBundleInput(
            "demo",
            b"{}",
            b"()",
            b"()",
            (_file("demo.kicad_prl"),),
        )


def test_all_files_is_complete_deterministic_and_digest_bound() -> None:
    source = ProjectBundleInput(
        "demo",
        b"project",
        b"schematic",
        b"board",
        (
            _file("FluxGenerated.kicad_sym", b"symbols"),
            _file("fp-lib-table", b"fp"),
            _file("sym-lib-table", b"sym"),
        ),
    )
    assert tuple(item.relative_name for item in source.all_files) == (
        "demo.kicad_pcb",
        "demo.kicad_pro",
        "demo.kicad_sch",
        "FluxGenerated.kicad_sym",
        "fp-lib-table",
        "sym-lib-table",
    )
    changed = replace(
        source,
        auxiliary_files=(
            replace(source.auxiliary_files[0], payload=b"changed"),
            *source.auxiliary_files[1:],
        ),
    )
    assert changed.auxiliary_manifest_sha256 != source.auxiliary_manifest_sha256


def test_auxiliary_limits_cover_count_per_file_auxiliary_and_total_bytes() -> None:
    source = ProjectBundleInput(
        "demo",
        b"p",
        b"s",
        b"b",
        (_file("one", b"1234"), _file("two", b"5678")),
    )
    with pytest.raises(ProjectSyntaxError, match="count"):
        import_project_bundle(
            source, limits=replace(BundleLimits(), maximum_auxiliary_file_count=1)
        )
    with pytest.raises(ProjectSyntaxError, match="per-file"):
        import_project_bundle(
            source, limits=replace(BundleLimits(), maximum_auxiliary_file_bytes=3)
        )
    with pytest.raises(ProjectSyntaxError, match="aggregate auxiliary"):
        import_project_bundle(
            source, limits=replace(BundleLimits(), maximum_auxiliary_total_bytes=7)
        )
    with pytest.raises(ProjectSyntaxError, match="aggregate limit"):
        import_project_bundle(
            source, limits=replace(BundleLimits(), maximum_total_bytes=10)
        )


def test_project_import_export_round_trip_carries_hermetic_auxiliaries_exactly() -> None:
    files = _hermetic_files()
    parse_hermetic_project_libraries(files)
    source = replace(supported_source(), auxiliary_files=files)
    imported = import_project_bundle(source)
    assert imported.bundle.auxiliary_files == files
    assert imported.evidence.auxiliary_source_manifest_sha256 == (
        source.auxiliary_manifest_sha256
    )
    exported = export_project_bundle(imported.bundle)
    assert exported.payload.auxiliary_files == files
    assert exported.evidence.auxiliary_source_manifest_sha256 == (
        source.auxiliary_manifest_sha256
    )
    round_trip = round_trip_project_bundle(source)
    assert round_trip.evidence.auxiliary_files_parity
    assert round_trip.exported.payload.auxiliary_files == files


def test_footprint_presentation_is_typed_fixed_point_and_source_ordered() -> None:
    libraries = parse_hermetic_project_libraries(_with_module(_presentation_module()))
    module = libraries.footprint_modules[0]
    assert tuple(item.kind for item in module.graphics) == (
        "fp_line",
        "fp_text",
        "fp_rect",
        "fp_poly",
    )
    assert tuple(item.layer for item in module.graphics) == (
        "F.Fab",
        "F.SilkS",
        "F.CrtYd",
        "F.Fab",
    )
    assert module.graphics[0].points_nm == (
        PointNm(-1_000_000, 0),
        PointNm(1_000_000, 0),
    )
    assert module.graphics[1].rotation_udeg == 90_000_000
    assert module.graphics[1].font_size_nm == (1_000_000, 800_000)
    assert module.graphics[2].stroke_type == "dash"
    assert module.graphics[2].fill_type == "none"
    assert module.graphics[3].fill_type == "solid"
    assert module.graphics[0].uuid == "00000000-0000-4000-8000-000000000010"

    assert len(module.models) == 1
    model = module.models[0]
    assert model.path == "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step"
    assert model.offset_nm == (-1_250_000, 0, 2_000_000)
    assert model.scale_ppm == (1_000_000, 2_000_000, 500_000)
    assert model.rotate_udeg == (0, -90_000_000, 45_000_000)
    with pytest.raises(FrozenInstanceError):
        model.path = "changed.step"  # type: ignore[misc]


def test_presentation_module_round_trip_retains_exact_bytes_and_order() -> None:
    files = _with_module(_presentation_module())
    source = replace(supported_source(), auxiliary_files=files)
    round_trip = round_trip_project_bundle(source)
    assert round_trip.evidence.auxiliary_files_parity
    assert round_trip.exported.payload.auxiliary_files == files
    reparsed = parse_hermetic_project_libraries(
        round_trip.reparsed.bundle.auxiliary_files
    ).footprint_modules[0]
    assert tuple(item.kind for item in reparsed.graphics) == (
        "fp_line",
        "fp_text",
        "fp_rect",
        "fp_poly",
    )
    assert tuple(item.path for item in reparsed.models) == (
        "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step",
    )


@pytest.mark.parametrize(
    "path",
    (
        "Fixture.3dshapes/body.step",
        "${KICAD10_3DMODEL_DIR}/../body.step",
        "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes\\body.step",
        "${KICAD10_3DMODEL_DIR}//absolute.step",
        "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.obj",
        "${KICAD9_3DMODEL_DIR}/Fixture.3dshapes/body.step",
    ),
)
def test_model_references_reject_nonportable_paths(path: str) -> None:
    mutated = _presentation_module().replace(
        b"${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step",
        path.replace("\\", "\\\\").encode(),
    )
    with pytest.raises(ProjectInvariantError, match="model path"):
        parse_hermetic_project_libraries(_with_module(mutated))


@pytest.mark.parametrize(
    ("old", "new", "message"),
    (
        (b"(offset (xyz -1.25 0 2))", b"(offset (xyz 0 0))", "three"),
        (b"(scale (xyz 1 2 0.5))", b"(scale (xyz 1 0 1))", "positive"),
        (b"(rotate (xyz 0 -90 45))", b"(rotate (xyz 0 nan 0))", "decimal"),
        (b"(rotate (xyz 0 -90 45))", b"(rotate (xyz 0 360 0))", "one turn"),
        (b"(scale (xyz 1 2 0.5))", b"(scale (xyz 1 1 1))(scale (xyz 1 1 1))", "one scale"),
    ),
)
def test_model_references_reject_malformed_or_duplicate_transforms(
    old: bytes, new: bytes, message: str
) -> None:
    with pytest.raises(ProjectInvariantError, match=message):
        parse_hermetic_project_libraries(
            _with_module(_presentation_module().replace(old, new))
        )


@pytest.mark.parametrize(
    ("old", "new", "message"),
    (
        (b"(type default)", b"(type custom)", "stroke type"),
        (b"(fill none)", b"(fill hatch)", "fill type"),
        (b"(width 0.1)", b"(width -0.1)", "cannot be negative"),
        (b'(layer "F.Fab")', b'(layer "F.SilkS")', "limited to footprint text"),
        (
            b"(uuid 00000000-0000-4000-8000-000000000013)",
            b"(uuid 00000000-0000-4000-8000-000000000010)",
            "UUIDs must be unique",
        ),
        (b"(fp_line", b"(fp_arc", "unreviewed"),
    ),
)
def test_graphics_reject_unreviewed_mutations(
    old: bytes, new: bytes, message: str
) -> None:
    with pytest.raises(ProjectInvariantError, match=message):
        parse_hermetic_project_libraries(
            _with_module(_presentation_module().replace(old, new, 1))
        )


def test_duplicate_model_paths_are_rejected_even_with_distinct_transforms() -> None:
    model = (
        b'(model "${KICAD10_3DMODEL_DIR}/Fixture.3dshapes/body.step"'
        b"(offset (xyz 0 0 0))(scale (xyz 1 1 1))(rotate (xyz 0 0 0)))"
    )
    mutated = _presentation_module().replace(
        b"(fp_text user", model + b"(fp_text user"
    )
    with pytest.raises(ProjectInvariantError, match="model paths must be unique"):
        parse_hermetic_project_libraries(_with_module(mutated))
