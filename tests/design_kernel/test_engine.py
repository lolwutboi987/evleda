from __future__ import annotations

import unittest
from datetime import datetime, timezone

from backend.design_kernel import (
    ApprovalMismatch,
    CommandConflict,
    CommandKind,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    HmacCommitAuthority,
    InvalidCommitAuthorization,
    InvariantViolation,
    ReleaseApprovalEvidence,
    StaleRevision,
    TransactionNotCommittable,
    TransactionState,
    stable_hash,
)


DATASHEET = "1" * 64
PIN_MAP = "2" * 64
REPORT = "3" * 64
NOW = datetime(2026, 8, 29, 20, 0, tzinfo=timezone.utc)


def command(
    kernel: DesignKernel,
    transaction_id: str,
    command_id: str,
    kind: CommandKind,
    payload: dict[str, object],
    key: str | None = None,
) -> DesignCommand:
    return DesignCommand.create(
        command_id=command_id,
        base_revision=kernel.get_transaction(transaction_id).base_revision,
        transaction_id=transaction_id,
        actor="agent:schematic-1",
        kind=kind,
        payload=payload,
        idempotency_key=key or command_id,
    )


def component_payload(
    component_id: str = "cmp-u1", reference: str = "U1"
) -> dict[str, object]:
    return {
        "component_id": component_id,
        "reference": reference,
        "value": "USB-C controller",
        "manufacturer_part_number": "TUSB320LAIRWBR",
        "package": "WQFN-12",
        "symbol_id": "symbol:tusb320",
        "footprint_id": "Package_DFN_QFN:WQFN-12-1EP_1.6x1.6mm",
        "datasheet_sha256": DATASHEET,
        "pin_map_sha256": PIN_MAP,
        "pins": [
            {"number": "1", "name": "VBUS", "electrical_type": "power_in", "pad_number": "1", "required": True},
            {"number": "2", "name": "CC1", "electrical_type": "bidirectional", "pad_number": "2", "required": True},
        ],
    }


def commit_authorization(
    kernel: DesignKernel,
    authority: HmacCommitAuthority,
    kernel_transaction_id: str,
    **changes: object,
):
    transaction = kernel.get_transaction(kernel_transaction_id)
    report_hash = changes.pop(
        "verification_report_hash",
        transaction.verification_report_hash or REPORT,
    )
    preview_digest = changes.pop("preview_digest", transaction.preview_digest)
    base_revision = changes.pop("base_revision", transaction.base_revision)
    verified_preview_digest = changes.pop(
        "verified_preview_digest",
        transaction.verification_preview_digest or preview_digest,
    )
    release_subject_digest = changes.pop(
        "release_subject_digest",
        stable_hash(
            {
                "base_revision": base_revision,
                "preview_digest": preview_digest,
                "report_hash": report_hash,
            },
            domain="flux-clone-release-v1",
        ),
    )
    approval_digest = changes.pop("human_approval_digest", "a" * 64)
    approval_principal = changes.pop("human_approval_principal", "user:owner")
    approval_id = changes.pop(
        "human_approval_id",
        "approval-release-"
        + stable_hash(
            {
                "base": base_revision,
                "preview": preview_digest,
                "report": report_hash,
                "subject": release_subject_digest,
                "digest": approval_digest,
                "principal": approval_principal,
            },
            domain="test-release-approval-id-v1",
        )[:16],
    )
    authority.register_release_approval(
        ReleaseApprovalEvidence(
            approval_id=approval_id,
            run_id=changes.pop("human_approval_run_id", "run-release-1"),
            kind=changes.pop("human_approval_kind", "release"),
            subject_digest=release_subject_digest,
            approval_digest=approval_digest,
            principal=approval_principal,
            decided_at=changes.pop("human_approval_decided_at", NOW),
            expires_at=changes.pop("human_approval_expires_at", None),
            verification_report_hash=report_hash,
            verified_preview_digest=verified_preview_digest,
            commit_gate_passed=changes.pop("commit_gate_passed", True),
        )
    )
    values = {
        "project_id": changes.pop("project_id", transaction.staged_graph.project_id),
        "base_revision": base_revision,
        "head_revision": changes.pop("head_revision", kernel.head.revision_hash),
        "transaction_id": changes.pop("transaction_id", transaction.transaction_id),
        "command_hashes": changes.pop(
            "command_hashes",
            tuple(staged.command_hash for staged in transaction.commands),
        ),
        "preview_digest": preview_digest,
        "prospective_graph_sha256": changes.pop(
            "prospective_graph_sha256",
            transaction.staged_graph.graph_hash,
        ),
        "approval_id": approval_id,
    }
    if "lifetime" in changes:
        values["lifetime"] = changes.pop("lifetime")
    if "nonce" in changes:
        values["nonce"] = changes.pop("nonce")
    if changes:
        raise AssertionError(f"unsupported test authorization overrides: {tuple(changes)}")
    return authority.issue(**values)


class DesignKernelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.authority = HmacCommitAuthority(
            key_id="test-commit-key",
            secret=b"design-kernel-test-commit-secret-32-bytes-minimum",
            clock=lambda: NOW,
        )
        self.kernel = DesignKernel(
            DesignGraph(1, "usb-c-monitor"),
            commit_verifier=self.authority.verifier,
        )
        self.base = self.kernel.head.revision_hash
        self.kernel.begin_transaction("txn-1", base_revision=self.base)

    def test_genesis_and_equivalent_graph_are_deterministic(self) -> None:
        other = DesignKernel(DesignGraph(1, "usb-c-monitor", layers=("B.Cu", "F.Cu")))
        self.assertEqual(self.kernel.head.graph_hash, other.head.graph_hash)
        self.assertEqual(self.kernel.head.revision_hash, other.head.revision_hash)

    def test_stages_typed_commands_and_builds_semantic_diff(self) -> None:
        self.kernel.stage(command(self.kernel, "txn-1", "cmd-1", CommandKind.COMPONENT_ADD, component_payload()))
        self.kernel.stage(command(self.kernel, "txn-1", "cmd-2", CommandKind.NET_CREATE, {"net_id": "net-vbus", "name": "VBUS"}))
        self.kernel.stage(command(self.kernel, "txn-1", "cmd-3", CommandKind.NET_CONNECT, {"net_id": "net-vbus", "component_id": "cmp-u1", "pin_number": "1"}))
        diff = self.kernel.preview("txn-1")
        self.assertEqual(diff.added, ("component:cmp-u1", "net:net-vbus"))
        self.assertEqual(diff.command_ids, ("cmd-1", "cmd-2", "cmd-3"))
        self.assertEqual(len(diff.preview_digest), 64)

    def test_rejects_stale_transaction_and_command_revision(self) -> None:
        with self.assertRaises(StaleRevision):
            self.kernel.begin_transaction("txn-stale", base_revision="0" * 64)
        bad = DesignCommand.create(
            command_id="cmd-bad",
            base_revision="0" * 64,
            transaction_id="txn-1",
            actor="agent:test",
            kind=CommandKind.NET_CREATE,
            payload={"net_id": "net-a", "name": "A"},
            idempotency_key="bad",
        )
        with self.assertRaises(StaleRevision):
            self.kernel.stage(bad)

    def test_idempotent_replay_and_collision(self) -> None:
        first = command(self.kernel, "txn-1", "cmd-1", CommandKind.NET_CREATE, {"net_id": "net-a", "name": "A"}, "stable-key")
        staged = self.kernel.stage(first)
        replayed = self.kernel.stage(first)
        self.assertEqual(staged, replayed)
        conflicting = command(self.kernel, "txn-1", "cmd-2", CommandKind.NET_CREATE, {"net_id": "net-b", "name": "B"}, "stable-key")
        with self.assertRaises(CommandConflict):
            self.kernel.stage(conflicting)

    def test_command_batch_staging_is_atomic_and_idempotent(self) -> None:
        add_component = command(
            self.kernel,
            "txn-1",
            "cmd-component",
            CommandKind.COMPONENT_ADD,
            component_payload(),
        )
        invalid_late_command = command(
            self.kernel,
            "txn-1",
            "cmd-invalid-connect",
            CommandKind.NET_CONNECT,
            {
                "net_id": "net-missing",
                "component_id": "cmp-u1",
                "pin_number": "1",
            },
        )
        before = self.kernel.get_transaction("txn-1")
        with self.assertRaises(InvariantViolation):
            self.kernel.stage_batch((add_component, invalid_late_command))
        self.assertEqual(before, self.kernel.get_transaction("txn-1"))

        create_net = command(
            self.kernel,
            "txn-1",
            "cmd-net",
            CommandKind.NET_CREATE,
            {"net_id": "net-vbus", "name": "VBUS"},
        )
        connect = command(
            self.kernel,
            "txn-1",
            "cmd-connect",
            CommandKind.NET_CONNECT,
            {
                "net_id": "net-vbus",
                "component_id": "cmp-u1",
                "pin_number": "1",
            },
        )
        staged = self.kernel.stage_batch((add_component, create_net, connect))
        self.assertEqual(
            ("cmd-component", "cmd-net", "cmd-connect"),
            tuple(item.command_id for item in staged.commands),
        )
        self.assertEqual(
            staged,
            self.kernel.stage_batch((add_component, create_net, connect)),
        )

    def test_commit_requires_passed_verification_and_exact_preview_approval(self) -> None:
        self.kernel.stage(command(self.kernel, "txn-1", "cmd-1", CommandKind.COMPONENT_ADD, component_payload()))
        digest = self.kernel.preview("txn-1").preview_digest
        with self.assertRaises(TransactionNotCommittable):
            self.kernel.commit(
                "txn-1",
                authorization=commit_authorization(
                    self.kernel, self.authority, "txn-1"
                ),
            )
        self.kernel.record_verification("txn-1", verification_report_hash=REPORT, commit_gate_passed=True)
        with self.assertRaises(InvalidCommitAuthorization):
            commit_authorization(
                self.kernel,
                self.authority,
                "txn-1",
                preview_digest="4" * 64,
            )
        revision = self.kernel.commit(
            "txn-1",
            authorization=commit_authorization(
                self.kernel,
                self.authority,
                "txn-1",
                human_approval_id="approval-release-final",
            ),
        )
        self.assertEqual(revision.parent_revision, self.base)
        self.assertEqual(revision.approval_preview_digest, digest)
        self.assertEqual(self.kernel.get_transaction("txn-1").state, TransactionState.COMMITTED)

    def test_preview_fork_preserves_committed_revision_identity_and_digest(self) -> None:
        self.kernel.stage(
            command(
                self.kernel,
                "txn-1",
                "cmd-net-a",
                CommandKind.NET_CREATE,
                {"net_id": "net-a", "name": "A"},
            )
        )
        self.kernel.record_verification(
            "txn-1", verification_report_hash=REPORT, commit_gate_passed=True
        )
        committed = self.kernel.commit(
            "txn-1",
            authorization=commit_authorization(
                self.kernel, self.authority, "txn-1"
            ),
        )

        preview_kernel = DesignKernel.from_revision(committed)
        self.assertEqual(committed.revision_hash, preview_kernel.head.revision_hash)
        self.assertEqual(committed.sequence, preview_kernel.head.sequence)
        self.kernel.begin_transaction("txn-2", base_revision=committed.revision_hash)
        preview_kernel.begin_transaction("txn-2", base_revision=committed.revision_hash)
        next_command = DesignCommand.create(
            command_id="cmd-net-b",
            base_revision=committed.revision_hash,
            transaction_id="txn-2",
            actor="agent:schematic-1",
            kind=CommandKind.NET_CREATE,
            payload={"net_id": "net-b", "name": "B"},
            idempotency_key="cmd-net-b",
        )
        real_stage = self.kernel.stage(next_command)
        preview_stage = preview_kernel.stage(next_command)
        self.assertEqual(real_stage.preview_digest, preview_stage.preview_digest)

    def test_failed_verification_does_not_make_transaction_committable(self) -> None:
        self.kernel.stage(
            command(
                self.kernel,
                "txn-1",
                "cmd-net-a",
                CommandKind.NET_CREATE,
                {"net_id": "net-a", "name": "A"},
            )
        )
        self.kernel.record_verification("txn-1", verification_report_hash=REPORT, commit_gate_passed=False)
        with self.assertRaises(TransactionNotCommittable):
            self.kernel.commit(
                "txn-1",
                authorization=commit_authorization(
                    self.kernel, self.authority, "txn-1"
                ),
            )

    def test_rollback_is_idempotent_and_does_not_change_head(self) -> None:
        rolled_back = self.kernel.rollback("txn-1")
        self.assertEqual(rolled_back.state, TransactionState.ROLLED_BACK)
        self.assertEqual(self.kernel.rollback("txn-1"), rolled_back)
        self.assertEqual(self.kernel.head.revision_hash, self.base)

    def test_rejects_unprovenanced_component_and_unknown_pin(self) -> None:
        invalid = component_payload()
        invalid["datasheet_sha256"] = "unknown"
        with self.assertRaises(InvariantViolation):
            self.kernel.stage(command(self.kernel, "txn-1", "cmd-1", CommandKind.COMPONENT_ADD, invalid))

        self.kernel.stage(command(self.kernel, "txn-1", "cmd-2", CommandKind.COMPONENT_ADD, component_payload()))
        self.kernel.stage(command(self.kernel, "txn-1", "cmd-3", CommandKind.NET_CREATE, {"net_id": "net-vbus", "name": "VBUS"}))
        with self.assertRaises(InvariantViolation):
            self.kernel.stage(command(self.kernel, "txn-1", "cmd-4", CommandKind.NET_CONNECT, {"net_id": "net-vbus", "component_id": "cmp-u1", "pin_number": "99"}))


if __name__ == "__main__":
    unittest.main()
