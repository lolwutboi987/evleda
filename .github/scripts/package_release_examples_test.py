"""Adversarial tests for the fail-closed release-assets output directory."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import package_release_examples as release


class ReleaseOutputSafetyTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.output = self.root / "release-assets"
        self.original_output = release.OUTPUT_DIRECTORY
        release.OUTPUT_DIRECTORY = self.output

    def tearDown(self) -> None:
        release.OUTPUT_DIRECTORY = self.original_output
        self.temporary.cleanup()

    def test_rejects_root_and_source_directories(self) -> None:
        for protected in (self.root, self.root / ".git", self.root / "backend", self.root / "docs"):
            protected.mkdir(exist_ok=True)
            (protected / "sentinel").write_text("keep", encoding="utf-8")
            with self.assertRaises(SystemExit):
                release.prepare_output(protected)
            self.assertTrue((protected / "sentinel").exists())

    def test_rejects_nonempty_unknown_output_without_removal(self) -> None:
        self.output.mkdir()
        sentinel = self.output / "not-owned.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaises(SystemExit):
            release.prepare_output(self.output)
        self.assertTrue(sentinel.exists())

    def test_cleans_only_known_output_files(self) -> None:
        self.output.mkdir()
        known = self.output / release.README
        known.write_text("old", encoding="utf-8")
        release.prepare_output(self.output)
        self.assertFalse(known.exists())

    def test_rejects_symlinked_output(self) -> None:
        destination = self.root / "destination"
        destination.mkdir()
        link = self.root / "release-assets-link"
        try:
            link.symlink_to(destination, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"symlink creation is unavailable: {exc}")
        release.OUTPUT_DIRECTORY = link
        with self.assertRaises(SystemExit):
            release.prepare_output(link)
        self.assertTrue(destination.exists())


if __name__ == "__main__":
    unittest.main()
