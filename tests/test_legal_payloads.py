"""Distribution and root-source invariants for standalone legal payloads."""

from __future__ import annotations

from pathlib import Path

from evleda.legal import load_legal_payloads


def test_packaged_legal_payloads_are_complete_and_self_authenticating() -> None:
    payloads = load_legal_payloads()
    assert tuple(item.filename for item in payloads) == (
        "CC-BY-SA-4.0.txt",
        "CERN-OHL-P-2.0.txt",
        "KiCad-Libraries-LICENSE.md",
        "NOTICE.txt",
        "THIRD_PARTY_NOTICES.md",
    )
    assert all(item.archive_filename == f"legal/{item.filename}" for item in payloads)


def test_packaged_legal_payloads_equal_the_governing_repository_files() -> None:
    root = Path(__file__).resolve().parents[1]
    repository_files = {
        "CC-BY-SA-4.0.txt": root / "LICENSES" / "CC-BY-SA-4.0.txt",
        "CERN-OHL-P-2.0.txt": root / "LICENSES" / "CERN-OHL-P-2.0.txt",
        "KiCad-Libraries-LICENSE.md": root / "LICENSES" / "KiCad-Libraries-LICENSE.md",
        "NOTICE.txt": root / "NOTICE",
        "THIRD_PARTY_NOTICES.md": root / "THIRD_PARTY_NOTICES.md",
    }
    assert {
        item.filename: item.payload for item in load_legal_payloads()
    } == {name: path.read_bytes() for name, path in repository_files.items()}
