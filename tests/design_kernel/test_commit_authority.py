from __future__ import annotations

import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Barrier
from typing import get_type_hints

from backend.design_kernel import (
    ApprovalMismatch,
    CommandKind,
    CommitAuthorityClockRollback,
    CommitAuthorization,
    DesignGraph,
    DesignKernel,
    ExpiredCommitAuthorization,
    HmacCommitAuthority,
    InvalidCommitAuthorization,
    ReleaseApprovalEvidence,
    ReplayedCommitAuthorization,
    stable_hash,
)
from backend.import_approval import AuthorizedImportStagingInput
from tests.design_kernel.test_engine import (
    REPORT,
    command,
    commit_authorization,
)
from tests.import_stage_journal.test_repository import (
    ApprovalFixture as ImportApprovalFixture,
)
from tests.import_stage_journal.test_repository import (
    MutableClock as ImportApprovalClock,
)


class MutableClock:
    def __init__(self) -> None:
        self.value = datetime(2026, 8, 29, 20, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.value


class CommitAuthorityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = MutableClock()
        self.authority = HmacCommitAuthority(
            key_id="kernel-commit-test-key",
            secret=b"kernel-commit-authority-test-secret-32-bytes-minimum",
            clock=self.clock,
        )
        self.kernel = DesignKernel(
            DesignGraph(1, "commit-authority-board"),
            commit_verifier=self.authority.verifier,
        )
        self.base_revision = self.kernel.head
        self.kernel.begin_transaction(
            "txn-authorized",
            base_revision=self.base_revision.revision_hash,
        )
        self.staged_command = command(
            self.kernel,
            "txn-authorized",
            "cmd-net-authorized",
            CommandKind.NET_CREATE,
            {"net_id": "net-authorized", "name": "AUTHORIZED"},
        )
        self.kernel.stage(self.staged_command)
        self.kernel.record_verification(
            "txn-authorized",
            verification_report_hash=REPORT,
            commit_gate_passed=True,
        )
        self._approval_sequence = 0

    def authorization(self, **changes: object) -> CommitAuthorization:
        self._approval_sequence += 1
        changes.setdefault(
            "human_approval_id",
            f"approval-release-authority-{self._approval_sequence}",
        )
        return commit_authorization(
            self.kernel,
            self.authority,
            "txn-authorized",
            **changes,
        )

    def test_secret_strength_and_capability_immutability(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least 32.*bytes"):
            HmacCommitAuthority(key_id="weak-key", secret=b"short")
        authorization = self.authorization()
        with self.assertRaises(FrozenInstanceError):
            authorization.project_id = "other"  # type: ignore[misc]

    def test_subclassed_capability_and_registry_substitution_fail_closed(self) -> None:
        authorization = self.authorization()

        class ForgedAuthorization(CommitAuthorization):
            def claims_payload(self) -> dict[str, object]:
                return authorization.claims_payload()

        forged = object.__new__(ForgedAuthorization)
        for field_name in authorization.__dataclass_fields__:
            object.__setattr__(forged, field_name, getattr(authorization, field_name))
        with self.assertRaisesRegex(ApprovalMismatch, "exact.*CommitAuthorization"):
            self.kernel.commit("txn-authorized", authorization=forged)

        registered = ReleaseApprovalEvidence(
            approval_id=authorization.human_approval_id,
            run_id=authorization.human_approval_run_id,
            kind=authorization.human_approval_kind,
            subject_digest=authorization.release_subject_digest,
            approval_digest=authorization.human_approval_digest,
            principal=authorization.human_approval_principal,
            decided_at=authorization.human_approval_decided_at,
            expires_at=authorization.human_approval_expires_at,
            verification_report_hash=authorization.verification_report_hash,
            verified_preview_digest=authorization.verified_preview_digest,
            commit_gate_passed=True,
        )
        with self.assertRaisesRegex(InvalidCommitAuthorization, "permanently bound"):
            self.authority.register_release_approval(
                replace(registered, approval_digest="b" * 64)
            )
        self.authority.revoke_release_approval(registered.approval_id)
        with self.assertRaisesRegex(InvalidCommitAuthorization, "revoked|unknown"):
            self.kernel.commit("txn-authorized", authorization=authorization)

    def test_registry_uses_private_snapshot_and_ids_are_terminal(self) -> None:
        transaction = self.kernel.get_transaction("txn-authorized")
        subject = stable_hash(
            {
                "base_revision": transaction.base_revision,
                "preview_digest": transaction.preview_digest,
                "report_hash": REPORT,
            },
            domain="flux-clone-release-v1",
        )
        evidence = ReleaseApprovalEvidence(
            approval_id="approval-private-snapshot",
            run_id="run-private-snapshot",
            kind="release",
            subject_digest=subject,
            approval_digest="d" * 64,
            principal="user:owner",
            decided_at=self.clock.value,
            expires_at=None,
            verification_report_hash=REPORT,
            verified_preview_digest=transaction.preview_digest,
            commit_gate_passed=True,
        )
        pristine = replace(evidence)
        returned = self.authority.register_release_approval(evidence)

        # frozen=True is not an authority boundary: deliberately bypass it on
        # both caller-visible objects and prove registry state is unaffected.
        object.__setattr__(evidence, "principal", "user:attacker")
        object.__delattr__(returned, "approval_digest")
        authorization = self.authority.issue(
            project_id=transaction.staged_graph.project_id,
            base_revision=transaction.base_revision,
            head_revision=self.kernel.head.revision_hash,
            transaction_id=transaction.transaction_id,
            command_hashes=tuple(
                staged.command_hash for staged in transaction.commands
            ),
            preview_digest=transaction.preview_digest,
            prospective_graph_sha256=transaction.staged_graph.graph_hash,
            approval_id=pristine.approval_id,
        )
        self.assertEqual(authorization.human_approval_principal, "user:owner")
        self.assertEqual(authorization.human_approval_digest, "d" * 64)

        for duplicate in (pristine, replace(pristine, approval_digest="e" * 64)):
            with self.subTest(duplicate=duplicate.approval_digest), self.assertRaisesRegex(
                InvalidCommitAuthorization,
                "permanently bound",
            ):
                self.authority.register_release_approval(duplicate)

        self.authority.revoke_release_approval(pristine.approval_id)
        with self.assertRaisesRegex(InvalidCommitAuthorization, "revoked|unknown"):
            self.kernel.commit("txn-authorized", authorization=authorization)
        with self.assertRaisesRegex(InvalidCommitAuthorization, "permanently bound"):
            self.authority.register_release_approval(pristine)

        tombstoned = replace(pristine, approval_id="approval-revoked-before-register")
        self.authority.revoke_release_approval(tombstoned.approval_id)
        with self.assertRaisesRegex(InvalidCommitAuthorization, "permanently bound"):
            self.authority.register_release_approval(tombstoned)

        missing = replace(pristine, approval_id="approval-missing-field")
        object.__delattr__(missing, "principal")
        with self.assertRaisesRegex(InvalidCommitAuthorization, "missing|canonical"):
            self.authority.register_release_approval(missing)

    def test_deleted_capability_field_is_translated_to_invalid_authorization(self) -> None:
        authorization = self.authorization()
        object.__delattr__(authorization, "project_id")
        with self.assertRaisesRegex(InvalidCommitAuthorization, "not canonical"):
            self.kernel.commit("txn-authorized", authorization=authorization)

    def test_nonce_consumption_has_one_winner_across_kernels(self) -> None:
        authorization = self.authorization()
        kernels = []
        for _ in range(2):
            kernel = DesignKernel.from_revision(
                self.base_revision,
                commit_verifier=self.authority.verifier,
            )
            kernel.begin_transaction(
                "txn-authorized",
                base_revision=self.base_revision.revision_hash,
            )
            kernel.stage(self.staged_command)
            kernel.record_verification(
                "txn-authorized",
                verification_report_hash=REPORT,
                commit_gate_passed=True,
            )
            kernels.append(kernel)
        barrier = Barrier(2)

        def commit(kernel: DesignKernel) -> str:
            barrier.wait()
            try:
                kernel.commit("txn-authorized", authorization=authorization)
                return "committed"
            except ReplayedCommitAuthorization:
                return "replayed"

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = tuple(executor.map(commit, kernels))
        self.assertCountEqual(outcomes, ("committed", "replayed"))

    def test_commit_type_excludes_import_stage_authority_and_preview_string(self) -> None:
        hints = get_type_hints(DesignKernel.commit)
        self.assertIs(hints["authorization"], CommitAuthorization)
        with TemporaryDirectory() as temporary:
            fixture = ImportApprovalFixture(
                Path(temporary),
                ImportApprovalClock(),
            )
            try:
                stage_only = fixture.authorization()
            finally:
                fixture.close()
        self.assertIsInstance(stage_only, AuthorizedImportStagingInput)
        with self.assertRaisesRegex(ApprovalMismatch, "CommitAuthorization"):
            self.kernel.commit(
                "txn-authorized",
                authorization=stage_only,  # type: ignore[arg-type]
            )
        with self.assertRaisesRegex(ApprovalMismatch, "CommitAuthorization"):
            self.kernel.commit(
                "txn-authorized",
                authorization=self.kernel.preview("txn-authorized").preview_digest,  # type: ignore[arg-type]
            )

    def test_exact_commit_retry_is_idempotent_but_new_or_replayed_capability_fails(self) -> None:
        authorization = self.authorization()
        revision = self.kernel.commit("txn-authorized", authorization=authorization)
        self.assertEqual(
            revision,
            self.kernel.commit("txn-authorized", authorization=authorization),
        )
        with self.assertRaises(ReplayedCommitAuthorization):
            self.kernel.commit(
                "txn-authorized",
                authorization=self.authorization(head_revision=self.base_revision.revision_hash),
            )

        replay_kernel = DesignKernel.from_revision(
            self.base_revision,
            commit_verifier=self.authority.verifier,
        )
        replay_kernel.begin_transaction(
            "txn-authorized",
            base_revision=self.base_revision.revision_hash,
        )
        replay_kernel.stage(self.staged_command)
        replay_kernel.record_verification(
            "txn-authorized",
            verification_report_hash=REPORT,
            commit_gate_passed=True,
        )
        with self.assertRaises(ReplayedCommitAuthorization):
            replay_kernel.commit(
                "txn-authorized",
                authorization=authorization,
            )

    def test_tampering_wrong_issuer_expiry_and_future_issue_fail_closed(self) -> None:
        authorization = self.authorization()
        with self.assertRaises(InvalidCommitAuthorization):
            self.kernel.commit(
                "txn-authorized",
                authorization=replace(authorization, seal="f" * 64),
            )

        other_authority = HmacCommitAuthority(
            key_id=self.authority.key_id,
            secret=b"different-kernel-authority-secret-32-bytes-minimum",
            clock=self.clock,
        )
        other_kernel = DesignKernel.from_revision(
            self.base_revision,
            commit_verifier=other_authority.verifier,
        )
        other_kernel.begin_transaction(
            "txn-authorized", base_revision=self.base_revision.revision_hash
        )
        other_kernel.stage(self.staged_command)
        other_kernel.record_verification(
            "txn-authorized",
            verification_report_hash=REPORT,
            commit_gate_passed=True,
        )
        with self.assertRaises(InvalidCommitAuthorization):
            other_kernel.commit("txn-authorized", authorization=authorization)

        for field, value in (
            ("scope", "mapping-to-canonical-stage"),
            ("version", 3),
            ("key_id", "untrusted-key"),
        ):
            with self.subTest(authority_metadata=field):
                payload = authorization.claims_payload()
                payload[field] = value
                digest = stable_hash(
                    payload,
                    domain="flux-clone-kernel-commit-authorization-v2",
                )
                malformed = replace(
                    authorization,
                    **{
                        field: value,
                        "authorization_digest": digest,
                        "authorization_id": f"commit-authorization-{digest[:32]}",
                    },
                )
                with self.assertRaises(InvalidCommitAuthorization):
                    self.kernel.commit("txn-authorized", authorization=malformed)

        short_lived = self.authority.issue(
            project_id=authorization.project_id,
            base_revision=authorization.base_revision,
            head_revision=authorization.head_revision,
            transaction_id=authorization.transaction_id,
            command_hashes=authorization.command_hashes,
            preview_digest=authorization.preview_digest,
            prospective_graph_sha256=authorization.prospective_graph_sha256,
            approval_id=authorization.human_approval_id,
            lifetime=timedelta(seconds=1),
        )
        self.clock.value += timedelta(seconds=1)
        with self.assertRaises(ExpiredCommitAuthorization):
            self.kernel.commit("txn-authorized", authorization=short_lived)
        self.clock.value -= timedelta(seconds=2)
        with self.assertRaises(CommitAuthorityClockRollback):
            self.kernel.commit("txn-authorized", authorization=authorization)
        self.clock.value += timedelta(seconds=10)
        with self.assertRaises(CommitAuthorityClockRollback):
            self.kernel.commit("txn-authorized", authorization=authorization)

    def test_validly_signed_transaction_substitution_and_all_kernel_bindings_fail(self) -> None:
        mismatches: tuple[tuple[str, dict[str, object]], ...] = (
            ("project", {"project_id": "other-project"}),
            ("base revision", {"base_revision": "1" * 64}),
            ("current head", {"head_revision": "2" * 64}),
            ("transaction", {"transaction_id": "txn-substituted"}),
            ("ordered commands", {"command_hashes": ("4" * 64,)}),
            ("prospective graph", {"prospective_graph_sha256": "6" * 64}),
            ("verification report", {"verification_report_hash": "7" * 64}),
        )
        for label, changes in mismatches:
            with self.subTest(binding=label), self.assertRaisesRegex(ApprovalMismatch, label):
                self.kernel.commit(
                    "txn-authorized",
                    authorization=self.authorization(**changes),
                )

        with self.assertRaisesRegex(
            InvalidCommitAuthorization,
            "verified preview",
        ):
            self.authorization(preview_digest="5" * 64)


if __name__ == "__main__":
    unittest.main()
