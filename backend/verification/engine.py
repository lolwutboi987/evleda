"""Fail-closed deterministic verification engine and policy gates."""

from __future__ import annotations

import hashlib
import inspect
from enum import Enum
from pathlib import Path
from types import CodeType, FunctionType, MethodType
from typing import Any, cast

from .algorithms import algorithm_rules
from .canonical import stable_hash
from .electrical import electrical_rules
from .geometric import geometric_rules
from .geometry import ExactGeometryKernel, GeometryKernel
from .model import (
    BoardGraph,
    BoardOutline,
    Component,
    EntityRef,
    EvidenceItem,
    Finding,
    GateDecision,
    GateDefinition,
    Hole,
    Net,
    NetConnection,
    PadShape,
    ParameterValue,
    PhysicalPad,
    Pin,
    PinElectricalType,
    PointNm,
    RuleDefinition,
    RuleDomain,
    RuleExecution,
    RuleExecutionOutcome,
    RuleOverride,
    Severity,
    Track,
    VerificationPolicy,
    VerificationReport,
    Via,
    Zone,
    ZoneFillEvidence,
    ZoneFillState,
    zone_fill_evidence_hash,
    zone_filled_geometry_hash,
)
from .rule import (
    FindingDraft,
    ResolvedRule,
    RuleConfigurationError,
    RuleContext,
    RuleEvaluator,
    finding_order_key,
    resolve_rule,
    validate_rule_definition,
)

ENGINE_VERSION = "2.1.0"
REPORT_SCHEMA_VERSION = 3
BOARD_SCHEMA_VERSION = 3
_REQUIRED_GATE_IDS = frozenset({"preview", "commit", "manufacturing-release"})
_KICAD_EVIDENCE_ID = "trusted-kicad-drc-v1"
_MAXIMUM_REQUIRED_GATE_THRESHOLDS = {
    "preview": Severity.FATAL,
    "commit": Severity.ERROR,
    "manufacturing-release": Severity.WARNING,
}
_MINIMUM_RULE_SEVERITIES = {
    "GEO.ZONE.FILL_UNVERIFIED": Severity.WARNING,
}
_LIVE_METHOD_NAMES = (
    "evaluate",
    "validate",
    "segments_intersect",
    "segment_distance_squared",
    "point_segment_distance_squared",
    "point_in_outline",
)
_SHAPE_DEPENDENT_RULE_IDS = frozenset(
    {
        "ALG.ROUTING.CONNECTIVITY",
        "ALG.VIA.NET_CONNECTIVITY",
        "GEO.COPPER.MIN_CLEARANCE",
        "GEO.COPPER.BOARD_EDGE_CLEARANCE",
        "GEO.PAD.MIN_ANNULAR_RING",
    }
)
_GEOMETRY_BLOCKER_PREFIXES = (
    "exact-pad-rotation-not-supported:",
    "exact-pad-circle-nonsquare-not-supported:",
    "exact-pad-roundrect-radius-not-represented:",
    "exact-hole-slot-not-supported:",
    "exact-drill-rotation-not-supported:",
)


class VerificationInputError(ValueError):
    """Raised when the board envelope itself is unsupported or ambiguous."""


class VerificationExecutionError(RuntimeError):
    """Fail-closed result when an authoritative evaluator cannot complete."""


def strict_policy() -> VerificationPolicy:
    """Safe default gates for preview, commit, and manufacturing release."""

    return VerificationPolicy(
        gates=(
            GateDefinition(
                "preview",
                "Preview may not contain fatal verification failures",
                Severity.FATAL,
            ),
            GateDefinition(
                "commit",
                "Project commit requires zero error-or-higher findings",
                Severity.ERROR,
            ),
            GateDefinition(
                "manufacturing-release",
                "Manufacturing release requires zero warning-or-higher findings",
                Severity.WARNING,
                required_external_evidence_ids=(_KICAD_EVIDENCE_ID,),
            ),
        )
    ).normalized()


def default_evaluators() -> tuple[RuleEvaluator, ...]:
    registered = cast(
        tuple[RuleEvaluator, ...],
        electrical_rules() + geometric_rules() + algorithm_rules(),
    )
    return tuple(
        sorted(
            registered,
            key=lambda evaluator: evaluator.definition.rule_id,
        )
    )


def _code_file_hash(subject: object) -> str:
    source_file = inspect.getsourcefile(type(subject))
    if source_file is None:
        identity = f"{type(subject).__module__}.{type(subject).__qualname__}"
        raise RuleConfigurationError(f"cannot establish code identity for {identity}")
    try:
        source = Path(source_file).read_bytes()
    except OSError as error:
        raise RuleConfigurationError(
            f"cannot read code identity for {type(subject).__module__}.{type(subject).__qualname__}"
        ) from error
    return hashlib.sha256(source).hexdigest()


