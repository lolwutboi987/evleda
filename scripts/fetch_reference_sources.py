"""Populate an external, private source-evidence cache for evleda.

This thin wrapper keeps the command usable from a source checkout.  Installed distributions may
expose the same implementation as ``evleda-fetch-reference-sources``.
"""

from __future__ import annotations

import sys
from pathlib import Path

# When invoked as ``python scripts/fetch_reference_sources.py`` Python places ``scripts/`` rather
# than the project root on sys.path.  Resolve the import explicitly without changing cwd.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.evidence.reference_sources import fetch_main  # noqa: E402,I001


if __name__ == "__main__":
    raise SystemExit(fetch_main())
