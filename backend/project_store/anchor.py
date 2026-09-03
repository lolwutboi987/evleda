"""External monotonic anchors protecting canonical project heads from DB rollback."""

from __future__ import annotations

import json
import os
from collections.abc import Generator
from contextlib import contextmanager, suppress
from dataclasses import asdict, dataclass
from pathlib import Path
from threading import RLock
from typing import Protocol, cast, runtime_checkable

from .models import IntegrityError

GENESIS_ATTESTATION_DIGEST = "0" * 64


def _identifier(value: object, label: str) -> str:
    if type(value) is not str or not value or value != value.strip():
        raise ValueError(f"{label} must be an exact non-empty identifier")
    return value


def _digest(value: object, label: str) -> str:
    if (
        type(value) is not str
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ValueError(f"{label} must be an exact lowercase SHA-256 digest")
    return value


def _sequence(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("anchor sequence must be an exact non-negative integer")
    return value


@dataclass(frozen=True, slots=True)
class ProjectHeadAnchorState:
    project_id: str
    sequence: int
    revision_hash: str
    attestation_digest: str

    def __post_init__(self) -> None:
        if type(self) is not ProjectHeadAnchorState:
            raise ValueError("project head anchor must be the exact concrete type")
        _identifier(self.project_id, "anchor project ID")
        if type(self.sequence) is not int or self.sequence < 0:
            raise ValueError("anchor sequence must be an exact non-negative integer")
        _digest(self.revision_hash, "anchor revision hash")
        _digest(self.attestation_digest, "anchor attestation digest")
        if self.sequence == 0 and self.attestation_digest != GENESIS_ATTESTATION_DIGEST:
            raise ValueError("genesis anchor must use the genesis attestation sentinel")
        if self.sequence > 0 and self.attestation_digest == GENESIS_ATTESTATION_DIGEST:
            raise ValueError("non-genesis anchor requires an attestation digest")


@runtime_checkable
class ProjectHeadAnchor(Protocol):
    """Trusted monotonic CAS kept outside the canonical project database."""

    def read(self, project_id: str) -> ProjectHeadAnchorState | None: ...

    def initialize(self, state: ProjectHeadAnchorState) -> None: ...

    def compare_and_set(
        self,
        expected: ProjectHeadAnchorState,
        current: ProjectHeadAnchorState,
    ) -> None: ...


class InMemoryProjectHeadAnchor:
    """Thread-safe anchor for tests and explicitly ephemeral processes."""

    def __init__(self) -> None:
        self._lock = RLock()
        self._states: dict[str, ProjectHeadAnchorState] = {}

    def read(self, project_id: str) -> ProjectHeadAnchorState | None:
        _identifier(project_id, "anchor project ID")
        with self._lock:
            return self._states.get(project_id)

    def initialize(self, state: ProjectHeadAnchorState) -> None:
        if type(state) is not ProjectHeadAnchorState:
            raise ValueError("anchor state must be the exact concrete type")
        with self._lock:
            existing = self._states.get(state.project_id)
            if existing is not None and existing != state:
                raise IntegrityError("project head anchor already has different state")
            self._states[state.project_id] = state

    def compare_and_set(
        self,
        expected: ProjectHeadAnchorState,
        current: ProjectHeadAnchorState,
    ) -> None:
        if type(expected) is not ProjectHeadAnchorState or type(current) is not (
            ProjectHeadAnchorState
        ):
            raise ValueError("anchor CAS requires exact anchor states")
        if expected.project_id != current.project_id:
            raise ValueError("anchor CAS states must belong to the same project")
        if current.sequence != expected.sequence + 1:
            raise ValueError("anchor CAS must advance exactly one revision")
        with self._lock:
            observed = self._states.get(expected.project_id)
            if observed == current:
                return
            if observed != expected:
                raise IntegrityError("project head anchor compare-and-set conflict")
            self._states[current.project_id] = current


class DirectoryProjectHeadAnchor:
    """Cross-process file anchor rooted outside the project SQLite database.

    The directory is an independently backed trust boundary. Operators must
    protect it from rollback separately from the project database. Locating it
    beside the database does not protect against a same-directory snapshot
    rollback; production deployments should use an external monotonic service.
    """

    def __init__(self, directory: str | Path) -> None:
        self._directory = Path(directory).resolve()
        self._directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            self._directory.chmod(0o700)
        except OSError as exc:
            raise IntegrityError("external anchor directory permissions could not be set") from exc
        self._thread_lock = RLock()
        self._lock_path = self._directory / ".project-head-anchor.lock"

    @contextmanager
    def _locked(self) -> Generator[None, None, None]:
        with self._thread_lock, self._lock_path.open("a+b") as handle:
            try:
                self._lock_path.chmod(0o600)
            except OSError as exc:
                raise IntegrityError("external anchor lock permissions could not be set") from exc
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _path(self, project_id: str) -> Path:
        _identifier(project_id, "anchor project ID")
        # The filename is a digest so project IDs cannot escape the anchor root.
        import hashlib

        name = hashlib.sha256(project_id.encode("utf-8")).hexdigest()
        return self._directory / f"{name}.json"

    @staticmethod
    def _decode(path: Path) -> ProjectHeadAnchorState | None:
        if not path.exists():
            return None
        try:
            raw_value: object = json.loads(path.read_text(encoding="utf-8"))
            if type(raw_value) is not dict:
                raise ValueError
            value = cast(dict[str, object], raw_value)
            if set(value) != {
                "project_id",
                "sequence",
                "revision_hash",
                "attestation_digest",
            }:
                raise ValueError
            return ProjectHeadAnchorState(
                project_id=_identifier(value["project_id"], "anchor project ID"),
                sequence=_sequence(value["sequence"]),
                revision_hash=_digest(value["revision_hash"], "anchor revision hash"),
                attestation_digest=_digest(
                    value["attestation_digest"],
                    "anchor attestation digest",
                ),
            )
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
            raise IntegrityError("external project head anchor is malformed") from exc

    @staticmethod
    def _encode(state: ProjectHeadAnchorState) -> str:
        return json.dumps(
            asdict(state),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ) + "\n"

    def _write(self, state: ProjectHeadAnchorState) -> None:
        path = self._path(state.project_id)
        temporary = path.with_suffix(f".{os.getpid()}.tmp")
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
            )
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(self._encode(state))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            if os.name != "nt":
                directory_fd = os.open(self._directory, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        except OSError as exc:
            with suppress(OSError):
                temporary.unlink(missing_ok=True)
            raise IntegrityError("external project head anchor could not be persisted") from exc

    def read(self, project_id: str) -> ProjectHeadAnchorState | None:
        with self._locked():
            return self._decode(self._path(project_id))

    def initialize(self, state: ProjectHeadAnchorState) -> None:
        if type(state) is not ProjectHeadAnchorState:
            raise ValueError("anchor state must be the exact concrete type")
        with self._locked():
            existing = self._decode(self._path(state.project_id))
            if existing is not None and existing != state:
                raise IntegrityError("project head anchor already has different state")
            if existing is None:
                self._write(state)

    def compare_and_set(
        self,
        expected: ProjectHeadAnchorState,
        current: ProjectHeadAnchorState,
    ) -> None:
        if type(expected) is not ProjectHeadAnchorState or type(current) is not (
            ProjectHeadAnchorState
        ):
            raise ValueError("anchor CAS requires exact anchor states")
        if expected.project_id != current.project_id:
            raise ValueError("anchor CAS states must belong to the same project")
        if current.sequence != expected.sequence + 1:
            raise ValueError("anchor CAS must advance exactly one revision")
        with self._locked():
            observed = self._decode(self._path(expected.project_id))
            if observed == current:
                return
            if observed != expected:
                raise IntegrityError("project head anchor compare-and-set conflict")
            self._write(current)


__all__ = (
    "DirectoryProjectHeadAnchor",
    "GENESIS_ATTESTATION_DIGEST",
    "InMemoryProjectHeadAnchor",
    "ProjectHeadAnchor",
    "ProjectHeadAnchorState",
)
