"""Portable discovery helpers for optional native KiCad integration tests."""

from __future__ import annotations

import os
import shutil
from pathlib import Path


def discover_kicad_cli() -> Path | None:
    """Return an explicitly configured CLI, or a ``PATH`` discovery result.

    Native KiCad tests are optional: a clean CI environment is expected to skip
    them unless it deliberately installs and pins a compatible KiCad runtime.
    """

    configured = os.environ.get("EVLEDA_KICAD_CLI")
    candidate = Path(configured) if configured else None
    if candidate is not None and candidate.is_file():
        return candidate.resolve()
    discovered = shutil.which("kicad-cli")
    if discovered is None:
        return None
    candidate = Path(discovered)
    return candidate.resolve() if candidate.is_file() else None


def discover_kicad_demo(cli: Path | None) -> Path | None:
    """Find KiCad's optional bundled ``ecc83`` demo beside a discovered CLI."""

    if cli is None:
        return None
    candidate = cli.parent.parent / "share" / "kicad" / "demos" / "ecc83"
    return candidate if candidate.is_dir() else None
