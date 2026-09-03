"""Strict, fail-closed loading for the committed product policy."""

from __future__ import annotations

import json
import os
import re
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import cast

from .orchestrator.models import Budget, Run, RunId


class ProductConfigurationError(ValueError):
    """The product configuration is ambiguous, unsupported, or unsafe."""


@dataclass(frozen=True, slots=True)
class CoordinationConfiguration:
    strict_user_coordination: bool
    require_brief_approval: bool
    require_plan_approval: bool
    require_exact_patch_approval: bool
    require_layout_constraint_approval: bool
    require_release_approval: bool
    invalidate_dependent_approvals_on_change: bool


@dataclass(frozen=True, slots=True)
class OrchestrationConfiguration:
    max_concurrent_agents: int
    wave_size: int
    total_agent_dispatch_limit: int | None
    token_limit: int | None
    tool_call_limit: int | None
    unsafe_resource_override_opt_in: bool
    require_independent_critic: bool
    max_task_attempts: int
    max_repair_cycles_per_candidate: int
    lease_seconds: int
    heartbeat_seconds: int


@dataclass(frozen=True, slots=True)
class ModelRuntimeConfiguration:
    provider: str
    default_model: str
    reasoning_effort: str
    proposal_only: bool
    structured_outputs: bool
    store_responses: bool
    max_output_tokens: int | None


@dataclass(frozen=True, slots=True)
class VerificationConfiguration:
    unknown_is_pass: bool
    require_native_engine: bool
    require_kicad_engine: bool
    engine_disagreement_is_blocking: bool
    require_exact_revision: bool
    preview_blocks_at: str
    commit_blocks_at: str
    manufacturing_release_blocks_at: str
    require_algorithm_replay_hash: bool


@dataclass(frozen=True, slots=True)
class KiCadBackendConfiguration:
    role: tuple[str, ...]
    minimum_version: str


@dataclass(frozen=True, slots=True)
class BackendConfiguration:
    canonical_design_store: str
    kicad: KiCadBackendConfiguration


@dataclass(frozen=True, slots=True)
class ProductConfiguration:
    schema_version: int
    coordination: CoordinationConfiguration
    orchestration: OrchestrationConfiguration
    model_runtime: ModelRuntimeConfiguration
    verification: VerificationConfiguration
    backends: BackendConfiguration
    _unsafe_resource_override_authorized: bool = field(
        default=False,
        init=False,
        repr=False,
        compare=False,
    )

    def __post_init__(self) -> None:
        """Reject ambiguous or unsafe policy records at construction."""

        authorized = _UNSAFE_RESOURCE_OVERRIDE_LOAD_GATE.get()
        _validated_configuration_snapshot(
            self,
            allow_unsafe_resource_override=authorized,
        )
        object.__setattr__(
            self,
            "_unsafe_resource_override_authorized",
            authorized and self.orchestration.unsafe_resource_override_opt_in,
        )

    @property
    def unsafe_resource_override_authorized(self) -> bool:
        """Internal load-time authorization retained for revalidation only."""

        return self._unsafe_resource_override_authorized

    def create_run(
        self,
        *,
        run_id: RunId,
        objective: str,
        created_at: datetime,
    ) -> Run:
        """Create a run whose live limits and gates match this policy."""

        (
            _,
            coordination,
            orchestration,
            _,
            _,
            _,
        ) = _validated_configuration_snapshot(self)

        return Run(
            id=run_id,
            objective=objective,
            created_at=created_at,
            strict_user_coordination=coordination.strict_user_coordination,
            require_plan_approval=coordination.require_plan_approval,
            require_independent_critic=orchestration.require_independent_critic,
            max_concurrency=orchestration.max_concurrent_agents,
            budget=Budget(
                token_limit=orchestration.token_limit,
                tool_call_limit=orchestration.tool_call_limit,
                agent_dispatch_limit=orchestration.total_agent_dispatch_limit,
            ),
        )


_COORDINATION_KEYS = frozenset(
    {
        "strict_user_coordination",
        "require_brief_approval",
        "require_plan_approval",
        "require_exact_patch_approval",
        "require_layout_constraint_approval",
        "require_release_approval",
        "invalidate_dependent_approvals_on_change",
    }
)
_ORCHESTRATION_KEYS = frozenset(
    {
        "max_concurrent_agents",
        "wave_size",
        "total_agent_dispatch_limit",
        "token_limit",
        "tool_call_limit",
        "unsafe_resource_override_opt_in",
        "require_independent_critic",
        "max_task_attempts",
        "max_repair_cycles_per_candidate",
        "lease_seconds",
        "heartbeat_seconds",
    }
)

