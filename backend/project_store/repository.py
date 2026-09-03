"""SQLite implementation of the append-safe canonical project repository."""

from __future__ import annotations

import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from threading import RLock
from typing import Protocol, runtime_checkable

from backend.design_kernel import (
    DesignKernel,
    DesignRevision,
    DesignTransaction,
    TransactionState,
    commit_command_hashes_digest,
    stable_hash,
)

from .anchor import (
    GENESIS_ATTESTATION_DIGEST,
    ProjectHeadAnchor,
    ProjectHeadAnchorState,
)
from .attestation import Ed25519CommitAttestationKeyring
from .codec import (
    DOCUMENT_VERSION,
    approval_from_payload,
    approval_payload,
    attestation_from_payload,
    attestation_payload,
    body_sha256,
    decode_document,
    encode_document,
    revision_from_payload,
    revision_hash_for,
    revision_payload,
    transaction_from_payload,
    transaction_payload,
)
from .models import (
    ApprovalDecision,
    ApprovalEvidence,
    ConcurrencyConflict,
    DurableCommitAttestation,
    IntegrityError,
    ProjectAlreadyExists,
    ProjectNotFound,
    ProjectState,
    ProjectStoreError,
    StoredTransaction,
    StoreUnavailable,
    UnsupportedStoreSchema,
)

STORE_SCHEMA_VERSION = 4
_APPLICATION_ID = 0x46504342  # "FPCB"


class _AnchorAheadOfSnapshot(RuntimeError):
    """A fresh DB snapshot is required before an ahead anchor is corruption."""


@runtime_checkable
class ProjectRepository(Protocol):
    """Storage-independent integration boundary for the application layer."""

    def create_project(self, genesis: DesignRevision) -> None: ...

    def get_head(self, project_id: str) -> DesignRevision: ...

    def get_revision(self, project_id: str, revision_hash: str) -> DesignRevision: ...

    def list_revisions(self, project_id: str) -> tuple[DesignRevision, ...]: ...

    def save_transaction(
        self,
        project_id: str,
        transaction: DesignTransaction,
        *,
        expected_generation: int | None,
    ) -> StoredTransaction: ...

    def get_transaction(self, project_id: str, transaction_id: str) -> StoredTransaction: ...

    def record_approval(self, project_id: str, approval: ApprovalEvidence) -> None: ...

    def append_revision(
        self,
        project_id: str,
        revision: DesignRevision,
        *,
        expected_head: str,
        transaction: DesignTransaction,
        approval: ApprovalEvidence,
        attestation: DurableCommitAttestation,
        expected_transaction_generation: int | None,
    ) -> None: ...

    def restore(self, project_id: str) -> ProjectState: ...


