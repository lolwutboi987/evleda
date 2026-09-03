"""Fail CI when tracked files violate the public-release boundary."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REQUIRED = {
    "LICENSE": "Apache License",
    "LICENSES/CERN-OHL-P-2.0.txt": "CERN Open Hardware Licence Version 2 - Permissive",
    "NOTICE": "Hardware design examples",
    "SECURITY.md": "Reporting a vulnerability",
    "CONTRIBUTING.md": "Contributing to EvlEDA",
    "CODE_OF_CONDUCT.md": "Contributor Covenant",
    "THIRD_PARTY_NOTICES.md": "Third-party",
}
FORBIDDEN_PARTS = {
    ".flux-clone",
    "tmp",
    "work",
    "outputs",
    "node_modules",
    ".ruff_cache",
    ".pytest_cache",
    "build",
    "dist",
    "private-evidence",
    "evidence-private",
    "runtime-evidence",
    "worker-state",
}
FORBIDDEN_SUFFIXES = (".egg-info", ".kicad_prl", ".sqlite", ".sqlite3", ".db", ".tsbuildinfo")
FORBIDDEN_PUBLIC_PREFIXES = (
    "backend/api/",
    "frontend/",
    "tests/api/",
)
FORBIDDEN_PUBLIC_FILES = {
    "package.json",
    "pnpm-lock.yaml",
    "docs/CONFIGURATION.md",
    "docs/EVLEDA_COMPARISON_RESEARCH.md",
    "docs/EXACT_PREVIEW_CONTRACT.md",
    "docs/FEATURE_PARITY.md",
    "docs/IMPORT_EXPORT_CONTRACT.md",
    "docs/IMPORT_STAGE_INTEGRATION_PLAN.md",
    "docs/PARITY_ROADMAP.md",
}
SECRET_PATTERNS = (
    re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    re.compile(rb"(?:ghp|github_pat)_[A-Za-z0-9_]{20,}"),
    re.compile(rb"AKIA[0-9A-Z]{16}"),
    re.compile(rb"(?:OPENAI|ANTHROPIC|AWS)_API_KEY\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{16,}", re.I),
)


def fail(message: str) -> None:
    raise SystemExit(f"repository hygiene failed: {message}")


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    )
    return [ROOT / item for item in result.stdout.decode("utf-8").split("\0") if item]


def main() -> None:
    for relative, marker in REQUIRED.items():
        path = ROOT / relative
        if not path.is_file() or marker not in path.read_text(encoding="utf-8"):
            fail(f"missing or invalid required public file: {relative}")
    third_party = (ROOT / "THIRD_PARTY_NOTICES.md").read_text(encoding="utf-8").lower()
    if "placeholder" in third_party or "todo" in third_party:
        fail("third-party notices must not contain placeholders")
    for path in tracked_files():
        relative = path.relative_to(ROOT)
        relative_posix = relative.as_posix()
        if relative_posix in FORBIDDEN_PUBLIC_FILES or relative_posix.startswith(
            FORBIDDEN_PUBLIC_PREFIXES
        ):
            fail(f"tracked superseded browser/HTTP product surface: {relative}")
        parts = set(relative.parts)
        if parts & FORBIDDEN_PARTS:
            fail(f"tracked internal/runtime path: {relative}")
        if relative.parts[:4] == ("docs", "evidence", "reference_sources", "blobs"):
            fail(f"tracked restricted source-evidence blob: {relative}")
        if relative.name.endswith(FORBIDDEN_SUFFIXES) or any(
            part.endswith(".egg-info") for part in relative.parts
        ):
            fail(f"tracked generated state: {relative}")
        if path.is_file() and path.stat().st_size <= 5 * 1024 * 1024:
            content = path.read_bytes()
            if any(pattern.search(content) for pattern in SECRET_PATTERNS):
                fail(f"likely credential in tracked file: {relative}")
    print("repository hygiene passed")


if __name__ == "__main__":
    main()
