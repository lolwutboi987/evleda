"""Deterministic, evidence-hashed PCB verification core.

Only the types and pure engine exported here are authoritative. AI agents may
request runs and explain results, but cannot create, waive, reorder, or alter a
finding outside a versioned :class:`VerificationPolicy`.
"""

from .canonical import CanonicalizationError, canonical_data, canonical_json_bytes, stable_hash
from .engine import (
    ENGINE_VERSION,
    VerificationEngine,
    VerificationExecutionError,
    VerificationInputError,
    default_evaluators,
    strict_policy,
)
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
from .rule import RuleConfigurationError, RuleEvaluator

__all__ = (
    "BOARD_SCHEMA_VERSION",
    "BoardGraph",
    "BoardOutline",
    "CanonicalizationError",
    "Component",
    "ENGINE_VERSION",
    "EntityRef",
    "EvidenceItem",
    "ExactGeometryKernel",
    "Finding",
    "GateDecision",
    "GateDefinition",
    "GeometryKernel",
    "Hole",
    "Net",
    "NetConnection",
    "ParameterValue",
    "PadShape",
    "PhysicalPad",
    "Pin",
    "PinElectricalType",
    "PointNm",
    "RuleConfigurationError",
    "RuleDefinition",
    "RuleDomain",
    "RuleExecutionOutcome",
    "RuleEvaluator",
    "RuleOverride",
    "Severity",
    "Track",
    "VerificationEngine",
    "VerificationExecutionError",
    "VerificationInputError",
    "VerificationPolicy",
    "VerificationReport",
    "Via",
    "Zone",
    "ZoneFillEvidence",
    "ZoneFillState",
    "zone_fill_evidence_hash",
    "zone_filled_geometry_hash",
    "canonical_data",
    "canonical_json_bytes",
    "default_evaluators",
    "stable_hash",
    "strict_policy",
)

# Re-exported separately so static consumers can discover the accepted board envelope.
from .engine import BOARD_SCHEMA_VERSION
