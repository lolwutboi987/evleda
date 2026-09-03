"""Deterministic, compiler-neutral F.SilkS planning for the reference board.

This module deliberately does not write a KiCad board.  It produces a small,
immutable plan which a later compiler integration may translate into KiCad
``gr_text`` and ``gr_line`` forms.  Keeping the collision checker here makes
the manufacturing rules testable without treating a rendered board as proof.

All dimensions are integer nanometres in absolute board coordinates.  Text is
modelled by a conservative stroked rectangle: that is intentionally stricter
than a glyph-centre-only check and is the fallback when a native KiCad font
renderer is not available.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import product
from math import isqrt
from typing import Literal

from backend.design_kernel import stable_hash

NM_PER_MM = 1_000_000
MIN_TEXT_HEIGHT_NM = 600_000
MIN_TEXT_STROKE_NM = 120_000
DEFAULT_TEXT_HEIGHT_NM = 800_000
DEFAULT_TEXT_STROKE_NM = 150_000
TITLE_TEXT_HEIGHT_NM = 1_000_000
KICAD_GLYPH_ADVANCE_NUMERATOR = 3
KICAD_GLYPH_ADVANCE_DENOMINATOR = 4
EDGE_CLEARANCE_NM = 500_000
PAD_CLEARANCE_NM = 200_000
BODY_CLEARANCE_NM = 200_000
SILK_CLEARANCE_NM = 150_000
ETCH_ALLOWANCE_NM = 100_000
GRID_NM = 100_000
MAX_SEARCH_RADIUS_NM = 5_000_000
OUTPUT_WARNING = "3V3 OUT 100mA MAX / DO NOT APPLY POWER"


class SilkscreenPlanningError(ValueError):
    """Raised when the planner cannot prove every required graphic is visible."""


@dataclass(frozen=True, slots=True)
class RectNm:
    """An axis-aligned closed rectangle in board coordinates."""

    min_x_nm: int
    min_y_nm: int
    max_x_nm: int
    max_y_nm: int

    def __post_init__(self) -> None:
        if self.min_x_nm > self.max_x_nm or self.min_y_nm > self.max_y_nm:
            raise ValueError("rectangle minimum must not exceed its maximum")

    def inflate(self, amount_nm: int) -> RectNm:
        if amount_nm < 0:
            raise ValueError("inflation must be non-negative")
        return RectNm(
            self.min_x_nm - amount_nm,
            self.min_y_nm - amount_nm,
            self.max_x_nm + amount_nm,
            self.max_y_nm + amount_nm,
        )

    def intersects(self, other: RectNm) -> bool:
        return not (
            self.max_x_nm < other.min_x_nm
            or other.max_x_nm < self.min_x_nm
            or self.max_y_nm < other.min_y_nm
            or other.max_y_nm < self.min_y_nm
        )

    def clearance_to(self, other: RectNm) -> int:
        """Return non-negative Euclidean edge clearance in integer nanometres.

        Intersecting or edge-touching rectangles have zero clearance.  This is
        intentionally a measurement API, not an overlap-depth API: callers use
        :meth:`intersects` to reject contact, while reports retain an honest,
        non-negative distance for every accepted or rejected candidate.
        """

        horizontal = max(0, other.min_x_nm - self.max_x_nm, self.min_x_nm - other.max_x_nm)
        vertical = max(0, other.min_y_nm - self.max_y_nm, self.min_y_nm - other.max_y_nm)
        return isqrt(horizontal * horizontal + vertical * vertical)


ColliderKind = Literal["source", "body", "courtyard", "pad", "hole", "silk", "reserve"]


@dataclass(frozen=True, slots=True)
class Envelope:
    """A proven source, component, or already-authored forbidden envelope."""

    identifier: str
    kind: ColliderKind
    bounds: RectNm
    clearance_nm: int

    def __post_init__(self) -> None:
        if self.clearance_nm < 0:
            raise ValueError("envelope clearance must be non-negative")

    @property
    def forbidden_bounds(self) -> RectNm:
        return self.bounds.inflate(self.clearance_nm)


@dataclass(frozen=True, slots=True)
class FittedPart:
    """The geometry evidence needed to place one fitted reference safely."""

    reference: str
    component_id: str
    anchor_x_nm: int
    anchor_y_nm: int
    source_envelope: RectNm | None
    body_envelope: RectNm | None
    courtyard_envelope: RectNm | None
    pad_envelopes: tuple[RectNm, ...] = ()
    hole_envelopes: tuple[RectNm, ...] = ()
    connector_or_probe: bool = False

    def required_envelopes(self) -> tuple[Envelope, ...]:
        """Return conservative forbidden geometry, or fail for missing evidence."""

        missing = tuple(
            name
            for name, value in (
                ("source", self.source_envelope),
                ("body", self.body_envelope),
                ("courtyard", self.courtyard_envelope),
            )
            if value is None
        )
        if missing:
            raise SilkscreenPlanningError(
                f"{self.reference} lacks verified {', '.join(missing)} geometry; refusing silk plan"
            )
        pad_clearance = 300_000 if self.connector_or_probe else PAD_CLEARANCE_NM
        body_clearance = 300_000 if self.connector_or_probe else BODY_CLEARANCE_NM
        # The three None checks above narrow these values for pyright.
        assert self.source_envelope is not None
        assert self.body_envelope is not None
        assert self.courtyard_envelope is not None
        return (
            Envelope(f"source:{self.component_id}", "source", self.source_envelope, body_clearance),
            Envelope(f"body:{self.component_id}", "body", self.body_envelope, body_clearance),
            Envelope(
                f"courtyard:{self.component_id}",
                "courtyard",
                self.courtyard_envelope,
                body_clearance,
            ),
            *(
                Envelope(f"pad:{self.component_id}:{index}", "pad", bounds, pad_clearance)
                for index, bounds in enumerate(self.pad_envelopes)
            ),
            *(
                Envelope(f"hole:{self.component_id}:{index}", "hole", bounds, pad_clearance)
                for index, bounds in enumerate(self.hole_envelopes)
            ),
        )


@dataclass(frozen=True, slots=True)
class TextPrimitive:
    """An upright KiCad-compatible top-silkscreen text primitive."""

    identifier: str
    text: str
    x_nm: int
    y_nm: int
    rotation_deg: Literal[0, 90]
    height_nm: int = DEFAULT_TEXT_HEIGHT_NM
    stroke_nm: int = DEFAULT_TEXT_STROKE_NM
    owner_reference: str | None = None
    role: str = "label"

    def __post_init__(self) -> None:
        if not self.text:
            raise ValueError("silkscreen text must not be empty")
        if self.height_nm < MIN_TEXT_HEIGHT_NM:
            raise ValueError("silkscreen text must be at least 0.60 mm high")
        if self.stroke_nm < MIN_TEXT_STROKE_NM:
            raise ValueError("silkscreen text stroke must be at least 0.12 mm")

    def nominal_bounds(self) -> RectNm:
        # KiCad's stroke font has glyphs materially wider than the compact
        # average used in early planning.  0.75 x character height is a
        # conservative upper bound used for every collision and edge decision.
        width_nm = (
            len(self.text)
            * self.height_nm
            * KICAD_GLYPH_ADVANCE_NUMERATOR
            // KICAD_GLYPH_ADVANCE_DENOMINATOR
        )
        height_nm = self.height_nm
        if self.rotation_deg == 90:
            width_nm, height_nm = height_nm, width_nm
        return RectNm(
            self.x_nm - width_nm // 2,
            self.y_nm - height_nm // 2,
            self.x_nm + (width_nm + 1) // 2,
            self.y_nm + (height_nm + 1) // 2,
        )

    def expanded_bounds(self) -> RectNm:
        return self.nominal_bounds().inflate(self.stroke_nm // 2 + ETCH_ALLOWANCE_NM)

    def kicad(self) -> str:
        """Return the exact standalone KiCad 20240108 ``gr_text`` form."""

        return (
            f'(gr_text "{self.text}" (at {_mm(self.x_nm)} {_mm(self.y_nm)} {self.rotation_deg}) '
            '(layer "F.SilkS") '
            f"(effects (font (size {_mm(self.height_nm)} {_mm(self.height_nm)}) "
            f"(thickness {_mm(self.stroke_nm)}))))"
        )


@dataclass(frozen=True, slots=True)
class LinePrimitive:
    """A short F.SilkS line used for pin-one and polarity cues."""

    identifier: str
    start_x_nm: int
    start_y_nm: int
    end_x_nm: int
    end_y_nm: int
    stroke_nm: int = DEFAULT_TEXT_STROKE_NM
    owner_reference: str | None = None
    role: str = "mark"

    def __post_init__(self) -> None:
        if self.stroke_nm < MIN_TEXT_STROKE_NM:
            raise ValueError("silkscreen mark stroke must be at least 0.12 mm")

    def expanded_bounds(self) -> RectNm:
        return RectNm(
            min(self.start_x_nm, self.end_x_nm),
            min(self.start_y_nm, self.end_y_nm),
            max(self.start_x_nm, self.end_x_nm),
            max(self.start_y_nm, self.end_y_nm),
        ).inflate(self.stroke_nm // 2 + ETCH_ALLOWANCE_NM)

    def kicad(self) -> str:
        return (
            f"(gr_line (start {_mm(self.start_x_nm)} {_mm(self.start_y_nm)}) "
            f"(end {_mm(self.end_x_nm)} {_mm(self.end_y_nm)}) "
            "(stroke (width "
            f'{_mm(self.stroke_nm)}) (type default)) (fill none) (layer "F.SilkS"))'
        )


SilkscreenPrimitive = TextPrimitive | LinePrimitive


@dataclass(frozen=True, slots=True)
class PlacementRequest:
    """A search request with a preferred centre and a primitive template."""

    primitive: TextPrimitive
    anchor_x_nm: int
    anchor_y_nm: int
    reserve_sensitive: bool = False


@dataclass(frozen=True, slots=True)
class CollisionReport:
    identifier: str
    candidate_x_nm: int
    candidate_y_nm: int
    rotation_deg: int
    bounds: RectNm
    collider_identifier: str | None
    collider_kind: str | None
    clearance_nm: int
    accepted: bool


@dataclass(frozen=True, slots=True)
class SilkscreenPlan:
    """A compiler-neutral, digest-bound F.SilkS plan."""

    primitives: tuple[SilkscreenPrimitive, ...]
    reports: tuple[CollisionReport, ...]
    digest: str

    def kicad_primitives(self) -> tuple[str, ...]:
        return tuple(primitive.kicad() for primitive in self.primitives)


@dataclass(frozen=True, slots=True)
class PlannerInput:
    board_bounds: RectNm
    fitted_parts: tuple[FittedPart, ...]
    existing_silk: tuple[RectNm, ...] = ()
    reserved_regions: tuple[RectNm, ...] = ()


# This table is intentionally independent from the compiler.  Its component IDs
# and anchors mirror the final 23-place placement contract in footprints.py;
# callers provide verified geometry separately before any plan is accepted.
FINAL_PLACEMENTS = (
    ("J1", "usb-j1", 3_675_000, 15_000_000),
    ("U1", "efuse-u1", 17_000_000, 15_000_000),
    ("U2", "ldo-u2", 28_000_000, 19_000_000),
    ("D1", "tvs-d1", 10_200_000, 15_000_000),
    ("R1", "cc-r1", 9_400_000, 12_250_000),
    ("R2", "cc-r2", 9_400_000, 17_750_000),
    ("R3", "ilim-r3", 22_000_000, 11_200_000),
    ("R4", "ovc-r4", 21_500_000, 9_500_000),
    ("R5", "ovc-r5", 24_500_000, 9_500_000),
    ("R6", "en-hi-r6", 14_500_000, 9_500_000),
    ("R7", "en-lo-r7", 17_500_000, 9_500_000),
    ("R8", "led-r8", 37_000_000, 13_500_000),
    ("R9", "cout-esr-r9", 27_250_000, 22_250_000),
    ("C1", "cin-c1", 12_050_000, 15_000_000),
    ("C2", "cldo-c2", 22_500_000, 19_000_000),
    ("C3", "cout-c3", 29_250_000, 26_000_000),
    ("C4", "dvdt-c4", 11_650_000, 10_750_000),
    ("D2", "led-d2", 34_000_000, 13_500_000),
    ("J2", "out-j2", 47_000_000, 13_730_000),
    ("TP1", "tp-1", 11_000_000, 23_000_000),
    ("TP2", "tp-2", 23_000_000, 23_000_000),
    ("TP3", "tp-3", 35_000_000, 23_000_000),
    ("TP4", "tp-4", 42_000_000, 23_000_000),
)


def reference_silkscreen_requests() -> tuple[PlacementRequest, ...]:
    """Return the fixed-order refdes, connector, TP, title, and warning intent."""

    preferred = {
        "J1": (4_000_000, 8_500_000),
        "D1": (10_200_000, 19_000_000),
        "C1": (12_050_000, 11_500_000),
        "R1": (8_800_000, 10_800_000),
        "R2": (8_800_000, 20_400_000),
        "U1": (17_000_000, 11_100_000),
        "R6": (14_500_000, 7_400_000),
        "R7": (17_500_000, 7_400_000),
        "R4": (21_500_000, 7_400_000),
        "R5": (24_500_000, 7_400_000),
        "R3": (22_000_000, 13_000_000),
        "C2": (22_500_000, 20_400_000),
        "C4": (11_650_000, 8_400_000),
        "J2": (47_000_000, 9_200_000),
        "U2": (40_500_000, 8_900_000),
        "R8": (40_500_000, 10_500_000),
        "D2": (40_500_000, 12_000_000),
        "R9": (29_500_000, 22_250_000),
        "C3": (33_000_000, 26_500_000),
        "TP1": (11_000_000, 20_800_000),
        "TP2": (23_000_000, 20_800_000),
        "TP3": (35_000_000, 20_800_000),
        "TP4": (42_000_000, 20_800_000),
    }
    part_by_reference = {item[0]: item for item in FINAL_PLACEMENTS}

    def request(
        identifier: str,
        text: str,
        x_nm: int,
        y_nm: int,
        *,
        owner: str | None = None,
        height_nm: int = DEFAULT_TEXT_HEIGHT_NM,
        role: str = "label",
        reserve: bool = False,
    ) -> PlacementRequest:
        anchor = part_by_reference[owner] if owner else ("", "", x_nm, y_nm)
        return PlacementRequest(
            TextPrimitive(
                identifier, text, x_nm, y_nm, 0, height_nm, DEFAULT_TEXT_STROKE_NM, owner, role
            ),
            anchor[2],
            anchor[3],
            reserve,
        )

    requests = [
        request(
            "title",
            "REFERENCE USB C 3V3",
            25_000_000,
            1_500_000,
            height_nm=TITLE_TEXT_HEIGHT_NM,
            role="title",
        ),
        request("revision", "REV 2", 25_000_000, 28_500_000, role="revision"),
    ]
    # Keep the documented deterministic ordering rather than alphabetical order.
    for reference in (
        "J1",
        "D1",
        "C1",
        "R1",
        "R2",
        "U1",
        "R6",
        "R7",
        "R4",
        "R5",
        "R3",
        "C2",
        "C4",
        "TP1",
        "TP2",
        "TP3",
        "TP4",
        "J2",
        "U2",
        "C3",
        "D2",
        "R8",
        "R9",
    ):
        x_nm, y_nm = preferred[reference]
        requests.append(
            request(
                f"refdes:{reference}",
                reference,
                x_nm,
                y_nm,
                owner=reference,
                role="refdes",
                reserve=reference in {"U2", "C3", "D2", "R8", "R9"},
            )
        )
    requests.extend(
        (
            request(
                "j1-input",
                "USB 5V IN",
                4_000_000,
                24_500_000,
                height_nm=TITLE_TEXT_HEIGHT_NM,
                role="connector",
            ),
            request("j2-3v3", "3V3", 44_000_000, 13_730_000, role="connector"),
            request("j2-gnd", "GND", 44_000_000, 16_270_000, role="connector"),
            request("tp1-net", "VBUS", 11_000_000, 25_200_000, owner="TP1", role="testpoint"),
            request("tp2-net", "V5", 23_000_000, 25_200_000, owner="TP2", role="testpoint"),
            request("tp3-net", "3V3", 35_000_000, 25_200_000, owner="TP3", role="testpoint"),
            request("tp4-net", "GND", 42_000_000, 25_200_000, owner="TP4", role="testpoint"),
            request("output-warning-1", "3V3 OUT 100mA MAX", 39_000_000, 3_500_000, role="warning"),
            request(
                "output-warning-2", "DO NOT APPLY POWER", 39_000_000, 4_900_000, role="warning"
            ),
        )
    )
    return tuple(requests)


def reference_orientation_marks() -> tuple[SilkscreenPrimitive, ...]:
    """Return explicit D1/D2/C3 polarity and U1/U2 pin-one F.SilkS marks."""

    # The chevrons are explicit three-segment marks.  U2 is transformed for its
    # final 180-degree placement rather than copied from the superseded SOT-23
    # position in the layout proposal.
    return (
        LinePrimitive(
            "d1-cathode",
            9_200_000,
            14_400_000,
            9_200_000,
            14_700_000,
            owner_reference="D1",
            role="polarity",
        ),
        LinePrimitive(
            "d2-cathode",
            31_800_000,
            13_500_000,
            32_200_000,
            13_500_000,
            owner_reference="D2",
            role="polarity",
        ),
        TextPrimitive(
            "c3-positive", "+", 24_900_000, 26_000_000, 0, owner_reference="C3", role="polarity"
        ),
        LinePrimitive(
            "c3-positive-arrow-shaft",
            26_000_000,
            26_000_000,
            26_350_000,
            26_000_000,
            owner_reference="C3",
            role="polarity",
        ),
        LinePrimitive(
            "c3-positive-arrow-head-a",
            26_350_000,
            26_000_000,
            26_150_000,
            25_800_000,
            owner_reference="C3",
            role="polarity",
        ),
        LinePrimitive(
            "c3-positive-arrow-head-b",
            26_350_000,
            26_000_000,
            26_150_000,
            26_200_000,
            owner_reference="C3",
            role="polarity",
        ),
        LinePrimitive(
            "u1-pin1-a",
            14_135_000,
            12_045_000,
            14_615_000,
            12_045_000,
            owner_reference="U1",
            role="pin1",
        ),
        LinePrimitive(
            "u1-pin1-b",
            14_135_000,
            12_045_000,
            14_375_000,
            12_375_000,
            owner_reference="U1",
            role="pin1",
        ),
        LinePrimitive(
            "u1-pin1-c",
            14_615_000,
            12_045_000,
            14_375_000,
            12_375_000,
            owner_reference="U1",
            role="pin1",
        ),
        LinePrimitive(
            "u2-pin1-a",
            31_500_000,
            18_700_000,
            32_100_000,
            18_700_000,
            owner_reference="U2",
            role="pin1",
        ),
        LinePrimitive(
            "u2-pin1-b",
            31_500_000,
            18_700_000,
            31_800_000,
            19_000_000,
            owner_reference="U2",
            role="pin1",
        ),
        LinePrimitive(
            "u2-pin1-c",
            32_100_000,
            18_700_000,
            31_800_000,
            19_000_000,
            owner_reference="U2",
            role="pin1",
        ),
    )


def plan_silkscreen(planner_input: PlannerInput) -> SilkscreenPlan:
    """Search fixed candidates and fail closed when the plan cannot be proven safe."""

    part_by_reference = {part.reference: part for part in planner_input.fitted_parts}
    expected_references = {item[0] for item in FINAL_PLACEMENTS}
    if set(part_by_reference) != expected_references:
        missing = sorted(expected_references - set(part_by_reference))
        extra = sorted(set(part_by_reference) - expected_references)
        raise SilkscreenPlanningError(
            f"fitted-reference mismatch; missing={missing}, extra={extra}"
        )
    if len(part_by_reference) != len(planner_input.fitted_parts):
        raise SilkscreenPlanningError("duplicate fitted reference")

    envelopes = [
        envelope for part in planner_input.fitted_parts for envelope in part.required_envelopes()
    ]
    envelopes.extend(
        Envelope(f"existing-silk:{index}", "silk", bounds, SILK_CLEARANCE_NM)
        for index, bounds in enumerate(planner_input.existing_silk)
    )
    envelopes.extend(
        Envelope(f"reserve:{index}", "reserve", bounds, 0)
        for index, bounds in enumerate(planner_input.reserved_regions)
    )
    accepted: list[SilkscreenPrimitive] = []
    reports: list[CollisionReport] = []
    # Fixed orientation geometry reserves its actual stroked envelope before
    # refdes search, so a movable label cannot consume the only legal cue site.
    for mark in reference_orientation_marks():
        mark_envelopes = tuple(
            envelope
            for envelope in envelopes
            if not (
                mark.owner_reference is not None
                and envelope.identifier
                == f"courtyard:{part_by_reference[mark.owner_reference].component_id}"
            )
        )
        report = _check_fixed_primitive(mark, planner_input.board_bounds, mark_envelopes, accepted)
        reports.append(report)
        if not report.accepted:
            raise SilkscreenPlanningError(f"unsafe required F.SilkS mark {mark.identifier}")
        accepted.append(mark)
    for request in reference_silkscreen_requests():
        candidate, report = _choose_candidate(
            request, planner_input.board_bounds, tuple(envelopes), accepted
        )
        if candidate is None:
            reports.append(report)
            raise SilkscreenPlanningError(
                f"no safe F.SilkS position for {request.primitive.identifier}"
            )
        accepted.append(candidate)
        reports.append(report)

    refdes = [
        item for item in accepted if isinstance(item, TextPrimitive) and item.role == "refdes"
    ]
    counts = {
        reference: sum(item.owner_reference == reference for item in refdes)
        for reference in expected_references
    }
    if any(count != 1 for count in counts.values()):
        raise SilkscreenPlanningError(
            f"every fitted reference needs exactly one visible refdes: {counts}"
        )
    primitive_tuple = tuple(accepted)
    digest = stable_hash(primitive_tuple, domain="flux-clone-reference-silkscreen-plan-v1")
    return SilkscreenPlan(primitive_tuple, tuple(reports), digest)


def _choose_candidate(
    request: PlacementRequest,
    board_bounds: RectNm,
    envelopes: tuple[Envelope, ...],
    accepted: list[SilkscreenPrimitive],
) -> tuple[TextPrimitive | None, CollisionReport]:
    last_report: CollisionReport | None = None
    for offsets in _candidate_rings():
        candidates: list[tuple[tuple[int, ...], TextPrimitive, CollisionReport]] = []
        for offset_x_nm, offset_y_nm in offsets:
            for rotation_deg in (0, 90):
                primitive = TextPrimitive(
                    request.primitive.identifier,
                    request.primitive.text,
                    request.primitive.x_nm + offset_x_nm,
                    request.primitive.y_nm + offset_y_nm,
                    rotation_deg,
                    request.primitive.height_nm,
                    request.primitive.stroke_nm,
                    request.primitive.owner_reference,
                    request.primitive.role,
                )
                report = _check_fixed_primitive(primitive, board_bounds, envelopes, accepted)
                last_report = report
                if report.accepted:
                    edge_margin = _edge_margin(primitive.expanded_bounds(), board_bounds)
                    other_clearances = [
                        primitive.expanded_bounds().clearance_to(envelope.forbidden_bounds)
                        for envelope in envelopes
                    ]
                    silk_clearances = [
                        primitive.expanded_bounds().clearance_to(_primitive_bounds(item))
                        for item in accepted
                    ]
                    nearest = min(other_clearances, default=MAX_SEARCH_RADIUS_NM)
                    silk = min(silk_clearances, default=MAX_SEARCH_RADIUS_NM)
                    reserved = int(
                        request.reserve_sensitive
                        and any(
                            primitive.expanded_bounds().intersects(envelope.forbidden_bounds)
                            for envelope in envelopes
                            if envelope.kind == "reserve"
                        )
                    )
                    score = (
                        reserved,
                        -edge_margin,
                        -nearest,
                        -silk,
                        abs(primitive.x_nm - request.anchor_x_nm)
                        + abs(primitive.y_nm - request.anchor_y_nm),
                        primitive.rotation_deg,
                        primitive.x_nm,
                        primitive.y_nm,
                    )
                    candidates.append((score, primitive, report))
        # Do not trade a nearby readable label for a distant one merely because
        # it has more empty board around it.  The prescribed score resolves all
        # valid ties in the first search ring that can actually be placed.
        if candidates:
            _, primitive, report = min(candidates, key=lambda item: item[0])
            return primitive, report
    assert last_report is not None
    return None, last_report


def _check_fixed_primitive(
    primitive: SilkscreenPrimitive,
    board_bounds: RectNm,
    envelopes: tuple[Envelope, ...],
    accepted: list[SilkscreenPrimitive],
) -> CollisionReport:
    bounds = _primitive_bounds(primitive)
    edge_margin = _edge_margin(bounds, board_bounds)
    if edge_margin < EDGE_CLEARANCE_NM:
        return CollisionReport(
            primitive.identifier,
            _primitive_x(primitive),
            _primitive_y(primitive),
            0,
            bounds,
            "edge-cuts",
            "edge",
            edge_margin - EDGE_CLEARANCE_NM,
            False,
        )
    # Line segments belonging to one compound cue intentionally meet at their
    # vertices.  Text is never part of that exemption: in particular, the C3
    # ``+`` and its arrow must retain real KiCad glyph-to-line clearance.
    accepted_colliders = tuple(
        item
        for item in accepted
        if not (
            isinstance(item, LinePrimitive)
            and isinstance(primitive, LinePrimitive)
            and item.owner_reference == primitive.owner_reference
            and item.role == primitive.role
            and item.role in {"pin1", "polarity"}
        )
    )
    colliders = (
        *envelopes,
        *(
            Envelope(item.identifier, "silk", _primitive_bounds(item), SILK_CLEARANCE_NM)
            for item in accepted_colliders
        ),
    )
    nearest: tuple[Envelope, int] | None = None
    for collider in colliders:
        clearance = bounds.clearance_to(collider.forbidden_bounds)
        if nearest is None or clearance < nearest[1]:
            nearest = collider, clearance
        if bounds.intersects(collider.forbidden_bounds):
            return CollisionReport(
                primitive.identifier,
                _primitive_x(primitive),
                _primitive_y(primitive),
                primitive.rotation_deg if isinstance(primitive, TextPrimitive) else 0,
                bounds,
                collider.identifier,
                collider.kind,
                clearance,
                False,
            )
    return CollisionReport(
        primitive.identifier,
        _primitive_x(primitive),
        _primitive_y(primitive),
        primitive.rotation_deg if isinstance(primitive, TextPrimitive) else 0,
        bounds,
        nearest[0].identifier if nearest else None,
        nearest[0].kind if nearest else None,
        nearest[1] if nearest else MAX_SEARCH_RADIUS_NM,
        True,
    )


def _candidate_rings() -> tuple[tuple[tuple[int, int], ...], ...]:
    rings: list[tuple[tuple[int, int], ...]] = [((0, 0),)]
    for distance_nm in range(200_000, MAX_SEARCH_RADIUS_NM + GRID_NM, 200_000):
        cardinal = ((-distance_nm, 0), (distance_nm, 0), (0, -distance_nm), (0, distance_nm))
        # The grid fill follows the documented cardinal trials and then has a
        # stable lexicographic tie-break for all remaining cells on the ring.
        ring = (
            (x_nm, y_nm)
            for x_nm, y_nm in product(range(-distance_nm, distance_nm + GRID_NM, GRID_NM), repeat=2)
            if max(abs(x_nm), abs(y_nm)) == distance_nm and (x_nm, y_nm) not in cardinal
        )
        rings.append(cardinal + tuple(sorted(ring)))
    return tuple(rings)


def _primitive_bounds(primitive: SilkscreenPrimitive) -> RectNm:
    return primitive.expanded_bounds()


def _primitive_x(primitive: SilkscreenPrimitive) -> int:
    return primitive.x_nm if isinstance(primitive, TextPrimitive) else primitive.start_x_nm


def _primitive_y(primitive: SilkscreenPrimitive) -> int:
    return primitive.y_nm if isinstance(primitive, TextPrimitive) else primitive.start_y_nm


def _edge_margin(bounds: RectNm, board_bounds: RectNm) -> int:
    return min(
        bounds.min_x_nm - board_bounds.min_x_nm,
        bounds.min_y_nm - board_bounds.min_y_nm,
        board_bounds.max_x_nm - bounds.max_x_nm,
        board_bounds.max_y_nm - bounds.max_y_nm,
    )


def _mm(value_nm: int) -> str:
    return f"{value_nm / NM_PER_MM:.3f}"


__all__ = (
    "BODY_CLEARANCE_NM",
    "DEFAULT_TEXT_HEIGHT_NM",
    "DEFAULT_TEXT_STROKE_NM",
    "EDGE_CLEARANCE_NM",
    "ETCH_ALLOWANCE_NM",
    "Envelope",
    "FINAL_PLACEMENTS",
    "FittedPart",
    "KICAD_GLYPH_ADVANCE_DENOMINATOR",
    "KICAD_GLYPH_ADVANCE_NUMERATOR",
    "LinePrimitive",
    "MIN_TEXT_HEIGHT_NM",
    "MIN_TEXT_STROKE_NM",
    "NM_PER_MM",
    "OUTPUT_WARNING",
    "PAD_CLEARANCE_NM",
    "PlannerInput",
    "RectNm",
    "SILK_CLEARANCE_NM",
    "SilkscreenPlan",
    "SilkscreenPlanningError",
    "TextPrimitive",
    "reference_orientation_marks",
    "reference_silkscreen_requests",
    "plan_silkscreen",
)
