"""Derivative KiCad CAM candidates with permanently absent release authority."""

from .filled_board_semantics import (
    NORMALIZER_ID,
    NORMALIZER_VERSION,
    FilledBoardSemanticEvidence,
    FilledPolygonEvidence,
    analyze_filled_board,
    filled_board_evidence_payload,
)
from .materialize import (
    COMPLETION_MANIFEST_FILENAME,
    FILE_MANIFEST_FILENAME,
    ZIP_FILENAME,
    CandidateMaterialization,
    materialize_manufacturing_candidate,
)
from .model import (
    NON_FABRICATION_NOTICE_FILENAME,
    NON_FABRICATION_NOTICE_PAYLOAD,
    NON_FABRICATION_NOTICE_SHA256,
    ArtifactDigest,
    CandidateArtifact,
    CandidateContractError,
    CandidateGenerationError,
    CandidateHostConfiguration,
    CandidatePolicy,
    CandidateReceipt,
    CandidateSource,
    CommandReceipt,
    ManufacturingCandidate,
)
from .pipeline import KiCadManufacturingCandidatePipeline
from .reference_adapter import (
    ReferencePublicationBinding,
    candidate_source_from_reference,
)
from .source_zone_identity import (
    ZONE_IDENTITY_NORMALIZER_ID,
    ZONE_IDENTITY_NORMALIZER_VERSION,
    AuthoredZoneIdentity,
    SourceZoneIdentityEvidence,
    compare_source_zone_identity,
    source_authored_zone_count,
)

__all__ = (
    "ArtifactDigest",
    "AuthoredZoneIdentity",
    "COMPLETION_MANIFEST_FILENAME",
    "CandidateArtifact",
    "CandidateContractError",
    "CandidateGenerationError",
    "CandidateHostConfiguration",
    "CandidateMaterialization",
    "CandidatePolicy",
    "CandidateReceipt",
    "CandidateSource",
    "CommandReceipt",
    "FILE_MANIFEST_FILENAME",
    "FilledBoardSemanticEvidence",
    "FilledPolygonEvidence",
    "KiCadManufacturingCandidatePipeline",
    "ManufacturingCandidate",
    "NON_FABRICATION_NOTICE_FILENAME",
    "NON_FABRICATION_NOTICE_PAYLOAD",
    "NON_FABRICATION_NOTICE_SHA256",
    "NORMALIZER_ID",
    "NORMALIZER_VERSION",
    "ReferencePublicationBinding",
    "SourceZoneIdentityEvidence",
    "ZIP_FILENAME",
    "ZONE_IDENTITY_NORMALIZER_ID",
    "ZONE_IDENTITY_NORMALIZER_VERSION",
    "candidate_source_from_reference",
    "compare_source_zone_identity",
    "analyze_filled_board",
    "filled_board_evidence_payload",
    "materialize_manufacturing_candidate",
    "source_authored_zone_count",
)
