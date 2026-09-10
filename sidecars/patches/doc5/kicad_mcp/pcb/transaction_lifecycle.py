"""FastMCP-free PCB lifecycle with exact, client/document-bound Commit handles."""
from __future__ import annotations

import inspect
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol
from kipy.common_types import Commit
from kipy.proto.common.types import DocumentSpecifier, DocumentType

class RunMutation(Protocol):
    """Serialize through the existing command queue; no second transaction framework."""
    def __call__[T](self, operation: str, command: Callable[[], T]) -> T: ...

type GetBoard = Callable[[], object]
type ConnectionErrors = tuple[type[Exception], ...]
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

class _LifecycleFailure(RuntimeError):
    """Never let the general queue retry an uncertain native dispatch."""
    retryable = False
    code = "PCB_COMMIT_LIFECYCLE_FAILED"
    def __init__(self, message: str, *, safe_detail: bool = True):
        super().__init__(message)
        self.safe_detail = safe_detail

@dataclass
class _Binding:
    # Native editor commits are keyed by request ClientName and checked by ID.
    # KiCadSession's normal TTL may replace a Python client wrapper, so bind the
    # immutable transport/request identity, not an ephemeral object address.
    client: tuple[str, str, str] = field(repr=False)
    document: DocumentSpecifier
    commit: Commit | None = None
    commit_id: bytes | None = None

@dataclass
class _ErrorContext:
    verified: bool = False
    tokens: set[str] = field(default_factory=set, repr=False)

@dataclass
class _State:
    active: _Binding | None = None
    errors: _ErrorContext | None = field(default=None, repr=False)