class SQLiteProjectStore:
    """Versioned SQLite repository with hash chains and optimistic writes.

    Revisions and approvals are immutable at both the repository and database
    layers. Transaction snapshots are the only mutable records and every update
    requires an exact generation. All public reads revalidate canonical bodies,
    secondary columns, intrinsic design hashes, and the revision record chain.
    """

    def __init__(
        self,
        path: str | Path,
        *,
        attestation_keyring: Ed25519CommitAttestationKeyring,
        project_head_anchor: ProjectHeadAnchor,
        busy_timeout_ms: int = 5_000,
    ) -> None:
        if (
            type(busy_timeout_ms) is not int
            or busy_timeout_ms < 0
        ):
            raise ValueError("busy_timeout_ms must be a non-negative integer")
        if type(attestation_keyring) is not Ed25519CommitAttestationKeyring:
            raise ValueError("project store requires an external Ed25519 attestation keyring")
        if not isinstance(  # pyright: ignore[reportUnnecessaryIsInstance]
            project_head_anchor, ProjectHeadAnchor
        ):
            raise ValueError("project store requires an external monotonic project-head anchor")
        self._attestation_keyring = attestation_keyring
        self._project_head_anchor = project_head_anchor
        self._lock = RLock()
        self._depth = 0
        try:
            self._connection = sqlite3.connect(
                str(path),
                isolation_level=None,
                check_same_thread=False,
                timeout=busy_timeout_ms / 1_000,
            )
            self._connection.row_factory = sqlite3.Row
            self._connection.execute("PRAGMA foreign_keys = ON")
            self._connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
            self._connection.execute("PRAGMA journal_mode = WAL")
            self._connection.execute("PRAGMA synchronous = FULL")
            self._initialize()
        except sqlite3.DatabaseError as exc:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                try:
                    connection.close()
                except sqlite3.DatabaseError:
                    pass
            raise self._translate_sqlite_error(exc) from exc
        except Exception:
            connection = getattr(self, "_connection", None)
            if connection is not None:
                try:
                    connection.close()
                except sqlite3.DatabaseError:
                    pass
            raise

    def close(self) -> None:
        with self._lock:
            try:
                self._connection.close()
            except sqlite3.DatabaseError as exc:
                raise self._translate_sqlite_error(exc) from exc

    def __enter__(self) -> SQLiteProjectStore:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @staticmethod
    def _translate_sqlite_error(exc: sqlite3.DatabaseError) -> ProjectStoreError:
        message = str(exc).lower()
        corruption_markers = (
            "corrupt",
            "malformed",
            "not a database",
            "file is encrypted",
            "schema has changed unexpectedly",
        )
        unavailable_markers = (
            "busy",
            "locked",
            "readonly",
            "read-only",
            "unable to open",
            "disk i/o",
            "database or disk is full",
        )
        if isinstance(exc, sqlite3.IntegrityError) or any(
            marker in message for marker in corruption_markers
        ):
            return IntegrityError("durable project database failed an integrity check")
        if isinstance(exc, sqlite3.OperationalError) and any(
            marker in message for marker in unavailable_markers
        ):
            return StoreUnavailable("durable project database is temporarily unavailable")
        return ProjectStoreError("durable project database operation failed")

    @contextmanager
    def _transaction(self, *, write: bool) -> Generator[None, None, None]:
        with self._lock:
            outer = self._depth == 0
            if outer:
                try:
                    self._connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                except sqlite3.DatabaseError as exc:
                    raise self._translate_sqlite_error(exc) from exc
            self._depth += 1
            try:
                yield
            except sqlite3.DatabaseError as exc:
                self._depth -= 1
                if outer:
                    try:
                        self._connection.execute("ROLLBACK")
                    except sqlite3.DatabaseError:
                        pass
                raise self._translate_sqlite_error(exc) from exc
            except Exception:
                self._depth -= 1
                if outer:
                    try:
                        self._connection.execute("ROLLBACK")
                    except sqlite3.DatabaseError as exc:
                        raise self._translate_sqlite_error(exc) from exc
                raise
            else:
                self._depth -= 1
                if outer:
                    try:
                        self._connection.execute("COMMIT")
                    except sqlite3.DatabaseError as exc:
                        try:
                            self._connection.execute("ROLLBACK")
                        except sqlite3.DatabaseError:
                            pass
                        raise self._translate_sqlite_error(exc) from exc

    def _initialize(self) -> None:
        with self._lock:
            user_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            application_id = int(self._connection.execute("PRAGMA application_id").fetchone()[0])
            existing = {
                row[0]
                for row in self._connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            owned = {
                "project_store_meta",
                "canonical_projects",
                "design_revisions",
                "design_transactions",
                "approval_evidence",
                "commit_attestations",
            }
            if user_version == 0 and not (existing & owned):
                if application_id not in {0, _APPLICATION_ID}:
                    raise UnsupportedStoreSchema("database belongs to another application")
                self._connection.executescript(
                    f"""
                    PRAGMA application_id = {_APPLICATION_ID};
                    PRAGMA user_version = {STORE_SCHEMA_VERSION};
                    CREATE TABLE project_store_meta (
                        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                        schema_name TEXT NOT NULL,
                        schema_version INTEGER NOT NULL,
                        document_version INTEGER NOT NULL
                    ) STRICT;
                    INSERT INTO project_store_meta VALUES
                        (1, 'flux-clone-project-store', {STORE_SCHEMA_VERSION}, {DOCUMENT_VERSION});
                    CREATE TABLE canonical_projects (
                        project_id TEXT PRIMARY KEY,
                        head_revision TEXT NOT NULL,
                        head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0),
                        generation INTEGER NOT NULL CHECK (generation >= 0)
                    ) STRICT;
                    CREATE TABLE design_revisions (
                        project_id TEXT NOT NULL REFERENCES canonical_projects(project_id),
                        sequence INTEGER NOT NULL CHECK (sequence >= 0),
                        revision_hash TEXT NOT NULL,
                        parent_revision TEXT,
                        graph_hash TEXT NOT NULL,
                        previous_record_hash TEXT NOT NULL,
                        record_hash TEXT NOT NULL,
                        body TEXT NOT NULL,
                        body_hash TEXT NOT NULL,
                        PRIMARY KEY (project_id, revision_hash),
                        UNIQUE (project_id, sequence)
                    ) STRICT;
                    CREATE TABLE design_transactions (
                        project_id TEXT NOT NULL REFERENCES canonical_projects(project_id),
                        transaction_id TEXT NOT NULL,
                        base_revision TEXT NOT NULL,
                        state TEXT NOT NULL,
                        preview_digest TEXT NOT NULL,
                        generation INTEGER NOT NULL CHECK (generation >= 0),
                        body TEXT NOT NULL,
                        body_hash TEXT NOT NULL,
                        PRIMARY KEY (project_id, transaction_id)
                    ) STRICT;
                    CREATE TABLE approval_evidence (
                        project_id TEXT NOT NULL REFERENCES canonical_projects(project_id),
                        approval_id TEXT NOT NULL,
                        approval_digest TEXT NOT NULL
                            CHECK (length(approval_digest) = 64
                                AND approval_digest NOT GLOB '*[^0-9a-f]*'),
                        transaction_id TEXT NOT NULL,
                        preview_digest TEXT NOT NULL,
                        release_subject_digest TEXT NOT NULL
                            CHECK (length(release_subject_digest) = 64
                                AND release_subject_digest NOT GLOB '*[^0-9a-f]*'),
                        verification_report_hash TEXT NOT NULL
                            CHECK (length(verification_report_hash) = 64
                                AND verification_report_hash NOT GLOB '*[^0-9a-f]*'),
                        decision TEXT NOT NULL,
                        body TEXT NOT NULL,
                        body_hash TEXT NOT NULL,
                        PRIMARY KEY (project_id, approval_id)
                    ) STRICT;
                    CREATE TABLE commit_attestations (
                        project_id TEXT NOT NULL REFERENCES canonical_projects(project_id),
                        revision_hash TEXT NOT NULL,
                        attestation_key_id TEXT NOT NULL,
                        authorization_key_id TEXT NOT NULL,
                        authorization_digest TEXT NOT NULL,
                        authorization_nonce TEXT NOT NULL,
                        approval_digest TEXT NOT NULL,
                        body TEXT NOT NULL,
                        body_hash TEXT NOT NULL,
                        PRIMARY KEY (project_id, revision_hash),
                        UNIQUE (authorization_key_id, authorization_digest),
                        UNIQUE (authorization_key_id, authorization_nonce),
                        UNIQUE (approval_digest)
                    ) STRICT;
                    CREATE INDEX design_transactions_by_base
                        ON design_transactions(project_id, base_revision, transaction_id);
                    CREATE INDEX approval_evidence_by_transaction
                        ON approval_evidence(project_id, transaction_id, approval_id);
                    CREATE INDEX commit_attestations_by_approval
                        ON commit_attestations(project_id, approval_digest, revision_hash);
                    CREATE TRIGGER design_revisions_no_update
                        BEFORE UPDATE ON design_revisions BEGIN
                            SELECT RAISE(ABORT, 'design revisions are immutable');
                        END;
                    CREATE TRIGGER design_revisions_no_delete
                        BEFORE DELETE ON design_revisions BEGIN
                            SELECT RAISE(ABORT, 'design revisions are append-only');
                        END;
                    CREATE TRIGGER approval_evidence_no_update
                        BEFORE UPDATE ON approval_evidence BEGIN
                            SELECT RAISE(ABORT, 'approval evidence is immutable');
                        END;
                    CREATE TRIGGER approval_evidence_no_delete
                        BEFORE DELETE ON approval_evidence BEGIN
                            SELECT RAISE(ABORT, 'approval evidence is append-only');
                    END;
                    CREATE TRIGGER commit_attestations_no_update
                        BEFORE UPDATE ON commit_attestations BEGIN
                            SELECT RAISE(ABORT, 'commit attestations are immutable');
                        END;
                    CREATE TRIGGER commit_attestations_no_delete
                        BEFORE DELETE ON commit_attestations BEGIN
                            SELECT RAISE(ABORT, 'commit attestations are append-only');
                        END;
                    CREATE TRIGGER design_transactions_terminal_no_update
                        BEFORE UPDATE ON design_transactions
                        WHEN OLD.state IN ('committed', 'rolled_back') BEGIN
                            SELECT RAISE(ABORT, 'terminal transactions are immutable');
                        END;
                    CREATE TRIGGER design_transactions_no_delete
                        BEFORE DELETE ON design_transactions BEGIN
                            SELECT RAISE(ABORT, 'transaction history is append-only');
                        END;
                    """
                )
            elif user_version == 0:
                raise UnsupportedStoreSchema("partial or unversioned project-store schema")

            user_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
            application_id = int(self._connection.execute("PRAGMA application_id").fetchone()[0])
            if user_version != STORE_SCHEMA_VERSION or application_id != _APPLICATION_ID:
                raise UnsupportedStoreSchema(
                    f"unsupported project-store database schema {user_version}"
                )
            row = self._connection.execute(
                """SELECT schema_name, schema_version, document_version
                   FROM project_store_meta WHERE singleton = 1"""
            ).fetchone()
            if row is None or tuple(row) != (
                "flux-clone-project-store",
                STORE_SCHEMA_VERSION,
                DOCUMENT_VERSION,
            ):
                raise UnsupportedStoreSchema("project-store metadata is missing or incompatible")
            actual_owned = {
                row[0]
                for row in self._connection.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                )
            }
            if not owned <= actual_owned:
                raise UnsupportedStoreSchema("project-store schema is incomplete")

    @staticmethod
    def _record_hash(
        *,
        project_id: str,
        sequence: int,
        revision_hash: str,
        body_hash: str,
        previous_record_hash: str,
    ) -> str:
        return stable_hash(
            {
                "body_hash": body_hash,
                "previous_record_hash": previous_record_hash,
                "project_id": project_id,
                "revision_hash": revision_hash,
                "sequence": sequence,
            },
            domain="flux-clone-project-store-revision-record-v1",
        )

    def _head_anchor_state_locked(
        self,
        revision: DesignRevision,
    ) -> ProjectHeadAnchorState:
        if revision.sequence == 0:
            attestation_digest = GENESIS_ATTESTATION_DIGEST
        else:
            row = self._connection.execute(
                """SELECT body_hash FROM commit_attestations
                   WHERE project_id = ? AND revision_hash = ?""",
                (revision.graph.project_id, revision.revision_hash),
            ).fetchone()
            if row is None:
                raise IntegrityError("durable project head has no commit attestation")
            attestation_digest = row["body_hash"]
        return ProjectHeadAnchorState(
            project_id=revision.graph.project_id,
            sequence=revision.sequence,
            revision_hash=revision.revision_hash,
            attestation_digest=attestation_digest,
        )

    def _assert_head_anchor_locked(
        self,
        revision: DesignRevision,
    ) -> ProjectHeadAnchorState:
        expected = self._head_anchor_state_locked(revision)
        observed = self._project_head_anchor.read(expected.project_id)
        if observed != expected:
            raise IntegrityError(
                "durable project database head conflicts with its external monotonic anchor"
            )
        return expected

    @staticmethod
    def _encode_revision(revision: DesignRevision) -> tuple[str, str]:
        body, digest = encode_document("design-revision", revision_payload(revision))
        decoded = revision_from_payload(decode_document(body, expected_kind="design-revision"))
        if decoded != revision:
            raise IntegrityError("revision does not survive its canonical codec exactly")
        return body, digest

    @staticmethod
    def _encode_transaction(transaction: DesignTransaction) -> tuple[str, str]:
        body, digest = encode_document("design-transaction", transaction_payload(transaction))
        decoded = transaction_from_payload(
            decode_document(body, expected_kind="design-transaction")
        )
        if decoded != transaction:
            raise IntegrityError("transaction does not survive its canonical codec exactly")
        return body, digest

    @staticmethod
    def _encode_approval(approval: ApprovalEvidence) -> tuple[str, str]:
        body, digest = encode_document("approval-evidence", approval_payload(approval))
        decoded = approval_from_payload(decode_document(body, expected_kind="approval-evidence"))
        if decoded != approval:
            raise IntegrityError("approval does not survive its canonical codec exactly")
        return body, digest

    @staticmethod
    def _encode_attestation(
        attestation: DurableCommitAttestation,
    ) -> tuple[str, str]:
        body, digest = encode_document(
            "durable-commit-attestation",
            attestation_payload(attestation),
        )
        decoded = attestation_from_payload(
            decode_document(body, expected_kind="durable-commit-attestation")
        )
        if decoded != attestation:
            raise IntegrityError("attestation does not survive its canonical codec exactly")
        return body, digest

    @staticmethod
    def _release_subject_digest(
        *,
        base_revision: str,
        preview_digest: str,
        report_hash: str,
    ) -> str:
        return stable_hash(
            {
                "base_revision": base_revision,
                "preview_digest": preview_digest,
                "report_hash": report_hash,
            },
            domain="flux-clone-release-v1",
        )

    @classmethod
    def _validate_approval_subject(
        cls,
        approval: ApprovalEvidence,
        *,
        base_revision: str,
    ) -> None:
        expected_release_subject = cls._release_subject_digest(
            base_revision=base_revision,
            preview_digest=approval.preview_digest,
            report_hash=approval.verification_report_hash,
        )
        if approval.release_subject_digest != expected_release_subject:
            raise IntegrityError(
                "approval release subject does not bind the exact base, preview, and report"
            )

    @classmethod
    def _validate_approval_binding(
        cls,
        approval: ApprovalEvidence,
        transaction: DesignTransaction,
    ) -> None:
        if approval.transaction_id != transaction.transaction_id:
            raise IntegrityError("approval evidence references a different transaction")
        if approval.preview_digest != transaction.preview_digest:
            raise IntegrityError(
                "approval does not bind the transaction's exact current preview"
            )
        if approval.verification_report_hash != transaction.verification_report_hash:
            raise IntegrityError(
                "approval verification report does not bind the transaction's exact report"
            )
        cls._validate_approval_subject(
            approval,
            base_revision=transaction.base_revision,
        )

    def _validate_attestation_binding(
        self,
        attestation: DurableCommitAttestation,
        revision: DesignRevision,
        transaction: DesignTransaction,
        approval: ApprovalEvidence,
    ) -> None:
        """Verify a public-key proof and every binding reproducible from durable state."""

        self._attestation_keyring.verify(attestation)
        command_hashes = tuple(command.command_hash for command in transaction.commands)
        expected_release_subject = self._release_subject_digest(
            base_revision=transaction.base_revision,
            preview_digest=transaction.preview_digest,
            report_hash=transaction.verification_report_hash or "",
        )
        checks = (
            attestation.project_id == revision.graph.project_id,
            attestation.base_revision == transaction.base_revision,
            attestation.head_revision == transaction.base_revision,
            attestation.parent_revision == revision.parent_revision,
            attestation.parent_revision == transaction.base_revision,
            attestation.revision_hash == revision.revision_hash,
            attestation.revision_hash == transaction.committed_revision_hash,
            attestation.sequence == revision.sequence,
            attestation.transaction_id == transaction.transaction_id,
            attestation.command_hashes == command_hashes,
            attestation.command_hashes_digest
            == commit_command_hashes_digest(command_hashes),
            attestation.preview_digest == transaction.preview_digest,
            attestation.preview_digest == revision.approval_preview_digest,
            attestation.verified_preview_digest
            == transaction.verification_preview_digest,
            attestation.verified_preview_digest == transaction.preview_digest,
            attestation.prospective_graph_sha256 == transaction.staged_graph.graph_hash,
            attestation.prospective_graph_sha256 == revision.graph_hash,
            attestation.verification_report_hash
            == transaction.verification_report_hash,
            attestation.verification_report_hash
            == revision.verification_report_hash,
            attestation.commit_gate_passed is transaction.commit_gate_passed is True,
            attestation.release_subject_digest == expected_release_subject,
            attestation.release_subject_digest == approval.release_subject_digest,
            attestation.approval_id == approval.approval_id,
            attestation.approval_digest == approval.approval_digest,
            attestation.approval_principal == approval.actor,
            attestation.approval_decided_at == approval.decided_at,
            approval.transaction_id == transaction.transaction_id,
            approval.preview_digest == transaction.preview_digest,
            approval.verification_report_hash == transaction.verification_report_hash,
            approval.decision is ApprovalDecision.APPROVED,
        )
        if not all(checks):
            raise IntegrityError(
                "durable commit attestation does not bind the exact revision, "
                "transaction, and approval"
            )

    @staticmethod
    def _validate_transaction_transition(
        previous: DesignTransaction,
        current: DesignTransaction,
    ) -> None:
        if (
            current.transaction_id != previous.transaction_id
            or current.base_revision != previous.base_revision
        ):
            raise IntegrityError("a transaction ID and base revision are immutable")
        if previous.state in {TransactionState.COMMITTED, TransactionState.ROLLED_BACK}:
            raise ConcurrencyConflict("terminal transaction snapshots are immutable")

        previous_commands = previous.commands
        current_commands = current.commands
        if (
            len(current_commands) < len(previous_commands)
            or current_commands[: len(previous_commands)] != previous_commands
        ):
            raise IntegrityError("transaction command history must be append-only")

        if current.state is TransactionState.COMMITTED:
            if previous.state is not TransactionState.VERIFIED:
                raise IntegrityError("only a verified transaction may become committed")
            if (
                replace(
                    current,
                    state=TransactionState.VERIFIED,
                    committed_revision_hash=None,
                )
                != previous
            ):
                raise IntegrityError(
                    "commit cannot change the verified transaction subject or evidence"
                )
            return

        if previous.state is TransactionState.VERIFIED:
            if current.state is TransactionState.VERIFIED:
                if current != previous:
                    raise IntegrityError("verified transaction evidence is immutable")
                return
            if current.state is not TransactionState.ROLLED_BACK:
                raise IntegrityError("verified transactions may only commit or roll back")
            if current_commands != previous_commands:
                raise IntegrityError("verified transactions cannot gain commands")
            return

        if current.state not in {
            TransactionState.OPEN,
            TransactionState.VERIFIED,
            TransactionState.ROLLED_BACK,
        }:
            raise IntegrityError("open transaction has an invalid durable state transition")

    def _project_row(self, project_id: str) -> sqlite3.Row:
        row = self._connection.execute(
            """SELECT project_id, head_revision, head_sequence, generation
               FROM canonical_projects WHERE project_id = ?""",
            (project_id,),
        ).fetchone()
        if row is None:
            raise ProjectNotFound(f"project {project_id} not found")
        return row

    def create_project(self, genesis: DesignRevision) -> None:
        if genesis.sequence != 0 or genesis.parent_revision is not None:
            raise IntegrityError("a new project requires an exact genesis revision")
        if genesis.revision_hash != revision_hash_for(genesis):
            raise IntegrityError("genesis revision hash is invalid")
        project_id = genesis.graph.project_id
        body, digest = self._encode_revision(genesis)
        record_hash = self._record_hash(
            project_id=project_id,
            sequence=0,
            revision_hash=genesis.revision_hash,
            body_hash=digest,
            previous_record_hash="",
        )
        genesis_anchor = ProjectHeadAnchorState(
            project_id=project_id,
            sequence=0,
            revision_hash=genesis.revision_hash,
            attestation_digest=GENESIS_ATTESTATION_DIGEST,
        )

        # Never bless a pre-existing database whose external trust root is
        # missing. Exact idempotence is available only when both sides already
        # contain the same genesis checkpoint.
        with self._transaction(write=False):
            existing = self._connection.execute(
                "SELECT 1 FROM canonical_projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if existing is not None:
                revisions = self._load_revisions_locked(project_id)
                if revisions != (genesis,):
                    raise ProjectAlreadyExists(
                        f"project {project_id} already exists with different state"
                    )
        if existing is not None:
            if self._project_head_anchor.read(project_id) != genesis_anchor:
                raise IntegrityError(
                    "existing project genesis lacks its exact external anchor"
                )
            return

        # Anchor-first makes every post-anchor failure retryable without ever
        # exposing a durable database project that has no trust root.
        self._project_head_anchor.initialize(genesis_anchor)
        try:
            with self._transaction(write=True):
                try:
                    self._connection.execute(
                        """INSERT INTO canonical_projects(
                            project_id, head_revision, head_sequence, generation
                        ) VALUES (?, ?, 0, 0)""",
                        (project_id, genesis.revision_hash),
                    )
                    self._connection.execute(
                        """INSERT INTO design_revisions(
                            project_id, sequence, revision_hash, parent_revision, graph_hash,
                            previous_record_hash, record_hash, body, body_hash
                        ) VALUES (?, 0, ?, NULL, ?, '', ?, ?, ?)""",
                        (
                            project_id,
                            genesis.revision_hash,
                            genesis.graph_hash,
                            record_hash,
                            body,
                            digest,
                        ),
                    )
                except sqlite3.IntegrityError as exc:
                    raise ProjectAlreadyExists(
                        f"project {project_id} already exists"
                    ) from exc
        except ProjectAlreadyExists as exc:
            # A same-genesis creator may have won between the absence check and
            # INSERT. Only the exact fully anchored state is idempotent.
            with self._transaction(write=False):
                revisions = self._load_revisions_locked(project_id)
            if revisions == (genesis,) and (
                self._project_head_anchor.read(project_id) == genesis_anchor
            ):
                return
            raise ProjectAlreadyExists(
                f"project {project_id} already exists with different state"
            ) from exc

    def _load_revisions_locked(self, project_id: str) -> tuple[DesignRevision, ...]:
        project = self._project_row(project_id)
        rows = self._connection.execute(
            """SELECT sequence, revision_hash, parent_revision, graph_hash,
                      previous_record_hash, record_hash, body, body_hash
               FROM design_revisions WHERE project_id = ? ORDER BY sequence""",
            (project_id,),
        ).fetchall()
        if not rows:
            raise IntegrityError("project has no genesis revision")
        revisions: list[DesignRevision] = []
        previous_revision: str | None = None
        previous_record_hash = ""
        for expected_sequence, row in enumerate(rows):
            body = row["body"]
            digest = body_sha256(body)
            if digest != row["body_hash"]:
                raise IntegrityError(
                    f"revision body digest mismatch at sequence {expected_sequence}"
                )
            payload = decode_document(body, expected_kind="design-revision")
            revision = revision_from_payload(payload)
            if (
                row["sequence"] != expected_sequence
                or revision.sequence != expected_sequence
                or row["revision_hash"] != revision.revision_hash
                or row["parent_revision"] != revision.parent_revision
                or row["graph_hash"] != revision.graph_hash
                or revision.graph.project_id != project_id
            ):
                raise IntegrityError(
                    f"revision index/body mismatch at sequence {expected_sequence}"
                )
            if revision.parent_revision != previous_revision:
                raise IntegrityError(f"revision lineage mismatch at sequence {expected_sequence}")
            expected_record_hash = self._record_hash(
                project_id=project_id,
                sequence=expected_sequence,
                revision_hash=revision.revision_hash,
                body_hash=digest,
                previous_record_hash=previous_record_hash,
            )
            if (
                row["previous_record_hash"] != previous_record_hash
                or row["record_hash"] != expected_record_hash
            ):
                raise IntegrityError(
                    f"revision record chain mismatch at sequence {expected_sequence}"
                )
            revisions.append(revision)
            previous_revision = revision.revision_hash
            previous_record_hash = expected_record_hash
        head = revisions[-1]
        if (
            project["project_id"] != project_id
            or project["head_revision"] != head.revision_hash
            or project["head_sequence"] != head.sequence
            or project["generation"] != head.sequence
        ):
            raise IntegrityError("project head index does not match immutable revision history")
        return tuple(revisions)

    def list_revisions(self, project_id: str) -> tuple[DesignRevision, ...]:
        return self.restore(project_id).revisions

    def get_head(self, project_id: str) -> DesignRevision:
        return self.list_revisions(project_id)[-1]

    def get_revision(self, project_id: str, revision_hash: str) -> DesignRevision:
        for revision in self.list_revisions(project_id):
            if revision.revision_hash == revision_hash:
                return revision
        raise ProjectNotFound(f"revision {revision_hash} not found in project {project_id}")

    @staticmethod
    def _validate_transaction(
        transaction: DesignTransaction,
        base: DesignRevision,
        committed_revision: DesignRevision | None = None,
    ) -> None:
        if transaction.base_revision != base.revision_hash:
            raise IntegrityError("transaction base revision is not its declared durable base")
        if transaction.staged_graph.project_id != base.graph.project_id:
            raise IntegrityError("transaction staged graph belongs to another project")
        kernel = DesignKernel.from_revision(base)
        replayed = kernel.begin_transaction(
            transaction.transaction_id,
            base_revision=transaction.base_revision,
        )
        for command in transaction.commands:
            replayed = kernel.stage(command)
        if transaction.verification_report_hash is not None and transaction.state in {
            TransactionState.OPEN,
            TransactionState.VERIFIED,
            TransactionState.COMMITTED,
        }:
            replayed = kernel.record_verification(
                transaction.transaction_id,
                verification_report_hash=transaction.verification_report_hash,
                commit_gate_passed=transaction.commit_gate_passed,
                verified_preview_digest=transaction.verification_preview_digest,
            )
        if transaction.state is TransactionState.ROLLED_BACK:
            replayed = kernel.rollback(transaction.transaction_id)
        elif transaction.state is TransactionState.COMMITTED:
            if committed_revision is None or committed_revision.approval_preview_digest is None:
                raise IntegrityError(
                    "committed transaction requires its durable committed revision"
                )
            if (
                replayed.state is not TransactionState.VERIFIED
                or not replayed.commit_gate_passed
                or replayed.verification_report_hash is None
                or replayed.verification_preview_digest != replayed.preview_digest
                or not replayed.commands
                or replayed.staged_graph.graph_hash == base.graph_hash
            ):
                raise IntegrityError(
                    "durable committed transaction was not exactly verified and committable"
                )
            command_hashes = tuple(
                command.command_hash for command in replayed.commands
            )
            graph = replayed.staged_graph.normalized()
            revision_hash = stable_hash(
                {
                    "parent": base.revision_hash,
                    "sequence": base.sequence + 1,
                    "graph_hash": graph.graph_hash,
                    "commands": command_hashes,
                    "verification_report_hash": replayed.verification_report_hash,
                    "approval_preview_digest": (
                        committed_revision.approval_preview_digest
                    ),
                },
                domain="flux-clone-design-revision-v1",
            )
            generated = DesignRevision(
                revision_hash=revision_hash,
                parent_revision=base.revision_hash,
                sequence=base.sequence + 1,
                graph=graph,
                graph_hash=graph.graph_hash,
                command_hashes=command_hashes,
                verification_report_hash=replayed.verification_report_hash,
                approval_preview_digest=(
                    committed_revision.approval_preview_digest
                ),
            )
            if generated != committed_revision:
                raise IntegrityError("transaction replay does not reproduce its committed revision")
            # Repository restore only validates an already durable terminal
            # snapshot.  It never calls the live commit-authority boundary and
            # cannot publish or authorize a new head.
            replayed = replace(
                replayed,
                state=TransactionState.COMMITTED,
                committed_revision_hash=generated.revision_hash,
            )
        if replayed != transaction:
            raise IntegrityError("transaction snapshot does not reproduce by deterministic replay")

    @staticmethod
    def _decode_transaction_row(row: sqlite3.Row) -> StoredTransaction:
        body = row["body"]
        if body_sha256(body) != row["body_hash"]:
            raise IntegrityError(f"transaction {row['transaction_id']} body digest mismatch")
        transaction = transaction_from_payload(
            decode_document(body, expected_kind="design-transaction")
        )
        if (
            transaction.transaction_id != row["transaction_id"]
            or transaction.base_revision != row["base_revision"]
            or transaction.state.value != row["state"]
            or transaction.preview_digest != row["preview_digest"]
        ):
            raise IntegrityError(
                f"transaction {transaction.transaction_id} index/body mismatch"
            )
        generation = row["generation"]
        if not isinstance(generation, int) or generation < 0:
            raise IntegrityError("transaction generation is invalid")
        return StoredTransaction(transaction, generation)

    def save_transaction(
        self,
        project_id: str,
        transaction: DesignTransaction,
        *,
        expected_generation: int | None,
    ) -> StoredTransaction:
        if transaction.state is TransactionState.COMMITTED:
            raise IntegrityError(
                "committed transactions must be saved atomically with append_revision"
            )
        body, digest = self._encode_transaction(transaction)
        self.restore(project_id)
        with self._transaction(write=True):
            revisions = self._load_revisions_locked(project_id)
            self._assert_head_anchor_locked(revisions[-1])
            by_hash = {revision.revision_hash: revision for revision in revisions}
            base = by_hash.get(transaction.base_revision)
            if base is None:
                raise IntegrityError("transaction references an unknown project revision")
            if (
                transaction.state in {TransactionState.OPEN, TransactionState.VERIFIED}
                and base != revisions[-1]
            ):
                raise ConcurrencyConflict("active transaction is not based on the current head")
            self._validate_transaction(transaction, base)
            existing = self._connection.execute(
                """SELECT transaction_id, base_revision, state, preview_digest,
                          generation, body, body_hash FROM design_transactions
                   WHERE project_id = ? AND transaction_id = ?""",
                (project_id, transaction.transaction_id),
            ).fetchone()
            if expected_generation is None:
                if existing is not None:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} already exists"
                    )
                generation = 0
                self._connection.execute(
                    """INSERT INTO design_transactions(
                        project_id, transaction_id, base_revision, state, preview_digest,
                        generation, body, body_hash
                    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)""",
                    (
                        project_id,
                        transaction.transaction_id,
                        transaction.base_revision,
                        transaction.state.value,
                        transaction.preview_digest,
                        body,
                        digest,
                    ),
                )
            else:
                if (
                    type(expected_generation) is not int
                    or expected_generation < 0
                ):
                    raise ValueError("expected_generation must be a non-negative integer or null")
                if existing is None:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} does not exist"
                    )
                stored = self._decode_transaction_row(existing)
                if stored.generation != expected_generation:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} is not at generation "
                        f"{expected_generation}"
                    )
                self._validate_transaction_transition(stored.transaction, transaction)
                generation = expected_generation + 1
                cursor = self._connection.execute(
                    """UPDATE design_transactions SET
                        state = ?, preview_digest = ?, generation = ?,
                        body = ?, body_hash = ?
                    WHERE project_id = ? AND transaction_id = ? AND generation = ?
                        AND base_revision = ?""",
                    (
                        transaction.state.value,
                        transaction.preview_digest,
                        generation,
                        body,
                        digest,
                        project_id,
                        transaction.transaction_id,
                        expected_generation,
                        transaction.base_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} is not at generation "
                        f"{expected_generation}"
                    )
            return StoredTransaction(transaction, generation)

    def _load_transactions_locked(
        self,
        project_id: str,
        revisions: tuple[DesignRevision, ...],
    ) -> tuple[StoredTransaction, ...]:
        by_hash = {revision.revision_hash: revision for revision in revisions}
        rows = self._connection.execute(
            """SELECT transaction_id, base_revision, state, preview_digest,
                      generation, body, body_hash
               FROM design_transactions WHERE project_id = ? ORDER BY transaction_id""",
            (project_id,),
        ).fetchall()
        result: list[StoredTransaction] = []
        for row in rows:
            stored = self._decode_transaction_row(row)
            transaction = stored.transaction
            base = by_hash.get(transaction.base_revision)
            if base is None:
                raise IntegrityError("transaction references a missing revision")
            committed = (
                by_hash.get(transaction.committed_revision_hash)
                if transaction.committed_revision_hash is not None
                else None
            )
            self._validate_transaction(transaction, base, committed)
            result.append(stored)
        return tuple(result)

    def get_transaction(self, project_id: str, transaction_id: str) -> StoredTransaction:
        for stored in self.restore(project_id).transactions:
            if stored.transaction.transaction_id == transaction_id:
                return stored
        raise ProjectNotFound(f"transaction {transaction_id} not found in project {project_id}")

    def record_approval(self, project_id: str, approval: ApprovalEvidence) -> None:
        body, digest = self._encode_approval(approval)
        self.restore(project_id)
        with self._transaction(write=True):
            revisions = self._load_revisions_locked(project_id)
            self._assert_head_anchor_locked(revisions[-1])
            transactions = self._load_transactions_locked(project_id, revisions)
            matching = tuple(
                stored.transaction
                for stored in transactions
                if stored.transaction.transaction_id == approval.transaction_id
            )
            if not matching:
                raise IntegrityError("approval references an unknown transaction")
            self._validate_approval_binding(approval, matching[0])
            try:
                self._connection.execute(
                    """INSERT INTO approval_evidence(
                        project_id, approval_id, approval_digest,
                        transaction_id, preview_digest,
                        release_subject_digest, verification_report_hash,
                        decision, body, body_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        project_id,
                        approval.approval_id,
                        approval.approval_digest,
                        approval.transaction_id,
                        approval.preview_digest,
                        approval.release_subject_digest,
                        approval.verification_report_hash,
                        approval.decision.value,
                        body,
                        digest,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise ProjectStoreError(f"approval {approval.approval_id} already exists") from exc

    def _load_approvals_locked(self, project_id: str) -> tuple[ApprovalEvidence, ...]:
        rows = self._connection.execute(
            """SELECT approval_id, approval_digest, transaction_id, preview_digest,
                      release_subject_digest, verification_report_hash,
                      decision, body, body_hash
               FROM approval_evidence WHERE project_id = ? ORDER BY approval_id""",
            (project_id,),
        ).fetchall()
        approvals: list[ApprovalEvidence] = []
        for row in rows:
            body = row["body"]
            if body_sha256(body) != row["body_hash"]:
                raise IntegrityError(f"approval {row['approval_id']} body digest mismatch")
            approval = approval_from_payload(
                decode_document(body, expected_kind="approval-evidence")
            )
            if (
                approval.approval_id != row["approval_id"]
                or approval.approval_digest != row["approval_digest"]
                or approval.transaction_id != row["transaction_id"]
                or approval.preview_digest != row["preview_digest"]
                or approval.release_subject_digest != row["release_subject_digest"]
                or approval.verification_report_hash != row["verification_report_hash"]
                or approval.decision.value != row["decision"]
            ):
                raise IntegrityError(f"approval {approval.approval_id} index/body mismatch")
            approvals.append(approval)
        return tuple(approvals)

    def _load_attestations_locked(
        self,
        project_id: str,
        revisions: tuple[DesignRevision, ...],
        transactions: tuple[StoredTransaction, ...],
        approvals: tuple[ApprovalEvidence, ...],
    ) -> tuple[DurableCommitAttestation, ...]:
        rows = self._connection.execute(
            """SELECT revision_hash, attestation_key_id, authorization_key_id,
                      authorization_digest, authorization_nonce, approval_digest,
                      body, body_hash
               FROM commit_attestations
               WHERE project_id = ? ORDER BY revision_hash""",
            (project_id,),
        ).fetchall()
        revisions_by_hash = {revision.revision_hash: revision for revision in revisions}
        transactions_by_revision = {
            stored.transaction.committed_revision_hash: stored.transaction
            for stored in transactions
            if stored.transaction.state is TransactionState.COMMITTED
        }
        approvals_by_id = {approval.approval_id: approval for approval in approvals}
        by_revision: dict[str, DurableCommitAttestation] = {}
        for row in rows:
            body = row["body"]
            if body_sha256(body) != row["body_hash"]:
                raise IntegrityError(
                    f"attestation for revision {row['revision_hash']} body digest mismatch"
                )
            attestation = attestation_from_payload(
                decode_document(body, expected_kind="durable-commit-attestation")
            )
            if (
                attestation.project_id != project_id
                or attestation.revision_hash != row["revision_hash"]
                or attestation.attestation_key_id != row["attestation_key_id"]
                or attestation.authorization_key_id != row["authorization_key_id"]
                or attestation.authorization_digest != row["authorization_digest"]
                or attestation.authorization_nonce != row["authorization_nonce"]
                or attestation.approval_digest != row["approval_digest"]
            ):
                raise IntegrityError(
                    f"attestation for revision {attestation.revision_hash} index/body mismatch"
                )
            revision = revisions_by_hash.get(attestation.revision_hash)
            transaction = transactions_by_revision.get(attestation.revision_hash)
            approval = approvals_by_id.get(attestation.approval_id)
            if revision is None or revision.sequence == 0:
                raise IntegrityError("attestation references a missing or genesis revision")
            if transaction is None:
                raise IntegrityError("attestation references a missing committed transaction")
            if approval is None:
                raise IntegrityError("attestation references missing approval evidence")
            self._validate_attestation_binding(
                attestation,
                revision,
                transaction,
                approval,
            )
            if attestation.revision_hash in by_revision:
                raise IntegrityError("revision has multiple durable commit attestations")
            by_revision[attestation.revision_hash] = attestation
        expected_hashes = {revision.revision_hash for revision in revisions[1:]}
        if set(by_revision) != expected_hashes:
            raise IntegrityError(
                "every non-genesis revision requires exactly one durable commit attestation"
            )
        return tuple(by_revision[revision.revision_hash] for revision in revisions[1:])

    def _reconcile_head_anchor_locked(
        self,
        revisions: tuple[DesignRevision, ...],
        attestations: tuple[DurableCommitAttestation, ...],
    ) -> None:
        """Recover only a stale anchor over a fully verified signed successor chain."""

        head = revisions[-1]
        observed = self._project_head_anchor.read(head.graph.project_id)
        if observed is None:
            raise IntegrityError("external project head anchor is missing")
        if observed.sequence > head.sequence:
            raise _AnchorAheadOfSnapshot

        def expected_anchor(sequence: int) -> ProjectHeadAnchorState:
            if sequence == 0:
                attestation_digest = GENESIS_ATTESTATION_DIGEST
            else:
                _, attestation_digest = self._encode_attestation(
                    attestations[sequence - 1]
                )
            return ProjectHeadAnchorState(
                project_id=head.graph.project_id,
                sequence=sequence,
                revision_hash=revisions[sequence].revision_hash,
                attestation_digest=attestation_digest,
            )

        if observed != expected_anchor(observed.sequence):
            raise IntegrityError(
                "external project head anchor contradicts the database revision chain"
            )
        previous = observed
        sequence = observed.sequence + 1
        while sequence <= head.sequence:
            current = expected_anchor(sequence)
            try:
                self._project_head_anchor.compare_and_set(previous, current)
            except IntegrityError as exc:
                raced = self._project_head_anchor.read(head.graph.project_id)
                if raced is None:
                    raise IntegrityError(
                        "external project head anchor disappeared"
                    ) from exc
                if raced.sequence > head.sequence:
                    raise _AnchorAheadOfSnapshot from exc
                if raced == previous:
                    raise
                if raced.sequence < previous.sequence or raced != expected_anchor(
                    raced.sequence
                ):
                    raise IntegrityError(
                        "external project head anchor contradicts the database revision chain"
                    ) from exc
                previous = raced
                sequence = raced.sequence + 1
                continue
            previous = current
            sequence += 1
        final = self._project_head_anchor.read(head.graph.project_id)
        if final is not None and final.sequence > head.sequence:
            raise _AnchorAheadOfSnapshot
        if final != previous:
            raise IntegrityError("external project head anchor did not reach the verified head")

    def append_revision(
        self,
        project_id: str,
        revision: DesignRevision,
        *,
        expected_head: str,
        transaction: DesignTransaction,
        approval: ApprovalEvidence,
        attestation: DurableCommitAttestation,
        expected_transaction_generation: int | None,
    ) -> None:
        if revision.sequence == 0:
            raise IntegrityError("append_revision cannot append another genesis")
        if revision.revision_hash != revision_hash_for(revision):
            raise IntegrityError("revision hash is invalid")
        if transaction.state is not TransactionState.COMMITTED:
            raise IntegrityError("a committed revision requires a committed transaction snapshot")
        if approval.decision is not ApprovalDecision.APPROVED:
            raise IntegrityError("a committed revision requires affirmative approval evidence")
        revision_body, revision_digest = self._encode_revision(revision)
        transaction_body, transaction_digest = self._encode_transaction(transaction)
        approval_body, approval_digest = self._encode_approval(approval)
        attestation_body, attestation_digest = self._encode_attestation(attestation)
        self._validate_attestation_binding(attestation, revision, transaction, approval)
        verified_state = self.restore(project_id)
        if verified_state.head_revision.revision_hash != expected_head:
            raise ConcurrencyConflict(
                "project head changed before the verified revision append"
            )
        expected_anchor: ProjectHeadAnchorState
        current_anchor: ProjectHeadAnchorState
        with self._transaction(write=True):
            revisions = self._load_revisions_locked(project_id)
            head = revisions[-1]
            if head.revision_hash != expected_head:
                raise ConcurrencyConflict(
                    "project head changed after the verified append preflight"
                )
            expected_anchor = self._assert_head_anchor_locked(head)
            if (
                revision.graph.project_id != project_id
                or revision.parent_revision != head.revision_hash
                or revision.sequence != head.sequence + 1
            ):
                raise IntegrityError("revision does not extend the exact durable project head")
            if (
                transaction.base_revision != head.revision_hash
                or transaction.committed_revision_hash != revision.revision_hash
                or transaction.staged_graph != revision.graph
                or tuple(command.command_hash for command in transaction.commands)
                != revision.command_hashes
                or transaction.verification_report_hash != revision.verification_report_hash
            ):
                raise IntegrityError(
                    "committed transaction evidence does not reproduce the revision"
                )
            if (
                approval.preview_digest != revision.approval_preview_digest
                or approval.verification_report_hash != revision.verification_report_hash
            ):
                raise IntegrityError(
                    "approval evidence does not bind the committed preview and report"
                )
            self._validate_approval_binding(approval, transaction)
            self._validate_transaction(transaction, head, revision)

            existing_transaction = self._connection.execute(
                """SELECT transaction_id, base_revision, state, preview_digest,
                          generation, body, body_hash FROM design_transactions
                   WHERE project_id = ? AND transaction_id = ?""",
                (project_id, transaction.transaction_id),
            ).fetchone()
            if expected_transaction_generation is None:
                if existing_transaction is not None:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} already exists"
                    )
                next_generation = 0
                self._connection.execute(
                    """INSERT INTO design_transactions(
                        project_id, transaction_id, base_revision, state, preview_digest,
                        generation, body, body_hash
                    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)""",
                    (
                        project_id,
                        transaction.transaction_id,
                        transaction.base_revision,
                        transaction.state.value,
                        transaction.preview_digest,
                        transaction_body,
                        transaction_digest,
                    ),
                )
            else:
                if (
                    type(expected_transaction_generation) is not int
                    or expected_transaction_generation < 0
                ):
                    raise ValueError("expected_transaction_generation must be non-negative or null")
                if existing_transaction is None:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} does not exist"
                    )
                stored = self._decode_transaction_row(existing_transaction)
                if stored.generation != expected_transaction_generation:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} is not at generation "
                        f"{expected_transaction_generation}"
                    )
                self._validate_transaction_transition(stored.transaction, transaction)
                next_generation = expected_transaction_generation + 1
                cursor = self._connection.execute(
                    """UPDATE design_transactions SET state = ?, preview_digest = ?,
                        generation = ?, body = ?, body_hash = ?
                    WHERE project_id = ? AND transaction_id = ? AND generation = ?
                        AND base_revision = ?""",
                    (
                        transaction.state.value,
                        transaction.preview_digest,
                        next_generation,
                        transaction_body,
                        transaction_digest,
                        project_id,
                        transaction.transaction_id,
                        expected_transaction_generation,
                        transaction.base_revision,
                    ),
                )
                if cursor.rowcount != 1:
                    raise ConcurrencyConflict(
                        f"transaction {transaction.transaction_id} is not at generation "
                        f"{expected_transaction_generation}"
                    )

            existing_approval = self._connection.execute(
                """SELECT body, body_hash FROM approval_evidence
                   WHERE project_id = ? AND approval_id = ?""",
                (project_id, approval.approval_id),
            ).fetchone()
            if existing_approval is None:
                self._connection.execute(
                    """INSERT INTO approval_evidence(
                        project_id, approval_id, approval_digest,
                        transaction_id, preview_digest,
                        release_subject_digest, verification_report_hash,
                        decision, body, body_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        project_id,
                        approval.approval_id,
                        approval.approval_digest,
                        approval.transaction_id,
                        approval.preview_digest,
                        approval.release_subject_digest,
                        approval.verification_report_hash,
                        approval.decision.value,
                        approval_body,
                        approval_digest,
                    ),
                )
            elif (
                existing_approval["body"] != approval_body
                or existing_approval["body_hash"] != approval_digest
            ):
                raise IntegrityError("approval ID is already bound to different evidence")

            previous_record_row = self._connection.execute(
                """SELECT record_hash FROM design_revisions
                   WHERE project_id = ? AND revision_hash = ?""",
                (project_id, head.revision_hash),
            ).fetchone()
            if previous_record_row is None:
                raise IntegrityError("durable head revision record is missing")
            previous_record_hash = previous_record_row["record_hash"]
            record_hash = self._record_hash(
                project_id=project_id,
                sequence=revision.sequence,
                revision_hash=revision.revision_hash,
                body_hash=revision_digest,
                previous_record_hash=previous_record_hash,
            )
            self._connection.execute(
                """INSERT INTO design_revisions(
                    project_id, sequence, revision_hash, parent_revision, graph_hash,
                    previous_record_hash, record_hash, body, body_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project_id,
                    revision.sequence,
                    revision.revision_hash,
                    revision.parent_revision,
                    revision.graph_hash,
                    previous_record_hash,
                    record_hash,
                    revision_body,
                    revision_digest,
                ),
            )
            self._connection.execute(
                """INSERT INTO commit_attestations(
                    project_id, revision_hash, attestation_key_id,
                    authorization_key_id, authorization_digest,
                    authorization_nonce, approval_digest, body, body_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    project_id,
                    revision.revision_hash,
                    attestation.attestation_key_id,
                    attestation.authorization_key_id,
                    attestation.authorization_digest,
                    attestation.authorization_nonce,
                    attestation.approval_digest,
                    attestation_body,
                    attestation_digest,
                ),
            )
            cursor = self._connection.execute(
                """UPDATE canonical_projects
                   SET head_revision = ?, head_sequence = ?, generation = ?
                   WHERE project_id = ? AND head_revision = ? AND head_sequence = ?""",
                (
                    revision.revision_hash,
                    revision.sequence,
                    revision.sequence,
                    project_id,
                    expected_head,
                    head.sequence,
                ),
            )
            if cursor.rowcount != 1:
                raise ConcurrencyConflict("project head changed during atomic revision append")
            current_anchor = ProjectHeadAnchorState(
                project_id=project_id,
                sequence=revision.sequence,
                revision_hash=revision.revision_hash,
                attestation_digest=attestation_digest,
            )
        # SQLite and the external monotonic anchor cannot share a transaction.
        # Never report success before the CAS. A failure between these writes is
        # recovered only by verifying the complete signed successor chain.
        self._project_head_anchor.compare_and_set(expected_anchor, current_anchor)

    def _restore_snapshot_locked(self, project_id: str) -> ProjectState:
        revisions = self._load_revisions_locked(project_id)
        transactions = self._load_transactions_locked(project_id, revisions)
        approvals = self._load_approvals_locked(project_id)
        attestations = self._load_attestations_locked(
            project_id,
            revisions,
            transactions,
            approvals,
        )
        transactions_by_id = {
            stored.transaction.transaction_id: stored.transaction
            for stored in transactions
        }
        for approval in approvals:
            transaction = transactions_by_id.get(approval.transaction_id)
            if transaction is None:
                raise IntegrityError("approval evidence references a missing transaction")
            # Approval evidence is immutable history while an uncommitted
            # transaction may later be rolled back, which intentionally clears
            # its current verification fields. Committed revisions below still
            # require an exact approval-to-final-transaction binding.
            self._validate_approval_subject(
                approval,
                base_revision=transaction.base_revision,
            )
        for revision in revisions[1:]:
            matching_transactions = tuple(
                stored.transaction
                for stored in transactions
                if stored.transaction.state is TransactionState.COMMITTED
                and stored.transaction.committed_revision_hash == revision.revision_hash
            )
            if len(matching_transactions) != 1:
                raise IntegrityError(
                    "each committed revision requires exactly one durable transaction"
                )
            transaction = matching_transactions[0]
            matching_approvals = tuple(
                approval
                for approval in approvals
                if approval.transaction_id == transaction.transaction_id
                and approval.preview_digest == revision.approval_preview_digest
                and approval.verification_report_hash
                == revision.verification_report_hash
                and approval.decision is ApprovalDecision.APPROVED
            )
            if not matching_approvals:
                raise IntegrityError(
                    "each committed revision requires exact affirmative approval evidence"
                )
            for approval in matching_approvals:
                self._validate_approval_binding(approval, transaction)
        self._reconcile_head_anchor_locked(revisions, attestations)
        return ProjectState(
            project_id=project_id,
            head_revision=revisions[-1],
            revisions=revisions,
            transactions=transactions,
            approvals=approvals,
            attestations=attestations,
        )

    def restore(self, project_id: str) -> ProjectState:
        # An anchor can legitimately be one checkpoint ahead of a read snapshot:
        # DB commit precedes anchor CAS, while SQLite snapshots may have opened
        # before that commit. Retry once with a fresh snapshot; an anchor still
        # ahead then is persistent rollback/tamper and fails closed.
        for attempt in range(2):
            try:
                with self._transaction(write=False):
                    return self._restore_snapshot_locked(project_id)
            except _AnchorAheadOfSnapshot as exc:
                if attempt == 0:
                    continue
                raise IntegrityError(
                    "external project head anchor is persistently ahead of the database"
                ) from exc
        raise AssertionError("restore retry loop exhausted unexpectedly")
