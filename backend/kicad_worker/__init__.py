"""Pinned local KiCad CLI verification worker."""

from .journal import (
    ClaimDisposition,
    JournalClaim,
    JournalConflictError,
    JournalError,
    JournalSubject,
    JournalTamperedError,
    SQLiteIdempotencyJournal,
)
from .models import (
    BundleResolutionError,
    ManagedArtifactPublisher,
    ManagedBundleResolver,
    ManagedKiCadBundle,
    PublishedArtifact,
    WorkerPolicy,
    managed_bundle_digest,
)
from .reports import KiCadReportError, ParsedCheckReport, parse_kicad_report
from .runner import (
    CommandExecutionError,
    CommandLaunchError,
    CommandOutputLimitError,
    CommandRunner,
    CommandTimeoutError,
    CompletedCommand,
    SubprocessRunner,
)
from .runtime_support import (
    RUNTIME_SUPPORT_POLICY_VERSION,
    RUNTIME_SUPPORT_TEMPLATE_SHA256,
    project_preferences_payload,
    runtime_support_manifest,
    runtime_support_manifest_sha256,
)
from .service import KiCadWorkerConfigurationError, LocalKiCadCliService

__all__ = (
    "BundleResolutionError",
    "ClaimDisposition",
    "CommandExecutionError",
    "CommandLaunchError",
    "CommandOutputLimitError",
    "CommandRunner",
    "CommandTimeoutError",
    "CompletedCommand",
    "JournalClaim",
    "JournalConflictError",
    "JournalError",
    "JournalSubject",
    "JournalTamperedError",
    "KiCadReportError",
    "KiCadWorkerConfigurationError",
    "LocalKiCadCliService",
    "ManagedArtifactPublisher",
    "ManagedBundleResolver",
    "ManagedKiCadBundle",
    "ParsedCheckReport",
    "PublishedArtifact",
    "RUNTIME_SUPPORT_POLICY_VERSION",
    "RUNTIME_SUPPORT_TEMPLATE_SHA256",
    "SQLiteIdempotencyJournal",
    "SubprocessRunner",
    "WorkerPolicy",
    "managed_bundle_digest",
    "parse_kicad_report",
    "project_preferences_payload",
    "runtime_support_manifest",
    "runtime_support_manifest_sha256",
)