# The public profile is intentionally small enough to be predictable on a
# developer workstation: one design/critic wave, bounded retries, and bounded
# model/tool work.  These are campaign guardrails, not claims about the host's
# actual available capacity; a host remains authoritative at every dispatch.
_PUBLIC_MAX_CONCURRENT_AGENTS = 8
_PUBLIC_WAVE_SIZE = 8
_PUBLIC_TOTAL_AGENT_DISPATCH_LIMIT = 48
_PUBLIC_TOKEN_LIMIT = 1_000_000
_PUBLIC_TOOL_CALL_LIMIT = 500
_PUBLIC_MAX_OUTPUT_TOKENS = 32_768

# An unlimited campaign has an explicit, deliberately alarming configuration
# bit *and* an out-of-band loader authorization.  The latter prevents a copied
# JSON file from silently changing public-run resource behavior.
_UNSAFE_RESOURCE_OVERRIDE_ENV = "EVLEDA_ALLOW_UNSAFE_RESOURCE_OVERRIDE"
_UNSAFE_RESOURCE_OVERRIDE_LOAD_GATE: ContextVar[bool] = ContextVar(
    "evleda_unsafe_resource_override_load_gate",
    default=False,
)
_MODEL_RUNTIME_KEYS = frozenset(
    {
        "provider",
        "default_model",
        "reasoning_effort",
        "proposal_only",
        "structured_outputs",
        "store_responses",
        "max_output_tokens",
    }
)
_VERIFICATION_KEYS = frozenset(
    {
        "unknown_is_pass",
        "require_native_engine",
        "require_kicad_engine",
        "engine_disagreement_is_blocking",
        "require_exact_revision",
        "preview_blocks_at",
        "commit_blocks_at",
        "manufacturing_release_blocks_at",
        "require_algorithm_replay_hash",
    }
)
_EXPECTED_KICAD_ROLES = (
    "import",
    "export",
    "independent-verification",
    "render",
    "manufacturing",
)


def _duplicate_rejecting_object(
    pairs: list[tuple[str, object]],
) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ProductConfigurationError(f"duplicate configuration key: {key}")
        result[key] = value
    return result


def _reject_constant(token: str) -> object:
    raise ProductConfigurationError(f"non-finite JSON constant: {token}")


def _object(
    value: object,
    *,
    label: str,
    keys: frozenset[str],
) -> dict[str, object]:
    if type(value) is not dict:
        raise ProductConfigurationError(f"{label} must be an object")
    result = cast(dict[str, object], value)
    actual = frozenset(result)
    if actual != keys:
        missing = ", ".join(sorted(keys - actual)) or "none"
        unknown = ", ".join(sorted(actual - keys)) or "none"
        raise ProductConfigurationError(
            f"{label} has invalid keys; missing: {missing}; unknown: {unknown}"
        )
    return result


def _bool(value: object, label: str) -> bool:
    if type(value) is not bool:
        raise ProductConfigurationError(f"{label} must be a boolean")
    return value


def _int(value: object, label: str, *, minimum: int = 1) -> int:
    if type(value) is not int or value < minimum:
        raise ProductConfigurationError(
            f"{label} must be an integer greater than or equal to {minimum}"
        )
    return value


def _optional_int(value: object, label: str) -> int | None:
    if value is None:
        return None
    return _int(value, label)


def _string(value: object, label: str) -> str:
    if type(value) is not str or not value.strip():
        raise ProductConfigurationError(f"{label} must be a non-empty string")
    result = value
    if result != result.strip():
        raise ProductConfigurationError(f"{label} cannot contain outer whitespace")
    return result


def _require_safe_flag(value: bool, label: str, expected: bool) -> bool:
    if value is not expected:
        raise ProductConfigurationError(
            f"{label} must be {str(expected).lower()} in a safe product profile"
        )
    return value


def _coordination(value: object) -> CoordinationConfiguration:
    source = _object(value, label="coordination", keys=_COORDINATION_KEYS)
    values = {
        key: _require_safe_flag(
            _bool(source[key], f"coordination.{key}"),
            f"coordination.{key}",
            True,
        )
        for key in sorted(_COORDINATION_KEYS)
    }
    return CoordinationConfiguration(**values)