def _code_constant_identity(value: object) -> object:
    if value is None or type(value) in {str, int, bool}:
        return value
    if type(value) is bytes:
        return {"bytes": value.hex()}
    if type(value) is float:
        return {"float_hex": value.hex()}
    if type(value) is complex:
        complex_value = value
        return {"complex": (complex_value.real.hex(), complex_value.imag.hex())}
    if type(value) is tuple:
        values = cast(tuple[object, ...], value)
        return {"tuple": tuple(_code_constant_identity(item) for item in values)}
    if type(value) is frozenset:
        values = tuple(_code_constant_identity(item) for item in cast(frozenset[object], value))
        return {
            "frozenset": tuple(
                sorted(
                    values,
                    key=lambda item: stable_hash(item, domain="pcb-code-constant-order-v1"),
                )
            )
        }
    if type(value) is CodeType:
        return {"code": _code_object_identity(value)}
    if value is Ellipsis:
        return {"ellipsis": True}
    raise RuleConfigurationError(
        f"unsupported live code constant type: {type(value).__module__}.{type(value).__qualname__}"
    )


def _code_object_identity(code: CodeType) -> dict[str, object]:
    return {
        "bytecode": code.co_code.hex(),
        "constants": tuple(_code_constant_identity(item) for item in code.co_consts),
        "names": code.co_names,
        "varnames": code.co_varnames,
        "freevars": code.co_freevars,
        "cellvars": code.co_cellvars,
        "argcount": code.co_argcount,
        "posonlyargcount": code.co_posonlyargcount,
        "kwonlyargcount": code.co_kwonlyargcount,
        "nlocals": code.co_nlocals,
        "stacksize": code.co_stacksize,
        "flags": code.co_flags,
        "exceptiontable": code.co_exceptiontable.hex(),
    }


def _callable_literal_identity(value: object) -> object:
    if value is None or type(value) in {str, int, bool}:
        return value
    if type(value) in {bytes, float, complex, tuple, frozenset, CodeType} or value is Ellipsis:
        return _code_constant_identity(value)
    if isinstance(value, Enum):
        return {
            "enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": value.value,
        }
    if type(value) in {RuleDefinition, ParameterValue}:
        return value
    raise RuleConfigurationError(
        f"unsupported live callable closure/default type: "
        f"{type(value).__module__}.{type(value).__qualname__}"
    )


def _live_callable_identity(value: object) -> dict[str, object]:
    function_object = value.__func__ if type(value) is MethodType else value  # type: ignore[union-attr]
    if type(function_object) is not FunctionType:
        raise RuleConfigurationError(
            f"live callable must be a Python function: "
            f"{type(function_object).__module__}.{type(function_object).__qualname__}"
        )
    function = cast(FunctionType, function_object)
    closure: list[object] = []
    for cell in function.__closure__ or ():
        try:
            cell_value = cell.cell_contents
        except ValueError:
            closure.append({"empty_cell": True})
        else:
            closure.append(_callable_literal_identity(cell_value))
    defaults = function.__defaults__ or ()
    keyword_defaults = function.__kwdefaults__ or {}
    return {
        "module": function.__module__,
        "qualname": function.__qualname__,
        "code": _code_object_identity(function.__code__),
        "defaults": tuple(_callable_literal_identity(item) for item in defaults),
        "keyword_defaults": tuple(
            (name, _callable_literal_identity(keyword_defaults[name]))
            for name in sorted(keyword_defaults)
        ),
        "closure": tuple(closure),
    }


def _implementation_state(value: Any, seen: set[int]) -> Any:
    if value is None or type(value) in {str, int, bool}:
        return value
    if type(value) is tuple:
        items = cast(tuple[object, ...], value)
        return tuple(_implementation_state(item, seen) for item in items)
    if type(value) in {FunctionType, MethodType}:
        return _live_callable_identity(value)
    if isinstance(value, Enum):
        return {
            "enum": f"{type(value).__module__}.{type(value).__qualname__}",
            "value": value.value,
        }
    if type(value) in {RuleDefinition, ParameterValue}:
        return value
    if id(value) in seen:
        raise RuleConfigurationError("cyclic evaluator implementation state is unsupported")
    seen.add(id(value))
    try:
        return _implementation_identity(value, seen)
    finally:
        seen.remove(id(value))


def _implementation_identity(subject: object, seen: set[int] | None = None) -> dict[str, Any]:
    """Bind declared identity, executable module bytes, and collaborator state."""

    active = seen if seen is not None else {id(subject)}
    declared: list[tuple[str, str]] = []
    for name in ("implementation_id", "algorithm_id", "kernel_id", "version", "code_hash"):
        if not hasattr(subject, name):
            continue
        value = getattr(subject, name)
        if type(value) is not str or not value.strip():
            field = f"{type(subject).__qualname__}.{name}"
            raise RuleConfigurationError(
                f"implementation identity field {field} must be a non-empty string"
            )
        declared.append((name, value))

    state: list[tuple[str, Any]] = []
    try:
        instance_state = vars(subject)
    except TypeError:
        instance_state = {}
    for name in sorted(instance_state):
        state.append((name, _implementation_state(instance_state[name], active)))

    live_methods: list[tuple[str, dict[str, object]]] = []
    for name in _LIVE_METHOD_NAMES:
        if not hasattr(subject, name):
            continue
        live_methods.append((name, _live_callable_identity(getattr(subject, name))))

    definition = getattr(subject, "definition", None)
    if definition is not None and type(definition) is not RuleDefinition:
        raise RuleConfigurationError("live evaluator definition must be exact RuleDefinition")

    return {
        "class": f"{type(subject).__module__}.{type(subject).__qualname__}",
        "module_code_sha256": _code_file_hash(subject),
        "declared_identity": tuple(declared),
        "instance_state": tuple(state),
        "rule_definition": definition,
        "live_methods": tuple(live_methods),
    }


