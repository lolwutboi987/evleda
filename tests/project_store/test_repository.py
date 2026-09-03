from __future__ import annotations

import hashlib
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from threading import Barrier, Event, Lock

from backend.design_kernel import (
    CommandKind,
    Component,
    CopperZone,
    DesignCommand,
    DesignGraph,
    DesignKernel,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    HmacCommitAuthority,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
    ReleaseApprovalEvidence,
    SchematicJunction,
    SchematicWire,
    Track,
    Via,
    ZoneFillState,
    bind_verified_zone_fill,
    stable_hash,
)
from backend.project_store import (
    ApprovalDecision,
    ApprovalEvidence,
    ConcurrencyConflict,
    Ed25519CommitAttestationKeyring,
    Ed25519CommitAttestationSigner,
    InMemoryProjectHeadAnchor,
    IntegrityError,
    ProjectRepository,
    StoreUnavailable,
    UnsupportedStoreSchema,
)
from backend.project_store import SQLiteProjectStore as _SQLiteProjectStore
from backend.project_store.codec import (
    DOCUMENT_VERSION,
    decode_document,
    graph_from_payload,
    graph_payload,
)

DATASHEET_HASH = "a" * 64
PIN_MAP_HASH = "b" * 64
REPORT_HASH = "c" * 64
DECIDED_AT = datetime(2026, 8, 29, 20, 30, 0, 123456, tzinfo=timezone.utc)
TEST_SIGNER = Ed25519CommitAttestationSigner.from_private_bytes(
    key_id="project-store-attestation-v1",
    private_key=b"\x11" * 32,
)
TEST_KEYRING = Ed25519CommitAttestationKeyring.from_signers(TEST_SIGNER)
_TEST_ANCHORS: dict[Path, InMemoryProjectHeadAnchor] = {}


def SQLiteProjectStore(path, **kwargs):  # type: ignore[no-untyped-def]
    """Inject external test trust roots while keeping each DB's anchor independent."""

    resolved = Path(path).resolve()
    kwargs.setdefault("attestation_keyring", TEST_KEYRING)
    kwargs.setdefault(
        "project_head_anchor",
        _TEST_ANCHORS.setdefault(resolved, InMemoryProjectHeadAnchor()),
    )
    return _SQLiteProjectStore(path, **kwargs)


class InjectedCrashAnchor:
    def __init__(self, *, after_advance: bool) -> None:
        self.delegate = InMemoryProjectHeadAnchor()
        self.after_advance = after_advance
        self.fail_next_advance = True

    def read(self, project_id: str):
        return self.delegate.read(project_id)

    def initialize(self, state) -> None:
        self.delegate.initialize(state)

    def compare_and_set(self, expected, current) -> None:
        if self.fail_next_advance:
            self.fail_next_advance = False
            if self.after_advance:
                self.delegate.compare_and_set(expected, current)
            raise IntegrityError("injected external anchor crash boundary")
        self.delegate.compare_and_set(expected, current)


class InjectedGenesisAnchor:
    def __init__(self, *, after_initialize: bool) -> None:
        self.delegate = InMemoryProjectHeadAnchor()
        self.after_initialize = after_initialize
        self.fail_next_initialize = True

    def read(self, project_id: str):
        return self.delegate.read(project_id)

    def initialize(self, state) -> None:
        if self.fail_next_initialize:
            self.fail_next_initialize = False
            if self.after_initialize:
                self.delegate.initialize(state)
            raise IntegrityError("injected genesis anchor boundary")
        self.delegate.initialize(state)

    def compare_and_set(self, expected, current) -> None:
        self.delegate.compare_and_set(expected, current)


class SlowFirstAdvanceAnchor:
    def __init__(self) -> None:
        self.delegate = InMemoryProjectHeadAnchor()
        self.entered = Event()
        self.release = Event()
        self._guard = Lock()
        self._block_next = True

    def read(self, project_id: str):
        return self.delegate.read(project_id)

    def initialize(self, state) -> None:
        self.delegate.initialize(state)

    def compare_and_set(self, expected, current) -> None:
        with self._guard:
            block = self._block_next
            self._block_next = False
        if block:
            self.entered.set()
            if not self.release.wait(timeout=5):
                raise AssertionError("slow anchor test release timed out")
        self.delegate.compare_and_set(expected, current)


class BlockingNextReadAnchor:
    def __init__(self) -> None:
        self.delegate = InMemoryProjectHeadAnchor()
        self.entered = Event()
        self.release = Event()
        self._guard = Lock()
        self._block_next = False

    def arm(self) -> None:
        with self._guard:
            self._block_next = True
            self.entered.clear()
            self.release.clear()

    def read(self, project_id: str):
        with self._guard:
            block = self._block_next
            self._block_next = False
        if block:
            self.entered.set()
            if not self.release.wait(timeout=5):
                raise AssertionError("anchor read-skew release timed out")
        return self.delegate.read(project_id)

    def initialize(self, state) -> None:
        self.delegate.initialize(state)

    def compare_and_set(self, expected, current) -> None:
        self.delegate.compare_and_set(expected, current)


def release_subject_digest(
    base_revision: str,
    preview_digest: str,
    report_hash: str = REPORT_HASH,
) -> str:
    return stable_hash(
        {
            "base_revision": base_revision,
            "preview_digest": preview_digest,
            "report_hash": report_hash,
        },
        domain="flux-clone-release-v1",
    )


def approval_digest(approval_id: str) -> str:
    return stable_hash(approval_id, domain="project-store-test-approval-v1")


