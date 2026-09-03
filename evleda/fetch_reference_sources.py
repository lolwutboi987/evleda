"""Public wrapper for permissioned reference-source retrieval."""

from __future__ import annotations

from backend.evidence.reference_sources import fetch_main


def main() -> int:
    """Fetch only the manifest-authorized verified evidence records."""

    return fetch_main()


__all__ = ("main",)
