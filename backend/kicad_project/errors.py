"""Errors for the bounded KiCad project-bundle interchange boundary."""

from __future__ import annotations


class KiCadProjectError(ValueError):
    """Base class for project, schematic, or bundle contract failures."""


class ProjectSyntaxError(KiCadProjectError):
    """An input artifact is not bounded, well-formed UTF-8 JSON/S-expression data."""


class ProjectInvariantError(KiCadProjectError):
    """A parsed project bundle violates an exact supported-subset invariant."""


class UnsupportedProjectConstructError(KiCadProjectError):
    """A strict import or export encountered release-significant opaque syntax."""

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
