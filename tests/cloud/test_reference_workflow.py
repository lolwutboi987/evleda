from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import stat
import sys
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "cloud" / "reference_workflow.py"


def _workflow() -> ModuleType:
    spec = importlib.util.spec_from_file_location("evleda_cloud_reference_workflow", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _zip(items: tuple[tuple[zipfile.ZipInfo, bytes], ...]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for info, payload in items:
            archive.writestr(info, payload)
    return output.getvalue()


def test_plan_is_deterministic_digest_bound_and_non_release() -> None:
    workflow = _workflow()
    first, _, files = workflow._plan_document()
    second, _, replay_files = workflow._plan_document()

    assert workflow._canonical_bytes(first) == workflow._canonical_bytes(second)
    assert files == replay_files
    assert first["workflow"] == "evleda-cloud-reference"
    assert first["scope"]["arbitrary_board_generation_supported"] is False
    assert first["output_policy"]["manufacturing_release_eligible"] is False
    assert first["source"]["packaged_runtime"]["available"] is True
    approval = first["approval"]
    body = {key: value for key, value in first.items() if key != "approval"}
    assert approval["subject_sha256"] == hashlib.sha256(
        workflow.APPROVAL_DOMAIN + workflow._canonical_bytes(body)
    ).hexdigest()
    assert approval["must_be_received_in_later_user_turn"] is True
    assert approval["execution_started"] is False
    assert approval["exact_phrase"].startswith("APPROVE EVLEDA REFERENCE PLAN ")
    assert first["mcp_preflight"]["tools"] == ["inspect_project"]
    assert first["mcp_preflight"]["side_effect_free"] is True


def test_stale_approval_fails_before_creating_output(tmp_path: Path) -> None:
    workflow = _workflow()
    destination = tmp_path / "must-not-exist"

    with pytest.raises(workflow.WorkflowError, match="absent, stale, or does not bind"):
        workflow._run("0" * 64, destination, None)

    assert not destination.exists()


def test_existing_output_is_rejected_without_mutation(tmp_path: Path) -> None:
    workflow = _workflow()
    workflow.REPOSITORY_ROOT = tmp_path
    destination = tmp_path / "outputs" / "existing"
    destination.parent.mkdir()
    destination.mkdir()
    sentinel = destination / "sentinel.txt"
    sentinel.write_text("preserve me", encoding="utf-8")

    with pytest.raises(workflow.WorkflowError, match="new, narrow"):
        workflow._safe_output_root(destination)

    assert sentinel.read_text(encoding="utf-8") == "preserve me"


@pytest.mark.parametrize("name", ("../escape", "/absolute", "C:/drive"))
def test_archive_rejects_unsafe_member_names(name: str) -> None:
    workflow = _workflow()
    payload = _zip(((zipfile.ZipInfo(name), b"payload"),))

    with pytest.raises(workflow.WorkflowError, match="unsafe filename"):
        workflow._zip_entries(payload, "test archive")


def test_archive_rejects_backslash_member_name() -> None:
    workflow = _workflow()
    # Python's Windows ZIP writer normalizes separators, so patch the equal-length
    # local and central directory names to exercise raw hostile input.
    payload = _zip(((zipfile.ZipInfo("a/b"), b"payload"),)).replace(b"a/b", b"a\\b")

    with pytest.raises(workflow.WorkflowError, match="unsafe filename"):
        workflow._zip_entries(payload, "test archive")


def test_archive_rejects_case_collisions() -> None:
    workflow = _workflow()
    payload = _zip(
        (
            (zipfile.ZipInfo("Board.kicad_pcb"), b"first"),
            (zipfile.ZipInfo("board.kicad_pcb"), b"second"),
        )
    )

    with pytest.raises(workflow.WorkflowError, match="portable filename collision"):
        workflow._zip_entries(payload, "test archive")


def test_archive_rejects_symlink_member() -> None:
    workflow = _workflow()
    info = zipfile.ZipInfo("link")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    payload = _zip(((info, b"target"),))

    with pytest.raises(workflow.WorkflowError, match="non-regular entry"):
        workflow._zip_entries(payload, "test archive")


def test_plan_cli_bytes_are_canonical() -> None:
    workflow = _workflow()
    plan, _, _ = workflow._plan_document()
    payload = workflow._canonical_bytes(plan)

    assert payload.endswith(b"\n")
    assert json.loads(payload) == plan
    assert b"manufacturing_release_eligible\":false" in payload


def test_cloud_shells_use_the_explicit_platform_kicad_cli() -> None:
    setup = (ROOT / "scripts" / "cloud" / "setup.sh").read_text(encoding="utf-8")
    run = (ROOT / "scripts" / "cloud" / "run.sh").read_text(encoding="utf-8")

    assert 'kicad_cli="/usr/bin/kicad-cli"' in setup
    assert "command -v kicad-cli" not in setup
    assert "--kicad-cli /usr/bin/kicad-cli" in run
    assert "EVLEDA_KICAD_CLI" not in run