def _verification_code_bundle_hash() -> str:
    root = Path(__file__).resolve().parent
    files = tuple(
        (path.name, hashlib.sha256(path.read_bytes()).hexdigest())
        for path in sorted(root.glob("*.py"), key=lambda item: item.name)
    )
    return stable_hash(files, domain="pcb-verification-code-bundle-v1")


def _validate_board_graph(board: BoardGraph) -> None:
    """Validate the exact immutable schema before normalization or evaluator access."""

    def exact(value: object, expected: type[object], location: str) -> None:
        if type(value) is not expected:
            raise VerificationInputError(f"{location} must be exact {expected.__name__}")

    def string(value: object, location: str, *, nonempty: bool = False) -> None:
        if type(value) is not str:
            raise VerificationInputError(f"{location} must be exact str")
        if nonempty and not value.strip():
            raise VerificationInputError(f"{location} must be non-empty")

    def integer(value: object, location: str) -> None:
        exact(value, int, location)

    def tuple_of_strings(value: object, location: str) -> None:
        if type(value) is not tuple:
            raise VerificationInputError(f"{location} must be exact tuple")
        for index, item in enumerate(cast(tuple[object, ...], value)):
            string(item, f"{location}[{index}]")

    def point(value: object, location: str) -> None:
        exact(value, PointNm, location)
        integer(value.x, f"{location}.x")  # type: ignore[union-attr]
        integer(value.y, f"{location}.y")  # type: ignore[union-attr]

    exact(board, BoardGraph, "board")
    integer(board.schema_version, "board.schema_version")
    string(board.design_id, "board.design_id", nonempty=True)
    string(board.revision, "board.revision", nonempty=True)
    tuple_of_strings(board.layers, "board.layers")
    tuple_of_strings(board.unsupported_features, "board.unsupported_features")

    exact(board.outline, BoardOutline, "board.outline")
    exact(board.outline.vertices, tuple, "board.outline.vertices")
    for index, vertex in enumerate(board.outline.vertices):
        point(vertex, f"board.outline.vertices[{index}]")

    exact(board.components, tuple, "board.components")
    for component_index, component in enumerate(board.components):
        location = f"board.components[{component_index}]"
        exact(component, Component, location)
        for name in (
            "component_id",
            "reference",
            "value",
            "footprint",
            "manufacturer_part_number",
            "datasheet_sha256",
            "pin_map_sha256",
        ):
            string(getattr(component, name), f"{location}.{name}")
        exact(component.pins, tuple, f"{location}.pins")
        for pin_index, pin_value in enumerate(component.pins):
            pin_location = f"{location}.pins[{pin_index}]"
            exact(pin_value, Pin, pin_location)
            string(pin_value.number, f"{pin_location}.number")
            string(pin_value.name, f"{pin_location}.name")
            exact(pin_value.electrical_type, PinElectricalType, f"{pin_location}.electrical_type")
            exact(pin_value.required, bool, f"{pin_location}.required")
            if pin_value.pad_center is not None:
                point(pin_value.pad_center, f"{pin_location}.pad_center")
            integer(pin_value.pad_diameter_nm, f"{pin_location}.pad_diameter_nm")
            integer(pin_value.pad_drill_nm, f"{pin_location}.pad_drill_nm")
            string(pin_value.pad_number, f"{pin_location}.pad_number")
            tuple_of_strings(pin_value.layers, f"{pin_location}.layers")

    exact(board.nets, tuple, "board.nets")
    for net_index, net in enumerate(board.nets):
        location = f"board.nets[{net_index}]"
        exact(net, Net, location)
        string(net.net_id, f"{location}.net_id")
        string(net.name, f"{location}.name")
        exact(net.external_source, bool, f"{location}.external_source")
        exact(net.connections, tuple, f"{location}.connections")
        for connection_index, connection in enumerate(net.connections):
            connection_location = f"{location}.connections[{connection_index}]"
            exact(connection, NetConnection, connection_location)
            string(connection.component_id, f"{connection_location}.component_id")
            string(connection.pin_number, f"{connection_location}.pin_number")

    exact(board.tracks, tuple, "board.tracks")
    for track_index, track in enumerate(board.tracks):
        location = f"board.tracks[{track_index}]"
        exact(track, Track, location)
        for name in ("track_id", "net_id", "layer"):
            string(getattr(track, name), f"{location}.{name}")
        point(track.start, f"{location}.start")
        point(track.end, f"{location}.end")
        integer(track.width_nm, f"{location}.width_nm")

    exact(board.vias, tuple, "board.vias")
    for via_index, via in enumerate(board.vias):
        location = f"board.vias[{via_index}]"
        exact(via, Via, location)
        string(via.via_id, f"{location}.via_id")
        string(via.net_id, f"{location}.net_id")
        point(via.center, f"{location}.center")
        integer(via.diameter_nm, f"{location}.diameter_nm")
        integer(via.drill_nm, f"{location}.drill_nm")
        tuple_of_strings(via.layers, f"{location}.layers")

    exact(board.zones, tuple, "board.zones")
    for zone_index, zone in enumerate(board.zones):
        location = f"board.zones[{zone_index}]"
        exact(zone, Zone, location)
        for name in ("zone_id", "net_id", "layer"):
            string(getattr(zone, name), f"{location}.{name}")
        exact(zone.outline, BoardOutline, f"{location}.outline")
        exact(zone.outline.vertices, tuple, f"{location}.outline.vertices")
        for vertex_index, vertex in enumerate(zone.outline.vertices):
            point(vertex, f"{location}.outline.vertices[{vertex_index}]")
        integer(zone.clearance_nm, f"{location}.clearance_nm")
        exact(zone.fill_state, ZoneFillState, f"{location}.fill_state")
        if zone.fill_state is ZoneFillState.UNFILLED_INTENT:
            if zone.fill_evidence is not None:
                raise VerificationInputError(
                    f"{location} unfilled intent cannot carry fill evidence"
                )
        elif zone.fill_state is ZoneFillState.VERIFIED_FILLED:
            exact(zone.fill_evidence, ZoneFillEvidence, f"{location}.fill_evidence")
            evidence = cast(ZoneFillEvidence, zone.fill_evidence)
            for name in (
                "source_graph_hash",
                "source_revision",
                "fill_engine_id",
                "fill_engine_revision",
                "filled_geometry_hash",
                "evidence_hash",
            ):
                string(getattr(evidence, name), f"{location}.fill_evidence.{name}", nonempty=True)
            for name in (
                "source_graph_hash",
                "source_revision",
                "filled_geometry_hash",
                "evidence_hash",
            ):
                digest = getattr(evidence, name)
                if len(digest) != 64 or any(
                    character not in "0123456789abcdef" for character in digest
                ):
                    raise VerificationInputError(
                        f"{location}.fill_evidence.{name} must be a lowercase SHA-256 digest"
                    )
            if evidence.filled_geometry_hash != zone_filled_geometry_hash(zone):
                raise VerificationInputError(
                    f"{location} fill evidence does not bind its exact modeled geometry"
                )
            if evidence.evidence_hash != zone_fill_evidence_hash(evidence):
                raise VerificationInputError(
                    f"{location} fill evidence hash does not bind its provenance"
                )

    exact(board.holes, tuple, "board.holes")
    for hole_index, hole in enumerate(board.holes):
        location = f"board.holes[{hole_index}]"
        exact(hole, Hole, location)
        string(hole.hole_id, f"{location}.hole_id", nonempty=True)
        string(hole.component_id, f"{location}.component_id", nonempty=True)
        point(hole.center, f"{location}.center")
        integer(hole.diameter_nm, f"{location}.diameter_nm")
        exact(hole.plated, bool, f"{location}.plated")
        if hole.pad_id is not None:
            string(hole.pad_id, f"{location}.pad_id", nonempty=True)
        integer(hole.drill_x_nm, f"{location}.drill_x_nm")
        integer(hole.drill_y_nm, f"{location}.drill_y_nm")
        integer(hole.drill_rotation_udeg, f"{location}.drill_rotation_udeg")

    exact(board.pads, tuple, "board.pads")
    for pad_index, pad in enumerate(board.pads):
        location = f"board.pads[{pad_index}]"
        exact(pad, PhysicalPad, location)
        string(pad.pad_id, f"{location}.pad_id", nonempty=True)
        string(pad.component_id, f"{location}.component_id", nonempty=True)
        string(pad.pad_number, f"{location}.pad_number", nonempty=True)
        if pad.net_id is not None:
            string(pad.net_id, f"{location}.net_id", nonempty=True)
        point(pad.center, f"{location}.center")
        integer(pad.size_x_nm, f"{location}.size_x_nm")
        integer(pad.size_y_nm, f"{location}.size_y_nm")
        exact(pad.shape, PadShape, f"{location}.shape")
        integer(pad.rotation_udeg, f"{location}.rotation_udeg")
        tuple_of_strings(pad.layers, f"{location}.layers")
        integer(pad.drill_nm, f"{location}.drill_nm")
        integer(pad.drill_x_nm, f"{location}.drill_x_nm")
        integer(pad.drill_y_nm, f"{location}.drill_y_nm")
        integer(pad.drill_rotation_udeg, f"{location}.drill_rotation_udeg")
        if pad.shared_land_group_id is not None:
            string(
                pad.shared_land_group_id,
                f"{location}.shared_land_group_id",
                nonempty=True,
            )