def _orchestration(
    value: object,
    *,
    allow_unsafe_resource_override: bool = False,
) -> OrchestrationConfiguration:
    source = _object(value, label="orchestration", keys=_ORCHESTRATION_KEYS)
    result = OrchestrationConfiguration(
        max_concurrent_agents=_int(
            source["max_concurrent_agents"],
            "orchestration.max_concurrent_agents",
        ),
        wave_size=_int(source["wave_size"], "orchestration.wave_size"),
        total_agent_dispatch_limit=_optional_int(
            source["total_agent_dispatch_limit"],
            "orchestration.total_agent_dispatch_limit",
        ),
        token_limit=_optional_int(
            source["token_limit"], "orchestration.token_limit"
        ),
        tool_call_limit=_optional_int(
            source["tool_call_limit"], "orchestration.tool_call_limit"
        ),
        unsafe_resource_override_opt_in=_bool(
            source["unsafe_resource_override_opt_in"],
            "orchestration.unsafe_resource_override_opt_in",
        ),
        require_independent_critic=_require_safe_flag(
            _bool(
                source["require_independent_critic"],
                "orchestration.require_independent_critic",
            ),
            "orchestration.require_independent_critic",
            True,
        ),
        max_task_attempts=_int(
            source["max_task_attempts"], "orchestration.max_task_attempts"
        ),
        max_repair_cycles_per_candidate=_int(
            source["max_repair_cycles_per_candidate"],
            "orchestration.max_repair_cycles_per_candidate",
            minimum=0,
        ),
        lease_seconds=_int(
            source["lease_seconds"], "orchestration.lease_seconds"
        ),
        heartbeat_seconds=_int(
            source["heartbeat_seconds"], "orchestration.heartbeat_seconds"
        ),
    )
    if result.wave_size > result.max_concurrent_agents:
        raise ProductConfigurationError(
            "orchestration.wave_size cannot exceed max_concurrent_agents"
        )
    if result.heartbeat_seconds >= result.lease_seconds:
        raise ProductConfigurationError(
            "orchestration.heartbeat_seconds must be less than lease_seconds"
        )
    if result.unsafe_resource_override_opt_in:
        if not allow_unsafe_resource_override:
            raise ProductConfigurationError(
                "unsafe resource override requires explicit loader authorization; "
                f"pass allow_unsafe_resource_override=True or set "
                f"{_UNSAFE_RESOURCE_OVERRIDE_ENV}=1"
            )
        return result

    public_limits = (
        result.max_concurrent_agents,
        result.wave_size,
        result.total_agent_dispatch_limit,
        result.token_limit,
        result.tool_call_limit,
    )
    expected_public_limits = (
        _PUBLIC_MAX_CONCURRENT_AGENTS,
        _PUBLIC_WAVE_SIZE,
        _PUBLIC_TOTAL_AGENT_DISPATCH_LIMIT,
        _PUBLIC_TOKEN_LIMIT,
        _PUBLIC_TOOL_CALL_LIMIT,
    )
    if public_limits != expected_public_limits:
        raise ProductConfigurationError(
            "safe product profile requires finite public campaign limits: "
            "8 concurrent agents, an 8-task wave, 48 dispatches, 1000000 tokens, "
            "and 500 tool calls; set unsafe_resource_override_opt_in with an "
            "explicit loader authorization for another resource profile"
        )
    return result


