"""Bounded, shell-free process execution for the local KiCad worker."""

from __future__ import annotations

import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread
from typing import IO, Protocol, cast


@dataclass(frozen=True, slots=True)
class CompletedCommand:
    argv: tuple[str, ...]
    exit_code: int
    stdout: bytes
    stderr: bytes

    def __post_init__(self) -> None:
        if type(self) is not CompletedCommand:
            raise TypeError("completed command must use the exact type")
        if type(self.argv) is not tuple or not self.argv or any(
            type(item) is not str or not item for item in self.argv
        ):
            raise ValueError("completed command argv must be a non-empty exact string tuple")
        if type(self.exit_code) is not int:
            raise ValueError("completed command exit_code must be an exact integer")
        if type(self.stdout) is not bytes or type(self.stderr) is not bytes:
            raise ValueError("completed command output must be exact bytes")


class CommandExecutionError(RuntimeError):
    """Base class for a process that could not yield a bounded outcome."""


class CommandLaunchError(CommandExecutionError):
    pass


class CommandTimeoutError(CommandExecutionError):
    pass


class CommandOutputLimitError(CommandExecutionError):
    def __init__(self, stream: str) -> None:
        super().__init__(f"KiCad {stream} exceeded its configured byte cap")
        self.stream = stream


class CommandRunner(Protocol):
    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand: ...


def _absolute_path(value: object) -> Path:
    if not isinstance(value, Path) or not value.is_absolute():
        raise TypeError("runner cwd must be an absolute pathlib.Path")
    return value


class SubprocessRunner:
    """Execute one argv directly and kill on timeout or either output cap."""

    @staticmethod
    def _reader(
        stream: IO[bytes],
        cap: int,
        target: bytearray,
        exceeded: Event,
        finished: Event,
    ) -> None:
        try:
            while True:
                chunk = stream.read(65_536)
                if not chunk:
                    return
                remaining = cap - len(target)
                if remaining > 0:
                    target.extend(chunk[:remaining])
                if len(chunk) > remaining:
                    exceeded.set()
                    return
        finally:
            finished.set()

    def run(
        self,
        argv: tuple[str, ...],
        *,
        cwd: Path,
        environment: Mapping[str, str],
        timeout_seconds: int,
        max_stdout_bytes: int,
        max_stderr_bytes: int,
    ) -> CompletedCommand:
        if type(argv) is not tuple or not argv or any(type(item) is not str for item in argv):
            raise TypeError("runner argv must be an exact string tuple")
        cwd = _absolute_path(cwd)
        environment_value: object = environment
        if type(environment_value) is not dict:
            raise TypeError("runner environment must be an exact string dictionary")
        untyped_environment = cast(dict[object, object], environment_value)
        if any(
            type(key) is not str or type(value) is not str
            for key, value in untyped_environment.items()
        ):
            raise TypeError("runner environment must be an exact string dictionary")
        exact_environment = cast(dict[str, str], untyped_environment)
        if any(
            type(value) is not int or value < 1
            for value in (timeout_seconds, max_stdout_bytes, max_stderr_bytes)
        ):
            raise ValueError("runner limits must be positive exact integers")

        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            process = subprocess.Popen(
                argv,
                cwd=str(cwd),
                env=exact_environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                creationflags=creation_flags,
            )
        except OSError as exc:
            raise CommandLaunchError("KiCad process could not be launched") from exc
        if process.stdout is None or process.stderr is None:
            process.kill()
            raise CommandLaunchError("KiCad process pipes were not created")

        stdout = bytearray()
        stderr = bytearray()
        stdout_exceeded = Event()
        stderr_exceeded = Event()
        stdout_finished = Event()
        stderr_finished = Event()
        stdout_thread = Thread(
            target=self._reader,
            args=(
                process.stdout,
                max_stdout_bytes,
                stdout,
                stdout_exceeded,
                stdout_finished,
            ),
            daemon=True,
        )
        stderr_thread = Thread(
            target=self._reader,
            args=(
                process.stderr,
                max_stderr_bytes,
                stderr,
                stderr_exceeded,
                stderr_finished,
            ),
            daemon=True,
        )
        stdout_thread.start()
        stderr_thread.start()
        timed_out = False
        deadline = time.monotonic() + timeout_seconds
        while process.poll() is None:
            if stdout_exceeded.is_set() or stderr_exceeded.is_set():
                process.kill()
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                process.kill()
                break
            time.sleep(min(0.02, remaining))
        process.wait()
        try:
            stdout_finished.wait(timeout=5)
            stderr_finished.wait(timeout=5)
        finally:
            process.stdout.close()
            process.stderr.close()
            stdout_thread.join(timeout=1)
            stderr_thread.join(timeout=1)

        if stdout_exceeded.is_set():
            raise CommandOutputLimitError("stdout")
        if stderr_exceeded.is_set():
            raise CommandOutputLimitError("stderr")
        if timed_out:
            raise CommandTimeoutError("KiCad process exceeded its configured timeout")
        exit_code = process.returncode
        if type(exit_code) is not int:
            raise CommandLaunchError("KiCad process returned no exit status")
        return CompletedCommand(argv, exit_code, bytes(stdout), bytes(stderr))


__all__ = (
    "CommandExecutionError",
    "CommandLaunchError",
    "CommandOutputLimitError",
    "CommandRunner",
    "CommandTimeoutError",
    "CompletedCommand",
    "SubprocessRunner",
)
