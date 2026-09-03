"""Deterministic canonical DesignGraph to strict KiCad-10 project compiler."""

from .compiler import (
    COMPILER_ID,
    COMPILER_VERSION,
    compile_design_graph,
    verify_compiled_project,
)
from .model import (
    CompilationBlockedError,
    CompilationBlocker,
    CompilationManifest,
    CompilationParityError,
    CompilationProfileEvidence,
    CompilationVerification,
    CompiledProject,
    FileDigest,
    IdentityBinding,
)

__all__ = (
    "COMPILER_ID",
    "COMPILER_VERSION",
    "CompilationBlockedError",
    "CompilationBlocker",
    "CompilationManifest",
    "CompilationParityError",
    "CompilationProfileEvidence",
    "CompilationVerification",
    "CompiledProject",
    "FileDigest",
    "IdentityBinding",
    "compile_design_graph",
    "verify_compiled_project",
)
