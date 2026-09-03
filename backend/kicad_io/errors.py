"""Errors raised by the deterministic KiCad exchange boundary."""

from __future__ import annotations


class KiCadIOError(ValueError):
    """Base class for an import or export contract violation."""


class KiCadSyntaxError(KiCadIOError):
    """The input is not a bounded, well-formed KiCad S-expression."""


class KiCadInvariantError(KiCadIOError):
    """The parsed or supplied board violates the exchange IR invariants."""


class UnsupportedConstructError(KiCadIOError):
    """A strict exchange encountered a construct outside the supported subset."""

    def __init__(
        self,
        message: str,
        *,
        manifest_sha256: str,
        diagnostics: tuple[object, ...] = (),
    ) -> None:
        super().__init__(message)
        self.manifest_sha256 = manifest_sha256
        self.diagnostics = diagnostics


class CanonicalMappingError(KiCadIOError):
    """The exchange IR cannot be mapped to the product graph without invention."""

    def __init__(self, message: str, *, gaps: tuple[object, ...]) -> None:
        super().__init__(message)
        self.gaps = gaps
