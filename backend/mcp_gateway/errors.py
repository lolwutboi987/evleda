"""Stable, transport-neutral errors for the capability-safe gateway."""

from __future__ import annotations


class GatewayError(RuntimeError):
    """Base error with a machine-readable code safe for MCP responses."""

    code = "gateway_error"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class InvalidRequest(GatewayError):
    code = "invalid_request"


class CapabilityDenied(GatewayError):
    code = "capability_denied"


class RevisionConflict(GatewayError):
    code = "revision_conflict"


class IdempotencyConflict(GatewayError):
    code = "idempotency_conflict"


class NotFound(GatewayError):
    code = "not_found"


class CoordinationRequired(GatewayError):
    code = "coordination_required"


class ApprovalRequired(GatewayError):
    code = "approval_required"


class VerificationFailed(GatewayError):
    code = "verification_failed"


class TransactionConflict(GatewayError):
    code = "transaction_conflict"


class StateConflict(GatewayError):
    """Another host process advanced the durable gateway journal."""

    code = "state_conflict"


class StateIntegrityError(GatewayError):
    """Persisted coordination or idempotency evidence failed validation."""

    code = "state_integrity_failed"


class StateUnavailable(GatewayError):
    """Durable coordination state could not be read or committed."""

    code = "state_unavailable"
