"""MCP stdio binding for the capability-safe KiCad gateway."""

from .hooks import (
    KiCadCommitAttestation,
    KiCadCommitAttestationVerifier,
    KiCadExecutionEvidence,
    KiCadImportApproval,
    KiCadImportApprovalVerifier,
    KiCadOperationService,
    KiCadServiceFailure,
    KiCadServiceResult,
)
from .server import HostConfig, MCPStdioServer, serve_stdio

__all__ = (
    "HostConfig",
    "KiCadCommitAttestation",
    "KiCadCommitAttestationVerifier",
    "KiCadExecutionEvidence",
    "KiCadImportApproval",
    "KiCadImportApprovalVerifier",
    "KiCadOperationService",
    "KiCadServiceFailure",
    "KiCadServiceResult",
    "MCPStdioServer",
    "serve_stdio",
)
