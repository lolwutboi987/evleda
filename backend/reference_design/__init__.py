"""Evidence-bound deterministic USB-C to 3.3 V reference-board package."""

from .artifacts import (
    PROJECT_STEM,
    ReferenceArtifactSet,
    build_reference_artifact_set,
    materialize_reference_artifacts,
    materialize_reference_kicad_working_copy,
)
from .audit import audit_reference_board
from .builder import ReferenceBoardBuild, ReferenceBoardBuildError, build_reference_board
from .model import (
    BoardAudit,
    BomLine,
    DesignConstraint,
    ReferenceDesignResult,
    ReferenceDesignViolation,
    SourceEvidence,
)
from .specification import (
    BOARD_HEIGHT_NM,
    BOARD_WIDTH_NM,
    PCB_THICKNESS_NM,
    PROJECT_ID,
    QUALIFIED_OUTPUT_CURRENT_MA,
    bom,
    components,
    constraints,
    sources,
)

__all__ = (
    "BOARD_HEIGHT_NM",
    "BOARD_WIDTH_NM",
    "PCB_THICKNESS_NM",
    "PROJECT_ID",
    "QUALIFIED_OUTPUT_CURRENT_MA",
    "BoardAudit",
    "BomLine",
    "DesignConstraint",
    "ReferenceBoardBuild",
    "ReferenceBoardBuildError",
    "ReferenceDesignResult",
    "ReferenceDesignViolation",
    "ReferenceArtifactSet",
    "SourceEvidence",
    "bom",
    "audit_reference_board",
    "build_reference_artifact_set",
    "build_reference_board",
    "components",
    "constraints",
    "sources",
    "materialize_reference_artifacts",
    "materialize_reference_kicad_working_copy",
    "PROJECT_STEM",
)
