from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from backend.kicad_worker import (
    CommandOutputLimitError,
    CommandTimeoutError,
    SubprocessRunner,
)


def environment() -> dict[str, str]:
    result = {"PATH": os.environ.get("PATH", "")}
    if os.name == "nt":
        system_root = os.environ.get("SYSTEMROOT", r"C:\Windows")
        result.update({"SYSTEMROOT": system_root, "WINDIR": system_root})
    return result


def test_subprocess_runner_kills_output_over_cap_without_a_shell(tmp_path: Path) -> None:
    runner = SubprocessRunner()
    with pytest.raises(CommandOutputLimitError, match="stdout"):
        runner.run(
            (sys.executable, "-c", "import sys;sys.stdout.write('x'*2000000)"),
            cwd=tmp_path,
            environment=environment(),
            timeout_seconds=10,
            max_stdout_bytes=1024,
            max_stderr_bytes=1024,
        )


def test_subprocess_runner_kills_timeout(tmp_path: Path) -> None:
    runner = SubprocessRunner()
    with pytest.raises(CommandTimeoutError):
        runner.run(
            (sys.executable, "-c", "import time;time.sleep(5)"),
            cwd=tmp_path,
            environment=environment(),
            timeout_seconds=1,
            max_stdout_bytes=1024,
            max_stderr_bytes=1024,
        )

