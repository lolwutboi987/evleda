"""Fast source-level contracts for the public packaging configuration."""

from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def test_dev_extra_declares_the_public_contributor_toolchain() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    dev = payload["project"]["optional-dependencies"]["dev"]
    assert isinstance(dev, list)
    joined = "\n".join(dev)
    for dependency in ("build", "pytest", "ruff", "pyright"):
        assert dependency in joined


def test_public_package_excludes_superseded_http_and_browser_products() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    package_find = payload["tool"]["setuptools"]["packages"]["find"]
    assert {"backend.api", "backend.api.*"} <= set(package_find["exclude"])
    manifest = (ROOT / "MANIFEST.in").read_text(encoding="utf-8")
    for excluded in ("frontend", "prototypes", "backend/api", "tests/api"):
        assert f"prune {excluded}" in manifest

    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    for forbidden in ("setup-node", "pnpm", "frontend"):
        assert forbidden not in workflow

    scripts = payload["project"]["scripts"]
    assert set(scripts) == {"evleda-mcp", "evleda-fetch-reference-sources"}
    assert all("backend.api" not in target for target in scripts.values())


def test_mixed_license_distribution_has_explicit_archive_rules() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    classifiers = payload["project"].get("classifiers", [])
    assert "License :: OSI Approved :: Apache Software License" not in classifiers
    license_files = payload["tool"]["setuptools"]["license-files"]
    assert set(license_files) == {
        "LICENSE",
        "NOTICE",
        "THIRD_PARTY_NOTICES.md",
        "LICENSES/*.txt",
        "LICENSES/*.md",
    }
    manifest = (ROOT / "MANIFEST.in").read_text(encoding="utf-8")
    assert "prune docs/evidence/reference_sources/blobs" in manifest
    assert "recursive-include LICENSES *.txt *.md" in manifest
    assert "recursive-include evleda/legal *.txt *.md *.json" in manifest
    package_data = payload["tool"]["setuptools"]["package-data"]["evleda"]
    assert {"legal/*.txt", "legal/*.md", "legal/*.json"} <= set(package_data)


def test_private_rebuilds_are_explicitly_marked_and_not_default_selected() -> None:
    payload = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    pytest_config = payload["tool"]["pytest"].get("ini_options", {})
    assert "not restricted_evidence" in pytest_config["addopts"]
    assert any("restricted_evidence" in marker for marker in pytest_config["markers"])
    assert "pytestmark = pytest.mark.restricted_evidence" in (
        ROOT / "tests" / "evidence" / "test_reference_sources.py"
    ).read_text(encoding="utf-8")
    assert "pytestmark = pytest.mark.restricted_evidence" in (
        ROOT / "tests" / "reference_design" / "test_audit.py"
    ).read_text(encoding="utf-8")
    compiler_tests = (
        ROOT / "tests" / "kicad_compile" / "test_compiler.py"
    ).read_text(encoding="utf-8")
    for test_name in (
        "test_full_reference_emits_exact_r2_profile_artwork_silk_and_model_evidence",
        "test_full_reference_dda_ep_separates_copper_mask_and_paste_apertures",
        "test_r2_permutation_profile_and_module_tampering_fail_closed",
        "test_installed_kicad_10_0_6_accepts_final_reference_and_refill",
    ):
        assert f"@pytest.mark.restricted_evidence\ndef {test_name}" in compiler_tests


def test_release_workflow_isolates_untrusted_build_from_publish_authority() -> None:
    workflow = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    build, publish = workflow.split("  publish:\n", maxsplit=1)
    assert "RELEASE_TAG: ${{ github.ref_name }}" in build
    assert "[[ ! \"$RELEASE_TAG\" =~ ^v" in build
    assert "git merge-base --is-ancestor \"$RELEASE_COMMIT\" origin/main" in build
    assert "artifact-digest" in build
    assert "actions/checkout" not in publish
    assert "environment: release" in publish
    assert "sha256sum --check release-assets/SHA256SUMS.txt" in publish
    assert "dist/*" not in workflow
