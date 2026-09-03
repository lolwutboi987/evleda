"""Portable distribution contracts for the public EvlEDA MCP command."""

from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from importlib import metadata, resources
from io import StringIO
from pathlib import Path
from unittest import mock

import evleda
from backend.mcp_server.cli import main
from backend.mcp_server.distribution import (
    discover_kicad_cli,
    no_shell_passthrough,
    probe_kicad_cli,
    render_doctor,
    resolve_kicad_installation,
)
from backend.mcp_server.reference_host import (
    ReferenceHostConfigurationError,
    ReferenceHostSettings,
    default_reference_state_root,
)
from backend.mcp_server.version import DISTRIBUTION_NAME, VERSION


class DistributionTests(unittest.TestCase):
    def test_public_distribution_identity_is_stable(self) -> None:
        self.assertEqual(DISTRIBUTION_NAME, "evleda")
        self.assertRegex(VERSION, r"^\d+\.\d+\.\d+$")
        self.assertEqual(evleda.__version__, VERSION)
        self.assertEqual(metadata.version(DISTRIBUTION_NAME), VERSION)
        manifest = resources.files("evleda").joinpath(
            "evidence/reference_sources/manifest.json"
        )
        self.assertTrue(manifest.is_file())
        self.assertIn('"source_evidence_count": 20', manifest.read_text(encoding="utf-8"))

    def test_explicit_override_wins_and_invalid_override_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            executable = root / ("kicad-cli.exe" if os.name == "nt" else "kicad-cli")
            executable.write_bytes(b"fixture")
            selected = discover_kicad_cli(executable, environment={})
            assert selected is not None
            selected_path, origin = selected
            self.assertEqual(origin, "override")
            self.assertTrue(os.path.samefile(selected_path, executable))
            self.assertTrue(selected_path.is_absolute())
            self.assertEqual(selected_path.name.casefold(), executable.name.casefold())
            with self.assertRaises(ReferenceHostConfigurationError):
                discover_kicad_cli(root / "not-kicad", environment={})

    def test_relative_and_linked_explicit_paths_fail_closed(self) -> None:
        with self.assertRaisesRegex(ReferenceHostConfigurationError, "must be absolute"):
            discover_kicad_cli(Path("kicad-cli"), environment={})
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target_dir = root / "target"
            target_dir.mkdir()
            name = "kicad-cli.exe" if os.name == "nt" else "kicad-cli"
            target = target_dir / name
            target.write_bytes(b"fixture")
            linked = root / name
            try:
                linked.symlink_to(target)
            except OSError:
                self.skipTest("file symlink creation is unavailable on this host")
            with self.assertRaisesRegex(ReferenceHostConfigurationError, "link or reparse"):
                discover_kicad_cli(linked, environment={})

    def test_fake_path_and_environment_executables_are_never_run_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            fake = root / ("kicad-cli.exe" if os.name == "nt" else "kicad-cli")
            fake.write_bytes(b"adversarial PATH executable")
            hostile_environment = {
                "PATH": str(root),
                "EVLEDA_KICAD_CLI": str(fake),
            }
            with (
                mock.patch(
                    "backend.mcp_server.distribution._platform_candidates", return_value=()
                ),
                mock.patch("backend.mcp_server.distribution.subprocess.run") as run,
            ):
                self.assertIsNone(
                    resolve_kicad_installation(environment=hostile_environment)
                )
            run.assert_not_called()

    def test_user_writable_automatic_candidate_is_rejected_before_execution(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            fake = Path(raw) / ("kicad-cli.exe" if os.name == "nt" else "kicad-cli")
            fake.write_bytes(b"adversarial platform lookalike")
            with (
                mock.patch(
                    "backend.mcp_server.distribution._platform_candidates",
                    return_value=(fake,),
                ),
                mock.patch("backend.mcp_server.distribution.subprocess.run") as run,
                self.assertRaisesRegex(ReferenceHostConfigurationError, "platform-owned"),
            ):
                resolve_kicad_installation(environment={})
            run.assert_not_called()

    def test_probe_hashes_first_and_rejects_mutation_during_version_execution(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            executable = Path(raw) / (
                "kicad-cli.exe" if os.name == "nt" else "kicad-cli"
            )
            executable.write_bytes(b"reviewed executable bytes")
            completed = subprocess.CompletedProcess(
                (str(executable), "version"), 0, b"10.0.6\n", b""
            )
            with mock.patch(
                "backend.mcp_server.distribution.subprocess.run", return_value=completed
            ):
                installation = probe_kicad_cli(executable, origin="override")
            self.assertEqual(
                installation.sha256,
                hashlib.sha256(b"reviewed executable bytes").hexdigest(),
            )
            self.assertEqual(installation.version, "10.0.6")

            def mutate(*args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
                del args, kwargs
                executable.write_bytes(b"replacement executable bytes")
                return completed

            with (
                mock.patch("backend.mcp_server.distribution.subprocess.run", side_effect=mutate),
                self.assertRaisesRegex(ReferenceHostConfigurationError, "changed"),
            ):
                probe_kicad_cli(executable, origin="override")

    def test_probe_requires_strict_kicad_10_version_output(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            executable = Path(raw) / (
                "kicad-cli.exe" if os.name == "nt" else "kicad-cli"
            )
            executable.write_bytes(b"reviewed executable bytes")
            completed = subprocess.CompletedProcess(
                (str(executable), "version"), 0, b"wrapper reports 10.0.6\n", b""
            )
            with (
                mock.patch(
                    "backend.mcp_server.distribution.subprocess.run", return_value=completed
                ),
                self.assertRaisesRegex(ReferenceHostConfigurationError, "exact KiCad 10"),
            ):
                probe_kicad_cli(executable, origin="override")

    def test_external_state_is_mandatory_and_no_command_passthrough_exists(self) -> None:
        state = default_reference_state_root()
        self.assertTrue(state.is_absolute())
        self.assertEqual(no_shell_passthrough(()), ())
        with self.assertRaises(ReferenceHostConfigurationError):
            no_shell_passthrough(("kicad-cli", "pcb", "drc"))
        source_root = Path(__file__).resolve().parents[2]
        with self.assertRaises(ReferenceHostConfigurationError):
            ReferenceHostSettings(source_root / "runtime-state")

    def test_installed_style_smoke_exercises_framing_without_kicad(self) -> None:
        stdout = StringIO()
        with redirect_stdout(stdout):
            self.assertEqual(main(["smoke"]), 0)
        self.assertEqual(
            stdout.getvalue(),
            "evleda-mcp smoke: passed (legacy initialize/list-tools/ping)\n",
        )

    def test_doctor_and_help_disclose_the_fail_closed_discovery_policy(self) -> None:
        doctor = render_doctor(None, default_reference_state_root())
        self.assertIn("evleda-mcp doctor", doctor)
        self.assertIn("PATH ignored", doctor)
        self.assertIn("not found in trusted locations", doctor)

        stdout = StringIO()
        with redirect_stdout(stdout), self.assertRaises(SystemExit) as exited:
            main(["doctor", "--help"])
        self.assertEqual(exited.exception.code, 0)
        self.assertIn("PATH and executable-selection environment", stdout.getvalue())
        self.assertIn("variables are not searched", stdout.getvalue())


if __name__ == "__main__":
    unittest.main()