def _model_runtime(
    value: object,
    *,
    allow_unsafe_resource_override: bool = False,
    unsafe_resource_override_opt_in: bool = False,
) -> ModelRuntimeConfiguration:
    source = _object(value, label="model_runtime", keys=_MODEL_RUNTIME_KEYS)
    provider = _string(source["provider"], "model_runtime.provider")
    if provider != "openai-responses":
        raise ProductConfigurationError("model_runtime.provider is unsupported")
    effort = _string(source["reasoning_effort"], "model_runtime.reasoning_effort")
    if effort not in {"low", "medium", "high", "xhigh", "max", "ultra"}:
        raise ProductConfigurationError("model_runtime.reasoning_effort is unsupported")
    result = ModelRuntimeConfiguration(
        provider=provider,
        default_model=_string(
            source["default_model"], "model_runtime.default_model"
        ),
        reasoning_effort=effort,
        proposal_only=_require_safe_flag(
            _bool(source["proposal_only"], "model_runtime.proposal_only"),
            "model_runtime.proposal_only",
            True,
        ),
        structured_outputs=_require_safe_flag(
            _bool(
                source["structured_outputs"], "model_runtime.structured_outputs"
            ),
            "model_runtime.structured_outputs",
            True,
        ),
        store_responses=_require_safe_flag(
            _bool(source["store_responses"], "model_runtime.store_responses"),
            "model_runtime.store_responses",
            False,
        ),
        max_output_tokens=_optional_int(
            source["max_output_tokens"], "model_runtime.max_output_tokens"
        ),
    )
    if result.default_model != "gpt-5.6-sol" or result.reasoning_effort != "max":
        raise ProductConfigurationError(
            "safe product profile requires gpt-5.6-sol at max effort"
        )
    if unsafe_resource_override_opt_in:
        if not allow_unsafe_resource_override:
            raise ProductConfigurationError(
                "unsafe resource override requires explicit loader authorization"
            )
    elif result.max_output_tokens != _PUBLIC_MAX_OUTPUT_TOKENS:
        raise ProductConfigurationError(
            "safe product profile requires a 32768-token model output limit"
        )
    return result


def _verification(value: object) -> VerificationConfiguration:
    source = _object(value, label="verification", keys=_VERIFICATION_KEYS)
    severities: dict[str, str] = {}
    for key in (
        "preview_blocks_at",
        "commit_blocks_at",
        "manufacturing_release_blocks_at",
    ):
        severity = _string(source[key], f"verification.{key}")
        if severity not in {"info", "warning", "error", "fatal"}:
            raise ProductConfigurationError(f"verification.{key} is unsupported")
        severities[key] = severity
    expected_severities = {
        "preview_blocks_at": "fatal",
        "commit_blocks_at": "error",
        "manufacturing_release_blocks_at": "warning",
    }
    if severities != expected_severities:
        raise ProductConfigurationError(
            "verification gate thresholds do not match the safe product profile"
        )
    return VerificationConfiguration(
        unknown_is_pass=_require_safe_flag(
            _bool(source["unknown_is_pass"], "verification.unknown_is_pass"),
            "verification.unknown_is_pass",
            False,
        ),
        require_native_engine=_require_safe_flag(
            _bool(
                source["require_native_engine"],
                "verification.require_native_engine",
            ),
            "verification.require_native_engine",
            True,
        ),
        require_kicad_engine=_require_safe_flag(
            _bool(
                source["require_kicad_engine"],
                "verification.require_kicad_engine",
            ),
            "verification.require_kicad_engine",
            True,
        ),
        engine_disagreement_is_blocking=_require_safe_flag(
            _bool(
                source["engine_disagreement_is_blocking"],
                "verification.engine_disagreement_is_blocking",
            ),
            "verification.engine_disagreement_is_blocking",
            True,
        ),
        require_exact_revision=_require_safe_flag(
            _bool(
                source["require_exact_revision"],
                "verification.require_exact_revision",
            ),
            "verification.require_exact_revision",
            True,
        ),
        preview_blocks_at=severities["preview_blocks_at"],
        commit_blocks_at=severities["commit_blocks_at"],
        manufacturing_release_blocks_at=severities[
            "manufacturing_release_blocks_at"
        ],
        require_algorithm_replay_hash=_require_safe_flag(
            _bool(
                source["require_algorithm_replay_hash"],
                "verification.require_algorithm_replay_hash",
            ),
            "verification.require_algorithm_replay_hash",
            True,
        ),
    )


def _backends(value: object) -> BackendConfiguration:
    source = _object(
        value,
        label="backends",
        keys=frozenset({"canonical_design_store", "kicad"}),
    )
    store = _string(
        source["canonical_design_store"], "backends.canonical_design_store"
    )
    if store != "native-object-graph":
        raise ProductConfigurationError("canonical design store is unsupported")
    kicad = _object(
        source["kicad"],
        label="backends.kicad",
        keys=frozenset({"role", "minimum_version"}),
    )
    roles_value = kicad["role"]
    if type(roles_value) is not list:
        raise ProductConfigurationError("backends.kicad.role must be an array")
    roles = tuple(
        _string(item, "backends.kicad.role item")
        for item in cast(list[object], roles_value)
    )
    if roles != _EXPECTED_KICAD_ROLES:
        raise ProductConfigurationError(
            "backends.kicad.role must contain the complete canonical role sequence"
        )
    minimum_version = _string(
        kicad["minimum_version"], "backends.kicad.minimum_version"
    )
    match = re.fullmatch(r"([0-9]+)\.([0-9]+)", minimum_version)
    if match is None or (int(match.group(1)), int(match.group(2))) < (10, 0):
        raise ProductConfigurationError(
            "backends.kicad.minimum_version must be at least 10.0"
        )
    return BackendConfiguration(
        canonical_design_store=store,
        kicad=KiCadBackendConfiguration(
            role=roles,
            minimum_version=minimum_version,
        ),
    )


