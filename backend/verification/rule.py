"""Rule contracts and policy resolution for deterministic evaluators."""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Protocol

from .geometry import GeometryKernel
from .model import (
    BoardGraph,
    EntityRef,
    EvidenceItem,
    Finding,
    ParameterSpec,
    ParameterType,
    ParameterValue,
    RuleDefinition,
    RuleDomain,
    RuleOverride,
    Scalar,
    Severity,
)

RULE_ID_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*(?:\.[A-Z][A-Z0-9_]*)+$")
SEMVER_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")


class RuleConfigurationError(ValueError):
    """Raised when the deterministic rule set or its policy is invalid."""


@dataclass(frozen=True, slots=True)
class FindingDraft:
    message: str
    entities: tuple[EntityRef, ...]
    evidence: tuple[EvidenceItem, ...]

    def normalized(self) -> "FindingDraft":
        return replace(
            self,
            entities=tuple(sorted(set(self.entities))),
            evidence=tuple(sorted(self.evidence)),
        )


@dataclass(frozen=True, slots=True)
class RuleContext:
    severity: Severity
    parameters: tuple[ParameterValue, ...]
    geometry: GeometryKernel

    def parameter(self, name: str) -> Scalar:
        for item in self.parameters:
            if item.name == name:
                return item.value
        raise KeyError(f"resolved rule parameter not found: {name}")

    def integer(self, name: str) -> int:
        value = self.parameter(name)
        if isinstance(value, bool) or not isinstance(value, int):
            raise TypeError(f"rule parameter {name!r} is not an integer")
        return value

    def boolean(self, name: str) -> bool:
        value = self.parameter(name)
        if not isinstance(value, bool):
            raise TypeError(f"rule parameter {name!r} is not a boolean")
        return value

    def string(self, name: str) -> str:
        value = self.parameter(name)
        if not isinstance(value, str):
            raise TypeError(f"rule parameter {name!r} is not a string")
        return value


class RuleEvaluator(Protocol):
    """A pure deterministic rule implementation.

    Evaluators receive only normalized typed board data, resolved parameters,
    and an exact geometry kernel. They have no network, clock, random, shell,
    LLM, or mutable project-state capability.
    """

    definition: RuleDefinition

    def evaluate(self, board: BoardGraph, context: RuleContext) -> tuple[FindingDraft, ...]: ...


def validate_rule_definition(definition: RuleDefinition) -> None:
    if type(definition) is not RuleDefinition:
        raise RuleConfigurationError("rule definition must be the exact RuleDefinition type")
    for field_name, value in (
        ("rule_id", definition.rule_id),
        ("version", definition.version),
        ("title", definition.title),
        ("description", definition.description),
    ):
        if type(value) is not str:
            raise RuleConfigurationError(f"rule definition {field_name} must be a string")
    if type(definition.domain) is not RuleDomain:
        raise RuleConfigurationError(f"rule {definition.rule_id} domain must be RuleDomain")
    if type(definition.default_severity) is not Severity:
        raise RuleConfigurationError(f"rule {definition.rule_id} default severity must be Severity")
    if type(definition.parameters) is not tuple:
        raise RuleConfigurationError(f"rule {definition.rule_id} parameters must be a tuple")
    if type(definition.mandatory) is not bool:
        raise RuleConfigurationError(f"rule {definition.rule_id} mandatory must be bool")
    if not RULE_ID_PATTERN.fullmatch(definition.rule_id):
        raise RuleConfigurationError(f"invalid stable rule id: {definition.rule_id!r}")
    if not SEMVER_PATTERN.fullmatch(definition.version):
        raise RuleConfigurationError(
            f"rule {definition.rule_id} must use a numeric semantic version"
        )
    parameter_names = [parameter.name for parameter in definition.parameters]
    if len(parameter_names) != len(set(parameter_names)):
        raise RuleConfigurationError(f"duplicate parameter in {definition.rule_id}")
    for parameter in definition.parameters:
        if type(parameter) is not ParameterSpec:
            raise RuleConfigurationError(
                f"rule {definition.rule_id} parameter must be ParameterSpec"
            )
        if type(parameter.name) is not str or not parameter.name.strip():
            raise RuleConfigurationError(
                f"rule {definition.rule_id} parameter name must be a non-empty string"
            )
        if type(parameter.parameter_type) is not ParameterType:
            raise RuleConfigurationError(
                f"rule {definition.rule_id}.{parameter.name} type must be ParameterType"
            )
        for bound_name, bound in (("minimum", parameter.minimum), ("maximum", parameter.maximum)):
            if bound is not None and type(bound) is not int:
                raise RuleConfigurationError(
                    f"parameter {definition.rule_id}.{parameter.name} {bound_name} must be int"
                )
        if (
            parameter.minimum is not None
            and parameter.maximum is not None
            and parameter.minimum > parameter.maximum
        ):
            raise RuleConfigurationError(
                f"parameter {definition.rule_id}.{parameter.name} minimum exceeds maximum"
            )
        validate_parameter(parameter, parameter.default, definition.rule_id)