def rich_graph(project_id: str = "persist-board") -> DesignGraph:
    component = Component(
        component_id="cmp-u1",
        reference="U1",
        value="Exact controller",
        manufacturer_part_number="MFG-EXACT-1",
        package="QFN-2",
        symbol_id="symbol:controller",
        footprint_id="Package_QFN:QFN-2",
        datasheet_sha256=DATASHEET_HASH,
        pin_map_sha256=PIN_MAP_HASH,
        pins=(
            PinDefinition("2", "OUT", "output", "2"),
            PinDefinition("1", "IN", "input", "1"),
        ),
    )
    graph = DesignGraph(
        schema_version=1,
        project_id=project_id,
        layers=("F.Cu", "B.Cu"),
        board_outline=(
            PointNm(0, 0),
            PointNm(10_000_000, 0),
            PointNm(10_000_000, 8_000_000),
            PointNm(0, 8_000_000),
            PointNm(0, 0),
        ),
        components=(component,),
        nets=(
            Net("net-b", "OUT", (PinRef("cmp-u1", "2"),)),
            Net("net-a", "IN", (PinRef("cmp-u1", "1"),)),
        ),
        placements=(
            FootprintPlacement("cmp-u1", PointNm(5_000_000, 4_000_000)),
        ),
        tracks=(
            Track(
                "track-a",
                "net-a",
                "F.Cu",
                PointNm(7_000_000, 4_000_000),
                PointNm(5_000_000, 4_000_000),
                250_000,
            ),
        ),
        pads=(
            FootprintPad(
                "pad-2", "cmp-u1", "2", PointNm(5_500_000, 4_000_000),
                700_000, 500_000, "rect", 0, ("F.Cu",), 0, "net-b",
            ),
            FootprintPad(
                "pad-1", "cmp-u1", "1", PointNm(4_500_000, 4_000_000),
                800_000, 800_000, "circle", 0, ("F.Cu", "B.Cu"),
                300_000, "net-a",
            ),
        ),
        holes=(
            FootprintHole(
                "hole-1", "cmp-u1", PointNm(4_500_000, 4_000_000),
                300_000, True, "pad-1",
            ),
        ),
        vias=(
            Via(
                "via-a", "net-a", PointNm(6_000_000, 4_000_000),
                600_000, 300_000, ("F.Cu", "B.Cu"),
            ),
        ),
        zones=(
            CopperZone(
                "zone-a", "net-a", "B.Cu",
                (
                    PointNm(1_000_000, 1_000_000),
                    PointNm(3_000_000, 1_000_000),
                    PointNm(3_000_000, 3_000_000),
                    PointNm(1_000_000, 3_000_000),
                ),
                200_000, 100_000, 1,
            ),
        ),
        schematic_wires=(
            SchematicWire(
                "wire-a", "net-a", (PointNm(0, 0), PointNm(1_000_000, 0)),
            ),
            SchematicWire(
                "wire-b", "net-a",
                (PointNm(1_000_000, 0), PointNm(1_000_000, 1_000_000)),
            ),
        ),
        schematic_junctions=(
            SchematicJunction("junction-a", "net-a", PointNm(1_000_000, 0)),
        ),
    )
    return graph.normalized()


def genesis(project_id: str = "persist-board"):
    return DesignKernel(rich_graph(project_id)).head


def staged_kernel(
    base,
    *,
    transaction_id: str = "txn-layout",
    via_id: str = "via-new",
    commit_authority: HmacCommitAuthority | None = None,
):
    kernel = DesignKernel.from_revision(
        base,
        commit_verifier=(commit_authority.verifier if commit_authority is not None else None),
    )
    transaction = kernel.begin_transaction(transaction_id, base_revision=base.revision_hash)
    command = DesignCommand.create(
        command_id=f"cmd-{via_id}",
        base_revision=base.revision_hash,
        transaction_id=transaction_id,
        actor="agent:layout",
        kind=CommandKind.VIA_ADD,
        payload={
            "via_id": via_id,
            "net_id": "net-a",
            "center_x_nm": 6_500_000,
            "center_y_nm": 4_000_000,
            "diameter_nm": 600_000,
            "drill_nm": 300_000,
            "layers": ["F.Cu", "B.Cu"],
        },
        idempotency_key=f"idem-{via_id}",
    )
    kernel.stage(command)
    return kernel


def commit_authorization(
    kernel: DesignKernel,
    authority: HmacCommitAuthority,
    transaction_id: str,
    *,
    approval_id: str = "approval-layout",
):
    transaction = kernel.get_transaction(transaction_id)
    report_hash = transaction.verification_report_hash or REPORT_HASH
    preview_digest = transaction.preview_digest
    verified_preview_digest = (
        transaction.verification_preview_digest or transaction.preview_digest
    )
    authority.register_release_approval(
        ReleaseApprovalEvidence(
            approval_id=approval_id,
            run_id="run-project-store",
            kind="release",
            subject_digest=release_subject_digest(
                transaction.base_revision,
                preview_digest,
                report_hash,
            ),
            approval_digest=approval_digest(approval_id),
            principal="user:owner",
            decided_at=DECIDED_AT,
            expires_at=None,
            verification_report_hash=report_hash,
            verified_preview_digest=verified_preview_digest,
            commit_gate_passed=True,
        )
    )
    return authority.issue(
        project_id=transaction.staged_graph.project_id,
        base_revision=transaction.base_revision,
        head_revision=kernel.head.revision_hash,
        transaction_id=transaction.transaction_id,
        command_hashes=tuple(command.command_hash for command in transaction.commands),
        preview_digest=preview_digest,
        prospective_graph_sha256=transaction.staged_graph.graph_hash,
        approval_id=approval_id,
    )


def committed_change(
    base,
    *,
    transaction_id: str = "txn-layout",
    via_id: str = "via-new",
    approval_id: str = "approval-layout",
    signer: Ed25519CommitAttestationSigner = TEST_SIGNER,
):
    authority = HmacCommitAuthority(
        key_id="project-store-test-commit-key",
        secret=b"project-store-test-commit-secret-32-bytes-minimum",
        clock=lambda: DECIDED_AT,
    )
    kernel = staged_kernel(
        base,
        transaction_id=transaction_id,
        via_id=via_id,
        commit_authority=authority,
    )
    transaction = kernel.get_transaction(transaction_id)
    kernel.record_verification(
        transaction_id,
        verification_report_hash=REPORT_HASH,
        commit_gate_passed=True,
        verified_preview_digest=transaction.preview_digest,
    )
    revision = kernel.commit(
        transaction_id,
        authorization=commit_authorization(
            kernel,
            authority,
            transaction_id,
            approval_id=approval_id,
        ),
    )
    committed = kernel.get_transaction(transaction_id)
    approval = ApprovalEvidence(
        approval_id=approval_id,
        approval_digest=approval_digest(approval_id),
        transaction_id=transaction_id,
        preview_digest=committed.preview_digest,
        release_subject_digest=release_subject_digest(
            committed.base_revision,
            committed.preview_digest,
        ),
        verification_report_hash=REPORT_HASH,
        decision=ApprovalDecision.APPROVED,
        actor="user:owner",
        decided_at=DECIDED_AT,
        reason="Exact preview reviewed",
    )
    attestation = signer.sign_commit(
        revision=revision,
        transaction=committed,
        approval=approval,
        authorization=kernel.get_commit_authorization_evidence(transaction_id),
        verification_input_hash="e" * 64,
        verification_rule_set_hash="f" * 64,
    )
    return committed, revision, approval, attestation


class ProjectStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        _TEST_ANCHORS.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "projects.sqlite3"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_repository_protocol_and_exact_rich_genesis_survive_restart(self) -> None:
        expected = genesis()
        with SQLiteProjectStore(self.path) as store:
            self.assertIsInstance(store, ProjectRepository)
            store.create_project(expected)
            self.assertEqual(store.get_head("persist-board"), expected)

        with SQLiteProjectStore(self.path) as reopened:
            state = reopened.restore("persist-board")
            self.assertEqual(state.head_revision, expected)
            self.assertEqual(state.revisions, (expected,))
            self.assertEqual(state.transactions, ())
            self.assertEqual(state.approvals, ())
            self.assertFalse(hasattr(state, "path"))
            restored = state.head_revision.graph
            self.assertEqual(len(restored.components), 1)
            self.assertEqual(len(restored.pads), 2)
            self.assertEqual(len(restored.holes), 1)
            self.assertEqual(len(restored.vias), 1)
            self.assertEqual(len(restored.zones), 1)
            self.assertEqual(len(restored.schematic_wires), 2)
            self.assertEqual(len(restored.schematic_junctions), 1)

    def test_multipad_shared_land_and_slots_survive_exact_restart(self) -> None:
        component = Component(
            "connector-j1",
            "J1",
            "Exact connector",
            "CONNECTOR-EXACT",
            "receptacle",
            "Connector:Exact",
            "Connector:Exact",
            DATASHEET_HASH,
            PIN_MAP_HASH,
            (
                PinDefinition("A1", "VBUS-A", "power_in", "A1"),
                PinDefinition("B12", "VBUS-B", "power_in", "B12"),
                PinDefinition("S1", "SHIELD", "passive", "S1"),
            ),
        )
        exact_graph = DesignGraph(
            1,
            "multipad-persist-board",
            components=(component,),
            nets=(
                Net(
                    "net-common",
                    "COMMON",
                    (
                        PinRef("connector-j1", "A1"),
                        PinRef("connector-j1", "B12"),
                        PinRef("connector-j1", "S1"),
                    ),
                ),
            ),
            placements=(FootprintPlacement("connector-j1", PointNm(0, 0)),),
            pads=(
                FootprintPad(
                    "pad-shell-left",
                    "connector-j1",
                    "S1",
                    PointNm(-2_000_000, 0),
                    1_200_000,
                    1_700_000,
                    "oval",
                    90_000_000,
                    ("F.Cu", "B.Cu"),
                    600_000,
                    "net-common",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintPad(
                    "pad-shell-right",
                    "connector-j1",
                    "S1",
                    PointNm(2_000_000, 0),
                    1_200_000,
                    1_700_000,
                    "oval",
                    90_000_000,
                    ("F.Cu", "B.Cu"),
                    600_000,
                    "net-common",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintPad(
                    "pad-a1",
                    "connector-j1",
                    "A1",
                    PointNm(0, -2_000_000),
                    1_000_000,
                    600_000,
                    "rect",
                    0,
                    ("F.Cu",),
                    net_id="net-common",
                    shared_land_group_id="land-vbus",
                ),
                FootprintPad(
                    "pad-b12",
                    "connector-j1",
                    "B12",
                    PointNm(0, -2_000_000),
                    1_000_000,
                    600_000,
                    "rect",
                    0,
                    ("F.Cu",),
                    net_id="net-common",
                    shared_land_group_id="land-vbus",
                ),
            ),
            holes=(
                FootprintHole(
                    "hole-shell-left",
                    "connector-j1",
                    PointNm(-2_000_000, 0),
                    600_000,
                    True,
                    "pad-shell-left",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
                FootprintHole(
                    "hole-shell-right",
                    "connector-j1",
                    PointNm(2_000_000, 0),
                    600_000,
                    True,
                    "pad-shell-right",
                    drill_x_nm=600_000,
                    drill_y_nm=1_100_000,
                    drill_rotation_udeg=90_000_000,
                ),
            ),
        ).normalized()
        expected = DesignKernel(exact_graph).head
        with SQLiteProjectStore(self.path) as store:
            store.create_project(expected)

        with SQLiteProjectStore(self.path) as reopened:
            restored = reopened.restore("multipad-persist-board").head_revision
        self.assertEqual(restored, expected)
        self.assertEqual(restored.graph.graph_hash, exact_graph.graph_hash)
        self.assertEqual(
            tuple(
                pad.pad_id
                for pad in restored.graph.pads
                if pad.pad_number == "S1"
            ),
            ("pad-shell-left", "pad-shell-right"),
        )
        self.assertEqual(
            {
                (hole.drill_x_nm, hole.drill_y_nm, hole.drill_rotation_udeg)
                for hole in restored.graph.holes
            },
            {(600_000, 1_100_000, 90_000_000)},
        )
        self.assertEqual(
            {
                pad.shared_land_group_id
                for pad in restored.graph.pads
                if pad.pad_number in {"A1", "B12"}
            },
            {"land-vbus"},
        )
        tampered_payload = graph_payload(exact_graph)
        first_pad_payload = tampered_payload["pads"][0]
        assert isinstance(first_pad_payload, dict)
        first_pad_payload["drill_x_nm"] = True
        with self.assertRaisesRegex(IntegrityError, "must be an integer"):
            graph_from_payload(tampered_payload)

    def test_genesis_is_anchor_first_idempotent_and_missing_anchor_is_terminal(self) -> None:
        base = genesis()
        for after_initialize in (False, True):
            with self.subTest(after_initialize=after_initialize):
                path = Path(self.temp.name) / f"genesis-crash-{after_initialize}.sqlite3"
                anchor = InjectedGenesisAnchor(after_initialize=after_initialize)
                with _SQLiteProjectStore(
                    path,
                    attestation_keyring=TEST_KEYRING,
                    project_head_anchor=anchor,
                ) as store:
                    with self.assertRaisesRegex(IntegrityError, "genesis anchor boundary"):
                        store.create_project(base)
                    count = store._connection.execute(  # noqa: SLF001
                        "SELECT COUNT(*) FROM canonical_projects"
                    ).fetchone()[0]
                    self.assertEqual(0, count)
                    self.assertEqual(after_initialize, anchor.read("persist-board") is not None)
                    store.create_project(base)
                    store.create_project(base)
                    self.assertEqual(base, store.restore("persist-board").head_revision)

        path = Path(self.temp.name) / "missing-genesis-anchor.sqlite3"
        anchor = InMemoryProjectHeadAnchor()
        with _SQLiteProjectStore(
            path,
            attestation_keyring=TEST_KEYRING,
            project_head_anchor=anchor,
        ) as store:
            store.create_project(base)
            anchor._states.clear()  # type: ignore[attr-defined]  # noqa: SLF001
            with self.assertRaisesRegex(IntegrityError, "anchor is missing"):
                store.restore("persist-board")
            self.assertIsNone(anchor.read("persist-board"))
            with self.assertRaisesRegex(IntegrityError, "lacks its exact external anchor"):
                store.create_project(base)
            self.assertIsNone(anchor.read("persist-board"))

    def test_concurrent_same_and_conflicting_genesis_are_deterministic(self) -> None:
        base = genesis()

        same_path = Path(self.temp.name) / "same-genesis.sqlite3"
        same_anchor = InMemoryProjectHeadAnchor()
        same_stores = tuple(
            _SQLiteProjectStore(
                same_path,
                attestation_keyring=TEST_KEYRING,
                project_head_anchor=same_anchor,
            )
            for _ in range(2)
        )
        same_barrier = Barrier(2)

        def create_same(store: _SQLiteProjectStore) -> str:
            same_barrier.wait()
            store.create_project(base)
            return "created"

        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = tuple(executor.map(create_same, same_stores))
            self.assertEqual(("created", "created"), outcomes)
            self.assertEqual(base, same_stores[0].restore("persist-board").head_revision)
        finally:
            for store in same_stores:
                store.close()

        conflicting_graph = rich_graph()
        conflicting_graph = replace(
            conflicting_graph,
            components=(
                replace(
                    conflicting_graph.components[0],
                    value="Conflicting exact controller",
                ),
            ),
        )
        conflicting = DesignKernel(conflicting_graph).head
        conflict_path = Path(self.temp.name) / "conflicting-genesis.sqlite3"
        conflict_anchor = InMemoryProjectHeadAnchor()
        conflict_stores = tuple(
            _SQLiteProjectStore(
                conflict_path,
                attestation_keyring=TEST_KEYRING,
                project_head_anchor=conflict_anchor,
            )
            for _ in range(2)
        )
        conflict_barrier = Barrier(2)

        def create_conflicting(index: int) -> str:
            conflict_barrier.wait()
            try:
                conflict_stores[index].create_project((base, conflicting)[index])
                return "created"
            except IntegrityError:
                return "conflict"

        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = tuple(executor.map(create_conflicting, (0, 1)))
            self.assertCountEqual(outcomes, ("created", "conflict"))
            winner = (base, conflicting)[outcomes.index("created")]
            self.assertEqual(
                winner,
                conflict_stores[0].restore("persist-board").head_revision,
            )
        finally:
            for store in conflict_stores:
                store.close()

    def test_open_and_verified_transaction_resume_with_optimistic_generation(self) -> None:
        base = genesis()
        kernel = staged_kernel(base)
        open_transaction = kernel.get_transaction("txn-layout")
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            first = store.save_transaction(
                "persist-board", open_transaction, expected_generation=None
            )
            self.assertEqual(first.generation, 0)
            kernel.record_verification(
                "txn-layout",
                verification_report_hash=REPORT_HASH,
                commit_gate_passed=True,
                verified_preview_digest=open_transaction.preview_digest,
            )
            verified = kernel.get_transaction("txn-layout")
            second = store.save_transaction(
                "persist-board", verified, expected_generation=0
            )
            self.assertEqual(second.generation, 1)
            with self.assertRaises(ConcurrencyConflict):
                store.save_transaction(
                    "persist-board", verified, expected_generation=0
                )

        with SQLiteProjectStore(self.path) as reopened:
            resumed = reopened.get_transaction("persist-board", "txn-layout")
            self.assertEqual(resumed.transaction, verified)
            self.assertEqual(resumed.generation, 1)

    def test_historical_rejected_approval_survives_a_later_rollback(self) -> None:
        base = genesis()
        kernel = staged_kernel(base)
        staged = kernel.get_transaction("txn-layout")
        kernel.record_verification(
            "txn-layout",
            verification_report_hash=REPORT_HASH,
            commit_gate_passed=True,
            verified_preview_digest=staged.preview_digest,
        )
        verified = kernel.get_transaction("txn-layout")
        rejected = ApprovalEvidence(
            approval_id="approval-rejected",
            approval_digest="9" * 64,
            transaction_id=verified.transaction_id,
            preview_digest=verified.preview_digest,
            release_subject_digest=release_subject_digest(
                verified.base_revision,
                verified.preview_digest,
            ),
            verification_report_hash=REPORT_HASH,
            decision=ApprovalDecision.REJECTED,
            actor="user:owner",
            decided_at=DECIDED_AT,
            reason="Rejected exact verified preview",
        )
        rolled_back = kernel.rollback("txn-layout")

        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.save_transaction(
                "persist-board", verified, expected_generation=None
            )
            store.record_approval("persist-board", rejected)
            stored = store.save_transaction(
                "persist-board", rolled_back, expected_generation=0
            )
            self.assertEqual(1, stored.generation)

        with SQLiteProjectStore(self.path) as reopened:
            state = reopened.restore("persist-board")
            self.assertEqual(rolled_back, state.transactions[0].transaction)
            self.assertEqual((rejected,), state.approvals)

    def test_transaction_identity_history_and_terminal_states_are_immutable(self) -> None:
        base = genesis()
        original_kernel = staged_kernel(
            base,
            transaction_id="txn-reused",
            via_id="via-original",
        )
        original = original_kernel.get_transaction("txn-reused")
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.save_transaction(
                "persist-board", original, expected_generation=None
            )

            empty_kernel = DesignKernel.from_revision(base)
            truncated = empty_kernel.begin_transaction(
                "txn-reused", base_revision=base.revision_hash
            )
            with self.assertRaisesRegex(IntegrityError, "append-only"):
                store.save_transaction(
                    "persist-board", truncated, expected_generation=0
                )

            committed, revision, approval, attestation = committed_change(
                base,
                transaction_id="txn-head",
                via_id="via-head",
                approval_id="approval-head",
            )
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
            rebound = staged_kernel(
                revision,
                transaction_id="txn-reused",
                via_id="via-rebound",
            ).get_transaction("txn-reused")
            with self.assertRaisesRegex(IntegrityError, "base revision"):
                store.save_transaction(
                    "persist-board", rebound, expected_generation=0
                )

        committed_path = Path(self.temp.name) / "committed-terminal.sqlite3"
        committed, revision, approval, attestation = committed_change(base)
        rolled_back = staged_kernel(base).rollback("txn-layout")
        with SQLiteProjectStore(committed_path) as store:
            store.create_project(base)
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
            with self.assertRaisesRegex(ConcurrencyConflict, "terminal"):
                store.save_transaction(
                    "persist-board", rolled_back, expected_generation=0
                )
            self.assertEqual(
                committed,
                store.get_transaction("persist-board", "txn-layout").transaction,
            )

        rolled_path = Path(self.temp.name) / "rolled-terminal.sqlite3"
        open_transaction = staged_kernel(base).get_transaction("txn-layout")
        with SQLiteProjectStore(rolled_path) as store:
            store.create_project(base)
            store.save_transaction(
                "persist-board", rolled_back, expected_generation=None
            )
            with self.assertRaisesRegex(ConcurrencyConflict, "terminal"):
                store.save_transaction(
                    "persist-board", open_transaction, expected_generation=0
                )

    def test_approval_then_commit_append_is_atomic_and_restart_safe(self) -> None:
        base = genesis()
        authority = HmacCommitAuthority(
            key_id="project-store-test-commit-key",
            secret=b"project-store-test-commit-secret-32-bytes-minimum",
            clock=lambda: DECIDED_AT,
        )
        kernel = staged_kernel(base, commit_authority=authority)
        staged = kernel.get_transaction("txn-layout")
        kernel.record_verification(
            "txn-layout",
            verification_report_hash=REPORT_HASH,
            commit_gate_passed=True,
            verified_preview_digest=staged.preview_digest,
        )
        verified = kernel.get_transaction("txn-layout")
        approval = ApprovalEvidence(
            approval_id="approval-layout",
            approval_digest=approval_digest("approval-layout"),
            transaction_id="txn-layout",
            preview_digest=verified.preview_digest,
            release_subject_digest=release_subject_digest(
                verified.base_revision,
                verified.preview_digest,
            ),
            verification_report_hash=REPORT_HASH,
            decision=ApprovalDecision.APPROVED,
            actor="user:owner",
            decided_at=DECIDED_AT,
            reason="Reviewed exact semantic diff",
        )
        revision = kernel.commit(
            "txn-layout",
            authorization=commit_authorization(
                kernel, authority, "txn-layout"
            ),
        )
        committed = kernel.get_transaction("txn-layout")
        attestation = TEST_SIGNER.sign_commit(
            revision=revision,
            transaction=committed,
            approval=approval,
            authorization=kernel.get_commit_authorization_evidence("txn-layout"),
            verification_input_hash="e" * 64,
            verification_rule_set_hash="f" * 64,
        )

        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.save_transaction(
                "persist-board", verified, expected_generation=None
            )
            store.record_approval("persist-board", approval)
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=0,
            )

        with SQLiteProjectStore(self.path) as reopened:
            state = reopened.restore("persist-board")
            self.assertEqual(state.head_revision, revision)
            self.assertEqual(state.revisions, (base, revision))
            self.assertEqual(state.transactions[0].transaction, committed)
            self.assertEqual(state.transactions[0].generation, 1)
            self.assertEqual(state.approvals, (approval,))

    def test_failed_append_rolls_back_transaction_update_and_all_new_rows(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        kernel = staged_kernel(base)
        staged = kernel.get_transaction("txn-layout")
        kernel.record_verification(
            "txn-layout",
            verification_report_hash=REPORT_HASH,
            commit_gate_passed=True,
            verified_preview_digest=staged.preview_digest,
        )
        verified = kernel.get_transaction("txn-layout")
        conflicting = replace(approval, actor="user:different")
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.save_transaction(
                "persist-board", verified, expected_generation=None
            )
            store.record_approval("persist-board", approval)
            with self.assertRaisesRegex(IntegrityError, "attestation.*bind"):
                store.append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=committed,
                    approval=conflicting,
                    attestation=attestation,
                    expected_transaction_generation=0,
                )
            self.assertEqual(store.get_head("persist-board"), base)
            durable = store.get_transaction("persist-board", "txn-layout")
            self.assertEqual(durable.transaction, verified)
            self.assertEqual(durable.generation, 0)
            self.assertEqual(store.list_revisions("persist-board"), (base,))

    def test_append_rejects_report_and_release_subject_mismatches(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        different_report = "d" * 64
        mismatches = (
            (
                "verification report",
                replace(
                    approval,
                    verification_report_hash=different_report,
                    release_subject_digest=release_subject_digest(
                        committed.base_revision,
                        committed.preview_digest,
                        different_report,
                    ),
                ),
                "attestation.*bind",
            ),
            (
                "release subject",
                replace(approval, release_subject_digest="e" * 64),
                "attestation.*bind",
            ),
        )
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            for label, mismatched, error_pattern in mismatches:
                with self.subTest(label=label):
                    with self.assertRaisesRegex(IntegrityError, error_pattern):
                        store.append_revision(
                            "persist-board",
                            revision,
                            expected_head=base.revision_hash,
                            transaction=committed,
                            approval=mismatched,
                            attestation=attestation,
                            expected_transaction_generation=None,
                        )
                    state = store.restore("persist-board")
                    self.assertEqual(state.head_revision, base)
                    self.assertEqual(state.transactions, ())
                    self.assertEqual(state.approvals, ())

    def test_approval_digest_fields_require_lowercase_sha256(self) -> None:
        _, _, approval, _ = committed_change(genesis())
        with self.assertRaisesRegex(ValueError, "release subject digest"):
            replace(approval, release_subject_digest="A" * 64)
        with self.assertRaisesRegex(ValueError, "verification report hash"):
            replace(approval, verification_report_hash="short")

    def test_database_immutability_trigger_and_hash_tamper_detection(self) -> None:
        base = genesis()
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
        attacker = sqlite3.connect(self.path)
        with self.assertRaises(sqlite3.IntegrityError):
            attacker.execute("UPDATE design_revisions SET body = body || ' '")
        attacker.execute("DROP TRIGGER design_revisions_no_update")
        attacker.execute(
            "UPDATE design_revisions SET body = replace(body, 'persist-board', 'forged-board')"
        )
        attacker.commit()
        attacker.close()
        with SQLiteProjectStore(self.path) as reopened:
            with self.assertRaisesRegex(IntegrityError, "body digest mismatch"):
                reopened.restore("persist-board")

    def test_restore_detects_removed_commit_approval_evidence(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
        attacker = sqlite3.connect(self.path)
        attacker.execute("DROP TRIGGER approval_evidence_no_delete")
        attacker.execute("DELETE FROM approval_evidence")
        attacker.commit()
        attacker.close()
        with SQLiteProjectStore(self.path) as reopened:
            with self.assertRaisesRegex(IntegrityError, "missing approval evidence"):
                reopened.restore("persist-board")

    def test_restore_detects_approval_digest_secondary_column_tamper(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        for index, column in enumerate(
            ("release_subject_digest", "verification_report_hash")
        ):
            with self.subTest(column=column):
                path = Path(self.temp.name) / f"approval-tamper-{index}.sqlite3"
                with SQLiteProjectStore(path) as store:
                    store.create_project(base)
                    store.append_revision(
                        "persist-board",
                        revision,
                        expected_head=base.revision_hash,
                        transaction=committed,
                        approval=approval,
                        attestation=attestation,
                        expected_transaction_generation=None,
                    )
                attacker = sqlite3.connect(path)
                attacker.execute("DROP TRIGGER approval_evidence_no_update")
                attacker.execute(
                    f"UPDATE approval_evidence SET {column} = ?",
                    ("f" * 64,),
                )
                attacker.commit()
                attacker.close()
                with SQLiteProjectStore(path) as reopened:
                    with self.assertRaisesRegex(IntegrityError, "index/body mismatch"):
                        reopened.restore("persist-board")

    def test_restore_recomputes_release_subject_after_coherent_row_tamper(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
        attacker = sqlite3.connect(self.path)
        attacker.execute("DROP TRIGGER approval_evidence_no_update")
        document = json.loads(
            attacker.execute("SELECT body FROM approval_evidence").fetchone()[0]
        )
        forged_subject = "f" * 64
        document["payload"]["release_subject_digest"] = forged_subject
        forged_body = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        forged_body_hash = hashlib.sha256(forged_body.encode("utf-8")).hexdigest()
        attacker.execute(
            """UPDATE approval_evidence
               SET release_subject_digest = ?, body = ?, body_hash = ?""",
            (forged_subject, forged_body, forged_body_hash),
        )
        attacker.commit()
        attacker.close()
        with SQLiteProjectStore(self.path) as reopened:
            with self.assertRaisesRegex(IntegrityError, "attestation.*bind"):
                reopened.restore("persist-board")

    def test_strict_codec_rejects_unknown_missing_and_float_fields(self) -> None:
        payload = graph_payload(rich_graph())
        with_unknown = dict(payload)
        with_unknown["future_unreviewed_field"] = 1
        with self.assertRaisesRegex(IntegrityError, "unknown=future_unreviewed_field"):
            graph_from_payload(with_unknown)
        missing = dict(payload)
        del missing["vias"]
        with self.assertRaisesRegex(IntegrityError, "missing=vias"):
            graph_from_payload(missing)
        wrong_schema = dict(payload)
        wrong_schema["schema_version"] = 2
        with self.assertRaisesRegex(IntegrityError, "canonical invariants"):
            graph_from_payload(wrong_schema)
        float_body = '{"document":"design-revision","payload":{"x":1.25},"version":2}'
        with self.assertRaisesRegex(IntegrityError, "floating-point"):
            decode_document(float_body, expected_kind="design-revision")
        old_document = '{"document":"design-revision","payload":{},"version":1}'
        with self.assertRaisesRegex(
            UnsupportedStoreSchema,
            "unsupported design-revision document version 1",
        ):
            decode_document(old_document, expected_kind="design-revision")

    def test_stored_json_is_canonical_and_contains_no_database_path(self) -> None:
        base = genesis()
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
        connection = sqlite3.connect(self.path)
        body = connection.execute("SELECT body FROM design_revisions").fetchone()[0]
        connection.close()
        self.assertEqual(
            body,
            json.dumps(json.loads(body), sort_keys=True, separators=(",", ":"), ensure_ascii=False),
        )
        self.assertNotIn(str(self.path), body)
        self.assertNotIn("\\\\", body)

    def test_two_concurrent_revision_appends_have_one_deterministic_winner(self) -> None:
        base = genesis()
        first = committed_change(
            base,
            transaction_id="txn-first",
            via_id="via-first",
            approval_id="approval-first",
        )
        second = committed_change(
            base,
            transaction_id="txn-second",
            via_id="via-second",
            approval_id="approval-second",
        )
        with SQLiteProjectStore(self.path) as creator:
            creator.create_project(base)
        stores = (SQLiteProjectStore(self.path), SQLiteProjectStore(self.path))
        barrier = Barrier(2)

        def append(index: int) -> str:
            transaction, revision, approval, attestation = (first, second)[index]
            barrier.wait()
            try:
                stores[index].append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=transaction,
                    approval=approval,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
                return "committed"
            except ConcurrencyConflict:
                return "conflict"

        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = tuple(executor.map(append, (0, 1)))
            self.assertCountEqual(outcomes, ("committed", "conflict"))
        finally:
            for store in stores:
                store.close()
        with SQLiteProjectStore(self.path) as verifier:
            state = verifier.restore("persist-board")
            self.assertEqual(len(state.revisions), 2)
            self.assertEqual(state.head_revision.sequence, 1)
            self.assertEqual(len(state.transactions), 1)
            self.assertEqual(len(state.approvals), 1)

    def test_attestation_tamper_missing_record_and_cross_binding_fail_closed(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            with self.assertRaisesRegex(IntegrityError, "attestation.*bind"):
                other = committed_change(
                    genesis("other-project"),
                    transaction_id="txn-other",
                    via_id="via-other",
                    approval_id="approval-other",
                )
                store.append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=committed,
                    approval=approval,
                    attestation=other[3],
                    expected_transaction_generation=None,
                )
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )

        attacker = sqlite3.connect(self.path)
        attacker.execute("DROP TRIGGER commit_attestations_no_update")
        document = json.loads(
            attacker.execute("SELECT body FROM commit_attestations").fetchone()[0]
        )
        document["payload"]["signature"] = "0" * 128
        forged_body = json.dumps(
            document,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        forged_hash = hashlib.sha256(forged_body.encode("utf-8")).hexdigest()
        attacker.execute(
            "UPDATE commit_attestations SET body = ?, body_hash = ?",
            (forged_body, forged_hash),
        )
        attacker.commit()
        attacker.close()
        with SQLiteProjectStore(self.path) as reopened:
            with self.assertRaisesRegex(IntegrityError, "signature"):
                reopened.restore("persist-board")

        missing_path = Path(self.temp.name) / "missing-attestation.sqlite3"
        with SQLiteProjectStore(missing_path) as store:
            store.create_project(base)
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
        attacker = sqlite3.connect(missing_path)
        attacker.execute("DROP TRIGGER commit_attestations_no_delete")
        attacker.execute("DELETE FROM commit_attestations")
        attacker.commit()
        attacker.close()
        with SQLiteProjectStore(missing_path) as reopened:
            with self.assertRaisesRegex(IntegrityError, "attestation"):
                reopened.restore("persist-board")

    def test_attestation_key_rotation_and_restart_require_complete_public_keyring(self) -> None:
        first_signer = Ed25519CommitAttestationSigner.from_private_bytes(
            key_id="rotation-key-1",
            private_key=b"\x31" * 32,
        )
        second_signer = Ed25519CommitAttestationSigner.from_private_bytes(
            key_id="rotation-key-2",
            private_key=b"\x32" * 32,
        )
        keyring = Ed25519CommitAttestationKeyring.from_signers(
            first_signer,
            second_signer,
        )
        anchor = InMemoryProjectHeadAnchor()
        base = genesis()
        first = committed_change(
            base,
            transaction_id="txn-rotation-1",
            via_id="via-rotation-1",
            approval_id="approval-rotation-1",
            signer=first_signer,
        )
        second = committed_change(
            first[1],
            transaction_id="txn-rotation-2",
            via_id="via-rotation-2",
            approval_id="approval-rotation-2",
            signer=second_signer,
        )
        with _SQLiteProjectStore(
            self.path,
            attestation_keyring=keyring,
            project_head_anchor=anchor,
        ) as store:
            store.create_project(base)
            for expected_head, fixture in (
                (base.revision_hash, first),
                (first[1].revision_hash, second),
            ):
                transaction, revision, approval, attestation = fixture
                store.append_revision(
                    "persist-board",
                    revision,
                    expected_head=expected_head,
                    transaction=transaction,
                    approval=approval,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
        with _SQLiteProjectStore(
            self.path,
            attestation_keyring=keyring,
            project_head_anchor=anchor,
        ) as reopened:
            self.assertEqual(reopened.restore("persist-board").head_revision, second[1])
            self.assertFalse(hasattr(reopened, "_commit_attestation_signer"))
        with _SQLiteProjectStore(
            self.path,
            attestation_keyring=Ed25519CommitAttestationKeyring.from_signers(
                second_signer
            ),
            project_head_anchor=anchor,
        ) as incomplete:
            with self.assertRaisesRegex(IntegrityError, "not trusted"):
                incomplete.restore("persist-board")

    def test_attestation_key_ids_are_canonical_and_conflicts_are_rejected(self) -> None:
        invalid_ids = (
            " key-id",
            "key-id ",
            "key id",
            "key\nid",
            "key\u200bid",
            "e\u0301-key",
        )
        for key_id in invalid_ids:
            with self.subTest(key_id=repr(key_id)):
                with self.assertRaisesRegex(ValueError, "identifier"):
                    Ed25519CommitAttestationSigner.from_private_bytes(
                        key_id=key_id,
                        private_key=b"\x41" * 32,
                    )
                with self.assertRaisesRegex(ValueError, "identifier"):
                    Ed25519CommitAttestationKeyring({key_id: b"\x42" * 32})

        first = Ed25519CommitAttestationSigner.from_private_bytes(
            key_id="duplicate-key-id",
            private_key=b"\x43" * 32,
        )
        second = Ed25519CommitAttestationSigner.from_private_bytes(
            key_id="duplicate-key-id",
            private_key=b"\x44" * 32,
        )
        with self.assertRaisesRegex(ValueError, "conflicting public keys"):
            Ed25519CommitAttestationKeyring.from_signers(first, second)
        # Repeating the exact same key is harmless deduplication, not conflict.
        Ed25519CommitAttestationKeyring.from_signers(first, first)

    def test_external_anchor_detects_rollback_and_recovers_only_signed_successors(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
        genesis_bytes = self.path.read_bytes()
        with SQLiteProjectStore(self.path) as store:
            store.append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=committed,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
        self.path.write_bytes(genesis_bytes)
        with SQLiteProjectStore(self.path) as rolled_back:
            with self.assertRaisesRegex(IntegrityError, "ahead"):
                rolled_back.restore("persist-board")

        for after_advance in (False, True):
            with self.subTest(after_advance=after_advance):
                path = Path(self.temp.name) / f"crash-{after_advance}.sqlite3"
                anchor = InjectedCrashAnchor(after_advance=after_advance)
                with _SQLiteProjectStore(
                    path,
                    attestation_keyring=TEST_KEYRING,
                    project_head_anchor=anchor,
                ) as store:
                    store.create_project(base)
                    with self.assertRaisesRegex(IntegrityError, "crash boundary"):
                        store.append_revision(
                            "persist-board",
                            revision,
                            expected_head=base.revision_hash,
                            transaction=committed,
                            approval=approval,
                            attestation=attestation,
                            expected_transaction_generation=None,
                        )
                    restored = store.restore("persist-board")
                    self.assertEqual(restored.head_revision, revision)

    def test_anchor_is_not_advanced_until_the_behind_db_chain_fully_verifies(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        path = Path(self.temp.name) / "invalid-behind-anchor.sqlite3"
        anchor = InjectedCrashAnchor(after_advance=False)
        with _SQLiteProjectStore(
            path,
            attestation_keyring=TEST_KEYRING,
            project_head_anchor=anchor,
        ) as store:
            store.create_project(base)
            with self.assertRaisesRegex(IntegrityError, "crash boundary"):
                store.append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=committed,
                    approval=approval,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
        attacker = sqlite3.connect(path)
        attacker.execute("DROP TRIGGER commit_attestations_no_delete")
        attacker.execute("DELETE FROM commit_attestations")
        attacker.commit()
        attacker.close()

        with _SQLiteProjectStore(
            path,
            attestation_keyring=TEST_KEYRING,
            project_head_anchor=anchor,
        ) as reopened, self.assertRaisesRegex(IntegrityError, "attestation"):
            reopened.restore("persist-board")
        observed = anchor.read("persist-board")
        self.assertIsNotNone(observed)
        assert observed is not None
        self.assertEqual(0, observed.sequence)

    def test_slow_anchor_competing_writer_is_concurrency_not_integrity(self) -> None:
        base = genesis()
        first = committed_change(
            base,
            transaction_id="txn-slow-winner",
            via_id="via-slow-winner",
            approval_id="approval-slow-winner",
        )
        competing = committed_change(
            base,
            transaction_id="txn-slow-loser",
            via_id="via-slow-loser",
            approval_id="approval-slow-loser",
        )
        path = Path(self.temp.name) / "slow-anchor-race.sqlite3"
        anchor = SlowFirstAdvanceAnchor()
        stores = tuple(
            _SQLiteProjectStore(
                path,
                attestation_keyring=TEST_KEYRING,
                project_head_anchor=anchor,
            )
            for _ in range(2)
        )
        stores[0].create_project(base)

        def append_first() -> str:
            transaction, revision, approval, attestation = first
            stores[0].append_revision(
                "persist-board",
                revision,
                expected_head=base.revision_hash,
                transaction=transaction,
                approval=approval,
                attestation=attestation,
                expected_transaction_generation=None,
            )
            return "committed"

        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(append_first)
                self.assertTrue(anchor.entered.wait(timeout=5))
                transaction, revision, approval, attestation = competing
                with self.assertRaises(ConcurrencyConflict):
                    stores[1].append_revision(
                        "persist-board",
                        revision,
                        expected_head=base.revision_hash,
                        transaction=transaction,
                        approval=approval,
                        attestation=attestation,
                        expected_transaction_generation=None,
                    )
                anchor.release.set()
                self.assertEqual("committed", future.result(timeout=5))
            self.assertEqual(first[1], stores[1].restore("persist-board").head_revision)
        finally:
            anchor.release.set()
            for store in stores:
                store.close()

    def test_restore_retries_a_real_db_snapshot_anchor_read_skew(self) -> None:
        base = genesis()
        committed, revision, approval, attestation = committed_change(base)
        path = Path(self.temp.name) / "read-skew.sqlite3"
        anchor = BlockingNextReadAnchor()
        stores = tuple(
            _SQLiteProjectStore(
                path,
                attestation_keyring=TEST_KEYRING,
                project_head_anchor=anchor,
            )
            for _ in range(2)
        )
        stores[0].create_project(base)
        anchor.arm()

        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                reader = executor.submit(stores[0].restore, "persist-board")
                self.assertTrue(anchor.entered.wait(timeout=5))
                stores[1].append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=committed,
                    approval=approval,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
                anchor.release.set()
                self.assertEqual(revision, reader.result(timeout=5).head_revision)
        finally:
            anchor.release.set()
            for store in stores:
                store.close()

    def test_concurrent_external_anchor_branches_have_one_cas_winner(self) -> None:
        base = genesis()
        shared_anchor = InMemoryProjectHeadAnchor()
        paths = (
            Path(self.temp.name) / "branch-a.sqlite3",
            Path(self.temp.name) / "branch-b.sqlite3",
        )
        fixtures = (
            committed_change(
                base,
                transaction_id="txn-branch-a",
                via_id="via-branch-a",
                approval_id="approval-branch-a",
            ),
            committed_change(
                base,
                transaction_id="txn-branch-b",
                via_id="via-branch-b",
                approval_id="approval-branch-b",
            ),
        )
        stores = tuple(
            _SQLiteProjectStore(
                path,
                attestation_keyring=TEST_KEYRING,
                project_head_anchor=shared_anchor,
            )
            for path in paths
        )
        for store in stores:
            store.create_project(base)
        barrier = Barrier(2)

        def append(index: int) -> str:
            transaction, revision, approval, attestation = fixtures[index]
            barrier.wait()
            try:
                stores[index].append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=transaction,
                    approval=approval,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
                return "committed"
            except IntegrityError:
                return "anchor-conflict"

        try:
            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = tuple(executor.map(append, (0, 1)))
            self.assertCountEqual(outcomes, ("committed", "anchor-conflict"))
            winner = outcomes.index("committed")
            loser = 1 - winner
            self.assertEqual(
                stores[winner].restore("persist-board").head_revision,
                fixtures[winner][1],
            )
            with self.assertRaisesRegex(IntegrityError, "contradicts"):
                stores[loser].restore("persist-board")
        finally:
            for store in stores:
                store.close()

    def test_incompatible_database_version_fails_closed(self) -> None:
        connection = sqlite3.connect(self.path)
        connection.execute("PRAGMA user_version = 99")
        connection.commit()
        connection.close()
        with self.assertRaises(UnsupportedStoreSchema):
            SQLiteProjectStore(self.path)

    def test_older_database_version_requires_explicit_migration(self) -> None:
        with SQLiteProjectStore(self.path):
            pass
        connection = sqlite3.connect(self.path)
        connection.execute("PRAGMA user_version = 1")
        connection.execute(
            "UPDATE project_store_meta SET schema_version = 1, document_version = 1"
        )
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(
            UnsupportedStoreSchema,
            "unsupported project-store database schema 1",
        ):
            SQLiteProjectStore(self.path)

    def test_sqlite_busy_and_corruption_never_escape_as_raw_driver_errors(self) -> None:
        base = genesis()
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
        contender = SQLiteProjectStore(self.path, busy_timeout_ms=0)
        locker = sqlite3.connect(self.path, isolation_level=None)
        locker.execute("BEGIN IMMEDIATE")
        try:
            with self.assertRaises(StoreUnavailable) as raised:
                contender.save_transaction(
                    "persist-board",
                    staged_kernel(base).get_transaction("txn-layout"),
                    expected_generation=None,
                )
            self.assertNotIsInstance(raised.exception, sqlite3.DatabaseError)
            self.assertNotIn(str(self.path), str(raised.exception))
        finally:
            contender.close()
            locker.execute("ROLLBACK")
            locker.close()

        corrupt_path = Path(self.temp.name) / "corrupt.sqlite3"
        corrupt_path.write_bytes(b"this is not a sqlite database")
        with self.assertRaises(IntegrityError) as corrupt:
            SQLiteProjectStore(corrupt_path)
        self.assertNotIsInstance(corrupt.exception, sqlite3.DatabaseError)
        self.assertNotIn(str(corrupt_path), str(corrupt.exception))

    def test_rejected_approval_cannot_authorize_commit(self) -> None:
        base = genesis()
        committed, revision, approved, attestation = committed_change(base)
        rejected = replace(
            approved,
            decision=ApprovalDecision.REJECTED,
            reason="Rejected after exact preview review",
        )
        with SQLiteProjectStore(self.path) as store:
            store.create_project(base)
            with self.assertRaisesRegex(IntegrityError, "affirmative"):
                store.append_revision(
                    "persist-board",
                    revision,
                    expected_head=base.revision_hash,
                    transaction=committed,
                    approval=rejected,
                    attestation=attestation,
                    expected_transaction_generation=None,
                )
            self.assertEqual(store.get_head("persist-board"), base)


class ZoneFillStoreContractTests(unittest.TestCase):
    def setUp(self) -> None:
        _TEST_ANCHORS.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "zone-fill.sqlite3"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _verified_graph(self) -> DesignGraph:
        graph = rich_graph("zone-fill-store")
        zone = bind_verified_zone_fill(
            graph.zones[0],
            source_graph=graph,
            source_revision="d" * 64,
            fill_engine_id="kicad-zone-fill",
            fill_engine_revision="10.0.0",
        )
        return replace(graph, zones=(zone,)).normalized()

    def test_verified_fill_round_trips_codec_and_repository_restore(self) -> None:
        graph = self._verified_graph()
        self.assertEqual(graph, graph_from_payload(graph_payload(graph)))
        revision = DesignKernel(graph).head

        with SQLiteProjectStore(self.path) as store:
            store.create_project(revision)
        with SQLiteProjectStore(self.path) as reopened:
            restored = reopened.restore("zone-fill-store").head_revision.graph

        self.assertEqual(graph, restored)
        self.assertIs(restored.zones[0].fill_state, ZoneFillState.VERIFIED_FILLED)
        self.assertIsNotNone(restored.zones[0].fill_evidence)

    def test_old_zone_shape_requires_explicit_migration_and_bool_is_rejected(self) -> None:
        self.assertEqual(5, DOCUMENT_VERSION)
        payload = graph_payload(rich_graph("zone-fill-migration"))
        legacy = json.loads(json.dumps(payload))
        del legacy["zones"][0]["fill_state"]
        del legacy["zones"][0]["fill_evidence"]
        with self.assertRaisesRegex(IntegrityError, "missing=fill_evidence,fill_state"):
            graph_from_payload(legacy)

        bool_state = json.loads(json.dumps(payload))
        bool_state["zones"][0]["fill_state"] = True
        with self.assertRaisesRegex(IntegrityError, "must be text"):
            graph_from_payload(bool_state)

        old_document = '{"document":"design-revision","payload":{},"version":4}'
        with self.assertRaisesRegex(UnsupportedStoreSchema, "document version 4"):
            decode_document(old_document, expected_kind="design-revision")

    def test_tampered_verified_fill_evidence_is_rejected_during_restore_decode(self) -> None:
        payload = graph_payload(self._verified_graph())
        forged = json.loads(json.dumps(payload))
        forged["zones"][0]["fill_evidence"]["source_graph_hash"] = "f" * 64
        with self.assertRaisesRegex(IntegrityError, "canonical invariants"):
            graph_from_payload(forged)


if __name__ == "__main__":
    unittest.main()
