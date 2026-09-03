"""Fail-closed KiCad discovery for the trusted local host.

Automatic discovery is deliberately limited to protected, conventional
platform installation locations. ``PATH`` and executable-selection
environment variables are never consulted. A host may instead supply an
absolute, human-reviewed ``--kicad-cli`` path.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
import subprocess
import sys
from collections.abc import Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .reference_host import ReferenceHostConfigurationError

_KICAD_CLI_NAMES = frozenset({"kicad-cli", "kicad-cli.exe"})
_VERSION = re.compile(r"10\.[0-9]+\.[0-9]+")
_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
_WINDOWS_PLATFORM_ROOTS = (Path(r"C:\Program Files"), Path(r"C:\Program Files (x86)"))


@dataclass(frozen=True, slots=True)
class _FileIdentity:
    device: int
    inode: int
    mode: int
    link_count: int
    size_bytes: int
    modified_ns: int
    changed_ns: int
    file_attributes: int

    @classmethod
    def from_stat(cls, metadata: os.stat_result) -> _FileIdentity:
        attributes = getattr(metadata, "st_file_attributes", 0)
        return cls(
            int(metadata.st_dev),
            int(metadata.st_ino),
            int(metadata.st_mode),
            int(metadata.st_nlink),
            int(metadata.st_size),
            int(metadata.st_mtime_ns),
            int(metadata.st_ctime_ns),
            int(attributes) if isinstance(attributes, int) else 0,
        )


@dataclass(frozen=True, slots=True)
class _OpenedExecutable:
    descriptor: int
    identity: _FileIdentity
    path_identity: _FileIdentity
    path_chain: tuple[_FileIdentity, ...]
    sha256: str


@dataclass(frozen=True, slots=True)
class KiCadInstallation:
    """An executable resolved and pinned before the MCP service starts."""

    executable: Path
    sha256: str
    version: str
    origin: str

    def __post_init__(self) -> None:
        if not self.executable.is_absolute():
            raise ReferenceHostConfigurationError("KiCad executable path must be absolute")
        _assert_safe_path(self.executable, source="KiCad")
        if self.executable.name.lower() not in _KICAD_CLI_NAMES:
            raise ReferenceHostConfigurationError("KiCad executable must be named kicad-cli")
        if re.fullmatch(r"[0-9a-f]{64}", self.sha256) is None:
            raise ReferenceHostConfigurationError("KiCad executable hash is invalid")
        if _VERSION.fullmatch(self.version) is None:
            raise ReferenceHostConfigurationError("KiCad CLI must report an exact KiCad 10 version")
        if self.origin not in {"override", "platform"}:
            raise ReferenceHostConfigurationError("KiCad discovery origin is invalid")


def _path_nodes(path: Path) -> tuple[Path, ...]:
    parts = path.parts
    if not parts:
        return ()
    current = Path(parts[0])
    nodes = [current]
    for part in parts[1:]:
        current /= part
        nodes.append(current)
    return tuple(nodes)


def _is_link_or_reparse(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    reparse = isinstance(attributes, int) and bool(attributes & _REPARSE_POINT)
    return stat.S_ISLNK(metadata.st_mode) or reparse


def _same_file_object(left: _FileIdentity, right: _FileIdentity) -> bool:
    """Compare fields represented consistently by path-stat and fd-stat."""

    return (
        left.device,
        left.inode,
        left.size_bytes,
        left.modified_ns,
        left.file_attributes,
    ) == (
        right.device,
        right.inode,
        right.size_bytes,
        right.modified_ns,
        right.file_attributes,
    )


def _inspect_safe_path(
    path: Path, *, source: str
) -> tuple[os.stat_result, tuple[_FileIdentity, ...]]:
    """Reject links, reparse points, missing nodes, and non-regular targets."""

    nodes = _path_nodes(path)
    if not path.is_absolute() or not nodes:
        raise ReferenceHostConfigurationError(f"{source} KiCad executable path must be absolute")
    try:
        identities: list[_FileIdentity] = []
        for node in nodes[:-1]:
            metadata = node.lstat()
            if _is_link_or_reparse(metadata) or not stat.S_ISDIR(metadata.st_mode):
                raise ReferenceHostConfigurationError(
                    f"{source} KiCad executable path contains a link or reparse point"
                )
            identities.append(_FileIdentity.from_stat(metadata))
        target = nodes[-1].lstat()
    except FileNotFoundError as exc:
        raise ReferenceHostConfigurationError(
            f"{source} KiCad executable is unavailable"
        ) from exc
    except OSError as exc:
        raise ReferenceHostConfigurationError(
            f"{source} KiCad executable path could not be inspected safely"
        ) from exc
    if _is_link_or_reparse(target):
        raise ReferenceHostConfigurationError(
            f"{source} KiCad executable cannot be a link or reparse point"
        )
    if not stat.S_ISREG(target.st_mode):
        raise ReferenceHostConfigurationError(
            f"{source} must identify a regular kicad-cli executable"
        )
    identities.append(_FileIdentity.from_stat(target))
    return target, tuple(identities)


def _assert_safe_path(path: Path, *, source: str) -> os.stat_result:
    return _inspect_safe_path(path, source=source)[0]


def _canonical_executable(value: Path, *, source: str) -> Path:
    try:
        candidate = value.expanduser()
    except (OSError, RuntimeError) as exc:
        raise ReferenceHostConfigurationError(
            f"{source} KiCad executable path could not be expanded"
        ) from exc
    if not candidate.is_absolute():
        raise ReferenceHostConfigurationError(
            f"{source} KiCad executable path must be absolute"
        )
    candidate = Path(os.path.abspath(candidate))
    if candidate.name.lower() not in _KICAD_CLI_NAMES:
        raise ReferenceHostConfigurationError(f"{source} must identify a kicad-cli executable")
    _assert_safe_path(candidate, source=source)
    return candidate


def _platform_candidates(environment: Mapping[str, str]) -> tuple[Path, ...]:
    """Return fixed official install locations without consulting ``PATH``."""

    del environment
    if os.name == "nt":
        return tuple(
            root / "KiCad" / "10.0" / "bin" / "kicad-cli.exe"
            for root in _WINDOWS_PLATFORM_ROOTS
        )
    if sys.platform == "darwin":
        return (
            Path("/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"),
            Path("/Applications/KiCad.app/Contents/MacOS/kicad-cli"),
        )
    return (Path("/usr/bin/kicad-cli"),)


def _is_platform_owned(path: Path) -> bool:
    """Conservatively recognize protected OS installation trees."""

    if os.name == "nt":
        return any(path.is_relative_to(root) for root in _WINDOWS_PLATFORM_ROOTS)
    try:
        for node in _path_nodes(path):
            metadata = node.lstat()
            if _is_link_or_reparse(metadata) or metadata.st_uid != 0:
                return False
            if metadata.st_mode & stat.S_IWOTH:
                return False
            if metadata.st_mode & stat.S_IWGRP and metadata.st_gid != 0:
                return False
    except OSError:
        return False
    return True


def discover_kicad_cli(
    override: Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> tuple[Path, str] | None:
    """Select an explicit reviewed CLI or a protected platform installation.

    ``PATH``, ``EVLEDA_KICAD_CLI``, and legacy executable-selection variables
    are intentionally ignored. An explicit argument wins and fails closed;
    otherwise missing automatic candidates return ``None``.
    """

    env = os.environ if environment is None else environment
    if override is not None:
        return _canonical_executable(override, source="--kicad-cli"), "override"
    for candidate in _platform_candidates(env):
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise ReferenceHostConfigurationError(
                "platform KiCad executable path could not be inspected safely"
            ) from exc
        executable = _canonical_executable(candidate, source="platform")
        if not _is_platform_owned(executable):
            raise ReferenceHostConfigurationError(
                "automatic KiCad executable is not in a platform-owned installation"
            )
        return executable, "platform"
    return None


def _hash_descriptor(descriptor: int, *, expected_size: int, source: str) -> str:
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        digest = hashlib.sha256()
        size = 0
        while block := os.read(descriptor, 1_048_576):
            digest.update(block)
            size += len(block)
    except OSError as exc:
        raise ReferenceHostConfigurationError(f"{source} could not be read safely") from exc
    if size != expected_size:
        raise ReferenceHostConfigurationError(f"{source} changed while it was being read")
    return digest.hexdigest()


@contextmanager
def _open_executable(path: Path, *, source: str) -> Generator[_OpenedExecutable]:
    """Open and hash one regular non-link file while retaining its identity."""

    before, expected_path_chain = _inspect_safe_path(path, source=source)
    expected_path_identity = _FileIdentity.from_stat(before)
    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ReferenceHostConfigurationError(f"{source} could not be opened safely") from exc
    try:
        opened = os.fstat(descriptor)
        opened_identity = _FileIdentity.from_stat(opened)
        if (
            _is_link_or_reparse(opened)
            or not stat.S_ISREG(opened.st_mode)
            or not _same_file_object(opened_identity, expected_path_identity)
        ):
            raise ReferenceHostConfigurationError(f"{source} changed before it was opened")
        digest = _hash_descriptor(
            descriptor,
            expected_size=opened_identity.size_bytes,
            source=source,
        )
        after_read = _FileIdentity.from_stat(os.fstat(descriptor))
        path_after_metadata, path_after_chain = _inspect_safe_path(path, source=source)
        path_after_read = _FileIdentity.from_stat(path_after_metadata)
        if (
            after_read != opened_identity
            or path_after_read != expected_path_identity
            or path_after_chain != expected_path_chain
            or not _same_file_object(after_read, path_after_read)
        ):
            raise ReferenceHostConfigurationError(f"{source} changed while it was hashed")
        yield _OpenedExecutable(
            descriptor,
            opened_identity,
            expected_path_identity,
            expected_path_chain,
            digest,
        )
    finally:
        os.close(descriptor)


def _verify_open_executable(path: Path, opened: _OpenedExecutable, *, source: str) -> None:
    descriptor_before = _FileIdentity.from_stat(os.fstat(opened.descriptor))
    digest = _hash_descriptor(
        opened.descriptor,
        expected_size=opened.identity.size_bytes,
        source=source,
    )
    descriptor_after = _FileIdentity.from_stat(os.fstat(opened.descriptor))
    path_after_metadata, path_after_chain = _inspect_safe_path(path, source=source)
    path_after = _FileIdentity.from_stat(path_after_metadata)
    if (
        descriptor_before != opened.identity
        or descriptor_after != opened.identity
        or path_after != opened.path_identity
        or path_after_chain != opened.path_chain
        or not _same_file_object(descriptor_after, path_after)
        or digest != opened.sha256
    ):
        raise ReferenceHostConfigurationError(f"{source} changed during version execution")


def sha256_file(path: Path) -> str:
    """Hash one stable regular file without following links or reparse points."""

    if not path.is_absolute():
        raise ReferenceHostConfigurationError("file path must be absolute")
    with _open_executable(Path(os.path.abspath(path)), source="file") as opened:
        return opened.sha256


def probe_kicad_cli(path: Path, *, origin: str, timeout_seconds: int = 10) -> KiCadInstallation:
    """Hash, identity-pin, and strictly version-check a selected KiCad CLI."""

    if origin not in {"override", "platform"}:
        raise ReferenceHostConfigurationError("KiCad discovery origin is invalid")
    if type(timeout_seconds) is not int or timeout_seconds <= 0:
        raise ReferenceHostConfigurationError("KiCad version timeout must be a positive integer")
    executable = _canonical_executable(path, source="KiCad")
    completed: subprocess.CompletedProcess[bytes] | None = None
    launch_error: OSError | subprocess.TimeoutExpired | None = None
    with _open_executable(executable, source="KiCad executable") as opened:
        try:
            completed = subprocess.run(
                (str(executable), "version"),
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=timeout_seconds,
                check=False,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            launch_error = exc
        _verify_open_executable(executable, opened, source="KiCad executable")
        executable_hash = opened.sha256
    if launch_error is not None:
        raise ReferenceHostConfigurationError("KiCad version probe failed") from launch_error
    if completed is None:
        raise ReferenceHostConfigurationError("KiCad version probe failed")
    try:
        version = completed.stdout.decode("utf-8", errors="strict").strip()
        stderr = completed.stderr.decode("utf-8", errors="strict").strip()
    except UnicodeError as exc:
        raise ReferenceHostConfigurationError("KiCad version output is not UTF-8") from exc
    if completed.returncode != 0 or stderr or _VERSION.fullmatch(version) is None:
        raise ReferenceHostConfigurationError(
            "KiCad version probe did not report an exact KiCad 10.x.y"
        )
    return KiCadInstallation(executable, executable_hash, version, origin)


def resolve_kicad_installation(
    override: Path | None = None,
    *,
    environment: Mapping[str, str] | None = None,
) -> KiCadInstallation | None:
    found = discover_kicad_cli(override, environment=environment)
    if found is None:
        return None
    path, origin = found
    return probe_kicad_cli(path, origin=origin)


def render_doctor(installation: KiCadInstallation | None, state_root: Path) -> str:
    """Stable human-readable diagnostics; never emits protocol frames."""

    lines = [
        "evleda-mcp doctor",
        f"platform: {sys.platform}",
        f"state_root: {state_root.expanduser().resolve(strict=False)}",
        "stdio: safe newline-delimited JSON-RPC only",
        (
            "kicad_discovery: reviewed absolute --kicad-cli or protected platform install; "
            "PATH ignored"
        ),
    ]
    if installation is None:
        lines.append("kicad: not found in trusted locations (serve remains inspect-only)")
    else:
        lines.extend(
            (
                f"kicad: {installation.executable}",
                f"kicad_version: {installation.version}",
                f"kicad_sha256: {installation.sha256}",
                f"kicad_origin: {installation.origin}",
            )
        )
    return "\n".join(lines) + "\n"


def no_shell_passthrough(argv: Sequence[str]) -> tuple[str, ...]:
    """Testable contract that user-provided command forwarding is unavailable."""

    if argv:
        raise ReferenceHostConfigurationError("shell command passthrough is not supported")
    return ()


__all__ = (
    "KiCadInstallation",
    "discover_kicad_cli",
    "no_shell_passthrough",
    "probe_kicad_cli",
    "render_doctor",
    "resolve_kicad_installation",
    "sha256_file",
)