def _validated_configuration_snapshot(
    value: object,
    *,
    allow_unsafe_resource_override: bool | None = None,
) -> tuple[
    int,
    CoordinationConfiguration,
    OrchestrationConfiguration,
    ModelRuntimeConfiguration,
    VerificationConfiguration,
    BackendConfiguration,
]:
    """Revalidate exact concrete records and return the values that were checked."""

    if type(value) is not ProductConfiguration:
        raise ProductConfigurationError(
            "product configuration must be the exact ProductConfiguration type"
        )
    configuration = value
    if allow_unsafe_resource_override is None:
        allow_unsafe_resource_override = configuration.unsafe_resource_override_authorized
    if type(allow_unsafe_resource_override) is not bool:
        raise ProductConfigurationError(
            "unsafe resource override authorization must be a boolean"
        )
    schema_version = configuration.schema_version
    coordination = configuration.coordination
    orchestration = configuration.orchestration
    model_runtime = configuration.model_runtime
    verification = configuration.verification
    backends = configuration.backends
    if type(schema_version) is not int or schema_version != 1:
        raise ProductConfigurationError(
            "product configuration schema_version must be the exact integer 1"
        )
    expected_records = (
        (coordination, CoordinationConfiguration, "coordination"),
        (orchestration, OrchestrationConfiguration, "orchestration"),
        (model_runtime, ModelRuntimeConfiguration, "model_runtime"),
        (verification, VerificationConfiguration, "verification"),
        (backends, BackendConfiguration, "backends"),
    )
    for record, expected_type, label in expected_records:
        if type(record) is not expected_type:
            raise ProductConfigurationError(
                f"{label} must use its exact concrete configuration record"
            )
    kicad = backends.kicad
    if type(kicad) is not KiCadBackendConfiguration:
        raise ProductConfigurationError(
            "backends.kicad must use its exact concrete configuration record"
        )
    kicad_roles = kicad.role
    if type(kicad_roles) is not tuple:
        raise ProductConfigurationError(
            "backends.kicad.role must be an exact immutable role tuple"
        )

    checked_coordination = _coordination(
        {
            "strict_user_coordination": coordination.strict_user_coordination,
            "require_brief_approval": coordination.require_brief_approval,
            "require_plan_approval": coordination.require_plan_approval,
            "require_exact_patch_approval": coordination.require_exact_patch_approval,
            "require_layout_constraint_approval": (
                coordination.require_layout_constraint_approval
            ),
            "require_release_approval": coordination.require_release_approval,
            "invalidate_dependent_approvals_on_change": (
                coordination.invalidate_dependent_approvals_on_change
            ),
        }
    )
    checked_orchestration = _orchestration(
        {
            "max_concurrent_agents": orchestration.max_concurrent_agents,
            "wave_size": orchestration.wave_size,
            "total_agent_dispatch_limit": orchestration.total_agent_dispatch_limit,
            "token_limit": orchestration.token_limit,
            "tool_call_limit": orchestration.tool_call_limit,
            "unsafe_resource_override_opt_in": (
                orchestration.unsafe_resource_override_opt_in
            ),
            "require_independent_critic": orchestration.require_independent_critic,
            "max_task_attempts": orchestration.max_task_attempts,
            "max_repair_cycles_per_candidate": (
                orchestration.max_repair_cycles_per_candidate
            ),
            "lease_seconds": orchestration.lease_seconds,
            "heartbeat_seconds": orchestration.heartbeat_seconds,
        },
        allow_unsafe_resource_override=allow_unsafe_resource_override,
    )
    checked_model_runtime = _model_runtime(
        {
            "provider": model_runtime.provider,
            "default_model": model_runtime.default_model,
            "reasoning_effort": model_runtime.reasoning_effort,
            "proposal_only": model_runtime.proposal_only,
            "structured_outputs": model_runtime.structured_outputs,
            "store_responses": model_runtime.store_responses,
            "max_output_tokens": model_runtime.max_output_tokens,
        },
        allow_unsafe_resource_override=allow_unsafe_resource_override,
        unsafe_resource_override_opt_in=(
            checked_orchestration.unsafe_resource_override_opt_in
        ),
    )
    checked_verification = _verification(
        {
            "unknown_is_pass": verification.unknown_is_pass,
            "require_native_engine": verification.require_native_engine,
            "require_kicad_engine": verification.require_kicad_engine,
            "engine_disagreement_is_blocking": (
                verification.engine_disagreement_is_blocking
            ),
            "require_exact_revision": verification.require_exact_revision,
            "preview_blocks_at": verification.preview_blocks_at,
            "commit_blocks_at": verification.commit_blocks_at,
            "manufacturing_release_blocks_at": (
                verification.manufacturing_release_blocks_at
            ),
            "require_algorithm_replay_hash": (
                verification.require_algorithm_replay_hash
            ),
        }
    )
    checked_backends = _backends(
        {
            "canonical_design_store": backends.canonical_design_store,
            "kicad": {
                "role": list(kicad_roles),
                "minimum_version": kicad.minimum_version,
            },
        }
    )
    return (
        schema_version,
        checked_coordination,
        checked_orchestration,
        checked_model_runtime,
        checked_verification,
        checked_backends,
    )


