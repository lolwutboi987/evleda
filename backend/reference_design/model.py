"""Immutable evidence and result models for the first reference PCB."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from math import gcd
from typing import cast

from backend.design_kernel import DesignGraph, DesignRevision, stable_hash
from backend.kicad_compile import CompilationManifest, CompilationVerification
from backend.verification import VerificationReport


class ReferenceDesignViolation(ValueError):
    """The benchmark graph or its evidence violates a board-specific invariant."""


def _require_text(value: object, label: str) -> str:
    if type(value) is not str or not value.strip() or value != value.strip():
        raise ReferenceDesignViolation(f"{label} must be exact non-empty stripped text")
    return value


def _require_id(value: object, label: str) -> str:
    text = _require_text(value, label)
    if any(character.isspace() for character in text):
        raise ReferenceDesignViolation(f"{label} must not contain whitespace")
    return text


def _require_sha256(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ReferenceDesignViolation(f"{label} must be a lowercase SHA-256 digest")
    return value


def _require_text_tuple(value: object, label: str, *, nonempty: bool = False) -> None:
    if type(value) is not tuple:
        raise ReferenceDesignViolation(f"{label} must be an immutable tuple of text")
    items = cast(tuple[object, ...], value)
    if any(type(item) is not str or not item.strip() for item in items):
        raise ReferenceDesignViolation(f"{label} must be an immutable tuple of text")
    if nonempty and not items:
        raise ReferenceDesignViolation(f"{label} must not be empty")


@dataclass(frozen=True, slots=True)
class SourceEvidence:
    """One byte-hashed primary document and the exact facts used from it."""

    evidence_id: str
    title: str
    uri: str
    sha256: str
    document_revision: str
    facts: tuple[str, ...]
    component_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not SourceEvidence:
            raise ReferenceDesignViolation("source evidence must be exact SourceEvidence")
        _require_id(self.evidence_id, "source evidence ID")
        _require_text(self.title, "source title")
        _require_text(self.uri, "source URI")
        if not self.uri.startswith("https://"):
            raise ReferenceDesignViolation("source URI must use HTTPS")
        _require_sha256(self.sha256, "source document digest")
        _require_text(self.document_revision, "source document revision")
        _require_text_tuple(self.facts, "source facts", nonempty=True)
        _require_text_tuple(self.component_ids, "source component IDs")


@dataclass(frozen=True, slots=True)
class BomLine:
    """One fitted reference with an exact orderable part and evidence binding."""

    reference: str
    component_id: str
    manufacturer: str
    manufacturer_part_number: str
    value: str
    package: str
    assembly_role: str
    source_evidence_ids: tuple[str, ...]
    quantity: int = 1
    fitted: bool = True

    def __post_init__(self) -> None:
        if type(self) is not BomLine:
            raise ReferenceDesignViolation("BOM line must be exact BomLine")
        _require_id(self.reference, "BOM reference")
        _require_id(self.component_id, "BOM component ID")
        _require_text(self.manufacturer, "BOM manufacturer")
        _require_text(self.manufacturer_part_number, "BOM manufacturer part number")
        _require_text(self.value, "BOM value")
        _require_text(self.package, "BOM package")
        _require_text(self.assembly_role, "BOM assembly role")
        _require_text_tuple(self.source_evidence_ids, "BOM evidence IDs", nonempty=True)
        if type(self.quantity) is not int or self.quantity != 1:
            raise ReferenceDesignViolation("reference BOM lines must have exact quantity one")
        if type(self.fitted) is not bool or not self.fitted:
            raise ReferenceDesignViolation("reference BOM lines must be fitted")


@dataclass(frozen=True, slots=True)
class DesignConstraint:
    """One deterministic electrical, fabrication, layout, or release requirement."""

    constraint_id: str
    category: str
    statement: str
    minimum: int | None = None
    maximum: int | None = None
    nominal: int | None = None
    unit: str | None = None
    source_evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not DesignConstraint:
            raise ReferenceDesignViolation("constraint must be exact DesignConstraint")
        _require_id(self.constraint_id, "constraint ID")
        _require_id(self.category, "constraint category")
        _require_text(self.statement, "constraint statement")
        for label, value in (
            ("constraint minimum", self.minimum),
            ("constraint maximum", self.maximum),
            ("constraint nominal", self.nominal),
        ):
            if value is not None and type(value) is not int:
                raise ReferenceDesignViolation(f"{label} must be an exact integer or null")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ReferenceDesignViolation("constraint minimum cannot exceed maximum")
        if self.nominal is not None:
            if self.minimum is not None and self.nominal < self.minimum:
                raise ReferenceDesignViolation("constraint nominal is below minimum")
            if self.maximum is not None and self.nominal > self.maximum:
                raise ReferenceDesignViolation("constraint nominal is above maximum")
        if self.unit is not None:
            _require_id(self.unit, "constraint unit")
        _require_text_tuple(self.source_evidence_ids, "constraint evidence IDs")


@dataclass(frozen=True, slots=True)
class ExactRational:
    """One reduced rational used to keep calculation evidence byte-exact."""

    numerator: int
    denominator: int = 1

    def __post_init__(self) -> None:
        if type(self) is not ExactRational:
            raise ReferenceDesignViolation("calculation bound must be exact ExactRational")
        if type(self.numerator) is not int or type(self.denominator) is not int:
            raise ReferenceDesignViolation("calculation rational terms must be exact integers")
        if self.denominator <= 0:
            raise ReferenceDesignViolation("calculation rational denominator must be positive")
        if gcd(abs(self.numerator), self.denominator) != 1:
            raise ReferenceDesignViolation("calculation rational must be reduced")


@dataclass(frozen=True, slots=True)
class CalculationQuantity:
    """One source-linked exact quantity or interval in a calculation receipt."""

    quantity_id: str
    unit: str
    basis: str
    source_evidence_ids: tuple[str, ...]
    minimum: ExactRational | None = None
    typical: ExactRational | None = None
    maximum: ExactRational | None = None

    def __post_init__(self) -> None:
        if type(self) is not CalculationQuantity:
            raise ReferenceDesignViolation("calculation quantity must be exact")
        _require_id(self.quantity_id, "calculation quantity ID")
        _require_id(self.unit, "calculation quantity unit")
        _require_text(self.basis, "calculation quantity basis")
        _require_text_tuple(
            self.source_evidence_ids,
            "calculation quantity evidence IDs",
            nonempty=True,
        )
        bounds = (self.minimum, self.typical, self.maximum)
        if not any(bound is not None for bound in bounds):
            raise ReferenceDesignViolation("calculation quantity must carry an exact bound")
        if any(bound is not None and type(bound) is not ExactRational for bound in bounds):
            raise ReferenceDesignViolation("calculation quantity bounds must be exact rationals")
        minimum = (
            Fraction(self.minimum.numerator, self.minimum.denominator) if self.minimum else None
        )
        typical = (
            Fraction(self.typical.numerator, self.typical.denominator) if self.typical else None
        )
        maximum = (
            Fraction(self.maximum.numerator, self.maximum.denominator) if self.maximum else None
        )
        if minimum is not None and maximum is not None and minimum > maximum:
            raise ReferenceDesignViolation("calculation quantity minimum exceeds maximum")
        if typical is not None:
            if minimum is not None and typical < minimum:
                raise ReferenceDesignViolation("calculation quantity typical is below minimum")
            if maximum is not None and typical > maximum:
                raise ReferenceDesignViolation("calculation quantity typical is above maximum")


@dataclass(frozen=True, slots=True)
class ElectricalCalculationSection:
    """One immutable current, startup, stability, thermal, or policy section."""

    section_id: str
    source_evidence_ids: tuple[str, ...]
    quantities: tuple[CalculationQuantity, ...]
    conclusions: tuple[str, ...]
    qualification_blockers: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if type(self) is not ElectricalCalculationSection:
            raise ReferenceDesignViolation("electrical calculation section must be exact")
        _require_id(self.section_id, "electrical calculation section ID")
        _require_text_tuple(
            self.source_evidence_ids,
            "electrical calculation section evidence IDs",
            nonempty=True,
        )
        if (
            type(self.quantities) is not tuple
            or any(type(item) is not CalculationQuantity for item in self.quantities)
            or tuple(item.quantity_id for item in self.quantities)
            != tuple(sorted(item.quantity_id for item in self.quantities))
            or len({item.quantity_id for item in self.quantities}) != len(self.quantities)
        ):
            raise ReferenceDesignViolation(
                "electrical calculation quantities must be unique and canonically ordered"
            )
        _require_text_tuple(self.conclusions, "electrical calculation conclusions")
        _require_text_tuple(
            self.qualification_blockers,
            "electrical calculation qualification blockers",
        )
        if not self.quantities and not self.conclusions:
            raise ReferenceDesignViolation("electrical calculation section must not be empty")
        section_sources = set(self.source_evidence_ids)
        if any(
            not set(quantity.source_evidence_ids).issubset(section_sources)
            for quantity in self.quantities
        ):
            raise ReferenceDesignViolation(
                "calculation quantity references evidence outside its section"
            )


@dataclass(frozen=True, slots=True)
class ElectricalCalculations:
    """Canonical, serializable calculation evidence retained beside its digest."""

    schema_version: str
    subject_component_mpns: tuple[tuple[str, str], ...]
    sections: tuple[ElectricalCalculationSection, ...]
    qualification_blockers: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self) is not ElectricalCalculations:
            raise ReferenceDesignViolation("electrical calculations must be exact")
        _require_id(self.schema_version, "electrical calculations schema version")
        if type(self.subject_component_mpns) is not tuple or not self.subject_component_mpns:
            raise ReferenceDesignViolation("calculation component/MPN bindings must not be empty")
        for binding in self.subject_component_mpns:
            if type(binding) is not tuple or len(binding) != 2:
                raise ReferenceDesignViolation("calculation component/MPN binding is malformed")
            _require_id(binding[0], "calculation component ID")
            _require_text(binding[1], "calculation component MPN")
        component_ids = tuple(binding[0] for binding in self.subject_component_mpns)
        if component_ids != tuple(sorted(component_ids)) or len(component_ids) != len(
            set(component_ids)
        ):
            raise ReferenceDesignViolation(
                "calculation component/MPN bindings must be unique and canonically ordered"
            )
        if (
            type(self.sections) is not tuple
            or not self.sections
            or any(type(item) is not ElectricalCalculationSection for item in self.sections)
        ):
            raise ReferenceDesignViolation("electrical calculation sections must not be empty")
        section_ids = tuple(item.section_id for item in self.sections)
        if section_ids != tuple(sorted(section_ids)) or len(section_ids) != len(set(section_ids)):
            raise ReferenceDesignViolation(
                "electrical calculation sections must be unique and canonically ordered"
            )
        _require_text_tuple(
            self.qualification_blockers,
            "electrical calculation consolidated blockers",
            nonempty=True,
        )
        section_blockers = {
            blocker for section in self.sections for blocker in section.qualification_blockers
        }
        if set(self.qualification_blockers) != section_blockers:
            raise ReferenceDesignViolation(
                "consolidated calculation blockers disagree with section blockers"
            )


@dataclass(frozen=True, slots=True)
class BoardAudit:
    """Board-specific checks that complement the generic native verifier."""

    audit_version: str
    graph_hash: str
    revision_hash: str
    constraints_hash: str
    sources_hash: str
    implementation_hash: str
    checker_code_hash: str
    evidence_receipts_hash: str
    electrical_calculations: ElectricalCalculations
    electrical_calculations_hash: str
    route_plan_hash: str
    route_input_hash: str
    route_provenance: str
    route_review_hash: str
    analog_bias_proof_hash: str
    passed_check_ids: tuple[str, ...]
    blocking_findings: tuple[str, ...]
    audit_hash: str

    def __post_init__(self) -> None:
        if type(self) is not BoardAudit:
            raise ReferenceDesignViolation("board audit must be exact BoardAudit")
        if type(self.electrical_calculations) is not ElectricalCalculations:
            raise ReferenceDesignViolation(
                "board audit must retain exact electrical calculation payload"
            )
        _require_id(self.audit_version, "board audit version")
        for label, value in (
            ("board audit graph hash", self.graph_hash),
            ("board audit revision hash", self.revision_hash),
            ("board audit constraints hash", self.constraints_hash),
            ("board audit sources hash", self.sources_hash),
            ("board audit implementation hash", self.implementation_hash),
            ("board audit checker-code hash", self.checker_code_hash),
            ("board audit evidence-receipts hash", self.evidence_receipts_hash),
            ("board audit electrical-calculations hash", self.electrical_calculations_hash),
            ("board audit route plan hash", self.route_plan_hash),
            ("board audit route input hash", self.route_input_hash),
            ("board audit route review hash", self.route_review_hash),
            ("board audit analog-bias proof hash", self.analog_bias_proof_hash),
        ):
            _require_sha256(value, label)
        expected_calculations_hash = stable_hash(
            self.electrical_calculations,
            domain="flux-clone-reference-electrical-calculations-v3",
        )
        if self.electrical_calculations_hash != expected_calculations_hash:
            raise ReferenceDesignViolation(
                "board audit electrical calculation hash is inconsistent"
            )
        _require_id(self.route_provenance, "board audit route provenance")
        if self.route_provenance != "frozen-authored-route-not-human-reviewed":
            raise ReferenceDesignViolation(
                "a frozen route must remain explicit authored content without "
                "human-review authority"
            )
        _require_text_tuple(self.passed_check_ids, "passed board checks")
        _require_text_tuple(self.blocking_findings, "board audit blockers")
        _require_sha256(self.audit_hash, "board audit hash")
        expected = stable_hash(
            {
                "audit_version": self.audit_version,
                "graph_hash": self.graph_hash,
                "revision_hash": self.revision_hash,
                "constraints_hash": self.constraints_hash,
                "sources_hash": self.sources_hash,
                "implementation_hash": self.implementation_hash,
                "checker_code_hash": self.checker_code_hash,
                "evidence_receipts_hash": self.evidence_receipts_hash,
                "electrical_calculations": self.electrical_calculations,
                "electrical_calculations_hash": self.electrical_calculations_hash,
                "route_plan_hash": self.route_plan_hash,
                "route_input_hash": self.route_input_hash,
                "route_provenance": self.route_provenance,
                "route_review_hash": self.route_review_hash,
                "analog_bias_proof_hash": self.analog_bias_proof_hash,
                "passed_check_ids": self.passed_check_ids,
                "blocking_findings": self.blocking_findings,
            },
            domain="flux-clone-reference-board-audit-v4",
        )
        if expected != self.audit_hash:
            raise ReferenceDesignViolation("board audit hash is inconsistent")


@dataclass(frozen=True, slots=True)
class ReferenceDesignResult:
    """Complete immutable benchmark result and every digest needed to bind it."""

    design_id: str
    graph: DesignGraph
    revision: DesignRevision
    bom: tuple[BomLine, ...]
    constraints: tuple[DesignConstraint, ...]
    sources: tuple[SourceEvidence, ...]
    native_report: VerificationReport
    compiler_manifest: CompilationManifest
    compilation_verification: CompilationVerification
    board_audit: BoardAudit
    graph_hash: str
    revision_hash: str
    bom_hash: str
    constraints_hash: str
    sources_hash: str
    native_report_hash: str
    compiler_manifest_hash: str
    compiler_bundle_hash: str
    compiler_reparse_hash: str
    artifact_hash: str
    preview_gate_passed: bool
    commit_gate_passed: bool
    manufacturing_release_passed: bool
    manufacturing_blockers: tuple[str, ...]

    def __post_init__(self) -> None:
        if type(self) is not ReferenceDesignResult:
            raise ReferenceDesignViolation("result must be exact ReferenceDesignResult")
        _require_id(self.design_id, "reference design ID")
        if type(self.graph) is not DesignGraph or type(self.revision) is not DesignRevision:
            raise ReferenceDesignViolation("result graph and revision must be exact kernel models")
        if type(self.native_report) is not VerificationReport:
            raise ReferenceDesignViolation("result report must be exact VerificationReport")
        if type(self.compiler_manifest) is not CompilationManifest:
            raise ReferenceDesignViolation(
                "result compiler manifest must be exact CompilationManifest"
            )
        if type(self.compilation_verification) is not CompilationVerification:
            raise ReferenceDesignViolation(
                "result compilation verification must be exact CompilationVerification"
            )
        if type(self.board_audit) is not BoardAudit:
            raise ReferenceDesignViolation("result board audit must be exact BoardAudit")
        for label, values, item_type in (
            ("BOM", self.bom, BomLine),
            ("constraints", self.constraints, DesignConstraint),
            ("sources", self.sources, SourceEvidence),
        ):
            if type(values) is not tuple or any(type(item) is not item_type for item in values):
                raise ReferenceDesignViolation(f"{label} must be an immutable exact tuple")
        if not self.bom or not self.constraints or not self.sources:
            raise ReferenceDesignViolation("result BOM, constraints, and sources must not be empty")
        for label, value in (
            ("graph hash", self.graph_hash),
            ("revision hash", self.revision_hash),
            ("BOM hash", self.bom_hash),
            ("constraints hash", self.constraints_hash),
            ("sources hash", self.sources_hash),
            ("native report hash", self.native_report_hash),
            ("compiler manifest hash", self.compiler_manifest_hash),
            ("compiler bundle hash", self.compiler_bundle_hash),
            ("compiler reparse hash", self.compiler_reparse_hash),
            ("artifact hash", self.artifact_hash),
        ):
            _require_sha256(value, label)
        for label, value in (
            ("preview gate", self.preview_gate_passed),
            ("commit gate", self.commit_gate_passed),
            ("manufacturing release", self.manufacturing_release_passed),
        ):
            if type(value) is not bool:
                raise ReferenceDesignViolation(f"{label} result must be exact bool")
        _require_text_tuple(self.manufacturing_blockers, "manufacturing blockers", nonempty=True)
        expected_hashes = {
            "graph hash": (self.graph_hash, self.graph.graph_hash),
            "revision hash": (self.revision_hash, self.revision.revision_hash),
            "BOM hash": (
                self.bom_hash,
                stable_hash(self.bom, domain="flux-clone-reference-bom-v1"),
            ),
            "constraints hash": (
                self.constraints_hash,
                stable_hash(self.constraints, domain="flux-clone-reference-constraints-v1"),
            ),
            "sources hash": (
                self.sources_hash,
                stable_hash(self.sources, domain="flux-clone-reference-sources-v1"),
            ),
            "native report hash": (self.native_report_hash, self.native_report.report_hash),
            "compiler manifest hash": (
                self.compiler_manifest_hash,
                self.compilation_verification.manifest_sha256,
            ),
            "compiler bundle hash": (
                self.compiler_bundle_hash,
                self.compiler_manifest.output_bundle_sha256,
            ),
            "compiler reparse hash": (
                self.compiler_reparse_hash,
                self.compilation_verification.reparsed_bundle_ir_sha256,
            ),
        }
        for label, (actual, expected) in expected_hashes.items():
            if actual != expected:
                raise ReferenceDesignViolation(f"{label} is inconsistent")
        if self.revision.graph != self.graph or self.revision.graph_hash != self.graph_hash:
            raise ReferenceDesignViolation("revision does not bind the exact normalized graph")
        if (
            self.board_audit.graph_hash != self.graph_hash
            or self.board_audit.revision_hash != self.revision_hash
            or self.board_audit.constraints_hash != self.constraints_hash
            or self.board_audit.sources_hash != self.sources_hash
        ):
            raise ReferenceDesignViolation("board audit does not bind this exact design subject")

        components = {component.component_id: component for component in self.graph.components}
        if len(components) != len(self.graph.components):
            raise ReferenceDesignViolation("graph component IDs are not unique")
        bom_components = {line.component_id: line for line in self.bom}
        if len(bom_components) != len(self.bom) or set(bom_components) != set(components):
            raise ReferenceDesignViolation("BOM and graph components must have one-to-one parity")
        for component_id, component in components.items():
            line = bom_components[component_id]
            if (
                line.reference != component.reference
                or line.manufacturer_part_number != component.manufacturer_part_number
                or line.value != component.value
                or line.package != component.package
            ):
                raise ReferenceDesignViolation(
                    f"BOM line disagrees with graph component {component_id}"
                )

        source_ids = {source.evidence_id for source in self.sources}
        if len(source_ids) != len(self.sources):
            raise ReferenceDesignViolation("source evidence IDs must be unique")
        for source in self.sources:
            unknown_components = set(source.component_ids) - set(components)
            if unknown_components:
                raise ReferenceDesignViolation("source evidence references an unknown component")
        calculation_bindings = dict(
            self.board_audit.electrical_calculations.subject_component_mpns
        )
        if any(
            component_id not in components
            or components[component_id].manufacturer_part_number != mpn
            for component_id, mpn in calculation_bindings.items()
        ):
            raise ReferenceDesignViolation(
                "electrical calculation component/MPN binding disagrees with graph"
            )
        for section in self.board_audit.electrical_calculations.sections:
            if not set(section.source_evidence_ids).issubset(source_ids):
                raise ReferenceDesignViolation(
                    "electrical calculation section references unknown source evidence"
                )
        for line in self.bom:
            if not set(line.source_evidence_ids).issubset(source_ids):
                raise ReferenceDesignViolation("BOM line references unknown source evidence")
        constraint_ids = {constraint.constraint_id for constraint in self.constraints}
        if len(constraint_ids) != len(self.constraints):
            raise ReferenceDesignViolation("constraint IDs must be unique")
        for constraint in self.constraints:
            if not set(constraint.source_evidence_ids).issubset(source_ids):
                raise ReferenceDesignViolation("constraint references unknown source evidence")

        gates = {gate.gate_id: gate for gate in self.native_report.gates}
        for gate_id in ("preview", "commit", "manufacturing-release"):
            if gate_id not in gates:
                raise ReferenceDesignViolation(f"native report is missing {gate_id} gate")
        if (
            self.preview_gate_passed is not gates["preview"].passed
            or self.commit_gate_passed is not gates["commit"].passed
            or self.manufacturing_release_passed is not gates["manufacturing-release"].passed
        ):
            raise ReferenceDesignViolation("result gate booleans disagree with native report")
        if self.commit_gate_passed and self.board_audit.blocking_findings:
            raise ReferenceDesignViolation(
                "commit cannot pass while the board-specific audit blocks"
            )

        # The native report is intentionally produced by the reference builder's
        # evidence-bound projection: it adds the proven passive EN/UVLO divider
        # source.  Its v2 input hash is therefore not the bare graph adapter.
        if self.native_report.schema_version != 3:
            raise ReferenceDesignViolation("reference native report must use verification schema 3")
        if self.compiler_manifest.input_graph_sha256 != self.graph_hash:
            raise ReferenceDesignViolation("compiler manifest does not bind this graph")
        if self.compilation_verification.input_graph_sha256 != self.graph_hash:
            raise ReferenceDesignViolation("compiler reparse does not bind this graph")
        if self.compiler_manifest.manufacturing_release_eligible:
            raise ReferenceDesignViolation("codec-only compilation cannot authorize manufacturing")
        expected_artifact = stable_hash(
            {
                "design_id": self.design_id,
                "graph_hash": self.graph_hash,
                "revision_hash": self.revision_hash,
                "bom_hash": self.bom_hash,
                "constraints_hash": self.constraints_hash,
                "sources_hash": self.sources_hash,
                "native_report_hash": self.native_report_hash,
                "compiler_manifest_hash": self.compiler_manifest_hash,
                "compiler_bundle_hash": self.compiler_bundle_hash,
                "compiler_reparse_hash": self.compiler_reparse_hash,
                "board_audit_hash": self.board_audit.audit_hash,
                "preview_gate_passed": self.preview_gate_passed,
                "commit_gate_passed": self.commit_gate_passed,
                "manufacturing_release_passed": self.manufacturing_release_passed,
                "manufacturing_blockers": self.manufacturing_blockers,
            },
            domain="flux-clone-reference-design-artifact-v1",
        )
        if expected_artifact != self.artifact_hash:
            raise ReferenceDesignViolation("reference design artifact hash is inconsistent")
        if self.manufacturing_release_passed:
            raise ReferenceDesignViolation(
                "reference builder cannot claim manufacturing release without trusted "
                "KiCad evidence"
            )


__all__ = (
    "BoardAudit",
    "BomLine",
    "CalculationQuantity",
    "DesignConstraint",
    "ElectricalCalculationSection",
    "ElectricalCalculations",
    "ExactRational",
    "ReferenceDesignResult",
    "ReferenceDesignViolation",
    "SourceEvidence",
)
