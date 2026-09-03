"""Isolated, source-backed assembly geometry for the frozen reference R2 BOM.

The canonical electrical graph deliberately does not model fabrication or
assembly artwork.  This module is an auditable sidecar: it records the local
F.Fab body, F.CrtYd/occupied-area envelope, and source orientation information
for every fitted R2 component.  It neither changes the graph nor emits KiCad
files.  In particular, it contains no 3D model claim or path.

Direct outlines are copied from the cited pinned KiCad footprint or
manufacturer document.  Where a manufacturer supplies a body and lands but no
courtyard, the corresponding outline is explicitly marked ``derived`` and is
limited to the documented body/land envelope under ``REFERENCE_COURTYARD_POLICY``.
It must not be presented as an assembler-approved courtyard.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Literal, cast

from .specification import KICAD_FOOTPRINT_COMMIT, KICAD_USB4105_FOOTPRINT_SHA256

NM_PER_MM = 1_000_000

Point = tuple[int, int]
Bounds = tuple[int, int, int, int]
SourceKind = Literal["pinned-kicad-footprint", "manufacturer-document"]
DimensionStatus = Literal["direct", "derived"]
OrientationRole = Literal["pin-one", "polarity", "none"]
OrientationFeature = Literal["fab-chamfer", "terminal-map", "polarity-end-view", "none"]
_SOURCE_KINDS = frozenset(("pinned-kicad-footprint", "manufacturer-document"))
_DIMENSION_STATUSES = frozenset(("direct", "derived"))
_OUTLINE_LAYERS = frozenset(("F.Fab", "F.CrtYd"))
_OUTLINE_ROLES = frozenset(("body", "courtyard"))
_ORIENTATION_ROLES = frozenset(("pin-one", "polarity", "none"))
_ORIENTATION_FEATURES = frozenset(("fab-chamfer", "terminal-map", "polarity-end-view", "none"))
_COLLISION_AXES = frozenset(("x", "y"))
REFERENCE_COMPONENT_COUNT = 23


class AssemblyGeometryProvenanceError(ValueError):
    """Raised when a profile is unknown or its frozen identity does not match."""


def _require_text(value: object, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")


def _require_literal(value: object, label: str, allowed: frozenset[str]) -> None:
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"{label} is unsupported")


def _require_int(value: object, label: str, *, minimum: int | None = None) -> None:
    if type(value) is not int:
        raise ValueError(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        raise ValueError(f"{label} must be at least {minimum}")


def _validate_point(point: object, label: str) -> Point:
    if not isinstance(point, tuple):
        raise ValueError(f"{label} must be an exact integer-nm point")
    values = cast(tuple[object, ...], point)
    if len(values) != 2:
        raise ValueError(f"{label} must be an exact integer-nm point")
    x_nm, y_nm = values
    _require_int(x_nm, f"{label}.x")
    _require_int(y_nm, f"{label}.y")
    return cast(int, x_nm), cast(int, y_nm)


def _validate_bounds(bounds: object, label: str) -> Bounds:
    if not isinstance(bounds, tuple):
        raise ValueError(f"{label} must be a four-integer bounding box")
    values = cast(tuple[object, ...], bounds)
    if len(values) != 4:
        raise ValueError(f"{label} must be a four-integer bounding box")
    left, top, right, bottom = values
    _require_int(left, f"{label}.left")
    _require_int(top, f"{label}.top")
    _require_int(right, f"{label}.right")
    _require_int(bottom, f"{label}.bottom")
    left_nm = cast(int, left)
    top_nm = cast(int, top)
    right_nm = cast(int, right)
    bottom_nm = cast(int, bottom)
    if left_nm >= right_nm or top_nm >= bottom_nm:
        raise ValueError(f"{label} must have positive area")
    return left_nm, top_nm, right_nm, bottom_nm


def _bounds(points: tuple[Point, ...]) -> Bounds:
    return (
        min(point[0] for point in points),
        min(point[1] for point in points),
        max(point[0] for point in points),
        max(point[1] for point in points),
    )


@dataclass(frozen=True, slots=True)
class GeometrySource:
    """One official or pinned source that authorizes a geometry record."""

    kind: SourceKind
    publisher: str
    revision: str
    locator: str
    sha256: str

    def __post_init__(self) -> None:
        _require_literal(self.kind, "assembly geometry source kind", _SOURCE_KINDS)
        _require_text(self.publisher, "assembly geometry source publisher")
        _require_text(self.revision, "assembly geometry source revision")
        _require_text(self.locator, "assembly geometry source locator")
        _require_text(self.sha256, "assembly geometry source digest")
        if len(self.sha256) != 64 or set(self.sha256) - set("0123456789abcdef"):
            raise ValueError("assembly geometry source digest must be SHA-256")


@dataclass(frozen=True, slots=True)
class Outline:
    """One closed local outline with an explicit direct/derived disposition."""

    layer: Literal["F.Fab", "F.CrtYd"]
    role: Literal["body", "courtyard"]
    vertices: tuple[Point, ...]
    stroke_nm: int
    status: DimensionStatus
    derivation: str | None = None

    def __post_init__(self) -> None:
        _require_literal(self.layer, "assembly outline layer", _OUTLINE_LAYERS)
        _require_literal(self.role, "assembly outline role", _OUTLINE_ROLES)
        _require_literal(self.status, "assembly outline dimension status", _DIMENSION_STATUSES)
        _require_int(self.stroke_nm, "assembly outline stroke", minimum=1)
        if type(self.vertices) is not tuple or len(self.vertices) < 4:
            raise ValueError("assembly outline requires at least three closed edges")
        points = tuple(
            _validate_point(point, f"assembly outline vertex {index}")
            for index, point in enumerate(self.vertices)
        )
        if points[0] != points[-1]:
            raise ValueError("assembly outline must be a closed polygon")
        open_points = points[:-1]
        if len(set(open_points)) != len(open_points):
            raise ValueError("assembly outline cannot repeat a non-closing vertex")
        if any(start == end for start, end in zip(points, points[1:], strict=False)):
            raise ValueError("assembly outline cannot contain a zero-length edge")
        if _polygon_self_intersects(open_points):
            raise ValueError("assembly outline cannot self-intersect")
        if _signed_area_twice(open_points) == 0:
            raise ValueError("assembly outline must have nonzero area")
        if self.status == "derived":
            _require_text(self.derivation, "derived assembly outline derivation")
        if self.status == "direct" and self.derivation is not None:
            raise ValueError("direct assembly outline must not imply a derivation")

    @property
    def bounds_nm(self) -> Bounds:
        return _bounds(self.vertices)


@dataclass(frozen=True, slots=True)
class OrientationMark:
    """Source-backed pin-one or polarity semantics associated with a profile."""

    role: OrientationRole
    status: DimensionStatus
    description: str
    feature: OrientationFeature
    local_anchor_nm: Point | None = None

    def __post_init__(self) -> None:
        _require_literal(self.role, "assembly orientation mark role", _ORIENTATION_ROLES)
        _require_literal(self.status, "assembly orientation mark status", _DIMENSION_STATUSES)
        _require_text(self.description, "assembly orientation mark description")
        _require_literal(self.feature, "assembly orientation mark feature", _ORIENTATION_FEATURES)
        if self.role == "none" and self.feature != "none":
            raise ValueError("an absent orientation mark cannot name a feature")
        if self.role != "none" and self.feature == "none":
            raise ValueError("a source orientation mark requires a feature")
        if self.role == "none" and self.local_anchor_nm is not None:
            raise ValueError("an absent orientation mark cannot have an anchor")
        if self.role != "none" and self.local_anchor_nm is None:
            raise ValueError("a source orientation mark requires an anchor")
        if self.local_anchor_nm is not None:
            _validate_point(self.local_anchor_nm, "assembly orientation mark anchor")


@dataclass(frozen=True, slots=True)
class FootprintProfile:
    """A local F.Fab/F.CrtYd profile shared by one or more R2 components."""

    profile_id: str
    footprint_id: str
    sources: tuple[GeometrySource, ...]
    fab_outline: Outline
    courtyard_outline: Outline
    orientation_mark: OrientationMark
    permits_board_edge_overhang: bool = False

    def __post_init__(self) -> None:
        _require_text(self.profile_id, "assembly profile ID")
        _require_text(self.footprint_id, "assembly footprint ID")
        if type(self.sources) is not tuple or not self.sources:
            raise ValueError("assembly profile requires an immutable source tuple")
        if any(type(source) is not GeometrySource for source in self.sources):
            raise ValueError("assembly profile sources must be GeometrySource records")
        receipts = tuple(
            (source.kind, source.publisher, source.revision, source.locator, source.sha256)
            for source in self.sources
        )
        if len(receipts) != len(set(receipts)):
            raise ValueError("assembly profile cannot repeat a source receipt")
        if type(self.fab_outline) is not Outline or type(self.courtyard_outline) is not Outline:
            raise ValueError("assembly profile outlines must be Outline records")
        if type(self.orientation_mark) is not OrientationMark:
            raise ValueError("assembly profile orientation mark must be an OrientationMark")
        if self.fab_outline.layer != "F.Fab" or self.fab_outline.role != "body":
            raise ValueError("assembly profile body must be an F.Fab outline")
        if self.courtyard_outline.layer != "F.CrtYd" or self.courtyard_outline.role != "courtyard":
            raise ValueError("assembly profile courtyard must be an F.CrtYd outline")
        if type(self.permits_board_edge_overhang) is not bool:
            raise ValueError("assembly board-edge-overhang permission must be boolean")
        _validate_orientation_anchor(self)


@dataclass(frozen=True, slots=True)
class ReferenceProfileRecord:
    """One of the 23 frozen R2 component-to-profile bindings."""

    component_id: str
    reference: str
    footprint_id: str
    profile_id: str

    def __post_init__(self) -> None:
        _require_text(self.component_id, "reference component ID")
        _require_text(self.reference, "reference designator")
        _require_text(self.footprint_id, "reference footprint ID")
        _require_text(self.profile_id, "reference profile ID")


@dataclass(frozen=True, slots=True)
class AssemblyPlacement:
    """Minimal immutable placement data for deterministic outline transforms."""

    subject_id: str
    footprint_id: str
    x_nm: int
    y_nm: int
    rotation_udeg: int

    def __post_init__(self) -> None:
        _require_text(self.subject_id, "assembly placement subject ID")
        _require_text(self.footprint_id, "assembly placement footprint ID")
        _require_int(self.x_nm, "assembly placement x")
        _require_int(self.y_nm, "assembly placement y")
        _require_int(self.rotation_udeg, "assembly placement rotation")
        if self.rotation_udeg not in {0, 90_000_000, 180_000_000, 270_000_000}:
            raise ValueError("assembly geometry supports exact quadrant rotations only")


@dataclass(frozen=True, slots=True)
class PlacedProfile:
    """A resolved local profile at a frozen board placement."""

    placement: AssemblyPlacement
    profile: FootprintProfile
    courtyard_bounds_nm: Bounds

    def __post_init__(self) -> None:
        if type(self.placement) is not AssemblyPlacement:
            raise ValueError("placed assembly profile requires an AssemblyPlacement")
        if type(self.profile) is not FootprintProfile:
            raise ValueError("placed assembly profile requires a FootprintProfile")
        if self.placement.footprint_id != self.profile.footprint_id:
            raise ValueError("placed assembly profile footprint must match the resolved profile")
        _validate_bounds(self.courtyard_bounds_nm, "placed assembly courtyard bounds")


@dataclass(frozen=True, slots=True)
class CourtyardClearancePolicy:
    """Explicit comparison policy for source and source-derived envelopes.

    Zero minimum clearance means edge-touching is allowed.  The policy reports
    only overlapping positive area; it never moves a component or upgrades a
    derived manufacturer envelope to an approved assembly courtyard.
    """

    minimum_clearance_nm: int
    permit_profile_board_edge_overhang: bool

    def __post_init__(self) -> None:
        _require_int(self.minimum_clearance_nm, "courtyard minimum clearance", minimum=0)
        if type(self.permit_profile_board_edge_overhang) is not bool:
            raise ValueError("courtyard board-edge-overhang permission must be boolean")


@dataclass(frozen=True, slots=True)
class CourtyardCollision:
    """A pairwise ordinary-placement collision under the explicit policy."""

    first_subject_id: str
    second_subject_id: str
    first_profile_id: str
    second_profile_id: str
    overlap_x_nm: int
    overlap_y_nm: int
    required_translation_nm: int
    translation_axis: Literal["x", "y"]

    def __post_init__(self) -> None:
        for value, label in (
            (self.first_subject_id, "first collision subject ID"),
            (self.second_subject_id, "second collision subject ID"),
            (self.first_profile_id, "first collision profile ID"),
            (self.second_profile_id, "second collision profile ID"),
        ):
            _require_text(value, label)
        if self.first_subject_id == self.second_subject_id:
            raise ValueError("courtyard collision subjects must be distinct")
        for value, label in (
            (self.overlap_x_nm, "courtyard collision x overlap"),
            (self.overlap_y_nm, "courtyard collision y overlap"),
            (self.required_translation_nm, "courtyard collision translation"),
        ):
            _require_int(value, label, minimum=0)
        _require_literal(self.translation_axis, "courtyard collision axis", _COLLISION_AXES)


@dataclass(frozen=True, slots=True)
class BoardOverhang:
    """A transformed courtyard extending beyond the nominal board boundary."""

    subject_id: str
    profile_id: str
    bounds_nm: Bounds
    permitted: bool

    def __post_init__(self) -> None:
        _require_text(self.subject_id, "board overhang subject ID")
        _require_text(self.profile_id, "board overhang profile ID")
        _validate_bounds(self.bounds_nm, "board overhang bounds")
        if type(self.permitted) is not bool:
            raise ValueError("board overhang permission must be boolean")


def _signed_area_twice(points: tuple[Point, ...]) -> int:
    return sum(
        first[0] * second[1] - second[0] * first[1]
        for first, second in zip(points, points[1:] + points[:1], strict=True)
    )


def _orientation(first: Point, second: Point, third: Point) -> int:
    cross = (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (
        third[0] - first[0]
    )
    return (cross > 0) - (cross < 0)


def _on_segment(point: Point, start: Point, end: Point) -> bool:
    return (
        _orientation(start, end, point) == 0
        and min(start[0], end[0]) <= point[0] <= max(start[0], end[0])
        and min(start[1], end[1]) <= point[1] <= max(start[1], end[1])
    )


def _segments_intersect(
    first_start: Point, first_end: Point, second_start: Point, second_end: Point
) -> bool:
    orientations = (
        _orientation(first_start, first_end, second_start),
        _orientation(first_start, first_end, second_end),
        _orientation(second_start, second_end, first_start),
        _orientation(second_start, second_end, first_end),
    )
    if orientations[0] * orientations[1] < 0 and orientations[2] * orientations[3] < 0:
        return True
    return (
        (orientations[0] == 0 and _on_segment(second_start, first_start, first_end))
        or (orientations[1] == 0 and _on_segment(second_end, first_start, first_end))
        or (orientations[2] == 0 and _on_segment(first_start, second_start, second_end))
        or (orientations[3] == 0 and _on_segment(first_end, second_start, second_end))
    )


def _polygon_self_intersects(points: tuple[Point, ...]) -> bool:
    edge_count = len(points)
    for first_index in range(edge_count):
        first_start = points[first_index]
        first_end = points[(first_index + 1) % edge_count]
        for second_index in range(first_index + 1, edge_count):
            if second_index in {first_index + 1, (first_index - 1) % edge_count}:
                continue
            if first_index == 0 and second_index == edge_count - 1:
                continue
            second_start = points[second_index]
            second_end = points[(second_index + 1) % edge_count]
            if _segments_intersect(first_start, first_end, second_start, second_end):
                return True
    return False


def _point_in_bounds(point: Point, bounds: Bounds) -> bool:
    left, top, right, bottom = bounds
    return left <= point[0] <= right and top <= point[1] <= bottom


def _validate_orientation_anchor(profile: FootprintProfile) -> None:
    mark = profile.orientation_mark
    if mark.role == "none":
        return
    assert mark.local_anchor_nm is not None
    anchor = mark.local_anchor_nm
    if mark.feature == "fab-chamfer" and anchor not in profile.fab_outline.vertices:
        raise ValueError("a fab-chamfer orientation anchor must be a body-outline vertex")
    if mark.feature in {"terminal-map", "polarity-end-view"} and not _point_in_bounds(
        anchor, profile.courtyard_outline.bounds_nm
    ):
        raise ValueError("a terminal-map orientation anchor must lie in the source courtyard")


REFERENCE_COURTYARD_POLICY = CourtyardClearancePolicy(
    minimum_clearance_nm=0,
    permit_profile_board_edge_overhang=True,
)


def _source(
    path: str,
    sha256: str,
    *,
    publisher: str = "kicad/libraries/kicad-footprints",
    revision: str = KICAD_FOOTPRINT_COMMIT,
    kind: SourceKind = "pinned-kicad-footprint",
) -> GeometrySource:
    return GeometrySource(kind, publisher, revision, path, sha256)


def _rect(
    left: int,
    top: int,
    right: int,
    bottom: int,
    layer: Literal["F.Fab", "F.CrtYd"],
    role: Literal["body", "courtyard"],
    stroke_nm: int,
    status: DimensionStatus = "direct",
    derivation: str | None = None,
) -> Outline:
    _require_int(left, "assembly rectangle left")
    _require_int(top, "assembly rectangle top")
    _require_int(right, "assembly rectangle right")
    _require_int(bottom, "assembly rectangle bottom")
    if left >= right or top >= bottom:
        raise ValueError("assembly rectangle must have ordered, nonzero area")
    return Outline(
        layer,
        role,
        ((left, top), (right, top), (right, bottom), (left, bottom), (left, top)),
        stroke_nm,
        status,
        derivation,
    )


def _polygon(
    vertices: tuple[Point, ...],
    layer: Literal["F.Fab", "F.CrtYd"],
    role: Literal["body", "courtyard"],
    stroke_nm: int,
) -> Outline:
    return Outline(layer, role, vertices, stroke_nm, "direct")


_PTVS = _source(
    "PTVS5V5Z1UPC.pdf",
    "dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1",
    publisher="Nexperia",
    revision="v1-2024-10-28",
    kind="manufacturer-document",
)
_LP38692 = _source(
    "LP38692 datasheet, NDC0005A package drawing, page 31",
    "37d312bc1c8189f8fe4275ceaf8928d447cb6faaa2796e503d6120a891376352",
    publisher="Texas Instruments",
    revision="SNVS322M Rev M, December 2015",
    kind="manufacturer-document",
)
_T598 = _source(
    "T2073_T59X.pdf, pages 8 and 22",
    "64cc7925483d23bc88a92c0dde3bba58e60152765bed5602f859c04c0c5db729",
    publisher="KEMET/YAGEO",
    revision="T2073_T59X-2025-11-05",
    kind="manufacturer-document",
)
_WSLP = _source(
    "WSLP.pdf, page 2",
    "5d20b5572767451d6a38e1e37c6f0f3113eb604e72593a6cd97a0a944458455b",
    publisher="Vishay Dale",
    revision="document-30122-2024-09-09",
    kind="manufacturer-document",
)
_C1206_FAMILY = _source(
    "KEM C1003 C0G SMD family data sheet, IPC-7351 density-B table",
    "02d179914aeb9585eb2229ba8e18ef9d6b01c77c056de2af295d6950a2a5cc0d",
    publisher="KEMET/YAGEO",
    revision="2025-02-20",
    kind="manufacturer-document",
)
_C1206_MPN = _source(
    "C1206C104J3GACTU exact-MPN specification sheet",
    "dbafe0002fa3f302ec182bbe37f000f47190256b73ee7c10b8066a55df835609",
    publisher="KEMET/YAGEO",
    revision="C1206C104J3GACTU",
    kind="manufacturer-document",
)

# The source profile table contains all 12 distinct footprint IDs used by the
# 23 fitted R2 components.  Source-derived courtyards have zero extra margin:
# they are occupied-area checks, not synthetic assembly clearance claims.
_PROFILES = (
    FootprintProfile(
        "usb4105",
        "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",
        (
            _source(
                "Connector_USB.pretty/USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod",
                KICAD_USB4105_FOOTPRINT_SHA256,
            ),
        ),
        _rect(-4_470_000, -3_675_000, 4_470_000, 3_675_000, "F.Fab", "body", 100_000),
        _rect(-5_320_000, -4_760_000, 5_320_000, 4_180_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark("none", "direct", "USB-C contacts use named A/B pin identities.", "none"),
        permits_board_edge_overhang=True,
    ),
    FootprintProfile(
        "tps259620_dda",
        "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm",
        (
            _source(
                "Package_SO.pretty/Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm.kicad_mod",
                "a2de8e28dd9f6a17dc2592de4c8500ac34f85d12e9e90e9c6499dc9de4937d91",
            ),
        ),
        _polygon(
            (
                (-1_950_000, -1_450_000),
                (-950_000, -2_450_000),
                (1_950_000, -2_450_000),
                (1_950_000, 2_450_000),
                (-1_950_000, 2_450_000),
                (-1_950_000, -1_450_000),
            ),
            "F.Fab",
            "body",
            150_000,
        ),
        _rect(-3_750_000, -2_750_000, 3_750_000, 2_750_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "pin-one",
            "direct",
            "Pinned KiCad F.Fab upper-left chamfer indicates pin 1.",
            "fab-chamfer",
            (-950_000, -2_450_000),
        ),
    ),
    FootprintProfile(
        "ti_lp38692_ndc",
        "Package_TO_SOT_SMD:SOT-223-5_TabPin5",
        (_LP38692,),
        _rect(
            -3_250_000,
            1_700_000,
            3_250_000,
            5_260_000,
            "F.Fab",
            "body",
            100_000,
            "derived",
            (
                "6.50 x 3.56 mm direct NDC body, centered on the 6.96 mm "
                "lead-to-tab source envelope registered to the manufacturer land-pattern datum"
            ),
        ),
        _rect(
            -3_250_000,
            -750_000,
            3_250_000,
            7_050_000,
            "F.CrtYd",
            "courtyard",
            50_000,
            "derived",
            (
                "zero-margin union of the direct 6.50 mm body width and NDC0005A "
                "recommended 1.00 x 1.50 mm pin lands plus 3.30 x 1.50 mm tab land"
            ),
        ),
        OrientationMark(
            "pin-one",
            "direct",
            (
                "TI pin numbering places pin 1 at the left-most small land with tab pin 5 "
                "above the row; no physical index mark is specified."
            ),
            "terminal-map",
            (-2_250_000, 0),
        ),
    ),
    FootprintProfile(
        "nexperia_ptvs_dfn1610_2",
        "Diode_SMD:Nexperia_DFN1610-2",
        (_PTVS,),
        _rect(-800_000, -500_000, 800_000, 500_000, "F.Fab", "body", 100_000),
        _rect(
            -975_000,
            -600_000,
            975_000,
            600_000,
            "F.CrtYd",
            "courtyard",
            50_000,
            "derived",
            (
                "zero-margin union of the direct 1.60 x 1.00 mm body and Figure 11 "
                "0.70 x 1.20 mm lands at 1.25 mm pitch"
            ),
        ),
        OrientationMark(
            "polarity",
            "direct",
            "Nexperia pin map defines pin 1 as K (cathode) and pin 2 as A (anode).",
            "terminal-map",
            (-625_000, 0),
        ),
    ),
    FootprintProfile(
        "resistor_0603",
        "Resistor_SMD:R_0603_1608Metric",
        (
            _source(
                "Resistor_SMD.pretty/R_0603_1608Metric.kicad_mod",
                "7190ac4a00125b807e54129ef0d87d87f2a658eeb74d025a7028203419b09f23",
            ),
        ),
        _rect(-800_000, -412_500, 800_000, 412_500, "F.Fab", "body", 100_000),
        _rect(-1_480_000, -730_000, 1_480_000, 730_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "none", "direct", "Two-terminal resistor has no polarity or pin-one mark.", "none"
        ),
    ),
    FootprintProfile(
        "vishay_wslp0603",
        "Resistor_SMD:R_0603_1608Metric",
        (_WSLP,),
        _rect(-760_000, -380_000, 760_000, 380_000, "F.Fab", "body", 100_000),
        _rect(
            -1_270_000,
            -510_000,
            1_270_000,
            510_000,
            "F.CrtYd",
            "courtyard",
            50_000,
            "derived",
            (
                "zero-margin union of the direct 1.52 x 0.76 mm WSLP body and direct "
                "1.02 x 1.02 mm lands at derived +/-0.76 mm centres"
            ),
        ),
        OrientationMark("none", "direct", "WSLP resistor is non-polar.", "none"),
    ),
    FootprintProfile(
        "capacitor_0805",
        "Capacitor_SMD:C_0805_2012Metric",
        (
            _source(
                "Capacitor_SMD.pretty/C_0805_2012Metric.kicad_mod",
                "62775a51fe74ba7f1b572de327bdbd3fc92582721b2abcaa47787865590d89cb",
            ),
        ),
        _rect(-1_000_000, -625_000, 1_000_000, 625_000, "F.Fab", "body", 100_000),
        _rect(-1_700_000, -980_000, 1_700_000, 980_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "none", "direct", "Ceramic capacitor has no polarity or pin-one mark.", "none"
        ),
    ),
    FootprintProfile(
        "kemet_t598b_density_b",
        "Capacitor_SMD:CP_EIA-3528-21_Kemet-B",
        (_T598,),
        _rect(-1_750_000, -1_400_000, 1_750_000, 1_400_000, "F.Fab", "body", 100_000),
        _rect(-2_610_000, -1_750_000, 2_610_000, 1_750_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "polarity",
            "direct",
            (
                "KEMET end views distinguish anode (+) and cathode (-); pin 1 is the "
                "positive terminal in the frozen land binding."
            ),
            "polarity-end-view",
            (-1_460_000, 0),
        ),
    ),
    FootprintProfile(
        "kemet_c1206_density_b",
        "Capacitor_SMD:C_1206_3216Metric",
        (_C1206_FAMILY, _C1206_MPN),
        _rect(-1_600_000, -800_000, 1_600_000, 800_000, "F.Fab", "body", 100_000),
        _rect(-2_350_000, -1_150_000, 2_350_000, 1_150_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "none", "direct", "C1206 C0G capacitor has no polarity or pin-one mark.", "none"
        ),
    ),
    FootprintProfile(
        "led_0603",
        "LED_SMD:LED_0603_1608Metric",
        (
            _source(
                "LED_SMD.pretty/LED_0603_1608Metric.kicad_mod",
                "7931ed1efba34cb13c8d74a60eb1dca4b0be57d950c38e08c3e7f007db500a1c",
            ),
        ),
        _polygon(
            (
                (-800_000, -100_000),
                (-800_000, 400_000),
                (800_000, 400_000),
                (800_000, -400_000),
                (-500_000, -400_000),
                (-800_000, -100_000),
            ),
            "F.Fab",
            "body",
            100_000,
        ),
        _rect(-1_480_000, -730_000, 1_480_000, 730_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "polarity",
            "direct",
            "Pinned KiCad F.Fab chamfer identifies the LED cathode/pin-1 end.",
            "fab-chamfer",
            (-500_000, -400_000),
        ),
    ),
    FootprintProfile(
        "header_1x02",
        "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
        (
            _source(
                "Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod",
                "5301303268f72ba9cc94b7fdbac355951933e6854272ce8d300b679b86b5d45d",
            ),
        ),
        _polygon(
            (
                (-1_270_000, -635_000),
                (-635_000, -1_270_000),
                (1_270_000, -1_270_000),
                (1_270_000, 3_810_000),
                (-1_270_000, 3_810_000),
                (-1_270_000, -635_000),
            ),
            "F.Fab",
            "body",
            100_000,
        ),
        _rect(-1_770_000, -1_770_000, 1_770_000, 4_320_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "pin-one",
            "direct",
            "Pinned KiCad F.Fab chamfer identifies header pin 1.",
            "fab-chamfer",
            (-635_000, -1_270_000),
        ),
    ),
    FootprintProfile(
        "testpoint_keystone_5015",
        "TestPoint:TestPoint_Keystone_5015_Micro_Miniature",
        (
            _source(
                "TestPoint.pretty/TestPoint_Keystone_5015_Micro_Mini.kicad_mod",
                "f14e0e7d28a0a75298142634f99f433f44d1ae9130852870e630df717f3bf647",
            ),
        ),
        _rect(-1_350_000, -500_000, 1_350_000, 500_000, "F.Fab", "body", 100_000),
        _rect(-2_150_000, -1_350_000, 2_150_000, 1_350_000, "F.CrtYd", "courtyard", 50_000),
        OrientationMark(
            "none", "direct", "Single-terminal test point has no polarity or pin-one mark.", "none"
        ),
    ),
)

_PROFILES_BY_ID = {profile.profile_id: profile for profile in _PROFILES}

REFERENCE_PROFILE_RECORDS = (
    ReferenceProfileRecord(
        "usb-j1",
        "J1",
        "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",
        "usb4105",
    ),
    ReferenceProfileRecord(
        "efuse-u1", "U1", "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm", "tps259620_dda"
    ),
    ReferenceProfileRecord(
        "ldo-u2", "U2", "Package_TO_SOT_SMD:SOT-223-5_TabPin5", "ti_lp38692_ndc"
    ),
    ReferenceProfileRecord(
        "tvs-d1", "D1", "Diode_SMD:Nexperia_DFN1610-2", "nexperia_ptvs_dfn1610_2"
    ),
    *(
        ReferenceProfileRecord(
            f"{prefix}-r{index}", f"R{reference}", "Resistor_SMD:R_0603_1608Metric", "resistor_0603"
        )
        for prefix, index, reference in (
            ("cc", 1, 1),
            ("cc", 2, 2),
            ("ilim", 3, 3),
            ("ovc", 4, 4),
            ("ovc", 5, 5),
            ("en-hi", 6, 6),
            ("en-lo", 7, 7),
            ("led", 8, 8),
        )
    ),
    ReferenceProfileRecord(
        "cout-esr-r9", "R9", "Resistor_SMD:R_0603_1608Metric", "vishay_wslp0603"
    ),
    ReferenceProfileRecord("cin-c1", "C1", "Capacitor_SMD:C_0805_2012Metric", "capacitor_0805"),
    ReferenceProfileRecord("cldo-c2", "C2", "Capacitor_SMD:C_0805_2012Metric", "capacitor_0805"),
    ReferenceProfileRecord(
        "cout-c3", "C3", "Capacitor_SMD:CP_EIA-3528-21_Kemet-B", "kemet_t598b_density_b"
    ),
    ReferenceProfileRecord(
        "dvdt-c4", "C4", "Capacitor_SMD:C_1206_3216Metric", "kemet_c1206_density_b"
    ),
    ReferenceProfileRecord("led-d2", "D2", "LED_SMD:LED_0603_1608Metric", "led_0603"),
    ReferenceProfileRecord(
        "out-j2", "J2", "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical", "header_1x02"
    ),
    *(
        ReferenceProfileRecord(
            f"tp-{index}",
            f"TP{index}",
            "TestPoint:TestPoint_Keystone_5015_Micro_Miniature",
            "testpoint_keystone_5015",
        )
        for index in range(1, 5)
    ),
)


def validate_reference_inventory() -> None:
    """Prove static profile/source/record identity before any lookup is exposed."""

    profile_ids = tuple(profile.profile_id for profile in _PROFILES)
    if len(profile_ids) != len(set(profile_ids)):
        raise ValueError("assembly profile IDs must be unique")
    if len(_PROFILES_BY_ID) != len(_PROFILES):
        raise ValueError("assembly profile index lost a profile ID")
    source_receipts = tuple(
        (source.kind, source.publisher, source.revision, source.locator, source.sha256)
        for profile in _PROFILES
        for source in profile.sources
    )
    if len(source_receipts) != len(set(source_receipts)):
        raise ValueError("assembly source receipts must be globally unique")
    if len(REFERENCE_PROFILE_RECORDS) != REFERENCE_COMPONENT_COUNT:
        raise ValueError("reference assembly inventory must contain exactly 23 component records")
    component_ids = tuple(record.component_id for record in REFERENCE_PROFILE_RECORDS)
    references = tuple(record.reference for record in REFERENCE_PROFILE_RECORDS)
    if len(component_ids) != len(set(component_ids)):
        raise ValueError("reference assembly component IDs must be unique")
    if len(references) != len(set(references)):
        raise ValueError("reference assembly designators must be unique")
    for record in REFERENCE_PROFILE_RECORDS:
        try:
            profile = _PROFILES_BY_ID[record.profile_id]
        except KeyError as exc:
            raise ValueError(
                f"reference assembly record {record.component_id!r} has no profile"
            ) from exc
        if record.footprint_id != profile.footprint_id:
            raise ValueError(
                f"reference assembly record {record.component_id!r} footprint does not "
                "match its profile"
            )


validate_reference_inventory()
_RECORDS_BY_COMPONENT = {record.component_id: record for record in REFERENCE_PROFILE_RECORDS}


def all_profiles() -> tuple[FootprintProfile, ...]:
    """Return the source profiles in stable profile-ID order."""

    return tuple(sorted(_PROFILES, key=lambda profile: profile.profile_id))


def profile_for_component(component_id: str, footprint_id: str) -> FootprintProfile:
    """Resolve one frozen R2 component binding or fail without a fallback profile."""

    try:
        record = _RECORDS_BY_COMPONENT[component_id]
    except KeyError as exc:
        raise AssemblyGeometryProvenanceError(
            f"no source-backed assembly profile is frozen for component {component_id!r}"
        ) from exc
    if record.footprint_id != footprint_id:
        raise AssemblyGeometryProvenanceError(
            f"component {component_id!r} footprint changed from frozen source profile "
            f"{record.footprint_id!r} to {footprint_id!r}"
        )
    return _PROFILES_BY_ID[record.profile_id]


def _transform(point: Point, placement: AssemblyPlacement) -> Point:
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


def resolve_placed_profiles(
    placements: tuple[AssemblyPlacement, ...],
) -> tuple[PlacedProfile, ...]:
    """Resolve and transform profiles in stable subject order."""

    if type(placements) is not tuple or any(
        type(placement) is not AssemblyPlacement for placement in placements
    ):
        raise ValueError("assembly placements must be an immutable AssemblyPlacement tuple")
    subject_ids = tuple(placement.subject_id for placement in placements)
    if len(subject_ids) != len(set(subject_ids)):
        raise ValueError("assembly placements cannot repeat a subject ID")
    result: list[PlacedProfile] = []
    for placement in sorted(placements, key=lambda item: item.subject_id):
        profile = profile_for_component(placement.subject_id, placement.footprint_id)
        bounds = _bounds(
            tuple(_transform(point, placement) for point in profile.courtyard_outline.vertices)
        )
        result.append(PlacedProfile(placement, profile, bounds))
    return tuple(result)


def _validate_placed_profiles(
    placed_profiles: tuple[PlacedProfile, ...],
) -> tuple[PlacedProfile, ...]:
    if type(placed_profiles) is not tuple or any(
        type(item) is not PlacedProfile for item in placed_profiles
    ):
        raise ValueError("placed assembly profiles must be an immutable PlacedProfile tuple")
    subject_ids = tuple(item.placement.subject_id for item in placed_profiles)
    if len(subject_ids) != len(set(subject_ids)):
        raise ValueError("placed assembly profiles cannot repeat a subject ID")
    return tuple(sorted(placed_profiles, key=lambda item: item.placement.subject_id))


def courtyard_collisions(
    placed_profiles: tuple[PlacedProfile, ...],
    policy: CourtyardClearancePolicy = REFERENCE_COURTYARD_POLICY,
) -> tuple[CourtyardCollision, ...]:
    """Report pairwise ordinary courtyard intersections deterministically."""

    if type(policy) is not CourtyardClearancePolicy:
        raise ValueError("courtyard collision policy must be CourtyardClearancePolicy")
    result: list[CourtyardCollision] = []
    ordered = _validate_placed_profiles(placed_profiles)
    for first, second in combinations(ordered, 2):
        first_box, second_box = first.courtyard_bounds_nm, second.courtyard_bounds_nm
        horizontal_gap = max(second_box[0] - first_box[2], first_box[0] - second_box[2])
        vertical_gap = max(second_box[1] - first_box[3], first_box[1] - second_box[3])
        horizontal_shortfall = max(0, policy.minimum_clearance_nm - horizontal_gap)
        vertical_shortfall = max(0, policy.minimum_clearance_nm - vertical_gap)
        if not horizontal_shortfall or not vertical_shortfall:
            continue
        overlap_x = max(0, min(first_box[2], second_box[2]) - max(first_box[0], second_box[0]))
        overlap_y = max(0, min(first_box[3], second_box[3]) - max(first_box[1], second_box[1]))
        if horizontal_shortfall <= vertical_shortfall:
            axis: Literal["x", "y"] = "x"
            translation = horizontal_shortfall
        else:
            axis = "y"
            translation = vertical_shortfall
        result.append(
            CourtyardCollision(
                first.placement.subject_id,
                second.placement.subject_id,
                first.profile.profile_id,
                second.profile.profile_id,
                overlap_x,
                overlap_y,
                translation,
                axis,
            )
        )
    return tuple(result)


def board_overhangs(
    placed_profiles: tuple[PlacedProfile, ...],
    board_bounds_nm: Bounds,
    policy: CourtyardClearancePolicy = REFERENCE_COURTYARD_POLICY,
) -> tuple[BoardOverhang, ...]:
    """Report courtyard overhangs; only source-authorized profiles may be permitted."""

    if type(policy) is not CourtyardClearancePolicy:
        raise ValueError("board-overhang policy must be CourtyardClearancePolicy")
    left, top, right, bottom = _validate_bounds(board_bounds_nm, "board bounds")
    result: list[BoardOverhang] = []
    for item in _validate_placed_profiles(placed_profiles):
        box = item.courtyard_bounds_nm
        if left <= box[0] and top <= box[1] and box[2] <= right and box[3] <= bottom:
            continue
        permitted = (
            policy.permit_profile_board_edge_overhang and item.profile.permits_board_edge_overhang
        )
        result.append(
            BoardOverhang(item.placement.subject_id, item.profile.profile_id, box, permitted)
        )
    return tuple(result)


__all__ = (
    "AssemblyGeometryProvenanceError",
    "AssemblyPlacement",
    "BoardOverhang",
    "CourtyardClearancePolicy",
    "CourtyardCollision",
    "DimensionStatus",
    "FootprintProfile",
    "GeometrySource",
    "KICAD_FOOTPRINT_COMMIT",
    "NM_PER_MM",
    "OrientationMark",
    "Outline",
    "PlacedProfile",
    "REFERENCE_COURTYARD_POLICY",
    "REFERENCE_PROFILE_RECORDS",
    "ReferenceProfileRecord",
    "all_profiles",
    "board_overhangs",
    "courtyard_collisions",
    "profile_for_component",
    "resolve_placed_profiles",
)