def _unsafe_resource_override_enabled(
    allow_unsafe_resource_override: bool,
) -> bool:
    """Return the explicit process-level authorization for an unsafe profile."""

    if type(allow_unsafe_resource_override) is not bool:
        raise TypeError("allow_unsafe_resource_override must be an exact boolean")
    return allow_unsafe_resource_override or (
        os.environ.get(_UNSAFE_RESOURCE_OVERRIDE_ENV) == "1"
    )


def load_product_configuration(
    path: str | Path,
    *,
    allow_unsafe_resource_override: bool = False,
) -> ProductConfiguration:
    """Load one exact schema-v1 product policy without JSON extensions.

    The normal public profile is finite.  A resource-override profile requires
    both its JSON opt-in and this argument (or the documented process
    environment gate); provider and host dispatch limits remain authoritative.
    """

    try:
        raw = Path(path).read_text(encoding="utf-8")
        decoded = json.loads(
            raw,
            object_pairs_hook=_duplicate_rejecting_object,
            parse_constant=_reject_constant,
        )
    except ProductConfigurationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ProductConfigurationError(
            f"cannot load product configuration: {exc}"
        ) from exc
    root = _object(
        decoded,
        label="product configuration",
        keys=frozenset(
            {
                "schema_version",
                "coordination",
                "orchestration",
                "model_runtime",
                "verification",
                "backends",
            }
        ),
    )
    schema_version = _int(root["schema_version"], "schema_version")
    if schema_version != 1:
        raise ProductConfigurationError(
            f"unsupported product configuration schema version: {schema_version}"
        )
    allow_override = _unsafe_resource_override_enabled(allow_unsafe_resource_override)
    token = _UNSAFE_RESOURCE_OVERRIDE_LOAD_GATE.set(allow_override)
    try:
        orchestration = _orchestration(
            root["orchestration"],
            allow_unsafe_resource_override=allow_override,
        )
        return ProductConfiguration(
            schema_version=schema_version,
            coordination=_coordination(root["coordination"]),
            orchestration=orchestration,
            model_runtime=_model_runtime(
                root["model_runtime"],
                allow_unsafe_resource_override=allow_override,
                unsafe_resource_override_opt_in=(
                    orchestration.unsafe_resource_override_opt_in
                ),
            ),
            verification=_verification(root["verification"]),
            backends=_backends(root["backends"]),
        )
    finally:
        _UNSAFE_RESOURCE_OVERRIDE_LOAD_GATE.reset(token)


DEFAULT_PRODUCT_CONFIGURATION_PATH = (
    Path(__file__).resolve().parents[1] / "config" / "product.json"
)


def load_default_product_configuration() -> ProductConfiguration:
    return load_product_configuration(DEFAULT_PRODUCT_CONFIGURATION_PATH)