def _geometry_blockers(board: BoardGraph) -> tuple[str, ...]:
    blockers = {
        feature
        for feature in board.unsupported_features
        if feature.startswith(_GEOMETRY_BLOCKER_PREFIXES)
    }
    pad_ids = [pad.pad_id for pad in board.pads]
    blockers.update(
        f"duplicate-physical-pad-id:{pad_id}"
        for pad_id in set(pad_ids)
        if pad_ids.count(pad_id) > 1
    )
    hole_ids = [hole.hole_id for hole in board.holes]
    blockers.update(
        f"duplicate-hole-id:{hole_id}"
        for hole_id in set(hole_ids)
        if hole_ids.count(hole_id) > 1
    )
    for pad in board.pads:
        if pad.rotation_udeg % 90_000_000:
            blockers.add(f"exact-pad-rotation-not-supported:{pad.pad_id}:{pad.rotation_udeg}")
        if pad.shape is PadShape.CIRCLE and pad.size_x_nm != pad.size_y_nm:
            blockers.add(f"exact-pad-circle-nonsquare-not-supported:{pad.pad_id}")
        if pad.shape is PadShape.ROUNDRECT:
            blockers.add(f"exact-pad-roundrect-radius-not-represented:{pad.pad_id}")
        if pad.drill_x_nm != pad.drill_y_nm and pad.drill_rotation_udeg % 90_000_000:
            blockers.add(
                f"exact-drill-rotation-not-supported:pad:{pad.pad_id}:{pad.drill_rotation_udeg}"
            )
    for hole in board.holes:
        if hole.drill_x_nm != hole.drill_y_nm and hole.drill_rotation_udeg % 90_000_000:
            blockers.add(
                f"exact-drill-rotation-not-supported:hole:{hole.hole_id}:{hole.drill_rotation_udeg}"
            )
    pin_by_number = {
        (component.component_id, pin.number): pin
        for component in board.components
        for pin in component.pins
    }
    logical_pad_nets: dict[tuple[str, str], str] = {}
    for net in board.nets:
        for connection in net.connections:
            pin = pin_by_number.get((connection.component_id, connection.pin_number))
            if pin is not None:
                key = (connection.component_id, pin.pad_number or pin.number)
                logical_pad_nets[key] = net.net_id
    groups: dict[str, list[PhysicalPad]] = {}
    for pad in board.pads:
        if pad.shared_land_group_id is not None:
            groups.setdefault(pad.shared_land_group_id, []).append(pad)
    for group_id, pads in groups.items():
        signatures = {
            (
                pad.component_id,
                pad.net_id or logical_pad_nets.get((pad.component_id, pad.pad_number), ""),
                pad.center,
                pad.size_x_nm,
                pad.size_y_nm,
                pad.shape,
                pad.rotation_udeg,
                pad.layers,
                pad.drill_nm,
                pad.drill_x_nm,
                pad.drill_y_nm,
                pad.drill_rotation_udeg,
            )
            for pad in pads
        }
        logical_numbers = {pad.pad_number for pad in pads}
        if len(pads) < 2 or len(logical_numbers) != len(pads) or len(signatures) != 1:
            blockers.add(f"shared-land-group-mismatch:{group_id}")
    return tuple(sorted(blockers))


