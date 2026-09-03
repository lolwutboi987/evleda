"""Deterministically assemble and verify the first complete reference board."""

from __future__ import annotations

from dataclasses import dataclass, replace

from backend.design_kernel import (
    DesignGraph,
    DesignRevision,
    FootprintPad,
    PinRef,
    PointNm,
    revision_to_verification_board,
    stable_hash,
    validate_graph,
)
from backend.verification import BoardGraph, VerificationEngine, VerificationReport
from backend.verification import stable_hash as verification_stable_hash

from .circuit import CircuitTopology, build_circuit
from .footprints import build_footprints
from .layout import build_layout
from .specification import (
    BOARD_HEIGHT_NM,
    BOARD_WIDTH_NM,
    PROJECT_ID,
    bom,
    components,
    sources,
)


def _board_outline() -> tuple[PointNm, ...]:
    return (
        PointNm(0, 0),
        PointNm(BOARD_WIDTH_NM, 0),
        PointNm(BOARD_WIDTH_NM, BOARD_HEIGHT_NM),
        PointNm(0, BOARD_HEIGHT_NM),
    )


class ReferenceBoardBuildError(RuntimeError):
    """The deterministic reference board could not satisfy its technical gates."""


def _require_sha256(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ReferenceBoardBuildError(f"{label} must be a lowercase SHA-256 digest")
    return value


def _analog_bias_proof_hash(graph: DesignGraph) -> str:
    """Prove the exact evidence-bound VBUS-to-ground EN/UVLO divider subject."""

    if type(graph) is not DesignGraph:
        raise ReferenceBoardBuildError("analog-bias proof requires exact DesignGraph")
    expected_circuit = build_circuit()
    if graph.nets != expected_circuit.nets:
        raise ReferenceBoardBuildError("analog-bias proof requires the exact reviewed netlist")

    expected_components = {
        component.component_id: component.normalized()
        for component in components()
        if component.component_id in {"efuse-u1", "en-hi-r6", "en-lo-r7"}
    }
    actual_components = {
        component.component_id: component
        for component in graph.components
        if component.component_id in expected_components
    }
    if actual_components != expected_components:
        raise ReferenceBoardBuildError(
            "analog-bias proof requires exact U1/R6/R7 part, value, datasheet, and pin-map evidence"
        )

    net_index = {net.net_id: net for net in graph.nets}
    required_members = {
        "net-en-uvlo": {
            PinRef("efuse-u1", "3"),
            PinRef("en-hi-r6", "2"),
            PinRef("en-lo-r7", "1"),
        },
        "net-vbus-raw": {
            PinRef("usb-j1", "A4"),
            PinRef("en-hi-r6", "1"),
        },
        "net-gnd": {PinRef("en-lo-r7", "2")},
    }
    for net_id, members in required_members.items():
        net = net_index.get(net_id)
        if net is None or not members.issubset(net.members):
            raise ReferenceBoardBuildError(f"analog-bias proof is missing {net_id} membership")
    if set(net_index["net-en-uvlo"].members) != required_members["net-en-uvlo"]:
        raise ReferenceBoardBuildError("EN_UVLO contains an unreviewed extra member")

    pad_index: dict[tuple[str, str], list[FootprintPad]] = {}
    for pad in graph.pads:
        pad_index.setdefault((pad.component_id, pad.pad_number), []).append(pad)
    logical_to_pad = {
        (component.component_id, pin.number): pin.pad_number
        for component in graph.components
        for pin in component.pins
    }
    for net_id, members in required_members.items():
        for member in members:
            pad_number = logical_to_pad.get((member.component_id, member.pin_number))
            physical = pad_index.get((member.component_id, pad_number or ""), [])
            if not physical or any(pad.net_id != net_id for pad in physical):
                raise ReferenceBoardBuildError(
                    "analog-bias physical binding disagrees at "
                    f"{member.component_id}:{member.pin_number}"
                )

    evidence_sources = tuple(
        source
        for source in sources()
        if source.evidence_id in {"src-tps2596", "src-vishay-resistors"}
    )
    evidence_bom = tuple(
        line for line in bom() if line.component_id in expected_components
    )
    if len(evidence_sources) != 2 or len(evidence_bom) != 3:
        raise ReferenceBoardBuildError("analog-bias BOM/source evidence closure is incomplete")
    return stable_hash(
        {
            "proof_version": "analog-bias-v1",
            "graph_hash": graph.graph_hash,
            "components": tuple(actual_components[item] for item in sorted(actual_components)),
            "nets": tuple(net_index[item] for item in sorted(required_members)),
            "pads": tuple(
                sorted(
                    (
                        pad
                        for key in sorted(pad_index)
                        if PinRef(*key) in set().union(*required_members.values())
                        for pad in pad_index[key]
                    ),
                    key=lambda pad: pad.pad_id,
                )
            ),
            "bom": evidence_bom,
            "sources": evidence_sources,
        },
        domain="flux-clone-reference-analog-bias-proof-v1",
    )


def _verification_board(revision: DesignRevision) -> BoardGraph:
    """Adapt the graph and identify the one intentionally analog-biased input net.

    The generic verifier's input-driver rule has no resistor-divider source
    type.  ``EN_UVLO`` is driven by the VBUS_RAW-to-GND divider, not a strong
    digital output, so its verification net explicitly carries the existing
    ``external_source`` escape hatch.  The embedded revision hash still binds
    this projection to the complete canonical graph.
    """

    proof_hash = _analog_bias_proof_hash(revision.graph)
    subject_hash = stable_hash(
        {
            "revision_hash": revision.revision_hash,
            "analog_bias_proof_hash": proof_hash,
        },
        domain="flux-clone-reference-native-verification-subject-v1",
    )
    board = replace(revision_to_verification_board(revision), revision=subject_hash)
    return replace(
        board,
        nets=tuple(
            replace(net, external_source=net.net_id == "net-en-uvlo")
            for net in board.nets
        ),
    ).normalized()


def _bind_pad_nets(
    circuit: CircuitTopology,
    pads: tuple[FootprintPad, ...],
) -> tuple[FootprintPad, ...]:
    """Bind transport-neutral footprint copper to the exact logical membership."""

    if type(circuit) is not CircuitTopology or type(pads) is not tuple:
        raise ReferenceBoardBuildError("pad binding requires exact circuit and pad tuple")
    if any(type(pad) is not FootprintPad for pad in pads):
        raise ReferenceBoardBuildError("pad binding accepts only exact FootprintPad values")
    if any(pad.net_id is not None for pad in pads):
        raise ReferenceBoardBuildError("footprint source pads must be transport-neutral")

    pin_nets: dict[PinRef, str] = {}
    for net in circuit.nets:
        for member in net.members:
            if member in pin_nets:
                raise ReferenceBoardBuildError("logical pin belongs to multiple nets")
            pin_nets[member] = net.net_id
    no_connects = set(circuit.no_connects)
    component_set = components()
    pin_by_physical_pad = {
        (component.component_id, pin.pad_number): pin
        for component in component_set
        for pin in component.pins
    }
    if len(pin_by_physical_pad) != sum(len(component.pins) for component in component_set):
        raise ReferenceBoardBuildError("component pin map has ambiguous physical pad numbers")
    expected_pads = {
        (component.component_id, pin.pad_number)
        for component in components()
        for pin in component.pins
    }
    actual_pads = {(pad.component_id, pad.pad_number) for pad in pads}
    if actual_pads != expected_pads:
        missing = tuple(sorted(expected_pads - actual_pads))
        unexpected = tuple(sorted(actual_pads - expected_pads))
        raise ReferenceBoardBuildError(
            f"physical pad coverage mismatch; missing={missing!r}, unexpected={unexpected!r}"
        )

    bound: list[FootprintPad] = []
    for pad in pads:
        definition = pin_by_physical_pad.get((pad.component_id, pad.pad_number))
        if definition is None:
            raise ReferenceBoardBuildError(f"physical pad {pad.pad_id} has no pin-map subject")
        logical_pin = PinRef(pad.component_id, definition.number)
        if logical_pin in no_connects:
            expected_net = None
        else:
            expected_net = pin_nets.get(logical_pin)
            if expected_net is None:
                raise ReferenceBoardBuildError(f"physical pad {pad.pad_id} has no logical subject")
        bound.append(replace(pad, net_id=expected_net))

    groups: dict[str, set[str | None]] = {}
    for pad in bound:
        if pad.shared_land_group_id is not None:
            groups.setdefault(pad.shared_land_group_id, set()).add(pad.net_id)
    if any(len(net_ids) != 1 for net_ids in groups.values()):
        raise ReferenceBoardBuildError("shared physical land carries mixed logical nets")
    return tuple(bound)


@dataclass(frozen=True, slots=True)
class ReferenceBoardBuild:
    """The normalized graph, genesis revision, and exact native verification result."""

    graph: DesignGraph
    revision: DesignRevision
    native_report: VerificationReport
    graph_hash: str
    revision_hash: str
    analog_bias_proof_hash: str

    def __post_init__(self) -> None:
        if type(self) is not ReferenceBoardBuild:
            raise ReferenceBoardBuildError("reference build must be exact ReferenceBoardBuild")
        if type(self.graph) is not DesignGraph or type(self.revision) is not DesignRevision:
            raise ReferenceBoardBuildError(
                "reference build requires exact kernel graph and revision"
            )
        if type(self.native_report) is not VerificationReport:
            raise ReferenceBoardBuildError("reference build requires an exact native report")
        _require_sha256(self.graph_hash, "reference graph hash")
        _require_sha256(self.revision_hash, "reference revision hash")
        _require_sha256(self.analog_bias_proof_hash, "analog-bias proof hash")
        if self.graph != self.graph.normalized():
            raise ReferenceBoardBuildError("reference graph must already be normalized")
        validate_graph(self.graph)
        if self.graph_hash != self.graph.graph_hash:
            raise ReferenceBoardBuildError("reference graph hash is inconsistent")
        if (
            self.revision_hash != self.revision.revision_hash
            or self.revision.graph != self.graph
            or self.revision.graph_hash != self.graph_hash
        ):
            raise ReferenceBoardBuildError("reference revision does not bind the exact graph")
        if self.analog_bias_proof_hash != _analog_bias_proof_hash(self.graph):
            raise ReferenceBoardBuildError("analog-bias proof hash is inconsistent")

        verification_board = _verification_board(self.revision)
        expected_input_hash = verification_stable_hash(
            verification_board.normalized(),
            domain="pcb-board-graph-v2",
        )
        if self.native_report.input_hash != expected_input_hash:
            raise ReferenceBoardBuildError("native report does not bind the exact revision")
        gates = {gate.gate_id: gate for gate in self.native_report.gates}
        if set(gates) != {"preview", "commit", "manufacturing-release"}:
            raise ReferenceBoardBuildError("native report has an unexpected gate set")
        if not gates["preview"].passed or not gates["commit"].passed:
            raise ReferenceBoardBuildError("reference board does not pass preview and commit gates")
        if gates["manufacturing-release"].passed:
            raise ReferenceBoardBuildError(
                "native verification cannot authorize manufacturing without trusted KiCad evidence"
            )

    @property
    def preview_gate_passed(self) -> bool:
        return next(gate for gate in self.native_report.gates if gate.gate_id == "preview").passed

    @property
    def commit_gate_passed(self) -> bool:
        return next(gate for gate in self.native_report.gates if gate.gate_id == "commit").passed

    @property
    def manufacturing_release_passed(self) -> bool:
        return next(
            gate for gate in self.native_report.gates if gate.gate_id == "manufacturing-release"
        ).passed


def build_reference_board() -> ReferenceBoardBuild:
    """Build the exact reference board and fail closed unless native technical gates pass."""

    circuit = build_circuit()
    placements, pads, holes = build_footprints()
    placements = tuple(replace(placement, locked=False) for placement in placements)
    pads = _bind_pad_nets(circuit, pads)
    tracks, vias, zones = build_layout()
    graph = DesignGraph(
        schema_version=1,
        project_id=PROJECT_ID,
        layers=("F.Cu", "B.Cu"),
        board_outline=_board_outline(),
        components=components(),
        nets=circuit.nets,
        placements=placements,
        tracks=tracks,
        pads=pads,
        holes=holes,
        vias=vias,
        zones=zones,
        schematic_wires=circuit.wires,
        schematic_junctions=circuit.junctions,
    ).normalized()
    validate_graph(graph)
    graph_hash = graph.graph_hash
    revision_hash = stable_hash(
        {"parent": None, "sequence": 0, "graph_hash": graph_hash},
        domain="flux-clone-design-revision-v1",
    )
    revision = DesignRevision(
        revision_hash,
        None,
        0,
        graph,
        graph_hash,
        (),
        None,
        None,
    )
    analog_bias_proof_hash = _analog_bias_proof_hash(graph)
    native_report = VerificationEngine().verify(_verification_board(revision))
    return ReferenceBoardBuild(
        graph,
        revision,
        native_report,
        graph_hash,
        revision_hash,
        analog_bias_proof_hash,
    )


__all__ = (
    "ReferenceBoardBuild",
    "ReferenceBoardBuildError",
    "build_reference_board",
)
