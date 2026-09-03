"""Dependency-free, dual-era MCP stdio transport.

The transport owns framing and protocol validation only. Authentication is a
host concern: the model never supplies a principal, actor kind, or profile.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from threading import RLock
from typing import Any, BinaryIO, cast

from backend.mcp_gateway import (
    ActorKind,
    AnswerQuestionRequest,
    ApprovalRequired,
    CapabilityDenied,
    CapabilitySafeGateway,
    CommitTransactionRequest,
    CreateAgentRunRequest,
    DecideApprovalRequest,
    DesignPatch,
    ExportFormat,
    ExportProjectRequest,
    GatewayError,
    IdempotencyConflict,
    InspectProjectRequest,
    InvalidRequest,
    Invocation,
    NotFound,
    Parameter,
    PatchAction,
    PatchOperation,
    PreviewPatchRequest,
    Principal,
    QuestionSpec,
    RevisionConflict,
    RollbackTransactionRequest,
    RunVerificationRequest,
    StageDesignPatchRequest,
    ToolName,
    canonical_data,
    canonical_json,
    stable_digest,
)

from .hooks import (
    KICAD_HOOK_BY_NAME,
    KICAD_HOOKS,
    KiCadCommitAttestation,
    KiCadCommitAttestationVerifier,
    KiCadHookSpec,
    KiCadImportApproval,
    KiCadImportApprovalVerifier,
    KiCadOperationService,
    KiCadServiceFailure,
    KiCadServiceResult,
    kicad_hook_output_schema,
    kicad_import_subject_digest,
)
from .validation import validate_json
from .version import VERSION

MODERN_VERSION = "2026-07-28"
LEGACY_VERSION = "2025-11-25"
SERVER_INFO = {"name": "evleda", "version": VERSION}
IDEMPOTENCY_META_KEY = "com.fluxclone/idempotencyKey"
# The 1 MiB limit applies to the JSON payload, not its line delimiter.  A
# tolerated CRLF input frame can therefore be two bytes larger than a payload.
MAX_PAYLOAD_BYTES = 1_048_576
MAX_FRAME_BYTES = MAX_PAYLOAD_BYTES + len(b"\r\n")
# Kept as the public compatibility name for the payload limit.
MAX_MESSAGE_BYTES = MAX_PAYLOAD_BYTES

_QUESTION_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "prompt": {"type": "string", "minLength": 1},
        "rationale": {"type": "string", "minLength": 1},
        "blocking": {"type": "boolean"},
        "options": {"type": "array", "items": {"type": "string", "minLength": 1}},
    },
    "required": ["prompt", "rationale", "blocking", "options"],
}


@dataclass(frozen=True, slots=True)
class HostConfig:
    """Trusted launch configuration, never populated from MCP arguments."""

    principal: Principal
    kicad_service: KiCadOperationService | None = None
    allowed_project_ids: frozenset[str] = frozenset()
    import_approval_verifier: KiCadImportApprovalVerifier | None = None
    canonical_verification_policy_digest: str | None = None
    commit_attestation_verifier: KiCadCommitAttestationVerifier | None = None
    commit_worker: str | None = None
    commit_version: str | None = None
    kicad_worker: str | None = None
    kicad_version: str | None = None
    kicad_policy_digest: str | None = None
    durable_worker_idempotency: bool = False
    exposed_gateway_tools: frozenset[ToolName] | None = None
    exposed_kicad_hooks: frozenset[str] | None = None

    def __post_init__(self) -> None:
        allowed_value = cast(object, self.allowed_project_ids)
        if type(allowed_value) is not frozenset:
            raise ValueError("allowed_project_ids must be a frozenset of project IDs")
        allowed_projects = cast(frozenset[object], allowed_value)
        if any(type(project_id) is not str or not project_id for project_id in allowed_projects):
            raise ValueError("allowed_project_ids must be a frozenset of project IDs")
        policy_digest = cast(object, self.canonical_verification_policy_digest)
        if policy_digest is not None and (
            type(policy_digest) is not str
            or len(policy_digest) != 64
            or any(character not in "0123456789abcdef" for character in policy_digest)
        ):
            raise ValueError("canonical_verification_policy_digest must be a sha256 digest or None")
        if self.kicad_service is not None:
            if not self.durable_worker_idempotency:
                raise ValueError("a KiCad service must guarantee durable idempotency")
            if not self.kicad_worker or not self.kicad_version:
                raise ValueError("a KiCad service requires pinned worker and version IDs")
            worker_policy = self.kicad_policy_digest
            if worker_policy is None or (
                len(worker_policy) != 64
                or any(character not in "0123456789abcdef" for character in worker_policy)
            ):
                raise ValueError("a KiCad service requires a pinned policy digest")
        commit_worker = self.commit_worker or self.kicad_worker
        commit_version = self.commit_version or self.kicad_version
        if self.commit_attestation_verifier is not None and (
            policy_digest is None or not commit_worker or not commit_version
        ):
            raise ValueError(
                "a commit attestation verifier requires pinned worker, version, "
                "and canonical policy identities"
            )
        if (
            policy_digest is not None
            and self.kicad_policy_digest is not None
            and policy_digest != self.kicad_policy_digest
            and self.commit_worker is None
        ):
            raise ValueError("canonical and hook verification policies must match")
        gateway_tools = self.exposed_gateway_tools
        if gateway_tools is not None and (
            type(gateway_tools) is not frozenset
            or any(type(tool) is not ToolName for tool in gateway_tools)
        ):
            raise ValueError("exposed_gateway_tools must be a frozenset of ToolName values")
        hooks = self.exposed_kicad_hooks
        if hooks is not None:
            if type(hooks) is not frozenset or any(type(name) is not str for name in hooks):
                raise ValueError("exposed_kicad_hooks must be a frozenset of hook names")
            unknown_hooks = hooks - KICAD_HOOK_BY_NAME.keys()
            if unknown_hooks:
                raise ValueError(
                    "exposed_kicad_hooks contains unknown hooks: "
                    + ", ".join(sorted(unknown_hooks))
                )
            if hooks and self.kicad_service is None:
                raise ValueError("exposed KiCad hooks require a configured KiCad service")
            if "kicad_import" in hooks and self.import_approval_verifier is None:
                raise ValueError("exposed kicad_import requires an import approval verifier")


class ProtocolFault(Exception):
    def __init__(self, code: int, message: str, data: Any | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


class MCPStdioServer:
    """Process-local MCP endpoint around one gateway and trusted principal."""

    def __init__(self, gateway: CapabilitySafeGateway, config: HostConfig) -> None:
        self._gateway = gateway
        self._config = config
        self._legacy_state = "new"
        self._gateway_manifests = {
            manifest.name.value: manifest
            for manifest in gateway.tool_manifest()
            if config.exposed_gateway_tools is None or manifest.name in config.exposed_gateway_tools
        }
        self._gateway_input_schemas = {
            name: _gateway_input_schema(manifest.name, manifest.input_schema())
            for name, manifest in self._gateway_manifests.items()
        }
        self._hook_lock = RLock()
        self._nonce_lock = RLock()
        self._request_nonce = 0
        self._hook_idempotency: dict[
            tuple[str, str, str, str], tuple[str, dict[str, Any], bool]
        ] = {}
        self._hook_manifests = {hook.name: hook for hook in self._active_hooks()}

    def handle_line(self, wire: bytes) -> bytes | None:
        """Handle exactly one newline-framed UTF-8 JSON-RPC message."""

        request_id: str | int | None = None
        is_valid_notification = False
        try:
            if not wire.endswith(b"\n"):
                raise ProtocolFault(-32700, "Parse error", {"reason": "missing newline"})
            raw = wire[:-1] if wire.endswith(b"\n") else wire
            if raw.endswith(b"\r"):
                raw = raw[:-1]
            if len(raw) > MAX_PAYLOAD_BYTES:
                raise ProtocolFault(-32700, "Parse error", {"reason": "message too large"})
            if b"\n" in raw or b"\r" in raw:
                raise ProtocolFault(-32700, "Parse error")
            try:
                decoded = cast(
                    object,
                    json.loads(
                        raw.decode("utf-8"),
                        object_pairs_hook=_unique_object,
                        parse_constant=_reject_json_constant,
                    ),
                )
            except (UnicodeDecodeError, ValueError) as exc:
                raise ProtocolFault(-32700, "Parse error") from exc
            if not isinstance(decoded, dict):
                raise ProtocolFault(-32600, "Invalid request")
            raw_message = cast(dict[object, object], decoded)
            if any(not isinstance(key, str) for key in raw_message):
                raise ProtocolFault(-32600, "Invalid request")
            message = cast(dict[str, Any], raw_message)
            is_notification = "id" not in message
            if not is_notification:
                candidate = cast(object, message["id"])
                if isinstance(candidate, bool) or not isinstance(candidate, (str, int)):
                    raise ProtocolFault(-32600, "Invalid request")
                request_id = candidate
            if message.get("jsonrpc") != "2.0":
                raise ProtocolFault(-32600, "Invalid request")
            method = cast(object, message.get("method"))
            if not isinstance(method, str) or not method:
                raise ProtocolFault(-32600, "Invalid request")
            is_valid_notification = is_notification
            allowed_fields = {"jsonrpc", "method", "params"}
            if not is_notification:
                allowed_fields.add("id")
            if message.keys() - allowed_fields:
                raise ProtocolFault(-32600, "Invalid request")
            params_value = cast(object, message.get("params", {}))
            if not isinstance(params_value, dict):
                raise ProtocolFault(-32602, "Invalid params")
            params = cast(dict[str, Any], params_value)
            if is_notification:
                self._notification(method, params)
                return None
            if request_id is None:
                raise ProtocolFault(-32600, "Invalid request")
            result = self._request(method, params, request_id)
            response = self._encode({"jsonrpc": "2.0", "id": request_id, "result": result})
            if len(response) - len(b"\n") > MAX_PAYLOAD_BYTES:
                raise ProtocolFault(-32603, "Internal error", {"reason": "response too large"})
            return response
        except ProtocolFault as exc:
            if is_valid_notification:
                return None
            error: dict[str, Any] = {"code": exc.code, "message": exc.message}
            if exc.data is not None:
                error["data"] = exc.data
            return self._bounded_encode({"jsonrpc": "2.0", "id": request_id, "error": error})
        except Exception:
            if is_valid_notification:
                return None
            return self._bounded_encode(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {"code": -32603, "message": "Internal error"},
                }
            )

    def _request(
        self,
        method: str,
        params: dict[str, Any],
        request_id: str | int,
    ) -> dict[str, Any]:
        if method == "initialize":
            return self._initialize(params)

        modern = self._is_modern(params)
        if modern:
            self._validate_modern_meta(params)
        elif method != "ping" and self._legacy_state != "ready":
            raise ProtocolFault(
                -32600,
                "Invalid request",
                {"reason": "legacy initialization is not complete"},
            )

        if method == "server/discover":
            if not modern:
                raise ProtocolFault(-32601, "Method not found")
            _protocol_fields(params, {"_meta"})
            return {
                "resultType": "complete",
                "supportedVersions": [MODERN_VERSION, LEGACY_VERSION],
                "capabilities": {"tools": {}},
                "instructions": "Use digest-bound approvals and exact revision preconditions.",
                "ttlMs": 3_600_000,
                "cacheScope": "public",
                "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
            }
        if method == "ping":
            _protocol_fields(params, {"_meta"})
            return self._result({}, modern)
        if method == "tools/list":
            _protocol_fields(params, {"_meta", "cursor"})
            cursor = params.get("cursor")
            if cursor is not None:
                raise ProtocolFault(-32602, "Invalid params", {"reason": "unknown cursor"})
            result: dict[str, Any] = {"tools": self._tools()}
            if modern:
                result.update(
                    resultType="complete",
                    ttlMs=3_600_000,
                    cacheScope="private" if self._config.kicad_service else "public",
                    _meta={"io.modelcontextprotocol/serverInfo": SERVER_INFO},
                )
            return result
        if method == "tools/call":
            return self._call_tool(params, request_id, modern)
        raise ProtocolFault(-32601, "Method not found", {"method": method})

    def _initialize(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._legacy_state != "new":
            raise ProtocolFault(-32600, "Invalid request", {"reason": "already initialized"})
        _protocol_fields(
            params,
            {"protocolVersion", "capabilities", "clientInfo", "_meta"},
            {"protocolVersion", "capabilities", "clientInfo"},
        )
        requested = cast(object, params.get("protocolVersion"))
        capabilities = cast(object, params.get("capabilities"))
        client_info = cast(object, params.get("clientInfo"))
        if not isinstance(requested, str) or not isinstance(capabilities, dict):
            raise ProtocolFault(-32602, "Invalid params")
        if not isinstance(client_info, dict):
            raise ProtocolFault(-32602, "Invalid params")
        exact_client_info = cast(dict[str, object], client_info)
        if not all(isinstance(exact_client_info.get(key), str) for key in ("name", "version")):
            raise ProtocolFault(-32602, "Invalid params")
        self._legacy_state = "awaiting_initialized"
        return {
            "protocolVersion": LEGACY_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": "Profiles and principals are fixed by the authenticated host.",
        }

    def _notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "notifications/initialized":
            if self._legacy_state == "awaiting_initialized":
                self._legacy_state = "ready"
            return
        # JSON-RPC notifications never receive responses. Unsupported and
        # cancellation notifications are intentionally safe no-ops here.

    @staticmethod
    def _is_modern(params: Mapping[str, Any]) -> bool:
        meta = cast(object, params.get("_meta"))
        return isinstance(meta, dict) and "io.modelcontextprotocol/protocolVersion" in meta

    @staticmethod
    def _validate_modern_meta(params: Mapping[str, Any]) -> None:
        meta_value = cast(object, params.get("_meta"))
        if not isinstance(meta_value, dict):
            raise ProtocolFault(-32602, "Invalid params")
        meta = cast(dict[str, object], meta_value)
        version = meta.get("io.modelcontextprotocol/protocolVersion")
        if version != MODERN_VERSION:
            raise ProtocolFault(
                -32022,
                "Unsupported protocol version",
                {"supported": [MODERN_VERSION, LEGACY_VERSION], "requested": version},
            )
        if not isinstance(meta.get("io.modelcontextprotocol/clientCapabilities"), dict):
            raise ProtocolFault(-32602, "Invalid params")

    @staticmethod
    def _result(payload: dict[str, Any], modern: bool) -> dict[str, Any]:
        if not modern:
            return payload
        return {
            "resultType": "complete",
            **payload,
            "_meta": {"io.modelcontextprotocol/serverInfo": SERVER_INFO},
        }

    def _tools(self) -> list[dict[str, Any]]:
        error_schema = {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "tool_name": {"type": "string"},
                "error": {
                    "type": "object",
                    "properties": {
                        "code": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["code", "message"],
                },
            },
            "required": ["tool_name", "error"],
        }
        tools: list[dict[str, Any]] = []
        for manifest in self._gateway_manifests.values():
            read_only = manifest.name is ToolName.INSPECT_PROJECT
            tools.append(
                {
                    "name": manifest.name.value,
                    "title": manifest.name.value.replace("_", " ").title(),
                    "description": manifest.description,
                    "inputSchema": self._gateway_input_schemas[manifest.name.value],
                    "outputSchema": {
                        "type": "object",
                        "oneOf": [manifest.output_schema(), error_schema],
                    },
                    "annotations": {
                        "readOnlyHint": read_only,
                        "destructiveHint": manifest.mutates_canonical_design,
                        "idempotentHint": read_only,
                        "openWorldHint": False,
                    },
                }
            )
        for hook in self._hook_manifests.values():
            tools.append(self._hook_tool(hook, error_schema))
        return sorted(tools, key=lambda item: item["name"])

    @staticmethod
    def _hook_tool(hook: KiCadHookSpec, error_schema: Mapping[str, Any]) -> dict[str, Any]:
        return {
            "name": hook.name,
            "title": hook.title,
            "description": hook.description,
            "inputSchema": hook.input_schema,
            "outputSchema": {
                "type": "object",
                "oneOf": [kicad_hook_output_schema(hook), error_schema],
            },
            "annotations": {
                "readOnlyHint": hook.read_only,
                "destructiveHint": hook.destructive,
                "idempotentHint": hook.read_only,
                "openWorldHint": False,
            },
        }

    def _call_tool(
        self, params: dict[str, Any], request_id: str | int, modern: bool
    ) -> dict[str, Any]:
        _protocol_fields(params, {"name", "arguments", "_meta"}, {"name"})
        name_value = cast(object, params.get("name"))
        arguments_value = cast(object, params.get("arguments", {}))
        if not isinstance(name_value, str) or not isinstance(arguments_value, dict):
            raise ProtocolFault(-32602, "Invalid params")
        name = name_value
        arguments = cast(dict[str, Any], arguments_value)
        gateway_manifest = self._gateway_manifests.get(name)
        hook = self._hook_manifests.get(name)
        if gateway_manifest is None and hook is None:
            raise ProtocolFault(-32602, f"Unknown tool: {name}")
        meta_value = cast(object, params.get("_meta", {}))
        if meta_value is not None and not isinstance(meta_value, dict):
            raise ProtocolFault(-32602, "Invalid params")
        meta = cast(dict[str, object], meta_value) if meta_value is not None else {}
        try:
            key = meta.get(IDEMPOTENCY_META_KEY)
            if key is None:
                nonce = self._fresh_nonce()
                material = canonical_json(
                    {
                        "nonce": nonce,
                        "request_id": request_id,
                        "tool_name": name,
                        "arguments_digest": stable_digest(arguments),
                    }
                )
                key = f"rpc_{hashlib.sha256(material.encode()).hexdigest()[:32]}"
            if not isinstance(key, str):
                raise InvalidRequest("idempotency key must be a string")
            invocation = Invocation(self._config.principal, key)
            if gateway_manifest is not None:
                validate_json(arguments, self._gateway_input_schemas[name])
                self._authorize_project(arguments)
                if (
                    gateway_manifest.name is ToolName.COMMIT_TRANSACTION
                    and self._config.commit_attestation_verifier is None
                ):
                    raise CapabilityDenied(
                        "canonical commit is disabled until the host configures a "
                        "digest-bound KiCad attestation verifier"
                    )
                gateway_request = _decode_tool_request(gateway_manifest.name, arguments)
                if gateway_manifest.name is ToolName.COMMIT_TRANSACTION:
                    self._attest_commit(arguments, invocation)
                result = getattr(self._gateway, name)(invocation, gateway_request)
                structured = canonical_data(result)
                is_error = False
            else:
                if hook is None:
                    raise ProtocolFault(-32602, f"Unknown tool: {name}")
                validate_json(arguments, hook.input_schema)
                self._authorize_project(arguments)
                structured, is_error = self._call_hook(hook, arguments, invocation)
        except GatewayError as exc:
            structured = {"tool_name": name, "error": exc.as_dict()}
            is_error = True
        except (KeyError, TypeError, ValueError) as exc:
            error = InvalidRequest(f"invalid typed tool input: {exc}")
            structured = {"tool_name": name, "error": error.as_dict()}
            is_error = True
        payload = {
            "content": [{"type": "text", "text": canonical_json(structured)}],
            "structuredContent": structured,
            "isError": is_error,
        }
        return self._result(payload, modern)

    def _active_hooks(self) -> tuple[KiCadHookSpec, ...]:
        if self._config.kicad_service is None:
            return ()
        exposed = self._config.exposed_kicad_hooks
        return tuple(
            hook
            for hook in KICAD_HOOKS
            if (exposed is None or hook.name in exposed)
            and (hook.name != "kicad_import" or self._config.import_approval_verifier is not None)
        )

    def _authorize_project(self, arguments: Mapping[str, Any]) -> None:
        project_id = arguments.get("project_id")
        if not isinstance(project_id, str) or project_id not in self._config.allowed_project_ids:
            raise CapabilityDenied("principal is not authorized for this project")

    def _attest_commit(self, arguments: Mapping[str, Any], invocation: Invocation) -> None:
        verifier = self._config.commit_attestation_verifier
        if verifier is None:
            raise CapabilityDenied("canonical commit requires a KiCad attestation")
        attestation_value = cast(object, verifier.attest_commit(arguments, invocation))
        if not isinstance(attestation_value, KiCadCommitAttestation):
            raise CapabilityDenied("commit verifier returned invalid attestation evidence")
        attestation = attestation_value
        expected = {
            "project_id": arguments["project_id"],
            "expected_project_revision": arguments["expected_project_revision"],
            "expected_staged_revision": arguments["expected_staged_revision"],
            "verification_report_digest": arguments["verification_report_digest"],
        }
        if any(getattr(attestation, name) != value for name, value in expected.items()):
            raise CapabilityDenied("KiCad attestation does not authorize this exact commit")
        if (
            not attestation.passed
            or attestation.worker != (self._config.commit_worker or self._config.kicad_worker)
            or attestation.kicad_version
            != (self._config.commit_version or self._config.kicad_version)
            or attestation.policy_digest != self._config.canonical_verification_policy_digest
        ):
            raise CapabilityDenied("KiCad commit attestation is not trusted by this host")

    def _call_hook(
        self,
        hook: KiCadHookSpec,
        arguments: Mapping[str, Any],
        invocation: Invocation,
    ) -> tuple[dict[str, Any], bool]:
        if invocation.principal.profile.maximum_tier < hook.required_tier:
            raise CapabilityDenied(
                f"{invocation.principal.profile.value} cannot invoke {hook.name}; "
                f"{hook.required_tier.name.lower()} capability is required"
            )
        if hook.requires_user and invocation.principal.actor_kind is not ActorKind.USER:
            raise CapabilityDenied(f"{hook.name} requires an authenticated user actor")
        if hook.name == "kicad_verify":
            checks_value = cast(object, arguments.get("checks"))
            if not isinstance(checks_value, list):
                raise InvalidRequest("KiCad verification checks must be sorted and unique")
            raw_checks = cast(list[object], checks_value)
            if any(not isinstance(check, str) for check in raw_checks):
                raise InvalidRequest("KiCad verification checks must be sorted and unique")
            checks = cast(list[str], raw_checks)
            if checks != sorted(set(checks)):
                raise InvalidRequest("KiCad verification checks must be sorted and unique")
        service = self._config.kicad_service
        if service is None:
            raise ProtocolFault(-32602, f"Unknown tool: {hook.name}")
        input_digest = stable_digest(arguments)
        authorization: KiCadImportApproval | None = None
        if hook.name == "kicad_import":
            verifier = self._config.import_approval_verifier
            if verifier is None:
                raise CapabilityDenied("kicad_import requires a host approval verifier")
            authorization_value = cast(
                object,
                verifier.authorize_import(arguments, invocation),
            )
            if not isinstance(authorization_value, KiCadImportApproval):
                raise ApprovalRequired("import approval verifier returned invalid evidence")
            authorization = authorization_value
            if authorization.receipt_id != arguments.get("approval_receipt_id"):
                raise ApprovalRequired("import approval receipt does not match the request")
            if authorization.subject_digest != kicad_import_subject_digest(arguments):
                raise ApprovalRequired("import approval does not authorize this exact subject")
        policy_digest = self._config.kicad_policy_digest
        if policy_digest is None:
            raise CapabilityDenied("KiCad hooks require a pinned worker policy")
        cache_key = (
            invocation.principal.actor_id,
            hook.name,
            policy_digest,
            invocation.idempotency_key,
        )
        with self._hook_lock:
            previous = self._hook_idempotency.get(cache_key)
            if previous is not None:
                previous_digest, structured, is_error = previous
                if previous_digest != input_digest:
                    raise IdempotencyConflict(
                        "idempotency key was already used with different canonical input"
                    )
                return structured, is_error
            self._require_current_project_revision(hook, arguments, invocation)
            try:
                method = getattr(service, hook.method_name)
                outcome = method(arguments, invocation)
            except KiCadServiceFailure as exc:
                structured = {
                    "tool_name": hook.name,
                    "error": {
                        "code": exc.code,
                        "message": exc.message,
                        "details": canonical_data(exc.details),
                    },
                }
                self._hook_idempotency[cache_key] = (input_digest, structured, True)
                return structured, True
            if not isinstance(outcome, KiCadServiceResult):
                raise InvalidRequest("KiCad service returned an invalid outcome type")
            payload = canonical_data(outcome.payload)
            validate_json(payload, hook.payload_schema, "$result.payload")
            evidence = outcome.evidence
            expected_revision = arguments.get("expected_project_revision")
            if (
                evidence.worker != self._config.kicad_worker
                or evidence.kicad_version != self._config.kicad_version
                or evidence.policy_digest != policy_digest
                or evidence.operation != hook.name
                or evidence.project_id != arguments.get("project_id")
                or evidence.expected_project_revision != expected_revision
                or evidence.opened_project_digest
                != (expected_revision[4:] if isinstance(expected_revision, str) else None)
                or (hook.name == "kicad_verify" and evidence.opened_bundle_sha256 is None)
                or (hook.name == "kicad_verify" and evidence.runtime_support_sha256 is None)
                or evidence.request_digest != input_digest
                or evidence.payload_digest != stable_digest(payload)
                or evidence.idempotency_key != invocation.idempotency_key
            ):
                raise InvalidRequest("KiCad worker evidence is not bound to this exact invocation")
            if outcome.succeeded != (evidence.exit_code == 0):
                raise InvalidRequest("KiCad worker success flag conflicts with its exit status")
            self._validate_hook_payload(hook, arguments, payload, outcome.succeeded)
            material = {
                "tool_name": hook.name,
                "succeeded": outcome.succeeded,
                "payload": payload,
                "evidence": canonical_data(evidence),
                "authorization": canonical_data(authorization),
            }
            structured = {**material, "result_digest": stable_digest(material)}
            is_error = not outcome.succeeded
            self._hook_idempotency[cache_key] = (input_digest, structured, is_error)
            return structured, is_error

    def _require_current_project_revision(
        self,
        hook: KiCadHookSpec,
        arguments: Mapping[str, Any],
        invocation: Invocation,
    ) -> None:
        project_id = arguments["project_id"]
        expected_revision = arguments["expected_project_revision"]
        inspect_invocation = Invocation(
            invocation.principal,
            f"guard_{self._fresh_nonce():032x}",
        )
        if expected_revision is None:
            try:
                self._gateway.inspect_project(
                    inspect_invocation, InspectProjectRequest(project_id, None)
                )
            except NotFound:
                return
            raise RevisionConflict("expected_project_revision may be null only for a new project")
        self._gateway.inspect_project(
            inspect_invocation,
            InspectProjectRequest(project_id, expected_revision),
        )

    def _fresh_nonce(self) -> int:
        with self._nonce_lock:
            self._request_nonce += 1
            return self._request_nonce

    @staticmethod
    def _validate_hook_payload(
        hook: KiCadHookSpec,
        arguments: Mapping[str, Any],
        payload: Mapping[str, Any],
        succeeded: bool,
    ) -> None:
        if payload["project_id"] != arguments["project_id"]:
            raise InvalidRequest("KiCad payload project does not match the request")
        if hook.name == "kicad_import":
            if (
                payload["previous_project_revision"] != arguments["expected_project_revision"]
                or payload["source_artifact_id"] != arguments["source_artifact_id"]
                or payload["source_sha256"] != arguments["source_sha256"]
            ):
                raise InvalidRequest("KiCad import payload is not bound to the request")
            return
        if payload["project_revision"] != arguments["expected_project_revision"]:
            raise InvalidRequest("KiCad payload revision does not match the request")
        if hook.name == "kicad_export" and payload["format"] != arguments["format"]:
            raise InvalidRequest("KiCad export format does not match the request")
        if hook.name == "kicad_render" and (
            payload["format"] != arguments["format"] or payload["view"] != arguments["view"]
        ):
            raise InvalidRequest("KiCad render parameters do not match the request")
        if hook.name == "kicad_verify":
            checks = arguments["checks"]
            if checks != sorted(set(checks)) or payload["checks"] != checks:
                raise InvalidRequest("KiCad verification checks must be sorted and unique")
            report_material = {
                key: payload[key]
                for key in (
                    "project_id",
                    "project_revision",
                    "checks",
                    "passed",
                    "blocking_findings",
                    "findings_digest",
                )
            }
            if payload["report_digest"] != stable_digest(report_material):
                raise InvalidRequest("KiCad verification report digest is invalid")
            if payload["passed"] != succeeded or (succeeded and payload["blocking_findings"] != 0):
                raise InvalidRequest("KiCad verification outcome is inconsistent")

    @staticmethod
    def _encode(message: dict[str, Any]) -> bytes:
        rendered = json.dumps(message, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        # json.loads accepts escaped lone surrogates, but UTF-8 does not.  The
        # UTF-16 surrogate-pass/replace round trip leaves normal text untouched,
        # combines a valid pair, and replaces each invalid scalar with U+FFFD.
        payload = rendered.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
        return payload.encode("utf-8") + b"\n"

    @classmethod
    def _bounded_encode(cls, message: dict[str, Any]) -> bytes:
        response = cls._encode(message)
        if len(response) - len(b"\n") <= MAX_PAYLOAD_BYTES:
            return response
        error_value = cast(object, message.get("error"))
        error = cast(dict[str, object], error_value) if isinstance(error_value, dict) else {}
        code = error.get("code", -32603)
        error_message = error.get("message", "Internal error")
        fallback = {
            "jsonrpc": "2.0",
            "id": message.get("id"),
            "error": {
                "code": code,
                "message": error_message,
                "data": {"reason": "response too large"},
            },
        }
        response = cls._encode(fallback)
        if len(response) - len(b"\n") <= MAX_PAYLOAD_BYTES:
            return response
        # An oversized ID cannot be represented together with any JSON-RPC
        # response under the configured limit.  Preserve the protocol code and
        # fail closed rather than exceeding the frame cap.
        fallback = {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": code, "message": "Response too large"},
        }
        response = cls._encode(fallback)
        if len(response) - len(b"\n") <= MAX_PAYLOAD_BYTES:
            return response
        return cls._encode(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {"code": -32603, "message": "Internal error"},
            }
        )

    @classmethod
    def oversized_frame_response(cls) -> bytes:
        """Return the fail-closed response for a discarded oversized frame."""

        return cls._bounded_encode(
            {
                "jsonrpc": "2.0",
                "id": None,
                "error": {
                    "code": -32700,
                    "message": "Parse error",
                    "data": {"reason": "message too large"},
                },
            }
        )


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise InvalidRequest(f"{label} must be an object")
    raw = cast(dict[object, object], value)
    if any(not isinstance(key, str) for key in raw):
        raise InvalidRequest(f"{label} keys must be strings")
    return cast(dict[str, Any], raw)


def _gateway_input_schema(name: ToolName, schema: Mapping[str, Any]) -> dict[str, Any]:
    """Tighten transport-visible shapes that the typed gateway already enforces."""

    rendered = _object(cast(object, canonical_data(schema)), "gateway tool input schema")
    if name is ToolName.CREATE_AGENT_RUN:
        properties = _object(
            cast(object, rendered.get("properties")),
            "gateway tool schema properties",
        )
        properties["initial_questions"] = {
            "type": "array",
            "items": _QUESTION_SCHEMA,
        }
    return rendered


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"invalid JSON constant: {value}")


def _protocol_fields(
    value: Mapping[str, Any],
    allowed: set[str],
    required: set[str] | None = None,
) -> None:
    missing = (required or set()) - value.keys()
    extra = value.keys() - allowed
    if missing or extra:
        data: dict[str, Any] = {}
        if missing:
            data["missing"] = sorted(missing)
        if extra:
            data["unknown"] = sorted(extra)
        raise ProtocolFault(-32602, "Invalid params", data)


def _exact(
    value: dict[str, Any],
    required: set[str],
    optional: frozenset[str] = frozenset(),
) -> None:
    missing = required - value.keys()
    extra = value.keys() - required - optional
    if missing:
        raise InvalidRequest(f"missing fields: {', '.join(sorted(missing))}")
    if extra:
        raise InvalidRequest(f"unknown fields: {', '.join(sorted(extra))}")


def _sequence(value: object, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise InvalidRequest(f"{label} must be an array")
    return cast(list[Any], value)


def _question(value: Any) -> QuestionSpec:
    item = _object(value, "question")
    _exact(item, {"prompt", "rationale", "blocking", "options"})
    if not isinstance(item["prompt"], str) or not isinstance(item["rationale"], str):
        raise InvalidRequest("question prompt and rationale must be strings")
    if not isinstance(item["blocking"], bool):
        raise InvalidRequest("question blocking must be a boolean")
    options = _sequence(item["options"], "options")
    if any(not isinstance(option, str) for option in options):
        raise InvalidRequest("question options must be strings")
    return QuestionSpec(item["prompt"], item["rationale"], item["blocking"], tuple(options))


def _patch(value: Any) -> DesignPatch:
    item = _object(value, "patch")
    _exact(item, {"patch_id", "base_revision", "rationale", "operations", "evidence_ids"})
    operations: list[PatchOperation] = []
    for raw_operation in _sequence(item["operations"], "operations"):
        operation = _object(raw_operation, "operation")
        _exact(operation, {"operation_id", "action", "target_id", "parameters"})
        parameters: list[Parameter] = []
        for raw_parameter in _sequence(operation["parameters"], "parameters"):
            parameter = _object(raw_parameter, "parameter")
            _exact(parameter, {"name", "value"})
            parameters.append(Parameter(parameter["name"], parameter["value"]))
        operations.append(
            PatchOperation(
                operation["operation_id"],
                PatchAction(operation["action"]),
                operation["target_id"],
                tuple(parameters),
            )
        )
    return DesignPatch(
        item["patch_id"],
        item["base_revision"],
        item["rationale"],
        tuple(operations),
        tuple(_sequence(item["evidence_ids"], "evidence_ids")),
    )


def _decode_tool_request(name: ToolName, arguments: dict[str, Any]) -> Any:
    run = {"project_id", "expected_project_revision", "run_id", "expected_run_revision"}
    stage = run | {"expected_staged_revision"}
    if name is ToolName.INSPECT_PROJECT:
        _exact(arguments, {"project_id", "expected_project_revision"})
        return InspectProjectRequest(**arguments)
    if name is ToolName.CREATE_AGENT_RUN:
        fields = {
            "project_id",
            "expected_project_revision",
            "objective",
            "initial_questions",
            "max_parallel_agents",
            "token_budget",
        }
        _exact(arguments, fields)
        return CreateAgentRunRequest(
            arguments["project_id"],
            arguments["expected_project_revision"],
            arguments["objective"],
            tuple(
                _question(item)
                for item in _sequence(arguments["initial_questions"], "initial_questions")
            ),
            arguments["max_parallel_agents"],
            arguments["token_budget"],
        )
    if name is ToolName.ANSWER_QUESTION:
        _exact(arguments, run | {"question_id", "answer"})
        return AnswerQuestionRequest(**arguments)
    if name is ToolName.DECIDE_APPROVAL:
        _exact(arguments, run | {"approval_id", "approve", "reason"})
        return DecideApprovalRequest(**arguments)
    if name is ToolName.PREVIEW_PATCH:
        _exact(arguments, run | {"patch"})
        return PreviewPatchRequest(
            arguments["project_id"],
            arguments["expected_project_revision"],
            arguments["run_id"],
            arguments["expected_run_revision"],
            _patch(arguments["patch"]),
        )
    if name is ToolName.STAGE_DESIGN_PATCH:
        _exact(arguments, run | {"patch", "preview_digest", "approval_receipt_id"})
        return StageDesignPatchRequest(
            arguments["project_id"],
            arguments["expected_project_revision"],
            arguments["run_id"],
            arguments["expected_run_revision"],
            _patch(arguments["patch"]),
            arguments["preview_digest"],
            arguments["approval_receipt_id"],
        )
    if name is ToolName.RUN_VERIFICATION:
        _exact(arguments, stage)
        return RunVerificationRequest(**arguments)
    if name is ToolName.COMMIT_TRANSACTION:
        _exact(arguments, stage | {"verification_report_digest", "approval_receipt_id"})
        return CommitTransactionRequest(**arguments)
    if name is ToolName.ROLLBACK_TRANSACTION:
        _exact(arguments, stage | {"reason"})
        return RollbackTransactionRequest(**arguments)
    if name is ToolName.EXPORT_PROJECT:
        _exact(arguments, {"project_id", "expected_project_revision", "format"})
        return ExportProjectRequest(
            arguments["project_id"],
            arguments["expected_project_revision"],
            ExportFormat(arguments["format"]),
        )
    raise InvalidRequest("unsupported tool")


def serve_stdio(server: MCPStdioServer, stdin: BinaryIO, stdout: BinaryIO) -> None:
    """Serve until EOF; stdout contains only newline-framed MCP messages."""

    discarding_oversized_frame = False
    while line := stdin.readline(MAX_FRAME_BYTES + 1):
        if discarding_oversized_frame:
            if line.endswith(b"\n"):
                discarding_oversized_frame = False
            continue
        if not line.endswith(b"\n") and len(line) >= MAX_FRAME_BYTES:
            # Reply before attempting another read: stdin may be a live pipe
            # whose sender never finishes the rejected frame.
            stdout.write(server.oversized_frame_response())
            stdout.flush()
            discarding_oversized_frame = True
            continue
        response = server.handle_line(line)
        if response is not None:
            stdout.write(response)
            stdout.flush()
