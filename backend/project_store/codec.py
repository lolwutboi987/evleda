"""Strict, lossless canonical JSON codec for design-kernel state."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import fields
from datetime import UTC, datetime
from typing import Any, TypeVar, cast

from backend.design_kernel import (
    CommandKind,
    Component,
    CopperZone,
    DesignCommand,
    DesignGraph,
    DesignRevision,
    DesignTransaction,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
    SchematicJunction,
    SchematicWire,
    Track,
    TransactionState,
    Via,
    ZoneFillEvidence,
    ZoneFillState,
    canonical_data,
    stable_hash,
    validate_graph,
)

from .models import (
    ApprovalDecision,
    ApprovalEvidence,
    DurableCommitAttestation,
    IntegrityError,
    UnsupportedStoreSchema,
)

DOCUMENT_VERSION = 5
_GRAPH_FIELDS = (
    "schema_version",
    "project_id",
    "layers",
    "board_outline",
    "components",
    "nets",
    "placements",
    "tracks",
    "pads",
    "holes",
    "vias",
    "zones",
    "schematic_wires",
    "schematic_junctions",
)


def _reject_float(value: str) -> None:
    raise IntegrityError(f"floating-point JSON values are forbidden: {value}")


def _reject_constant(value: str) -> None:
    raise IntegrityError(f"non-finite JSON values are forbidden: {value}")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise IntegrityError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _canonical_json(value: Any) -> str:
    try:
        return json.dumps(
            canonical_data(value),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise IntegrityError("value cannot be represented as canonical JSON") from exc


def _decode_json(body: str) -> dict[str, Any]:
    if type(body) is not str:
        raise IntegrityError("stored document body must be text")
    try:
        value = json.loads(
            body,
            object_pairs_hook=_unique_object,
            parse_float=_reject_float,
            parse_constant=_reject_constant,
        )
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise IntegrityError("stored document is not valid canonical JSON") from exc
    if type(value) is not dict or _canonical_json(value) != body:
        raise IntegrityError("stored document is not canonical JSON")
    return cast(dict[str, Any], value)


def body_sha256(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8", errors="strict")).hexdigest()


def _expect_object(value: Any, label: str) -> dict[str, Any]:
    if type(value) is not dict:
        raise IntegrityError(f"{label} must be an object")
    return cast(dict[str, Any], value)


def _expect_keys(value: Mapping[str, Any], expected: tuple[str, ...], label: str) -> None:
    actual = set(value)
    wanted = set(expected)
    if actual != wanted:
        missing = ",".join(sorted(wanted - actual)) or "none"
        unknown = ",".join(sorted(actual - wanted)) or "none"
        raise IntegrityError(f"{label} fields differ (missing={missing}; unknown={unknown})")


def _expect_list(value: Any, label: str) -> list[Any]:
    if type(value) is not list:
        raise IntegrityError(f"{label} must be an array")
    return cast(list[Any], value)


def _expect_str(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise IntegrityError(f"{label} must be text")
    return value


def _expect_optional_str(value: Any, label: str) -> str | None:
    if value is not None and not isinstance(value, str):
        raise IntegrityError(f"{label} must be text or null")
    return value


def _expect_int(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise IntegrityError(f"{label} must be an integer")
    return value


def _expect_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise IntegrityError(f"{label} must be a boolean")
    return value


def _strings(value: Any, label: str) -> tuple[str, ...]:
    return tuple(_expect_str(item, f"{label} item") for item in _expect_list(value, label))


def _point(value: Any, label: str) -> PointNm:
    obj = _expect_object(value, label)
    _expect_keys(obj, ("x", "y"), label)
    return PointNm(_expect_int(obj["x"], f"{label}.x"), _expect_int(obj["y"], f"{label}.y"))


T = TypeVar("T")


def _objects(value: Any, label: str, decoder: Callable[[dict[str, Any], str], T]) -> tuple[T, ...]:
    return tuple(
        decoder(_expect_object(item, f"{label}[{index}]"), f"{label}[{index}]")
        for index, item in enumerate(_expect_list(value, label))
    )


def _pin_definition(value: dict[str, Any], label: str) -> PinDefinition:
    _expect_keys(value, ("number", "name", "electrical_type", "pad_number", "required"), label)
    return PinDefinition(
        _expect_str(value["number"], f"{label}.number"),
        _expect_str(value["name"], f"{label}.name"),
        _expect_str(value["electrical_type"], f"{label}.electrical_type"),
        _expect_str(value["pad_number"], f"{label}.pad_number"),
        _expect_bool(value["required"], f"{label}.required"),
    )


def _pin_ref(value: dict[str, Any], label: str) -> PinRef:
    _expect_keys(value, ("component_id", "pin_number"), label)
    return PinRef(
        _expect_str(value["component_id"], f"{label}.component_id"),
        _expect_str(value["pin_number"], f"{label}.pin_number"),
    )


def _component(value: dict[str, Any], label: str) -> Component:
    expected = (
        "component_id", "reference", "value", "manufacturer_part_number", "package",
        "symbol_id", "footprint_id", "datasheet_sha256", "pin_map_sha256", "pins",
    )
    _expect_keys(value, expected, label)
    return Component(
        component_id=_expect_str(value["component_id"], f"{label}.component_id"),
        reference=_expect_str(value["reference"], f"{label}.reference"),
        value=_expect_str(value["value"], f"{label}.value"),
        manufacturer_part_number=_expect_str(
            value["manufacturer_part_number"],
            f"{label}.manufacturer_part_number",
        ),
        package=_expect_str(value["package"], f"{label}.package"),
        symbol_id=_expect_str(value["symbol_id"], f"{label}.symbol_id"),
        footprint_id=_expect_str(value["footprint_id"], f"{label}.footprint_id"),
        datasheet_sha256=_expect_str(value["datasheet_sha256"], f"{label}.datasheet_sha256"),
        pin_map_sha256=_expect_str(value["pin_map_sha256"], f"{label}.pin_map_sha256"),
        pins=_objects(value["pins"], f"{label}.pins", _pin_definition),
    )


def _net(value: dict[str, Any], label: str) -> Net:
    _expect_keys(value, ("net_id", "name", "members"), label)
    return Net(
        _expect_str(value["net_id"], f"{label}.net_id"),
        _expect_str(value["name"], f"{label}.name"),
        _objects(value["members"], f"{label}.members", _pin_ref),
    )


def _placement(value: dict[str, Any], label: str) -> FootprintPlacement:
    _expect_keys(value, ("component_id", "position", "rotation_udeg", "side", "locked"), label)
    return FootprintPlacement(
        _expect_str(value["component_id"], f"{label}.component_id"),
        _point(value["position"], f"{label}.position"),
        _expect_int(value["rotation_udeg"], f"{label}.rotation_udeg"),
        _expect_str(value["side"], f"{label}.side"),
        _expect_bool(value["locked"], f"{label}.locked"),
    )


def _track(value: dict[str, Any], label: str) -> Track:
    _expect_keys(
        value,
        ("track_id", "net_id", "layer", "start", "end", "width_nm", "locked"),
        label,
    )
    return Track(
        _expect_str(value["track_id"], f"{label}.track_id"),
        _expect_str(value["net_id"], f"{label}.net_id"),
        _expect_str(value["layer"], f"{label}.layer"),
        _point(value["start"], f"{label}.start"),
        _point(value["end"], f"{label}.end"),
        _expect_int(value["width_nm"], f"{label}.width_nm"),
        _expect_bool(value["locked"], f"{label}.locked"),
    )


def _pad(value: dict[str, Any], label: str) -> FootprintPad:
    expected = (
        "pad_id", "component_id", "pad_number", "center", "size_x_nm", "size_y_nm",
        "shape", "rotation_udeg", "layers", "pad_drill_nm", "net_id", "locked",
        "drill_x_nm", "drill_y_nm", "drill_rotation_udeg", "shared_land_group_id",
    )
    _expect_keys(value, expected, label)
    return FootprintPad(
        pad_id=_expect_str(value["pad_id"], f"{label}.pad_id"),
        component_id=_expect_str(value["component_id"], f"{label}.component_id"),
        pad_number=_expect_str(value["pad_number"], f"{label}.pad_number"),
        center=_point(value["center"], f"{label}.center"),
        size_x_nm=_expect_int(value["size_x_nm"], f"{label}.size_x_nm"),
        size_y_nm=_expect_int(value["size_y_nm"], f"{label}.size_y_nm"),
        shape=_expect_str(value["shape"], f"{label}.shape"),
        rotation_udeg=_expect_int(value["rotation_udeg"], f"{label}.rotation_udeg"),
        layers=_strings(value["layers"], f"{label}.layers"),
        pad_drill_nm=_expect_int(value["pad_drill_nm"], f"{label}.pad_drill_nm"),
        net_id=_expect_optional_str(value["net_id"], f"{label}.net_id"),
        locked=_expect_bool(value["locked"], f"{label}.locked"),
        drill_x_nm=_expect_int(value["drill_x_nm"], f"{label}.drill_x_nm"),
        drill_y_nm=_expect_int(value["drill_y_nm"], f"{label}.drill_y_nm"),
        drill_rotation_udeg=_expect_int(
            value["drill_rotation_udeg"], f"{label}.drill_rotation_udeg"
        ),
        shared_land_group_id=_expect_optional_str(
            value["shared_land_group_id"], f"{label}.shared_land_group_id"
        ),
    )


def _hole(value: dict[str, Any], label: str) -> FootprintHole:
    _expect_keys(
        value,
        (
            "hole_id",
            "component_id",
            "center",
            "diameter_nm",
            "plated",
            "pad_id",
            "locked",
            "drill_x_nm",
            "drill_y_nm",
            "drill_rotation_udeg",
        ),
        label,
    )
    return FootprintHole(
        hole_id=_expect_str(value["hole_id"], f"{label}.hole_id"),
        component_id=_expect_str(value["component_id"], f"{label}.component_id"),
        center=_point(value["center"], f"{label}.center"),
        diameter_nm=_expect_int(value["diameter_nm"], f"{label}.diameter_nm"),
        plated=_expect_bool(value["plated"], f"{label}.plated"),
        pad_id=_expect_optional_str(value["pad_id"], f"{label}.pad_id"),
        locked=_expect_bool(value["locked"], f"{label}.locked"),
        drill_x_nm=_expect_int(value["drill_x_nm"], f"{label}.drill_x_nm"),
        drill_y_nm=_expect_int(value["drill_y_nm"], f"{label}.drill_y_nm"),
        drill_rotation_udeg=_expect_int(
            value["drill_rotation_udeg"], f"{label}.drill_rotation_udeg"
        ),
    )


def _via(value: dict[str, Any], label: str) -> Via:
    _expect_keys(
        value,
        ("via_id", "net_id", "center", "diameter_nm", "drill_nm", "layers", "locked"),
        label,
    )
    return Via(
        _expect_str(value["via_id"], f"{label}.via_id"),
        _expect_str(value["net_id"], f"{label}.net_id"),
        _point(value["center"], f"{label}.center"),
        _expect_int(value["diameter_nm"], f"{label}.diameter_nm"),
        _expect_int(value["drill_nm"], f"{label}.drill_nm"),
        _strings(value["layers"], f"{label}.layers"),
        _expect_bool(value["locked"], f"{label}.locked"),
    )


def _zone(value: dict[str, Any], label: str) -> CopperZone:
    expected = (
        "zone_id",
        "net_id",
        "layer",
        "outline",
        "clearance_nm",
        "min_thickness_nm",
        "priority",
        "locked",
        "fill_state",
        "fill_evidence",
    )
    _expect_keys(value, expected, label)
    evidence_value = value["fill_evidence"]
    evidence: ZoneFillEvidence | None
    if evidence_value is None:
        evidence = None
    else:
        evidence_obj = _expect_object(evidence_value, f"{label}.fill_evidence")
        _expect_keys(
            evidence_obj,
            (
                "source_graph_hash",
                "source_revision",
                "fill_engine_id",
                "fill_engine_revision",
                "filled_geometry_hash",
                "evidence_hash",
            ),
            f"{label}.fill_evidence",
        )
        evidence = ZoneFillEvidence(
            source_graph_hash=_expect_str(
                evidence_obj["source_graph_hash"], f"{label}.fill_evidence.source_graph_hash"
            ),
            source_revision=_expect_str(
                evidence_obj["source_revision"], f"{label}.fill_evidence.source_revision"
            ),
            fill_engine_id=_expect_str(
                evidence_obj["fill_engine_id"], f"{label}.fill_evidence.fill_engine_id"
            ),
            fill_engine_revision=_expect_str(
                evidence_obj["fill_engine_revision"],
                f"{label}.fill_evidence.fill_engine_revision",
            ),
            filled_geometry_hash=_expect_str(
                evidence_obj["filled_geometry_hash"],
                f"{label}.fill_evidence.filled_geometry_hash",
            ),
            evidence_hash=_expect_str(
                evidence_obj["evidence_hash"], f"{label}.fill_evidence.evidence_hash"
            ),
        )
    state_value = _expect_str(value["fill_state"], f"{label}.fill_state")
    try:
        fill_state = ZoneFillState(state_value)
    except ValueError as exc:
        raise IntegrityError(f"{label}.fill_state is not a supported zone fill state") from exc
    return CopperZone(
        _expect_str(value["zone_id"], f"{label}.zone_id"),
        _expect_str(value["net_id"], f"{label}.net_id"),
        _expect_str(value["layer"], f"{label}.layer"),
        tuple(
            _point(item, f"{label}.outline[{index}]")
            for index, item in enumerate(
                _expect_list(value["outline"], f"{label}.outline")
            )
        ),
        _expect_int(value["clearance_nm"], f"{label}.clearance_nm"),
        _expect_int(value["min_thickness_nm"], f"{label}.min_thickness_nm"),
        _expect_int(value["priority"], f"{label}.priority"),
        _expect_bool(value["locked"], f"{label}.locked"),
        fill_state,
        evidence,
    )


def _wire(value: dict[str, Any], label: str) -> SchematicWire:
    _expect_keys(value, ("wire_id", "net_id", "vertices", "sheet_id", "locked"), label)
    return SchematicWire(
        _expect_str(value["wire_id"], f"{label}.wire_id"),
        _expect_str(value["net_id"], f"{label}.net_id"),
        tuple(
            _point(item, f"{label}.vertices[{index}]")
            for index, item in enumerate(
                _expect_list(value["vertices"], f"{label}.vertices")
            )
        ),
        _expect_str(value["sheet_id"], f"{label}.sheet_id"),
        _expect_bool(value["locked"], f"{label}.locked"),
    )


def _junction(value: dict[str, Any], label: str) -> SchematicJunction:
    _expect_keys(value, ("junction_id", "net_id", "position", "sheet_id", "locked"), label)
    return SchematicJunction(
        _expect_str(value["junction_id"], f"{label}.junction_id"),
        _expect_str(value["net_id"], f"{label}.net_id"),
        _point(value["position"], f"{label}.position"),
        _expect_str(value["sheet_id"], f"{label}.sheet_id"),
        _expect_bool(value["locked"], f"{label}.locked"),
    )


def graph_payload(graph: DesignGraph) -> dict[str, Any]:
    runtime_fields = tuple(field.name for field in fields(DesignGraph))
    if runtime_fields != _GRAPH_FIELDS:
        raise UnsupportedStoreSchema(
            "DesignGraph fields changed; a reviewed project-store codec migration is required"
        )
    normalized = graph.normalized()
    validate_graph(normalized)
    if normalized != graph:
        raise IntegrityError("only normalized DesignGraph values may cross the durable boundary")
    payload = _expect_object(canonical_data(normalized), "DesignGraph")
    _expect_keys(payload, _GRAPH_FIELDS, "DesignGraph")
    return payload


def graph_from_payload(value: Any) -> DesignGraph:
    runtime_fields = tuple(field.name for field in fields(DesignGraph))
    if runtime_fields != _GRAPH_FIELDS:
        raise UnsupportedStoreSchema(
            "DesignGraph fields changed; a reviewed project-store codec migration is required"
        )
    obj = _expect_object(value, "DesignGraph")
    _expect_keys(obj, _GRAPH_FIELDS, "DesignGraph")
    try:
        graph = DesignGraph(
            schema_version=_expect_int(
                obj["schema_version"], "DesignGraph.schema_version"
            ),
            project_id=_expect_str(obj["project_id"], "DesignGraph.project_id"),
            layers=_strings(obj["layers"], "DesignGraph.layers"),
            board_outline=tuple(
                _point(item, f"DesignGraph.board_outline[{index}]")
                for index, item in enumerate(
                    _expect_list(obj["board_outline"], "DesignGraph.board_outline")
                )
            ),
            components=_objects(
                obj["components"], "DesignGraph.components", _component
            ),
            nets=_objects(obj["nets"], "DesignGraph.nets", _net),
            placements=_objects(
                obj["placements"], "DesignGraph.placements", _placement
            ),
            tracks=_objects(obj["tracks"], "DesignGraph.tracks", _track),
            pads=_objects(obj["pads"], "DesignGraph.pads", _pad),
            holes=_objects(obj["holes"], "DesignGraph.holes", _hole),
            vias=_objects(obj["vias"], "DesignGraph.vias", _via),
            zones=_objects(obj["zones"], "DesignGraph.zones", _zone),
            schematic_wires=_objects(
                obj["schematic_wires"], "DesignGraph.schematic_wires", _wire
            ),
            schematic_junctions=_objects(
                obj["schematic_junctions"],
                "DesignGraph.schematic_junctions",
                _junction,
            ),
        )
        validate_graph(graph)
    except ValueError as exc:
        raise IntegrityError("stored DesignGraph violates canonical invariants") from exc
    if graph.normalized() != graph:
        raise IntegrityError("stored DesignGraph is not normalized")
    return graph


def _command_payload(command: DesignCommand) -> dict[str, Any]:
    return {
        "actor": command.actor,
        "base_revision": command.base_revision,
        "command_hash": command.command_hash,
        "command_id": command.command_id,
        "idempotency_key": command.idempotency_key,
        "kind": command.kind.value,
        "payload_json": command.payload_json,
        "transaction_id": command.transaction_id,
    }


def _command(value: dict[str, Any], label: str) -> DesignCommand:
    expected = (
        "actor",
        "base_revision",
        "command_hash",
        "command_id",
        "idempotency_key",
        "kind",
        "payload_json",
        "transaction_id",
    )
    _expect_keys(value, expected, label)
    try:
        command = DesignCommand(
            command_id=_expect_str(value["command_id"], f"{label}.command_id"),
            base_revision=_expect_str(value["base_revision"], f"{label}.base_revision"),
            transaction_id=_expect_str(value["transaction_id"], f"{label}.transaction_id"),
            actor=_expect_str(value["actor"], f"{label}.actor"),
            kind=CommandKind(_expect_str(value["kind"], f"{label}.kind")),
            payload_json=_expect_str(value["payload_json"], f"{label}.payload_json"),
            idempotency_key=_expect_str(value["idempotency_key"], f"{label}.idempotency_key"),
        )
    except ValueError as exc:
        raise IntegrityError(f"{label} is invalid") from exc
    if command.command_hash != _expect_str(value["command_hash"], f"{label}.command_hash"):
        raise IntegrityError(f"{label} hash mismatch")
    return command


def revision_payload(revision: DesignRevision) -> dict[str, Any]:
    return {
        "approval_preview_digest": revision.approval_preview_digest,
        "command_hashes": list(revision.command_hashes),
        "graph": graph_payload(revision.graph),
        "graph_hash": revision.graph_hash,
        "parent_revision": revision.parent_revision,
        "revision_hash": revision.revision_hash,
        "sequence": revision.sequence,
        "verification_report_hash": revision.verification_report_hash,
    }


def revision_from_payload(value: Any) -> DesignRevision:
    obj = _expect_object(value, "DesignRevision")
    expected = (
        "approval_preview_digest",
        "command_hashes",
        "graph",
        "graph_hash",
        "parent_revision",
        "revision_hash",
        "sequence",
        "verification_report_hash",
    )
    _expect_keys(obj, expected, "DesignRevision")
    try:
        revision = DesignRevision(
            revision_hash=_expect_str(
                obj["revision_hash"], "DesignRevision.revision_hash"
            ),
            parent_revision=_expect_optional_str(
                obj["parent_revision"], "DesignRevision.parent_revision"
            ),
            sequence=_expect_int(obj["sequence"], "DesignRevision.sequence"),
            graph=graph_from_payload(obj["graph"]),
            graph_hash=_expect_str(obj["graph_hash"], "DesignRevision.graph_hash"),
            command_hashes=_strings(
                obj["command_hashes"], "DesignRevision.command_hashes"
            ),
            verification_report_hash=_expect_optional_str(
                obj["verification_report_hash"],
                "DesignRevision.verification_report_hash",
            ),
            approval_preview_digest=_expect_optional_str(
                obj["approval_preview_digest"],
                "DesignRevision.approval_preview_digest",
            ),
        )
    except ValueError as exc:
        raise IntegrityError("stored DesignRevision violates canonical invariants") from exc
    expected_hash = revision_hash_for(revision)
    if revision.revision_hash != expected_hash:
        raise IntegrityError("revision hash does not match its canonical contents")
    return revision


def revision_hash_for(revision: DesignRevision) -> str:
    if revision.sequence == 0:
        material: dict[str, Any] = {
            "parent": None,
            "sequence": 0,
            "graph_hash": revision.graph_hash,
        }
    else:
        material = {
            "parent": revision.parent_revision,
            "sequence": revision.sequence,
            "graph_hash": revision.graph_hash,
            "commands": revision.command_hashes,
            "verification_report_hash": revision.verification_report_hash,
            "approval_preview_digest": revision.approval_preview_digest,
        }
    return stable_hash(material, domain="flux-clone-design-revision-v1")


def transaction_payload(transaction: DesignTransaction) -> dict[str, Any]:
    return {
        "base_revision": transaction.base_revision,
        "commands": [_command_payload(command) for command in transaction.commands],
        "commit_gate_passed": transaction.commit_gate_passed,
        "committed_revision_hash": transaction.committed_revision_hash,
        "preview_digest": transaction.preview_digest,
        "staged_graph": graph_payload(transaction.staged_graph),
        "state": transaction.state.value,
        "transaction_id": transaction.transaction_id,
        "verification_preview_digest": transaction.verification_preview_digest,
        "verification_report_hash": transaction.verification_report_hash,
    }


def transaction_from_payload(value: Any) -> DesignTransaction:
    obj = _expect_object(value, "DesignTransaction")
    expected = (
        "base_revision", "commands", "commit_gate_passed", "committed_revision_hash",
        "preview_digest", "staged_graph", "state", "transaction_id",
        "verification_preview_digest", "verification_report_hash",
    )
    _expect_keys(obj, expected, "DesignTransaction")
    try:
        return DesignTransaction(
            transaction_id=_expect_str(obj["transaction_id"], "DesignTransaction.transaction_id"),
            base_revision=_expect_str(obj["base_revision"], "DesignTransaction.base_revision"),
            staged_graph=graph_from_payload(obj["staged_graph"]),
            commands=_objects(obj["commands"], "DesignTransaction.commands", _command),
            state=TransactionState(_expect_str(obj["state"], "DesignTransaction.state")),
            verification_report_hash=_expect_optional_str(
                obj["verification_report_hash"],
                "DesignTransaction.verification_report_hash",
            ),
            commit_gate_passed=_expect_bool(
                obj["commit_gate_passed"],
                "DesignTransaction.commit_gate_passed",
            ),
            preview_digest=_expect_str(obj["preview_digest"], "DesignTransaction.preview_digest"),
            verification_preview_digest=_expect_optional_str(
                obj["verification_preview_digest"],
                "DesignTransaction.verification_preview_digest",
            ),
            committed_revision_hash=_expect_optional_str(
                obj["committed_revision_hash"],
                "DesignTransaction.committed_revision_hash",
            ),
        )
    except ValueError as exc:
        raise IntegrityError("stored DesignTransaction is invalid") from exc


def approval_payload(approval: ApprovalEvidence) -> dict[str, Any]:
    decided_at = (
        approval.decided_at.astimezone(UTC)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )
    return {
        "actor": approval.actor,
        "approval_id": approval.approval_id,
        "approval_digest": approval.approval_digest,
        "decided_at": decided_at,
        "decision": approval.decision.value,
        "preview_digest": approval.preview_digest,
        "reason": approval.reason,
        "release_subject_digest": approval.release_subject_digest,
        "transaction_id": approval.transaction_id,
        "verification_report_hash": approval.verification_report_hash,
    }


def approval_from_payload(value: Any) -> ApprovalEvidence:
    obj = _expect_object(value, "ApprovalEvidence")
    expected = (
        "actor",
        "approval_id",
        "approval_digest",
        "decided_at",
        "decision",
        "preview_digest",
        "reason",
        "release_subject_digest",
        "transaction_id",
        "verification_report_hash",
    )
    _expect_keys(obj, expected, "ApprovalEvidence")
    timestamp = _expect_str(obj["decided_at"], "ApprovalEvidence.decided_at")
    if not timestamp.endswith("Z"):
        raise IntegrityError("approval time must use canonical UTC Z form")
    try:
        decided_at = datetime.fromisoformat(timestamp[:-1] + "+00:00")
        decision = ApprovalDecision(_expect_str(obj["decision"], "ApprovalEvidence.decision"))
        approval = ApprovalEvidence(
            approval_id=_expect_str(obj["approval_id"], "ApprovalEvidence.approval_id"),
            approval_digest=_expect_str(
                obj["approval_digest"], "ApprovalEvidence.approval_digest"
            ),
            transaction_id=_expect_str(obj["transaction_id"], "ApprovalEvidence.transaction_id"),
            preview_digest=_expect_str(obj["preview_digest"], "ApprovalEvidence.preview_digest"),
            release_subject_digest=_expect_str(
                obj["release_subject_digest"],
                "ApprovalEvidence.release_subject_digest",
            ),
            verification_report_hash=_expect_str(
                obj["verification_report_hash"],
                "ApprovalEvidence.verification_report_hash",
            ),
            decision=decision,
            actor=_expect_str(obj["actor"], "ApprovalEvidence.actor"),
            decided_at=decided_at,
            reason=_expect_optional_str(obj["reason"], "ApprovalEvidence.reason"),
        )
    except ValueError as exc:
        raise IntegrityError("stored ApprovalEvidence is invalid") from exc
    if approval_payload(approval)["decided_at"] != timestamp:
        raise IntegrityError("approval time is not in canonical form")
    return approval


def _canonical_time_text(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(UTC).isoformat(timespec="microseconds").replace(
        "+00:00", "Z"
    )


def _decode_canonical_time(value: Any, label: str, *, optional: bool = False) -> datetime | None:
    if value is None and optional:
        return None
    timestamp = _expect_str(value, label)
    if not timestamp.endswith("Z"):
        raise IntegrityError(f"{label} must use canonical UTC Z form")
    try:
        parsed = datetime.fromisoformat(timestamp[:-1] + "+00:00")
    except ValueError as exc:
        raise IntegrityError(f"{label} is not a valid timestamp") from exc
    if _canonical_time_text(parsed) != timestamp:
        raise IntegrityError(f"{label} is not in canonical form")
    return parsed


def attestation_payload(attestation: DurableCommitAttestation) -> dict[str, Any]:
    if type(attestation) is not DurableCommitAttestation:
        raise IntegrityError("attestation must use the exact durable type")
    return {
        "algorithm": attestation.algorithm,
        "approval_decided_at": _canonical_time_text(attestation.approval_decided_at),
        "approval_digest": attestation.approval_digest,
        "approval_expires_at": _canonical_time_text(attestation.approval_expires_at),
        "approval_id": attestation.approval_id,
        "approval_kind": attestation.approval_kind,
        "approval_principal": attestation.approval_principal,
        "approval_run_id": attestation.approval_run_id,
        "attestation_key_id": attestation.attestation_key_id,
        "authorization_consumed_at": _canonical_time_text(
            attestation.authorization_consumed_at
        ),
        "authorization_digest": attestation.authorization_digest,
        "authorization_expires_at": _canonical_time_text(
            attestation.authorization_expires_at
        ),
        "authorization_id": attestation.authorization_id,
        "authorization_issued_at": _canonical_time_text(
            attestation.authorization_issued_at
        ),
        "authorization_key_id": attestation.authorization_key_id,
        "authorization_nonce": attestation.authorization_nonce,
        "base_revision": attestation.base_revision,
        "command_hashes": list(attestation.command_hashes),
        "command_hashes_digest": attestation.command_hashes_digest,
        "commit_gate_passed": attestation.commit_gate_passed,
        "head_revision": attestation.head_revision,
        "parent_revision": attestation.parent_revision,
        "preview_digest": attestation.preview_digest,
        "project_id": attestation.project_id,
        "prospective_graph_sha256": attestation.prospective_graph_sha256,
        "release_subject_digest": attestation.release_subject_digest,
        "revision_hash": attestation.revision_hash,
        "schema_version": attestation.schema_version,
        "scope": attestation.scope,
        "sequence": attestation.sequence,
        "signature": attestation.signature,
        "transaction_id": attestation.transaction_id,
        "verification_input_hash": attestation.verification_input_hash,
        "verification_report_hash": attestation.verification_report_hash,
        "verification_rule_set_hash": attestation.verification_rule_set_hash,
        "verified_preview_digest": attestation.verified_preview_digest,
    }


def attestation_from_payload(value: Any) -> DurableCommitAttestation:
    obj = _expect_object(value, "DurableCommitAttestation")
    keys = (
        "algorithm",
        "approval_decided_at",
        "approval_digest",
        "approval_expires_at",
        "approval_id",
        "approval_kind",
        "approval_principal",
        "approval_run_id",
        "attestation_key_id",
        "authorization_consumed_at",
        "authorization_digest",
        "authorization_expires_at",
        "authorization_id",
        "authorization_issued_at",
        "authorization_key_id",
        "authorization_nonce",
        "base_revision",
        "command_hashes",
        "command_hashes_digest",
        "commit_gate_passed",
        "head_revision",
        "parent_revision",
        "preview_digest",
        "project_id",
        "prospective_graph_sha256",
        "release_subject_digest",
        "revision_hash",
        "schema_version",
        "scope",
        "sequence",
        "signature",
        "transaction_id",
        "verification_input_hash",
        "verification_report_hash",
        "verification_rule_set_hash",
        "verified_preview_digest",
    )
    _expect_keys(obj, keys, "DurableCommitAttestation")
    try:
        decided_at = _decode_canonical_time(
            obj["approval_decided_at"], "DurableCommitAttestation.approval_decided_at"
        )
        issued_at = _decode_canonical_time(
            obj["authorization_issued_at"],
            "DurableCommitAttestation.authorization_issued_at",
        )
        expires_at = _decode_canonical_time(
            obj["authorization_expires_at"],
            "DurableCommitAttestation.authorization_expires_at",
        )
        consumed_at = _decode_canonical_time(
            obj["authorization_consumed_at"],
            "DurableCommitAttestation.authorization_consumed_at",
        )
        assert decided_at is not None
        assert issued_at is not None
        assert expires_at is not None
        assert consumed_at is not None
        return DurableCommitAttestation(
            schema_version=_expect_int(obj["schema_version"], "attestation.schema_version"),
            scope=_expect_str(obj["scope"], "attestation.scope"),
            algorithm=_expect_str(obj["algorithm"], "attestation.algorithm"),
            attestation_key_id=_expect_str(
                obj["attestation_key_id"], "attestation.attestation_key_id"
            ),
            project_id=_expect_str(obj["project_id"], "attestation.project_id"),
            base_revision=_expect_str(obj["base_revision"], "attestation.base_revision"),
            head_revision=_expect_str(obj["head_revision"], "attestation.head_revision"),
            parent_revision=_expect_str(
                obj["parent_revision"], "attestation.parent_revision"
            ),
            revision_hash=_expect_str(obj["revision_hash"], "attestation.revision_hash"),
            sequence=_expect_int(obj["sequence"], "attestation.sequence"),
            transaction_id=_expect_str(
                obj["transaction_id"], "attestation.transaction_id"
            ),
            command_hashes=_strings(obj["command_hashes"], "attestation.command_hashes"),
            command_hashes_digest=_expect_str(
                obj["command_hashes_digest"], "attestation.command_hashes_digest"
            ),
            preview_digest=_expect_str(obj["preview_digest"], "attestation.preview_digest"),
            verified_preview_digest=_expect_str(
                obj["verified_preview_digest"], "attestation.verified_preview_digest"
            ),
            prospective_graph_sha256=_expect_str(
                obj["prospective_graph_sha256"], "attestation.prospective_graph_sha256"
            ),
            verification_report_hash=_expect_str(
                obj["verification_report_hash"], "attestation.verification_report_hash"
            ),
            verification_input_hash=_expect_str(
                obj["verification_input_hash"], "attestation.verification_input_hash"
            ),
            verification_rule_set_hash=_expect_str(
                obj["verification_rule_set_hash"],
                "attestation.verification_rule_set_hash",
            ),
            commit_gate_passed=_expect_bool(
                obj["commit_gate_passed"], "attestation.commit_gate_passed"
            ),
            release_subject_digest=_expect_str(
                obj["release_subject_digest"], "attestation.release_subject_digest"
            ),
            approval_id=_expect_str(obj["approval_id"], "attestation.approval_id"),
            approval_run_id=_expect_str(
                obj["approval_run_id"], "attestation.approval_run_id"
            ),
            approval_kind=_expect_str(obj["approval_kind"], "attestation.approval_kind"),
            approval_digest=_expect_str(
                obj["approval_digest"], "attestation.approval_digest"
            ),
            approval_principal=_expect_str(
                obj["approval_principal"], "attestation.approval_principal"
            ),
            approval_decided_at=decided_at,
            approval_expires_at=_decode_canonical_time(
                obj["approval_expires_at"],
                "DurableCommitAttestation.approval_expires_at",
                optional=True,
            ),
            authorization_key_id=_expect_str(
                obj["authorization_key_id"], "attestation.authorization_key_id"
            ),
            authorization_id=_expect_str(
                obj["authorization_id"], "attestation.authorization_id"
            ),
            authorization_digest=_expect_str(
                obj["authorization_digest"], "attestation.authorization_digest"
            ),
            authorization_nonce=_expect_str(
                obj["authorization_nonce"], "attestation.authorization_nonce"
            ),
            authorization_issued_at=issued_at,
            authorization_expires_at=expires_at,
            authorization_consumed_at=consumed_at,
            signature=_expect_str(obj["signature"], "attestation.signature"),
        )
    except (AssertionError, ValueError) as exc:
        raise IntegrityError("stored DurableCommitAttestation is invalid") from exc


def encode_document(kind: str, payload: Mapping[str, Any]) -> tuple[str, str]:
    body = _canonical_json(
        {"document": kind, "payload": dict(payload), "version": DOCUMENT_VERSION}
    )
    return body, body_sha256(body)


def decode_document(body: str, *, expected_kind: str) -> dict[str, Any]:
    envelope = _decode_json(body)
    _expect_keys(envelope, ("document", "payload", "version"), "document envelope")
    if _expect_str(envelope["document"], "document kind") != expected_kind:
        raise IntegrityError(f"expected {expected_kind} document")
    version = _expect_int(envelope["version"], "document version")
    if version != DOCUMENT_VERSION:
        raise UnsupportedStoreSchema(f"unsupported {expected_kind} document version {version}")
    return _expect_object(envelope["payload"], "document payload")
