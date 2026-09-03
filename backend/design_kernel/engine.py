"""Transaction executor for the canonical ECAD design graph."""

from __future__ import annotations

import hmac
from collections.abc import Iterable
from dataclasses import replace
from threading import RLock
from typing import Any, cast

from .commit_authority import (
    CommitAuthorization,
    ConsumedCommitAuthorization,
    HmacCommitVerifier,
    ReplayedCommitAuthorization,
    _VerifiedCommitClaims,
    commit_command_hashes_digest,
)
from .model import (
    CommandKind,
    Component,
    CopperZone,
    DesignCommand,
    DesignGraph,
    DesignRevision,
    DesignTransaction,
    FootprintHole,
    FootprintPad,
    FootprintPlacement,
    InvariantViolation,
    Net,
    PinDefinition,
    PinRef,
    PointNm,
    SchematicJunction,
    SchematicWire,
    SemanticDiff,
    Track,
    TransactionState,
    Via,
    stable_hash,
    validate_graph,
)


class KernelError(RuntimeError):
    pass


class StaleRevision(KernelError):
    pass


class CommandConflict(KernelError):
    pass


class ApprovalMismatch(KernelError):
    pass


class TransactionNotCommittable(KernelError):
    pass


class LockedObject(KernelError):
    pass


def _sha256(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise InvariantViolation(f"{label} must be a lowercase SHA-256 digest")
    return value


def _payload_keys(
    payload: dict[str, Any], *, required: frozenset[str], optional: frozenset[str] = frozenset()
) -> None:
    missing = sorted(required - payload.keys())
    unknown = sorted(payload.keys() - required - optional)
    if missing or unknown:
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if unknown:
            details.append(f"unknown: {', '.join(unknown)}")
        raise InvariantViolation(
            f"payload fields do not match command schema ({'; '.join(details)})"
        )


def _string(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise InvariantViolation(f"payload field {key} must be a non-empty string")
    return value


def _integer(payload: dict[str, Any], key: str) -> int:
    value = payload.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvariantViolation(f"payload field {key} must be an integer")
    return value


def _boolean(payload: dict[str, Any], key: str, default: bool = False) -> bool:
    value = payload.get(key, default)
    if not isinstance(value, bool):
        raise InvariantViolation(f"payload field {key} must be a boolean")
    return value


def _optional_string(payload: dict[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise InvariantViolation(f"payload field {key} must be null or a non-empty string")
    return value


def _string_tuple(payload: dict[str, Any], key: str) -> tuple[str, ...]:
    value = payload.get(key)
    if not isinstance(value, list) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise InvariantViolation(f"payload field {key} must be an array of non-empty strings")
    return tuple(value)


def _points(payload: dict[str, Any], key: str) -> tuple[PointNm, ...]:
    value = payload.get(key)
    if not isinstance(value, list):
        raise InvariantViolation(f"payload field {key} must be an array of [x_nm, y_nm]")
    points: list[PointNm] = []
    for raw_point in value:
        if (
            not isinstance(raw_point, list)
            or len(raw_point) != 2
            or not all(
                isinstance(coordinate, int) and not isinstance(coordinate, bool)
                for coordinate in raw_point
            )
        ):
            raise InvariantViolation(f"each {key} vertex must be [x_nm, y_nm]")
        points.append(PointNm(raw_point[0], raw_point[1]))
    return tuple(points)


_PAD_REQUIRED_FIELDS = frozenset(
    {
        "pad_id",
        "component_id",
        "pad_number",
        "center_x_nm",
        "center_y_nm",
        "size_x_nm",
        "size_y_nm",
        "shape",
        "rotation_udeg",
        "layers",
        "pad_drill_nm",
    }
)
_PAD_OPTIONAL_FIELDS = frozenset(
    {
        "net_id",
        "locked",
        "drill_x_nm",
        "drill_y_nm",
        "drill_rotation_udeg",
        "shared_land_group_id",
    }
)


def _footprint_pad(payload: dict[str, Any]) -> FootprintPad:
    _payload_keys(
        payload,
        required=_PAD_REQUIRED_FIELDS,
        optional=_PAD_OPTIONAL_FIELDS,
    )
    return FootprintPad(
        pad_id=_string(payload, "pad_id"),
        component_id=_string(payload, "component_id"),
        pad_number=_string(payload, "pad_number"),
        center=PointNm(
            _integer(payload, "center_x_nm"),
            _integer(payload, "center_y_nm"),
        ),
        size_x_nm=_integer(payload, "size_x_nm"),
        size_y_nm=_integer(payload, "size_y_nm"),
        shape=_string(payload, "shape"),
        rotation_udeg=_integer(payload, "rotation_udeg"),
        layers=_string_tuple(payload, "layers"),
        pad_drill_nm=_integer(payload, "pad_drill_nm"),
        net_id=_optional_string(payload, "net_id"),
        locked=_boolean(payload, "locked", False),
        drill_x_nm=(_integer(payload, "drill_x_nm") if "drill_x_nm" in payload else 0),
        drill_y_nm=(_integer(payload, "drill_y_nm") if "drill_y_nm" in payload else 0),
        drill_rotation_udeg=(
            _integer(payload, "drill_rotation_udeg") if "drill_rotation_udeg" in payload else 0
        ),
        shared_land_group_id=_optional_string(payload, "shared_land_group_id"),
    )


def _without[T](values: Iterable[T], predicate) -> tuple[T, ...]:
    return tuple(value for value in values if not predicate(value))


class DesignKernel:
    """Thread-safe, in-memory reference kernel.

    Production storage will append the same commands and revisions to a durable
    database.  This implementation makes the mutation and approval invariants
    executable now and supports deterministic replay in tests.
    """

    def __init__(
        self,
        initial_graph: DesignGraph,
        *,
        commit_verifier: HmacCommitVerifier | None = None,
    ) -> None:
        if commit_verifier is not None and type(commit_verifier) is not HmacCommitVerifier:
            raise InvariantViolation(
                "kernel commit verifier must be exact HmacCommitVerifier or null"
            )
        normalized = initial_graph.normalized()
        validate_graph(normalized)
        graph_hash = normalized.graph_hash
        genesis_hash = stable_hash(
            {"parent": None, "sequence": 0, "graph_hash": graph_hash},
            domain="flux-clone-design-revision-v1",
        )
        genesis = DesignRevision(genesis_hash, None, 0, normalized, graph_hash, (), None, None)
        self._revisions = {genesis_hash: genesis}
        self._head = genesis_hash
        self._transactions: dict[str, DesignTransaction] = {}
        self._idempotency: dict[tuple[str, str], str] = {}
        self._command_ids: dict[str, str] = {}
        self._commit_verifier = commit_verifier
        self._committed_authorizations: dict[str, str] = {}
        self._committed_authorization_evidence: dict[str, ConsumedCommitAuthorization] = {}
        self._lock = RLock()

    @classmethod
    def from_revision(
        cls,
        revision: DesignRevision,
        *,
        commit_verifier: HmacCommitVerifier | None = None,
    ) -> DesignKernel:
        """Create an isolated kernel whose head retains an exact revision identity.

        This is the safe boundary for approval previews: rebuilding from only a
        graph would invent a new genesis revision and therefore a different
        preview digest after the first commit.
        """

        if not isinstance(revision, DesignRevision):
            raise InvariantViolation("preview fork requires a DesignRevision")
        normalized = revision.graph.normalized()
        validate_graph(normalized)
        if normalized != revision.graph or normalized.graph_hash != revision.graph_hash:
            raise InvariantViolation(
                "preview fork revision must contain its normalized exact graph"
            )
        if commit_verifier is not None and type(commit_verifier) is not HmacCommitVerifier:
            raise InvariantViolation(
                "kernel commit verifier must be exact HmacCommitVerifier or null"
            )
        kernel = cls.__new__(cls)
        kernel._revisions = {revision.revision_hash: revision}
        kernel._head = revision.revision_hash
        kernel._transactions = {}
        kernel._idempotency = {}
        kernel._command_ids = {}
        kernel._commit_verifier = commit_verifier
        kernel._committed_authorizations = {}
        kernel._committed_authorization_evidence = {}
        kernel._lock = RLock()
        return kernel

    @property
    def head(self) -> DesignRevision:
        with self._lock:
            return self._revisions[self._head]

    def get_revision(self, revision_hash: str) -> DesignRevision:
        with self._lock:
            try:
                return self._revisions[revision_hash]
            except KeyError as exc:
                raise StaleRevision(f"unknown revision {revision_hash}") from exc

    def begin_transaction(self, transaction_id: str, *, base_revision: str) -> DesignTransaction:
        with self._lock:
            if (
                not transaction_id
                or transaction_id != transaction_id.strip()
                or any(character.isspace() for character in transaction_id)
            ):
                raise InvariantViolation(
                    "transaction ID must be a non-empty whitespace-free identifier"
                )
            _sha256(base_revision, "transaction base revision")
            if transaction_id in self._transactions:
                transaction = self._transactions[transaction_id]
                if transaction.base_revision != base_revision:
                    raise CommandConflict("transaction ID was reused against another revision")
                return transaction
            if base_revision != self._head:
                raise StaleRevision(
                    f"transaction base {base_revision} is not current head {self._head}"
                )
            transaction = DesignTransaction(transaction_id, base_revision, self.head.graph)
            transaction = self._refresh_preview(transaction)
            self._transactions[transaction_id] = transaction
            return transaction

    def get_transaction(self, transaction_id: str) -> DesignTransaction:
        with self._lock:
            try:
                return self._transactions[transaction_id]
            except KeyError as exc:
                raise KernelError(f"unknown transaction {transaction_id}") from exc

    def get_commit_authorization_evidence(
        self,
        transaction_id: str,
    ) -> ConsumedCommitAuthorization:
        """Return the exact live-authority consumption evidence for a local commit."""

        with self._lock:
            try:
                return self._committed_authorization_evidence[transaction_id]
            except KeyError as exc:
                raise KernelError(
                    f"transaction {transaction_id} has no consumed commit authorization"
                ) from exc

    def stage(self, command: DesignCommand) -> DesignTransaction:
        with self._lock:
            transaction = self.get_transaction(command.transaction_id)
            if command.base_revision != transaction.base_revision:
                raise StaleRevision("command base revision does not match its transaction")
            key = (command.transaction_id, command.idempotency_key)
            existing_hash = self._idempotency.get(key)
            if existing_hash is not None:
                if existing_hash != command.command_hash:
                    raise CommandConflict("idempotency key was reused for a different command")
                return transaction
            existing_command_hash = self._command_ids.get(command.command_id)
            if existing_command_hash is not None:
                raise CommandConflict("command ID was already used for another accepted command")
            if transaction.state is not TransactionState.OPEN:
                raise TransactionNotCommittable(
                    "commands may only be staged into an open transaction"
                )

            staged_graph = self._apply(transaction.staged_graph, command).normalized()
            validate_graph(staged_graph)
            if staged_graph == transaction.staged_graph:
                raise CommandConflict("command has no semantic effect")
            next_transaction = replace(
                transaction,
                staged_graph=staged_graph,
                commands=transaction.commands + (command,),
                verification_report_hash=None,
                verification_preview_digest=None,
                commit_gate_passed=False,
            )
            next_transaction = self._refresh_preview(next_transaction)
            self._transactions[command.transaction_id] = next_transaction
            self._idempotency[key] = command.command_hash
            self._command_ids[command.command_id] = command.command_hash
            return next_transaction

    def stage_batch(self, commands: Iterable[DesignCommand]) -> DesignTransaction:
        """Atomically stage an exact ordered command batch.

        Every command is replayed against a local transaction value first.  The
        transaction, idempotency index, and global command index are published
        only after the complete batch succeeds, so a late invalid import command
        cannot leave a partially staged review subject.
        """

        batch = tuple(commands)
        if not batch or any(not isinstance(command, DesignCommand) for command in batch):
            raise InvariantViolation("stage batch must be a non-empty DesignCommand iterable")
        transaction_id = batch[0].transaction_id
        base_revision = batch[0].base_revision
        if any(
            command.transaction_id != transaction_id or command.base_revision != base_revision
            for command in batch
        ):
            raise InvariantViolation(
                "stage batch commands must bind one transaction and base revision"
            )
        if len({command.command_id for command in batch}) != len(batch):
            raise InvariantViolation("stage batch command IDs must be unique")
        if len({command.idempotency_key for command in batch}) != len(batch):
            raise InvariantViolation("stage batch idempotency keys must be unique")

        with self._lock:
            transaction = self.get_transaction(transaction_id)
            if base_revision != transaction.base_revision:
                raise StaleRevision("stage batch base revision does not match its transaction")
            next_transaction = transaction
            accepted_idempotency: dict[tuple[str, str], str] = {}
            accepted_command_ids: dict[str, str] = {}
            for command in batch:
                key = (transaction_id, command.idempotency_key)
                existing_hash = self._idempotency.get(key)
                if existing_hash is not None:
                    if existing_hash != command.command_hash:
                        raise CommandConflict(
                            "stage batch idempotency key was reused for a different command"
                        )
                    continue
                if command.command_id in self._command_ids:
                    raise CommandConflict(
                        "stage batch command ID was already used for another accepted command"
                    )
                if next_transaction.state is not TransactionState.OPEN:
                    raise TransactionNotCommittable(
                        "commands may only be staged into an open transaction"
                    )
                staged_graph = self._apply(next_transaction.staged_graph, command).normalized()
                validate_graph(staged_graph)
                if staged_graph == next_transaction.staged_graph:
                    raise CommandConflict("stage batch command has no semantic effect")
                next_transaction = replace(
                    next_transaction,
                    staged_graph=staged_graph,
                    commands=next_transaction.commands + (command,),
                    verification_report_hash=None,
                    verification_preview_digest=None,
                    commit_gate_passed=False,
                )
                next_transaction = self._refresh_preview(next_transaction)
                accepted_idempotency[key] = command.command_hash
                accepted_command_ids[command.command_id] = command.command_hash

            if accepted_idempotency:
                self._transactions[transaction_id] = next_transaction
                self._idempotency.update(accepted_idempotency)
                self._command_ids.update(accepted_command_ids)
            return next_transaction

    def preview(self, transaction_id: str) -> SemanticDiff:
        with self._lock:
            transaction = self.get_transaction(transaction_id)
            base = self.get_revision(transaction.base_revision).graph
            return self._diff(base, transaction)

    def record_verification(
        self,
        transaction_id: str,
        *,
        verification_report_hash: str,
        commit_gate_passed: bool,
        verified_preview_digest: str | None = None,
    ) -> DesignTransaction:
        with self._lock:
            transaction = self.get_transaction(transaction_id)
            _sha256(verification_report_hash, "verification report hash")
            if not isinstance(commit_gate_passed, bool):
                raise InvariantViolation("commit gate result must be a boolean")
            subject = verified_preview_digest or transaction.preview_digest
            _sha256(subject, "verified preview digest")
            if subject != transaction.preview_digest:
                raise ApprovalMismatch("verification does not bind the exact staged preview")
            if transaction.state is TransactionState.VERIFIED:
                if (
                    transaction.verification_report_hash == verification_report_hash
                    and transaction.commit_gate_passed == commit_gate_passed
                    and transaction.verification_preview_digest == subject
                ):
                    return transaction
                raise CommandConflict(
                    "verified transaction cannot be assigned conflicting evidence"
                )
            if transaction.state is not TransactionState.OPEN:
                raise TransactionNotCommittable("only an open transaction can be verified")
            state = TransactionState.VERIFIED if commit_gate_passed else TransactionState.OPEN
            transaction = replace(
                transaction,
                state=state,
                verification_report_hash=verification_report_hash,
                commit_gate_passed=commit_gate_passed,
                verification_preview_digest=subject,
            )
            self._transactions[transaction_id] = transaction
            return transaction

    def commit(
        self,
        transaction_id: str,
        *,
        authorization: CommitAuthorization,
    ) -> DesignRevision:
        with self._lock:
            transaction = self.get_transaction(transaction_id)
            if type(authorization) is not CommitAuthorization:
                raise ApprovalMismatch(
                    "commit requires the exact issuer-verifiable CommitAuthorization type"
                )
            verifier = self._commit_verifier
            if verifier is None:
                raise ApprovalMismatch("kernel has no trusted commit verifier")
            verified = verifier.verify(authorization)
            claims = verified.claims
            if transaction.state is TransactionState.COMMITTED:
                self._match_commit_authorization(transaction, verified)
                expected_authorization = self._committed_authorizations.get(transaction_id)
                if (
                    expected_authorization is None
                    or not hmac.compare_digest(
                        expected_authorization,
                        claims.authorization_digest,
                    )
                    or verified.previously_consumed_authorization_digest is None
                    or not hmac.compare_digest(
                        verified.previously_consumed_authorization_digest,
                        claims.authorization_digest,
                    )
                ):
                    raise ReplayedCommitAuthorization(
                        "only the exact capability may retry its already committed transaction"
                    )
                assert transaction.committed_revision_hash is not None
                return self.get_revision(transaction.committed_revision_hash)
            if verified.previously_consumed_authorization_digest is not None:
                raise ReplayedCommitAuthorization(
                    "commit authorization nonce has already been consumed"
                )
            if transaction.base_revision != self._head:
                raise StaleRevision("head changed after the transaction was staged")
            if (
                transaction.state is not TransactionState.VERIFIED
                or not transaction.commit_gate_passed
            ):
                raise TransactionNotCommittable(
                    "commit requires a passed deterministic verification gate"
                )
            self._match_commit_authorization(transaction, verified)
            parent = self.head
            if not transaction.commands or transaction.staged_graph.graph_hash == parent.graph_hash:
                raise TransactionNotCommittable("a commit must contain a semantic graph change")
            command_hashes = tuple(command.command_hash for command in transaction.commands)
            graph = transaction.staged_graph.normalized()
            graph_hash = graph.graph_hash
            revision_hash = stable_hash(
                {
                    "parent": parent.revision_hash,
                    "sequence": parent.sequence + 1,
                    "graph_hash": graph_hash,
                    "commands": command_hashes,
                    "verification_report_hash": transaction.verification_report_hash,
                    "approval_preview_digest": claims.preview_digest,
                },
                domain="flux-clone-design-revision-v1",
            )
            revision = DesignRevision(
                revision_hash,
                parent.revision_hash,
                parent.sequence + 1,
                graph,
                graph_hash,
                command_hashes,
                transaction.verification_report_hash,
                claims.preview_digest,
            )
            # The capability is consumed only after every transaction binding
            # and the deterministic revision construction have succeeded, but
            # before any new head is published.  Authority.consume rechecks the
            # HMAC, time window, and nonce atomically.
            consumed = verifier.consume(verified)
            self._revisions[revision_hash] = revision
            self._head = revision_hash
            self._committed_authorizations[transaction_id] = claims.authorization_digest
            self._committed_authorization_evidence[transaction_id] = consumed
            self._transactions[transaction_id] = replace(
                transaction,
                state=TransactionState.COMMITTED,
                committed_revision_hash=revision_hash,
            )
            return revision

    def _match_commit_authorization(
        self,
        transaction: DesignTransaction,
        verified: _VerifiedCommitClaims,
    ) -> None:
        """Independently bind issuer claims to every available kernel fact."""

        authorization = verified.claims
        approval = verified.release_approval
        command_hashes = tuple(command.command_hash for command in transaction.commands)
        command_digest = commit_command_hashes_digest(command_hashes)
        expected_release_subject = stable_hash(
            {
                "base_revision": transaction.base_revision,
                "preview_digest": transaction.preview_digest,
                "report_hash": transaction.verification_report_hash,
            },
            domain="flux-clone-release-v1",
        )
        bindings = (
            (
                authorization.project_id == transaction.staged_graph.project_id,
                "project",
            ),
            (authorization.base_revision == transaction.base_revision, "base revision"),
            (
                authorization.head_revision == transaction.base_revision,
                "current head",
            ),
            (authorization.transaction_id == transaction.transaction_id, "transaction"),
            (authorization.command_hashes == command_hashes, "ordered commands"),
            (
                hmac.compare_digest(authorization.command_hashes_digest, command_digest),
                "ordered command digest",
            ),
            (
                hmac.compare_digest(authorization.preview_digest, transaction.preview_digest),
                "preview",
            ),
            (
                hmac.compare_digest(
                    authorization.prospective_graph_sha256,
                    transaction.staged_graph.graph_hash,
                ),
                "prospective graph",
            ),
            (
                transaction.verification_report_hash is not None
                and hmac.compare_digest(
                    authorization.verification_report_hash,
                    transaction.verification_report_hash,
                ),
                "verification report",
            ),
            (
                transaction.verification_preview_digest is not None
                and hmac.compare_digest(
                    authorization.verified_preview_digest,
                    transaction.verification_preview_digest,
                )
                and hmac.compare_digest(
                    authorization.verified_preview_digest,
                    transaction.preview_digest,
                ),
                "verified preview",
            ),
            (
                hmac.compare_digest(authorization.release_subject_digest, expected_release_subject),
                "release subject",
            ),
            (
                authorization.commit_gate_passed is True
                and transaction.commit_gate_passed is True
                and approval.commit_gate_passed is True,
                "commit gate",
            ),
            (
                authorization.human_approval_id == approval.approval_id,
                "human approval ID",
            ),
            (
                authorization.human_approval_run_id == approval.run_id,
                "human approval run",
            ),
            (
                authorization.human_approval_kind == approval.kind == "release",
                "human approval kind",
            ),
            (
                hmac.compare_digest(
                    authorization.human_approval_digest,
                    approval.approval_digest,
                ),
                "human approval digest",
            ),
            (
                authorization.human_approval_principal == approval.principal,
                "human approval principal",
            ),
            (
                authorization.human_approval_decided_at == approval.decided_at,
                "human approval decision time",
            ),
            (
                authorization.human_approval_expires_at == approval.expires_at,
                "human approval expiry",
            ),
        )
        for matches, label in bindings:
            if not matches:
                raise ApprovalMismatch(f"commit authorization does not bind the exact {label}")

    def rollback(self, transaction_id: str) -> DesignTransaction:
        with self._lock:
            transaction = self.get_transaction(transaction_id)
            if transaction.state is TransactionState.COMMITTED:
                raise TransactionNotCommittable("committed history cannot be rolled back in place")
            if transaction.state is TransactionState.ROLLED_BACK:
                return transaction
            transaction = replace(
                transaction,
                state=TransactionState.ROLLED_BACK,
                verification_report_hash=None,
                verification_preview_digest=None,
                commit_gate_passed=False,
            )
            self._transactions[transaction_id] = transaction
            return transaction

    @staticmethod
    def _refresh_preview(transaction: DesignTransaction) -> DesignTransaction:
        digest = stable_hash(
            {
                "base_revision": transaction.base_revision,
                "transaction_id": transaction.transaction_id,
                "staged_graph_hash": transaction.staged_graph.graph_hash,
                "command_hashes": tuple(command.command_hash for command in transaction.commands),
            },
            domain="flux-clone-preview-v2",
        )
        return replace(transaction, preview_digest=digest)

    @staticmethod
    def _diff(base: DesignGraph, transaction: DesignTransaction) -> SemanticDiff:
        staged = transaction.staged_graph
        added: list[str] = []
        removed: list[str] = []
        modified: list[str] = []

        for prefix, before_items, after_items, identity in (
            ("component", base.components, staged.components, lambda item: item.component_id),
            ("net", base.nets, staged.nets, lambda item: item.net_id),
            ("placement", base.placements, staged.placements, lambda item: item.component_id),
            ("track", base.tracks, staged.tracks, lambda item: item.track_id),
            ("pad", base.pads, staged.pads, lambda item: item.pad_id),
            ("hole", base.holes, staged.holes, lambda item: item.hole_id),
            ("via", base.vias, staged.vias, lambda item: item.via_id),
            ("zone", base.zones, staged.zones, lambda item: item.zone_id),
            (
                "schematic-wire",
                base.schematic_wires,
                staged.schematic_wires,
                lambda item: item.wire_id,
            ),
            (
                "schematic-junction",
                base.schematic_junctions,
                staged.schematic_junctions,
                lambda item: item.junction_id,
            ),
        ):
            before = {identity(item): item for item in before_items}
            after = {identity(item): item for item in after_items}
            added.extend(f"{prefix}:{item}" for item in sorted(after.keys() - before.keys()))
            removed.extend(f"{prefix}:{item}" for item in sorted(before.keys() - after.keys()))
            modified.extend(
                f"{prefix}:{item}"
                for item in sorted(before.keys() & after.keys())
                if before[item] != after[item]
            )
        added.extend(f"layer:{layer}" for layer in sorted(set(staged.layers) - set(base.layers)))
        removed.extend(f"layer:{layer}" for layer in sorted(set(base.layers) - set(staged.layers)))
        if not base.board_outline and staged.board_outline:
            added.append("board:outline")
        elif base.board_outline and not staged.board_outline:
            removed.append("board:outline")
        elif base.board_outline != staged.board_outline:
            modified.append("board:outline")
        return SemanticDiff(
            transaction.base_revision,
            staged.graph_hash,
            tuple(sorted(added)),
            tuple(sorted(removed)),
            tuple(sorted(modified)),
            tuple(command.command_id for command in transaction.commands),
            transaction.preview_digest,
        )

    @classmethod
    def _apply(cls, graph: DesignGraph, command: DesignCommand) -> DesignGraph:
        payload = command.payload
        if command.kind is CommandKind.COMPONENT_ADD:
            _payload_keys(
                payload,
                required=frozenset(
                    {
                        "component_id",
                        "reference",
                        "value",
                        "manufacturer_part_number",
                        "package",
                        "symbol_id",
                        "footprint_id",
                        "datasheet_sha256",
                        "pin_map_sha256",
                        "pins",
                    }
                ),
            )
            raw_pins = payload.get("pins")
            if not isinstance(raw_pins, list):
                raise InvariantViolation("component pins must be an array")
            pins = tuple(
                PinDefinition(
                    _string(pin, "number"),
                    _string(pin, "name"),
                    _string(pin, "electrical_type"),
                    _string(pin, "pad_number"),
                    _boolean(pin, "required", True),
                )
                for pin in raw_pins
                if isinstance(pin, dict)
            )
            if len(pins) != len(raw_pins):
                raise InvariantViolation("each pin must be an object")
            for pin in raw_pins:
                _payload_keys(
                    pin,
                    required=frozenset({"number", "name", "electrical_type", "pad_number"}),
                    optional=frozenset({"required"}),
                )
            component = Component(
                _string(payload, "component_id"),
                _string(payload, "reference"),
                _string(payload, "value"),
                _string(payload, "manufacturer_part_number"),
                _string(payload, "package"),
                _string(payload, "symbol_id"),
                _string(payload, "footprint_id"),
                _string(payload, "datasheet_sha256"),
                _string(payload, "pin_map_sha256"),
                pins,
            )
            if any(item.component_id == component.component_id for item in graph.components):
                raise InvariantViolation(f"component {component.component_id} already exists")
            if any(item.reference == component.reference for item in graph.components):
                raise InvariantViolation(
                    f"component reference {component.reference} already exists"
                )
            return replace(graph, components=graph.components + (component,))

        if command.kind is CommandKind.COMPONENT_REMOVE:
            _payload_keys(payload, required=frozenset({"component_id"}))
            component_id = _string(payload, "component_id")
            if not any(item.component_id == component_id for item in graph.components):
                raise InvariantViolation(f"unknown component {component_id}")
            if any(
                member.component_id == component_id for net in graph.nets for member in net.members
            ):
                raise InvariantViolation("disconnect a component from all nets before removal")
            placement = next(
                (item for item in graph.placements if item.component_id == component_id), None
            )
            if placement is not None and placement.locked:
                raise LockedObject(f"component {component_id} has a locked placement")
            if any(
                item.component_id == component_id and item.locked
                for item in graph.pads + graph.holes
            ):
                raise LockedObject(f"component {component_id} has locked footprint geometry")
            return replace(
                graph,
                components=_without(
                    graph.components, lambda item: item.component_id == component_id
                ),
                placements=_without(
                    graph.placements, lambda item: item.component_id == component_id
                ),
                pads=_without(graph.pads, lambda item: item.component_id == component_id),
                holes=_without(graph.holes, lambda item: item.component_id == component_id),
            )

        if command.kind is CommandKind.NET_CREATE:
            _payload_keys(payload, required=frozenset({"net_id", "name"}))
            net_id = _string(payload, "net_id")
            name = _string(payload, "name")
            if any(item.net_id == net_id for item in graph.nets):
                raise InvariantViolation(f"net {net_id} already exists")
            if any(item.name == name for item in graph.nets):
                raise InvariantViolation(f"net name {name} already exists")
            return replace(graph, nets=graph.nets + (Net(net_id, name),))

        if command.kind is CommandKind.NET_CONNECT:
            _payload_keys(payload, required=frozenset({"net_id", "component_id", "pin_number"}))
            net_id = _string(payload, "net_id")
            member = PinRef(_string(payload, "component_id"), _string(payload, "pin_number"))
            for existing_net in graph.nets:
                if member in existing_net.members:
                    if existing_net.net_id == net_id:
                        raise CommandConflict(
                            f"pin {member.component_id}:{member.pin_number} is already connected"
                        )
                    raise InvariantViolation(
                        f"pin {member.component_id}:{member.pin_number} already "
                        f"belongs to net {existing_net.net_id}"
                    )
            matched = False
            nets: list[Net] = []
            for net in graph.nets:
                if net.net_id == net_id:
                    matched = True
                    nets.append(replace(net, members=net.members + (member,)))
                else:
                    nets.append(net)
            if not matched:
                raise InvariantViolation(f"unknown net {net_id}")
            return replace(graph, nets=tuple(nets))

        if command.kind is CommandKind.FOOTPRINT_PLACE:
            _payload_keys(
                payload,
                required=frozenset({"component_id", "x_nm", "y_nm", "rotation_udeg", "side"}),
                optional=frozenset({"locked"}),
            )
            component_id = _string(payload, "component_id")
            if not any(item.component_id == component_id for item in graph.components):
                raise InvariantViolation(f"unknown component {component_id}")
            current = next(
                (item for item in graph.placements if item.component_id == component_id), None
            )
            if current is not None and current.locked:
                raise LockedObject(f"placement for {component_id} is locked")
            placement = FootprintPlacement(
                component_id,
                PointNm(_integer(payload, "x_nm"), _integer(payload, "y_nm")),
                _integer(payload, "rotation_udeg"),
                _string(payload, "side"),
                _boolean(payload, "locked", False),
            )
            return replace(
                graph,
                placements=_without(
                    graph.placements, lambda item: item.component_id == component_id
                )
                + (placement,),
            )

        if command.kind is CommandKind.FOOTPRINT_PAD_ADD:
            pad = _footprint_pad(payload)
            if pad.shared_land_group_id is not None:
                raise InvariantViolation(
                    "a shared land must be added atomically with footprint.pad_group.add"
                )
            if any(item.pad_id == pad.pad_id for item in graph.pads):
                raise InvariantViolation(f"pad {pad.pad_id} already exists")
            return replace(graph, pads=graph.pads + (pad,))

        if command.kind is CommandKind.FOOTPRINT_PAD_GROUP_ADD:
            _payload_keys(payload, required=frozenset({"shared_land_group_id", "pads"}))
            group_id = _string(payload, "shared_land_group_id")
            raw_pads_value: object = payload.get("pads")
            if type(raw_pads_value) is not list:
                raise InvariantViolation(
                    "shared land pads must be an array of at least two exact pad objects"
                )
            raw_pad_values = cast(list[object], raw_pads_value)
            if len(raw_pad_values) < 2 or any(
                type(raw_pad) is not dict for raw_pad in raw_pad_values
            ):
                raise InvariantViolation(
                    "shared land pads must be an array of at least two exact pad objects"
                )
            raw_pads = tuple(
                cast(dict[str, Any], raw_pad) for raw_pad in raw_pad_values
            )
            group_pads = tuple(_footprint_pad(raw_pad) for raw_pad in raw_pads)
            if any(pad.shared_land_group_id != group_id for pad in group_pads):
                raise InvariantViolation(
                    "every shared land pad must bind the exact command group ID"
                )
            new_pad_ids = tuple(pad.pad_id for pad in group_pads)
            if len(new_pad_ids) != len(set(new_pad_ids)) or any(
                existing.pad_id in set(new_pad_ids) for existing in graph.pads
            ):
                raise InvariantViolation("shared land physical pad IDs must be new and unique")
            return replace(graph, pads=graph.pads + group_pads)

        if command.kind is CommandKind.FOOTPRINT_HOLE_ADD:
            _payload_keys(
                payload,
                required=frozenset(
                    {
                        "hole_id",
                        "component_id",
                        "center_x_nm",
                        "center_y_nm",
                        "diameter_nm",
                        "plated",
                    }
                ),
                optional=frozenset(
                    {
                        "pad_id",
                        "locked",
                        "drill_x_nm",
                        "drill_y_nm",
                        "drill_rotation_udeg",
                    }
                ),
            )
            hole = FootprintHole(
                hole_id=_string(payload, "hole_id"),
                component_id=_string(payload, "component_id"),
                center=PointNm(
                    _integer(payload, "center_x_nm"),
                    _integer(payload, "center_y_nm"),
                ),
                diameter_nm=_integer(payload, "diameter_nm"),
                plated=_boolean(payload, "plated"),
                pad_id=_optional_string(payload, "pad_id"),
                locked=_boolean(payload, "locked", False),
                drill_x_nm=(_integer(payload, "drill_x_nm") if "drill_x_nm" in payload else 0),
                drill_y_nm=(_integer(payload, "drill_y_nm") if "drill_y_nm" in payload else 0),
                drill_rotation_udeg=(
                    _integer(payload, "drill_rotation_udeg")
                    if "drill_rotation_udeg" in payload
                    else 0
                ),
            )
            if any(item.hole_id == hole.hole_id for item in graph.holes):
                raise InvariantViolation(f"hole {hole.hole_id} already exists")
            return replace(graph, holes=graph.holes + (hole,))

        if command.kind is CommandKind.TRACK_ADD:
            _payload_keys(
                payload,
                required=frozenset(
                    {
                        "track_id",
                        "net_id",
                        "layer",
                        "start_x_nm",
                        "start_y_nm",
                        "end_x_nm",
                        "end_y_nm",
                        "width_nm",
                    }
                ),
                optional=frozenset({"locked"}),
            )
            track = Track(
                _string(payload, "track_id"),
                _string(payload, "net_id"),
                _string(payload, "layer"),
                PointNm(_integer(payload, "start_x_nm"), _integer(payload, "start_y_nm")),
                PointNm(_integer(payload, "end_x_nm"), _integer(payload, "end_y_nm")),
                _integer(payload, "width_nm"),
                _boolean(payload, "locked", False),
            )
            if any(item.track_id == track.track_id for item in graph.tracks):
                raise InvariantViolation(f"track {track.track_id} already exists")
            return replace(graph, tracks=graph.tracks + (track,))

        if command.kind is CommandKind.VIA_ADD:
            _payload_keys(
                payload,
                required=frozenset(
                    {
                        "via_id",
                        "net_id",
                        "center_x_nm",
                        "center_y_nm",
                        "diameter_nm",
                        "drill_nm",
                        "layers",
                    }
                ),
                optional=frozenset({"locked"}),
            )
            via = Via(
                _string(payload, "via_id"),
                _string(payload, "net_id"),
                PointNm(_integer(payload, "center_x_nm"), _integer(payload, "center_y_nm")),
                _integer(payload, "diameter_nm"),
                _integer(payload, "drill_nm"),
                _string_tuple(payload, "layers"),
                _boolean(payload, "locked", False),
            )
            if any(item.via_id == via.via_id for item in graph.vias):
                raise InvariantViolation(f"via {via.via_id} already exists")
            return replace(graph, vias=graph.vias + (via,))

        if command.kind is CommandKind.ZONE_ADD:
            _payload_keys(
                payload,
                required=frozenset({"zone_id", "net_id", "layer", "outline", "clearance_nm"}),
                optional=frozenset({"min_thickness_nm", "priority", "locked"}),
            )
            zone = CopperZone(
                _string(payload, "zone_id"),
                _string(payload, "net_id"),
                _string(payload, "layer"),
                _points(payload, "outline"),
                _integer(payload, "clearance_nm"),
                _integer(payload, "min_thickness_nm") if "min_thickness_nm" in payload else 100_000,
                _integer(payload, "priority") if "priority" in payload else 0,
                _boolean(payload, "locked", False),
            )
            if any(item.zone_id == zone.zone_id for item in graph.zones):
                raise InvariantViolation(f"zone {zone.zone_id} already exists")
            return replace(graph, zones=graph.zones + (zone,))

        if command.kind is CommandKind.SCHEMATIC_WIRE_ADD:
            _payload_keys(
                payload,
                required=frozenset({"wire_id", "net_id", "vertices"}),
                optional=frozenset({"sheet_id", "locked"}),
            )
            wire = SchematicWire(
                _string(payload, "wire_id"),
                _string(payload, "net_id"),
                _points(payload, "vertices"),
                _string(payload, "sheet_id") if "sheet_id" in payload else "root",
                _boolean(payload, "locked", False),
            )
            if any(item.wire_id == wire.wire_id for item in graph.schematic_wires):
                raise InvariantViolation(f"schematic wire {wire.wire_id} already exists")
            return replace(graph, schematic_wires=graph.schematic_wires + (wire,))

        if command.kind is CommandKind.SCHEMATIC_JUNCTION_ADD:
            _payload_keys(
                payload,
                required=frozenset({"junction_id", "net_id", "x_nm", "y_nm"}),
                optional=frozenset({"sheet_id", "locked"}),
            )
            junction = SchematicJunction(
                _string(payload, "junction_id"),
                _string(payload, "net_id"),
                PointNm(_integer(payload, "x_nm"), _integer(payload, "y_nm")),
                _string(payload, "sheet_id") if "sheet_id" in payload else "root",
                _boolean(payload, "locked", False),
            )
            if any(item.junction_id == junction.junction_id for item in graph.schematic_junctions):
                raise InvariantViolation(
                    f"schematic junction {junction.junction_id} already exists"
                )
            return replace(
                graph,
                schematic_junctions=graph.schematic_junctions + (junction,),
            )

        if command.kind is CommandKind.BOARD_SET_OUTLINE:
            _payload_keys(payload, required=frozenset({"vertices"}))
            return replace(graph, board_outline=_points(payload, "vertices"))

        raise InvariantViolation(f"unsupported command kind {command.kind.value}")