def validate_parameter(spec: ParameterSpec, value: Scalar, rule_id: str) -> None:
    if spec.parameter_type is ParameterType.INTEGER:
        valid = isinstance(value, int) and not isinstance(value, bool)
    elif spec.parameter_type is ParameterType.BOOLEAN:
        valid = isinstance(value, bool)
    elif spec.parameter_type is ParameterType.STRING:
        valid = isinstance(value, str)
    else:  # pragma: no cover - exhaustive Enum guard
        valid = False
    if not valid:
        raise RuleConfigurationError(
            f"parameter {rule_id}.{spec.name} must be {spec.parameter_type.value}"
        )
    if isinstance(value, int) and not isinstance(value, bool):
        if spec.minimum is not None and value < spec.minimum:
            raise RuleConfigurationError(f"parameter {rule_id}.{spec.name} is below {spec.minimum}")
        if spec.maximum is not None and value > spec.maximum:
            raise RuleConfigurationError(f"parameter {rule_id}.{spec.name} is above {spec.maximum}")


@dataclass(frozen=True, slots=True)
class ResolvedRule:
    evaluator: RuleEvaluator
    enabled: bool
    severity: Severity
    parameters: tuple[ParameterValue, ...]


def resolve_rule(evaluator: RuleEvaluator, override: RuleOverride | None) -> ResolvedRule:
    definition = evaluator.definition
    validate_rule_definition(definition)
    if override is not None and type(override) is not RuleOverride:
        raise RuleConfigurationError("rule override must be the exact RuleOverride type")
    if override is not None:
        if type(override.rule_id) is not str:
            raise RuleConfigurationError("override rule id must be a string")
        if type(override.enabled) is not bool:
            raise RuleConfigurationError(
                f"override enabled flag for {definition.rule_id} must be bool"
            )
        if override.severity is not None and type(override.severity) is not Severity:
            raise RuleConfigurationError(
                f"override severity for {definition.rule_id} must be Severity"
            )
        if type(override.parameters) is not tuple:
            raise RuleConfigurationError(
                f"override parameters for {definition.rule_id} must be a tuple"
            )
        if any(type(item) is not ParameterValue for item in override.parameters):
            raise RuleConfigurationError(
                f"override parameters for {definition.rule_id} must be ParameterValue"
            )
        if any(type(item.name) is not str for item in override.parameters):
            raise RuleConfigurationError(
                f"override parameter names for {definition.rule_id} must be strings"
            )
    enabled = True if override is None else override.enabled
    if definition.mandatory and not enabled:
        raise RuleConfigurationError(f"mandatory rule cannot be disabled: {definition.rule_id}")
    severity = override.severity if override and override.severity else definition.default_severity
    if (
        definition.mandatory
        and definition.default_severity is Severity.FATAL
        and severity is not Severity.FATAL
    ):
        raise RuleConfigurationError(
            f"mandatory fatal rule cannot be severity-downgraded: {definition.rule_id}"
        )
    provided = {item.name: item.value for item in (override.parameters if override else ())}
    if len(provided) != len(override.parameters if override else ()):
        raise RuleConfigurationError(f"duplicate override parameter for {definition.rule_id}")
    specs = {spec.name: spec for spec in definition.parameters}
    unknown = sorted(set(provided) - set(specs))
    if unknown:
        raise RuleConfigurationError(
            f"unknown parameters for {definition.rule_id}: {', '.join(unknown)}"
        )
    resolved: list[ParameterValue] = []
    for name in sorted(specs):
        value = provided.get(name, specs[name].default)
        validate_parameter(specs[name], value, definition.rule_id)
        resolved.append(ParameterValue(name, value))
    return ResolvedRule(evaluator, enabled, severity, tuple(resolved))


def finding_order_key(finding: Finding) -> tuple[int, str, tuple[EntityRef, ...], str]:
    """Authoritative finding order: highest severity, then stable identity."""

    return (-finding.severity.rank, finding.rule_id, finding.entities, finding.finding_id)