def _gate_selects(gate: GateDefinition, definition: RuleDefinition) -> bool:
    return (
        definition.rule_id not in gate.exempt_rule_ids
        and (not gate.domains or definition.domain in gate.domains)
        and (not gate.rule_ids or definition.rule_id in gate.rule_ids)
    )


def _assert_implementation_identity(
    subject: object,
    expected: dict[str, Any],
    label: str,
) -> None:
    current = _implementation_identity(subject)
    expected_hash = stable_hash(expected, domain="pcb-live-implementation-identity-v1")
    current_hash = stable_hash(current, domain="pcb-live-implementation-identity-v1")
    if current_hash != expected_hash:
        raise VerificationExecutionError(f"{label} implementation identity drifted during run")


class VerificationEngine:
    """Runs a closed, typed rule registry over a normalized immutable board graph."""

    def __init__(
        self,
        evaluators: tuple[RuleEvaluator, ...] | None = None,
        geometry: GeometryKernel | None = None,
    ) -> None:
        if evaluators is not None and type(evaluators) is not tuple:
            raise RuleConfigurationError("evaluator registry must be an exact tuple")
        self._evaluators = tuple(
            sorted(
                default_evaluators() if evaluators is None else evaluators,
                key=lambda item: item.definition.rule_id,
            )
        )
        self._geometry = ExactGeometryKernel() if geometry is None else geometry
        for field_name in ("kernel_id", "version"):
            value = getattr(self._geometry, field_name, None)
            if type(value) is not str or not value.strip():
                raise RuleConfigurationError(f"geometry {field_name} must be a non-empty string")
        _implementation_identity(self._geometry)
        rule_ids = [item.definition.rule_id for item in self._evaluators]
        if len(rule_ids) != len(set(rule_ids)):
            duplicates = sorted({item for item in rule_ids if rule_ids.count(item) > 1})
            raise RuleConfigurationError(f"duplicate rule ids: {', '.join(duplicates)}")
        for evaluator in self._evaluators:
            validate_rule_definition(evaluator.definition)
            _implementation_identity(evaluator)

    @property
    def definitions(self) -> tuple[object, ...]:
        return tuple(item.definition for item in self._evaluators)

    def verify(
        self, board: BoardGraph, policy: VerificationPolicy | None = None
    ) -> VerificationReport:
        _validate_board_graph(board)
        if board.schema_version != BOARD_SCHEMA_VERSION:
            raise VerificationInputError(
                f"unsupported board schema {board.schema_version}; expected {BOARD_SCHEMA_VERSION}"
            )
        normalized_board = board.normalized()
        source_policy = strict_policy() if policy is None else policy
        self._validate_policy_shape(source_policy)
        normalized_policy = source_policy.normalized()
        overrides = self._validate_policy(normalized_policy)
        resolved_rules = tuple(
            resolve_rule(evaluator, overrides.get(evaluator.definition.rule_id))
            for evaluator in self._evaluators
        )
        input_hash = stable_hash(normalized_board, domain="pcb-board-graph-v2")
        geometry_implementation = _implementation_identity(self._geometry)
        evaluator_implementations = {
            item.evaluator.definition.rule_id: _implementation_identity(item.evaluator)
            for item in resolved_rules
        }
        rule_set_payload = {
            "engine_version": ENGINE_VERSION,
            "verification_code_bundle_hash": _verification_code_bundle_hash(),
            "geometry_kernel": {
                "kernel_id": self._geometry.kernel_id,
                "version": self._geometry.version,
                "implementation": geometry_implementation,
            },
            "rules": tuple(
                {
                    "definition": item.evaluator.definition,
                    "implementation": evaluator_implementations[item.evaluator.definition.rule_id],
                    "enabled": item.enabled,
                    "severity": item.severity,
                    "parameters": item.parameters,
                }
                for item in resolved_rules
            ),
            "gates": normalized_policy.gates,
        }
        rule_set_hash = stable_hash(rule_set_payload, domain="pcb-rule-set-v2")
        run_id = (
            "RUN-"
            + stable_hash(
                {"input_hash": input_hash, "rule_set_hash": rule_set_hash},
                domain="pcb-verification-run-v2",
            )[:24]
        )

        findings: dict[str, Finding] = {}
        executions: list[RuleExecution] = []
        for resolved in resolved_rules:
            definition = resolved.evaluator.definition
            blocker_ids = (
                _geometry_blockers(normalized_board)
                if definition.rule_id in _SHAPE_DEPENDENT_RULE_IDS
                else ()
            )
            _assert_implementation_identity(
                self._geometry,
                geometry_implementation,
                "geometry kernel",
            )
            _assert_implementation_identity(
                resolved.evaluator,
                evaluator_implementations[definition.rule_id],
                f"rule {definition.rule_id}",
            )
            rule_findings: list[Finding] = []
            if resolved.enabled and not blocker_ids:
                context = RuleContext(resolved.severity, resolved.parameters, self._geometry)
                try:
                    draft_value: object = resolved.evaluator.evaluate(normalized_board, context)
                except Exception as exc:  # fail closed; a partial report is never authoritative
                    raise VerificationExecutionError(
                        f"rule {definition.rule_id} failed closed: {type(exc).__name__}: {exc}"
                    ) from exc
                if type(draft_value) is not tuple:
                    raise VerificationExecutionError(
                        f"rule {definition.rule_id} returned a mutable/non-canonical result"
                    )
                drafts = draft_value
                for draft in drafts:
                    finding = self._materialize_finding(resolved, draft)
                    previous = findings.get(finding.finding_id)
                    if previous is not None and previous != finding:
                        raise VerificationExecutionError(
                            f"finding identity collision in {definition.rule_id}"
                        )
                    findings[finding.finding_id] = finding
                    rule_findings.append(finding)
                _assert_implementation_identity(
                    self._geometry,
                    geometry_implementation,
                    "geometry kernel",
                )
                _assert_implementation_identity(
                    resolved.evaluator,
                    evaluator_implementations[definition.rule_id],
                    f"rule {definition.rule_id}",
                )
            executions.append(
                RuleExecution(
                    definition.rule_id,
                    definition.version,
                    resolved.enabled,
                    resolved.severity,
                    resolved.parameters,
                    tuple(sorted({item.finding_id for item in rule_findings})),
                    RuleExecutionOutcome.NOT_RUN
                    if not resolved.enabled or blocker_ids
                    else RuleExecutionOutcome.FAIL
                    if rule_findings
                    else RuleExecutionOutcome.PASS,
                    blocker_ids,
                )
            )

        _assert_implementation_identity(
            self._geometry,
            geometry_implementation,
            "geometry kernel",
        )
        for resolved in resolved_rules:
            rule_id = resolved.evaluator.definition.rule_id
            _assert_implementation_identity(
                resolved.evaluator,
                evaluator_implementations[rule_id],
                f"rule {rule_id}",
            )

        ordered_findings = tuple(sorted(findings.values(), key=finding_order_key))
        gates = self._evaluate_gates(
            normalized_policy.gates,
            ordered_findings,
            tuple(executions),
            {item.definition.rule_id: item.definition for item in self._evaluators},
            input_hash,
            rule_set_hash,
        )
        report_payload = {
            "schema_version": REPORT_SCHEMA_VERSION,
            "engine_version": ENGINE_VERSION,
            "run_id": run_id,
            "input_hash": input_hash,
            "rule_set_hash": rule_set_hash,
            "findings": ordered_findings,
            "executions": tuple(executions),
            "gates": gates,
        }
        report_hash = stable_hash(report_payload, domain="pcb-verification-report-v3")
        return VerificationReport(
            REPORT_SCHEMA_VERSION,
            ENGINE_VERSION,
            run_id,
            input_hash,
            rule_set_hash,
            ordered_findings,
            tuple(executions),
            gates,
            report_hash,
        )

    @staticmethod
    def _validate_policy_shape(policy: VerificationPolicy) -> None:
        if type(policy) is not VerificationPolicy:
            raise RuleConfigurationError("policy must be the exact VerificationPolicy type")
        if type(policy.overrides) is not tuple or type(policy.gates) is not tuple:
            raise RuleConfigurationError("policy overrides and gates must be exact tuples")
        for override in policy.overrides:
            if type(override) is not RuleOverride:
                raise RuleConfigurationError("policy override must be exact RuleOverride")
            if type(override.rule_id) is not str:
                raise RuleConfigurationError("policy override rule id must be a string")
            if type(override.enabled) is not bool:
                raise RuleConfigurationError(
                    f"policy override {override.rule_id} enabled must be bool"
                )
            if override.severity is not None and type(override.severity) is not Severity:
                raise RuleConfigurationError(
                    f"policy override {override.rule_id} severity must be Severity"
                )
            if type(override.parameters) is not tuple:
                raise RuleConfigurationError(
                    f"policy override {override.rule_id} parameters must be a tuple"
                )
            for item in override.parameters:
                if type(item) is not ParameterValue or type(item.name) is not str:
                    raise RuleConfigurationError(
                        f"policy override {override.rule_id} parameter must be exact ParameterValue"
                    )
        for gate in policy.gates:
            if type(gate) is not GateDefinition:
                raise RuleConfigurationError("policy gate must be exact GateDefinition")
            if type(gate.gate_id) is not str or type(gate.title) is not str:
                raise RuleConfigurationError("gate id and title must be strings")
            if type(gate.block_at_or_above) is not Severity:
                raise RuleConfigurationError(f"gate {gate.gate_id} threshold must be Severity")
            for field_name, values, item_type in (
                ("domains", gate.domains, RuleDomain),
                ("rule_ids", gate.rule_ids, str),
                ("exempt_rule_ids", gate.exempt_rule_ids, str),
                (
                    "required_external_evidence_ids",
                    gate.required_external_evidence_ids,
                    str,
                ),
            ):
                if type(values) is not tuple:
                    raise RuleConfigurationError(
                        f"gate {gate.gate_id} {field_name} must be a tuple"
                    )
                if any(type(item) is not item_type for item in values):
                    raise RuleConfigurationError(
                        f"gate {gate.gate_id} {field_name} contains an invalid type"
                    )
                if len(values) != len(set(values)):
                    raise RuleConfigurationError(
                        f"gate {gate.gate_id} {field_name} contains duplicates"
                    )
            if any(not item.strip() for item in gate.required_external_evidence_ids):
                raise RuleConfigurationError(
                    f"gate {gate.gate_id} external evidence ids must be non-empty"
                )

    def _validate_policy(self, policy: VerificationPolicy) -> dict[str, RuleOverride]:
        known = {item.definition.rule_id for item in self._evaluators}
        mandatory_fatal = {
            item.definition.rule_id
            for item in self._evaluators
            if item.definition.mandatory and item.definition.default_severity is Severity.FATAL
        }
        override_ids = [item.rule_id for item in policy.overrides]
        if len(override_ids) != len(set(override_ids)):
            raise RuleConfigurationError("policy contains duplicate rule overrides")
        unknown = sorted(set(override_ids) - known)
        if unknown:
            raise RuleConfigurationError(f"policy overrides unknown rules: {', '.join(unknown)}")
        gate_ids = [item.gate_id for item in policy.gates]
        if len(gate_ids) != len(set(gate_ids)):
            raise RuleConfigurationError("policy contains duplicate gate ids")
        missing_gate_ids = sorted(_REQUIRED_GATE_IDS.difference(gate_ids))
        if missing_gate_ids:
            raise RuleConfigurationError(
                "policy is missing required gates: " + ", ".join(missing_gate_ids)
            )
        for gate in policy.gates:
            if not gate.gate_id.strip():
                raise RuleConfigurationError("gate id must be non-empty")
            unknown_rules = sorted((set(gate.rule_ids) | set(gate.exempt_rule_ids)) - known)
            if unknown_rules:
                raise RuleConfigurationError(
                    f"gate {gate.gate_id} references unknown rules: {', '.join(unknown_rules)}"
                )
            forbidden_exemptions = sorted(set(gate.exempt_rule_ids).intersection(mandatory_fatal))
            if forbidden_exemptions:
                raise RuleConfigurationError(
                    f"gate {gate.gate_id} cannot exempt mandatory fatal rules: "
                    + ", ".join(forbidden_exemptions)
                )
            if gate.gate_id in _REQUIRED_GATE_IDS and (
                gate.domains or gate.rule_ids or gate.exempt_rule_ids
            ):
                raise RuleConfigurationError(
                    f"required gate {gate.gate_id} cannot scope or exempt verification rules"
                )
            maximum_threshold = _MAXIMUM_REQUIRED_GATE_THRESHOLDS.get(gate.gate_id)
            if (
                maximum_threshold is not None
                and gate.block_at_or_above.rank > maximum_threshold.rank
            ):
                raise RuleConfigurationError(
                    f"required gate {gate.gate_id} threshold cannot be weaker than "
                    f"{maximum_threshold.value}"
                )
            if (
                gate.gate_id == "manufacturing-release"
                and _KICAD_EVIDENCE_ID not in gate.required_external_evidence_ids
            ):
                raise RuleConfigurationError(
                    "manufacturing-release requires trusted KiCad DRC evidence"
                )
        for override in policy.overrides:
            minimum_severity = _MINIMUM_RULE_SEVERITIES.get(override.rule_id)
            if (
                minimum_severity is not None
                and override.severity is not None
                and override.severity.rank < minimum_severity.rank
            ):
                raise RuleConfigurationError(
                    f"rule {override.rule_id} severity cannot be weaker than "
                    f"{minimum_severity.value}"
                )
        return {item.rule_id: item for item in policy.overrides}

    @staticmethod
    def _materialize_finding(resolved: ResolvedRule, draft: FindingDraft) -> Finding:
        if type(draft) is not FindingDraft:
            raise VerificationExecutionError("evaluator finding must be exact FindingDraft")
        if type(draft.message) is not str or not draft.message.strip():
            raise VerificationExecutionError("evaluator finding message must be non-empty")
        if type(draft.entities) is not tuple or type(draft.evidence) is not tuple:
            raise VerificationExecutionError("evaluator finding collections must be tuples")
        for entity in draft.entities:
            if (
                type(entity) is not EntityRef
                or type(entity.kind) is not str
                or type(entity.entity_id) is not str
            ):
                raise VerificationExecutionError("evaluator entity must be exact EntityRef")
        for item in draft.evidence:
            if type(item) is not EvidenceItem or type(item.name) is not str:
                raise VerificationExecutionError("evaluator evidence must be exact EvidenceItem")
            values = item.value if type(item.value) is tuple else (item.value,)
            if any(type(value) not in {str, int, bool} for value in values):
                raise VerificationExecutionError("evaluator evidence scalar type is unsupported")
        definition = resolved.evaluator.definition
        normalized = draft.normalized()
        evidence_payload = {
            "rule_id": definition.rule_id,
            "rule_version": definition.version,
            "entities": normalized.entities,
            "evidence": normalized.evidence,
        }
        evidence_hash = stable_hash(evidence_payload, domain="pcb-finding-evidence-v1")
        identity_payload = {
            "rule_id": definition.rule_id,
            "rule_version": definition.version,
            "entities": normalized.entities,
            "evidence_hash": evidence_hash,
        }
        finding_id = "FND-" + stable_hash(identity_payload, domain="pcb-finding-identity-v1")[:24]
        return Finding(
            finding_id,
            definition.rule_id,
            definition.version,
            definition.domain,
            resolved.severity,
            normalized.message,
            normalized.entities,
            normalized.evidence,
            evidence_hash,
        )

    @staticmethod
    def _evaluate_gates(
        gates: tuple[GateDefinition, ...],
        findings: tuple[Finding, ...],
        executions: tuple[RuleExecution, ...],
        definitions: dict[str, RuleDefinition],
        input_hash: str,
        rule_set_hash: str,
    ) -> tuple[GateDecision, ...]:
        decisions: list[GateDecision] = []
        for gate in gates:
            blocking = tuple(
                finding
                for finding in findings
                if finding.severity.rank >= gate.block_at_or_above.rank
                and _gate_selects(gate, definitions[finding.rule_id])
            )
            blocking_ids = tuple(sorted(item.finding_id for item in blocking))
            blocking_rule_ids = tuple(
                sorted(
                    execution.rule_id
                    for execution in executions
                    if execution.outcome is RuleExecutionOutcome.NOT_RUN
                    and _gate_selects(gate, definitions[execution.rule_id])
                )
            )
            unavailable_evidence_ids = gate.required_external_evidence_ids
            evidence_hash = stable_hash(
                {
                    "gate": gate,
                    "input_hash": input_hash,
                    "rule_set_hash": rule_set_hash,
                    "blocking_findings": tuple(
                        (item.finding_id, item.evidence_hash) for item in blocking
                    ),
                    "blocking_not_run_rule_ids": blocking_rule_ids,
                    "unavailable_external_evidence_ids": unavailable_evidence_ids,
                },
                domain="pcb-policy-gate-v1",
            )
            decisions.append(
                GateDecision(
                    gate.gate_id,
                    not blocking_ids and not blocking_rule_ids and not unavailable_evidence_ids,
                    blocking_ids,
                    blocking_rule_ids,
                    unavailable_evidence_ids,
                    evidence_hash,
                )
            )
        return tuple(sorted(decisions, key=lambda item: item.gate_id))
