"""Exact integer/rational geometry primitives used by authoritative rules."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from typing import Iterable, Protocol

from .model import BoardOutline, PointNm


@dataclass(frozen=True, slots=True, order=True)
class ExactPoint:
    """Internal rational point used for half-nanometre pad boundaries."""

    x: Fraction
    y: Fraction


def exact_point(point: PointNm) -> ExactPoint:
    return ExactPoint(Fraction(point.x), Fraction(point.y))


def exact_cross(origin: ExactPoint, first: ExactPoint, second: ExactPoint) -> Fraction:
    return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (
        second.x - origin.x
    )


def exact_on_segment(point: ExactPoint, start: ExactPoint, end: ExactPoint) -> bool:
    return (
        exact_cross(start, end, point) == 0
        and min(start.x, end.x) <= point.x <= max(start.x, end.x)
        and min(start.y, end.y) <= point.y <= max(start.y, end.y)
    )


def exact_segments_intersect(
    first_start: ExactPoint,
    first_end: ExactPoint,
    second_start: ExactPoint,
    second_end: ExactPoint,
) -> bool:
    """Exact segment intersection over rational coordinates."""

    first_a = exact_cross(first_start, first_end, second_start)
    first_b = exact_cross(first_start, first_end, second_end)
    second_a = exact_cross(second_start, second_end, first_start)
    second_b = exact_cross(second_start, second_end, first_end)
    if ((first_a > 0 and first_b < 0) or (first_a < 0 and first_b > 0)) and (
        (second_a > 0 and second_b < 0) or (second_a < 0 and second_b > 0)
    ):
        return True
    return (
        (first_a == 0 and exact_on_segment(second_start, first_start, first_end))
        or (first_b == 0 and exact_on_segment(second_end, first_start, first_end))
        or (second_a == 0 and exact_on_segment(first_start, second_start, second_end))
        or (second_b == 0 and exact_on_segment(first_end, second_start, second_end))
    )


def exact_point_segment_distance_squared(
    point: ExactPoint, start: ExactPoint, end: ExactPoint
) -> Fraction:
    """Exact squared distance for rational point/segment coordinates."""

    dx = end.x - start.x
    dy = end.y - start.y
    length_squared = dx * dx + dy * dy
    if length_squared == 0:
        px = point.x - start.x
        py = point.y - start.y
        return px * px + py * py
    projection = (point.x - start.x) * dx + (point.y - start.y) * dy
    if projection <= 0:
        px = point.x - start.x
        py = point.y - start.y
        return px * px + py * py
    if projection >= length_squared:
        px = point.x - end.x
        py = point.y - end.y
        return px * px + py * py
    cross = dx * (point.y - start.y) - dy * (point.x - start.x)
    return cross * cross / length_squared


def exact_segment_distance_squared(
    first_start: ExactPoint,
    first_end: ExactPoint,
    second_start: ExactPoint,
    second_end: ExactPoint,
) -> Fraction:
    """Exact squared distance for two rational-coordinate segments."""

    if exact_segments_intersect(first_start, first_end, second_start, second_end):
        return Fraction(0)
    return min(
        exact_point_segment_distance_squared(first_start, second_start, second_end),
        exact_point_segment_distance_squared(first_end, second_start, second_end),
        exact_point_segment_distance_squared(second_start, first_start, first_end),
        exact_point_segment_distance_squared(second_end, first_start, first_end),
    )


def exact_point_in_outline(point: ExactPoint, outline: BoardOutline) -> bool:
    """Exact closed-set point-in-polygon test for a rational point."""

    if len(outline.vertices) < 3:
        return False
    inside = False
    for integer_start, integer_end in outline_edges(outline):
        start = exact_point(integer_start)
        end = exact_point(integer_end)
        if exact_on_segment(point, start, end):
            return True
        if (start.y > point.y) != (end.y > point.y):
            intersection_x = (end.x - start.x) * (point.y - start.y) / (end.y - start.y) + start.x
            if point.x < intersection_x:
                inside = not inside
    return inside


class GeometryKernel(Protocol):
    """Contract for a deterministic geometry implementation."""

    kernel_id: str
    version: str

    def segments_intersect(
        self, a_start: PointNm, a_end: PointNm, b_start: PointNm, b_end: PointNm
    ) -> bool: ...

    def segment_distance_squared(
        self, a_start: PointNm, a_end: PointNm, b_start: PointNm, b_end: PointNm
    ) -> Fraction: ...

    def point_segment_distance_squared(
        self, point: PointNm, start: PointNm, end: PointNm
    ) -> Fraction: ...

    def point_in_outline(self, point: PointNm, outline: BoardOutline) -> bool: ...


def _cross(origin: PointNm, a: PointNm, b: PointNm) -> int:
    return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)


def _on_segment(point: PointNm, start: PointNm, end: PointNm) -> bool:
    return (
        _cross(start, end, point) == 0
        and min(start.x, end.x) <= point.x <= max(start.x, end.x)
        and min(start.y, end.y) <= point.y <= max(start.y, end.y)
    )


class ExactGeometryKernel:
    """Geometry kernel with no floating-point operations.

    Distances are squared rational numbers. Callers compare them to squared
    integer limits, avoiding square roots and host-specific rounding.
    """

    kernel_id = "exact-integer-rational-2d"
    version = "1.0.0"

    def segments_intersect(
        self, a_start: PointNm, a_end: PointNm, b_start: PointNm, b_end: PointNm
    ) -> bool:
        d1 = _cross(a_start, a_end, b_start)
        d2 = _cross(a_start, a_end, b_end)
        d3 = _cross(b_start, b_end, a_start)
        d4 = _cross(b_start, b_end, a_end)
        if ((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and (
            (d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0)
        ):
            return True
        return (
            (d1 == 0 and _on_segment(b_start, a_start, a_end))
            or (d2 == 0 and _on_segment(b_end, a_start, a_end))
            or (d3 == 0 and _on_segment(a_start, b_start, b_end))
            or (d4 == 0 and _on_segment(a_end, b_start, b_end))
        )

    def point_segment_distance_squared(
        self, point: PointNm, start: PointNm, end: PointNm
    ) -> Fraction:
        dx = end.x - start.x
        dy = end.y - start.y
        length_squared = dx * dx + dy * dy
        if length_squared == 0:
            px = point.x - start.x
            py = point.y - start.y
            return Fraction(px * px + py * py)
        projection = (point.x - start.x) * dx + (point.y - start.y) * dy
        if projection <= 0:
            px = point.x - start.x
            py = point.y - start.y
            return Fraction(px * px + py * py)
        if projection >= length_squared:
            px = point.x - end.x
            py = point.y - end.y
            return Fraction(px * px + py * py)
        cross = dx * (point.y - start.y) - dy * (point.x - start.x)
        return Fraction(cross * cross, length_squared)

    def segment_distance_squared(
        self, a_start: PointNm, a_end: PointNm, b_start: PointNm, b_end: PointNm
    ) -> Fraction:
        if self.segments_intersect(a_start, a_end, b_start, b_end):
            return Fraction(0)
        return min(
            self.point_segment_distance_squared(a_start, b_start, b_end),
            self.point_segment_distance_squared(a_end, b_start, b_end),
            self.point_segment_distance_squared(b_start, a_start, a_end),
            self.point_segment_distance_squared(b_end, a_start, a_end),
        )

    def point_in_outline(self, point: PointNm, outline: BoardOutline) -> bool:
        vertices = outline.vertices
        if len(vertices) < 3:
            return False
        inside = False
        for start, end in outline_edges(outline):
            if _on_segment(point, start, end):
                return True
            if (start.y > point.y) != (end.y > point.y):
                intersection_x = (
                    Fraction((end.x - start.x) * (point.y - start.y), end.y - start.y) + start.x
                )
                if Fraction(point.x) < intersection_x:
                    inside = not inside
        return inside


def outline_edges(outline: BoardOutline) -> tuple[tuple[PointNm, PointNm], ...]:
    vertices = outline.vertices
    if len(vertices) < 2:
        return ()
    return tuple(
        (vertices[index], vertices[(index + 1) % len(vertices)])
        for index in range(len(vertices))
    )


def signed_area_twice(outline: BoardOutline) -> int:
    return sum(start.x * end.y - end.x * start.y for start, end in outline_edges(outline))


def outline_defects(
    outline: BoardOutline, kernel: GeometryKernel
) -> tuple[tuple[str, tuple[int, ...]], ...]:
    """Return stable machine-readable outline defects."""

    vertices = outline.vertices
    defects: list[tuple[str, tuple[int, ...]]] = []
    if len(vertices) < 3:
        return (("fewer_than_three_vertices", (len(vertices),)),)
    if len(set(vertices)) < 3:
        defects.append(("fewer_than_three_unique_vertices", (len(set(vertices)),)))
    edges = outline_edges(outline)
    for index, (start, end) in enumerate(edges):
        if start == end:
            defects.append(("zero_length_edge", (index,)))
    if signed_area_twice(outline) == 0:
        defects.append(("zero_area", ()))
    for first in range(len(edges)):
        for second in range(first + 1, len(edges)):
            # Adjacent polygon edges intentionally share one endpoint.
            if second == first + 1 or (first == 0 and second == len(edges) - 1):
                continue
            if kernel.segments_intersect(*edges[first], *edges[second]):
                defects.append(("self_intersection", (first, second)))
    return tuple(sorted(set(defects)))


def minimum_point_outline_distance_squared(
    point: PointNm, outline: BoardOutline, kernel: GeometryKernel
) -> Fraction:
    distances = tuple(
        kernel.point_segment_distance_squared(point, start, end)
        for start, end in outline_edges(outline)
    )
    return min(distances) if distances else Fraction(0)


def minimum_segment_outline_distance_squared(
    start: PointNm, end: PointNm, outline: BoardOutline, kernel: GeometryKernel
) -> Fraction:
    distances = tuple(
        kernel.segment_distance_squared(start, end, edge_start, edge_end)
        for edge_start, edge_end in outline_edges(outline)
    )
    return min(distances) if distances else Fraction(0)


def minimum_outlines_distance_squared(
    first: BoardOutline, second: BoardOutline, kernel: GeometryKernel
) -> Fraction:
    """Return the exact minimum boundary-to-boundary squared distance."""

    distances = tuple(
        kernel.segment_distance_squared(first_start, first_end, second_start, second_end)
        for first_start, first_end in outline_edges(first)
        for second_start, second_end in outline_edges(second)
    )
    return min(distances) if distances else Fraction(0)


def outlines_overlap(first: BoardOutline, second: BoardOutline, kernel: GeometryKernel) -> bool:
    """Return whether two simple closed polygons share any filled area/boundary."""

    if any(
        kernel.segments_intersect(first_start, first_end, second_start, second_end)
        for first_start, first_end in outline_edges(first)
        for second_start, second_end in outline_edges(second)
    ):
        return True
    return bool(
        first.vertices
        and second.vertices
        and (
            kernel.point_in_outline(first.vertices[0], second)
            or kernel.point_in_outline(second.vertices[0], first)
        )
    )


def rational_less_than_squared(distance_squared: Fraction, required_distance_nm: int) -> bool:
    """Exact strict comparison used for minimum-clearance rules."""

    if required_distance_nm < 0:
        raise ValueError("required distance must be non-negative")
    return distance_squared < required_distance_nm * required_distance_nm


def points_distance_squared(first: PointNm, second: PointNm) -> int:
    dx = first.x - second.x
    dy = first.y - second.y
    return dx * dx + dy * dy


def all_distinct(values: Iterable[str]) -> bool:
    values_tuple = tuple(values)
    return len(values_tuple) == len(set(values_tuple))
