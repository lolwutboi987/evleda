"""Restart-safe, non-mutating KiCad import-candidate lifecycle."""

from backend.interchange_artifacts import ArtifactKind

from .models import (
    LEGAL_TRANSITIONS,
    CandidateBlocker,
    CandidateConcurrencyConflict,
    CandidateDiagnostic,
    CandidateEventKind,
    CandidateIdentityScheme,
    CandidateIntegrityError,
    CandidateNotFound,
    CandidateRepositoryError,
    CandidateState,
    CandidateStoreUnavailable,
    CandidateTransitionEvent,
    DiagnosticSeverity,
    IllegalCandidateTransition,
    ImportCandidate,
    ImportCandidateDraft,
    InvalidCandidate,
    UnsupportedCandidateStoreSchema,
    canonical_data,
    canonical_json,
)
from .repository import (
    STORE_SCHEMA_VERSION,
    ImportCandidateRepository,
    SQLiteImportCandidateRepository,
)

__all__ = (
    "LEGAL_TRANSITIONS",
    "STORE_SCHEMA_VERSION",
    "ArtifactKind",
    "CandidateBlocker",
    "CandidateConcurrencyConflict",
    "CandidateDiagnostic",
    "CandidateEventKind",
    "CandidateIdentityScheme",
    "CandidateIntegrityError",
    "CandidateNotFound",
    "CandidateRepositoryError",
    "CandidateState",
    "CandidateStoreUnavailable",
    "CandidateTransitionEvent",
    "DiagnosticSeverity",
    "IllegalCandidateTransition",
    "ImportCandidate",
    "ImportCandidateDraft",
    "ImportCandidateRepository",
    "InvalidCandidate",
    "SQLiteImportCandidateRepository",
    "UnsupportedCandidateStoreSchema",
    "canonical_data",
    "canonical_json",
)