@dataclass(frozen=True)
class PcbTransactionLifecycleService:
    """One service-owned group, guarded entirely by the existing mutation queue.

    A failed Begin may have dispatched without returning a usable handle. Failed
    Ends retain the exact handle for checked recovery. Neither permits nested
    Begin or silent fallback to individually committed mutations.
    """
    get_board: GetBoard
    run_mutation: RunMutation
    connection_errors: ConnectionErrors
    _state: _State = field(default_factory=_State, init=False, repr=False, compare=False)

    def _run(self, operation: str, prefix: str, command: Callable[[], str]) -> str:
        context = _ErrorContext()
        def guarded() -> str:
            previous = self._state.errors
            self._state.errors = context
            if self._state.active is not None and self._state.active.client[2]:
                context.tokens.add(self._state.active.client[2])
            try:
                return command()
            finally:
                self._state.errors = previous
        try:
            return self.run_mutation(operation, guarded)
        except Exception as error:
            if isinstance(error, _LifecycleFailure) and error.safe_detail:
                detail = str(error)
            elif context.verified and context.tokens:
                detail = str(error)
            else:
                detail = "Native error detail unavailable before verified client identity"
            message = f"{prefix}: {type(error).__name__}: {detail}"
            # Redact complete known values before bounding output, so truncation
            # cannot disclose a token prefix. Tokens never enter diagnostics.
            for token in sorted(context.tokens, key=len, reverse=True):
                message = message.replace(token, "<redacted-token>")
            return message[:1400]

    def _owner(self, board: object) -> tuple[tuple[str, str, str], DocumentSpecifier]:
        client = getattr(board, "client", None)
        document = getattr(board, "document", None)
        if (client is None or not isinstance(document, DocumentSpecifier)
                or document.type != DocumentType.DOCTYPE_PCB
                or not document.board_filename or not document.project.path):
            raise _LifecycleFailure("Native client and exact PCB DocumentSpecifier required")
        native_identity = tuple(getattr(client, name, None) for name in ("_socket_path", "_client_name", "_kicad_token"))
        if any(type(value) is not str for value in native_identity) or not native_identity[0] or not native_identity[1]:
            raise _LifecycleFailure("Native client request identity is unavailable")
        if self._state.errors is not None:
            self._state.errors.verified = True
            if native_identity[2]:
                self._state.errors.tokens.add(native_identity[2])
        captured = DocumentSpecifier()
        captured.CopyFrom(document)
        return native_identity, captured

    def _same_owner(self, board: object, binding: _Binding) -> None:
        client, document = self._owner(board)
        if client != binding.client or document != binding.document:
            raise _LifecycleFailure("Native client/document changed; retained transaction requires checked recovery")

    @staticmethod
    def _handle_identity(commit: object) -> bytes:
        if not isinstance(commit, Commit) or not _UUID.fullmatch(commit.id.value) or commit.id.value == "00000000-0000-0000-0000-000000000000":
            raise _LifecycleFailure("Begin did not return a valid native Commit; outcome is uncertain")
        return commit.id.SerializeToString(deterministic=True)

    @staticmethod
    def _supports_group(board: object) -> bool:
        for name, arguments in (("begin_commit", ()), ("push_commit", (object(),)), ("drop_commit", (object(),))):
            command = getattr(board, name, None)
            if not callable(command):
                return False
            try:
                inspect.signature(command).bind(*arguments)
            except (TypeError, ValueError):
                return False
        return True

    def begin(self) -> str:
        def command() -> str:
            if self._state.active is not None:
                raise _LifecycleFailure("Another transaction is active or pending; nested Begin is forbidden")
            board = self.get_board()
            if not self._supports_group(board):
                return "Transaction grouping is not supported by the current KiCad IPC version. No transaction was started."
            client, document = self._owner(board)
            binding = _Binding(client, document)
            # Record pending before dispatch: uncertain Begin cannot be repeated.
            self._state.active = binding
            try:
                commit = board.begin_commit()
                if isinstance(commit, Commit):
                    binding.commit = commit
                binding.commit_id = self._handle_identity(commit)
                self._same_owner(board, binding)
                self._same_owner(self.get_board(), binding)
            except Exception as error:
                raise _LifecycleFailure(f"Begin outcome retained for recovery ({type(error).__name__}: {error})", safe_detail=False) from error
            return "Transaction group started. Use pcb_push_commit to apply or pcb_drop_commit to discard."
        return self._run("pcb_begin_commit", "Failed to begin transaction", command)

    def _end(self, name: str, operation: str, success: str, prefix: str, absent: str) -> str:
        def command() -> str:
            binding = self._state.active
            if binding is None:
                return absent
            board = self.get_board()
            self._same_owner(board, binding)
            if binding.commit is None or binding.commit_id is None:
                raise _LifecycleFailure("Pending Begin has no confirmed Commit handle; checked recovery required")
            if self._handle_identity(binding.commit) != binding.commit_id:
                raise _LifecycleFailure("Retained Commit identity changed; refusing a different handle")
            end = getattr(board, name, None)
            if not callable(end):
                raise _LifecycleFailure("Native End capability disappeared; handle retained")
            try:
                inspect.signature(end).bind(binding.commit)
                result = end(binding.commit)
                # Pinned KiPy returns None after KiCadClient.send validates the
                # API envelope and receives EndCommitResponse (an empty proto).
                if result is not None:
                    raise _LifecycleFailure("Native End returned an unexpected acknowledgement")
                if self._handle_identity(binding.commit) != binding.commit_id:
                    raise _LifecycleFailure("Commit handle changed during End")
                self._same_owner(board, binding)
                self._same_owner(self.get_board(), binding)
            except Exception as error:
                raise _LifecycleFailure(f"End outcome uncertain; Commit retained ({type(error).__name__}: {error})", safe_detail=False) from error
            self._state.active = None
            return success
        return self._run(operation, prefix, command)

    def push(self) -> str:
        return self._end("push_commit", "pcb_push_commit", "Transaction group committed successfully.",
                         "Failed to commit transaction", "No active transaction group to commit.")

    def drop(self) -> str:
        return self._end("drop_commit", "pcb_drop_commit", "Transaction group discarded successfully.",
                         "Failed to discard transaction", "No active transaction group to discard.")

    def revert(self) -> str:
        """Caller-guarded revert is not treated as an EndCommit acknowledgement."""
        def command() -> str:
            board = self.get_board()
            binding = self._state.active
            self._owner(board)
            if binding is not None:
                self._same_owner(board, binding)
            revert = getattr(board, "revert", None)
            if not callable(revert):
                return "Revert is not supported by the current KiCad IPC version. Please save and reload the board manually."
            try:
                result = revert()
                if result is not None:
                    raise _LifecycleFailure("Native revert returned an unexpected acknowledgement")
                if binding is not None:
                    self._same_owner(board, binding)
                    self._same_owner(self.get_board(), binding)
            except Exception as error:
                raise _LifecycleFailure(f"Revert outcome uncertain ({type(error).__name__}: {error})", safe_detail=False) from error
            # Only acknowledged push/drop clears grouping state. Revert does
            # not establish what happened to an uncertain native commit token.
            return "Board reverted to last saved state. All unsaved changes have been discarded."
        return self._run("pcb_revert", "Failed to revert board", command)
