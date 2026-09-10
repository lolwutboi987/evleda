"""Fixed host-only Windows PCB editor supervisor; never accepts PID/window targets."""
import ctypes
from ctypes import wintypes
import json
import os
import queue
import subprocess
import sys
import threading
import time


EDITOR_START_BUDGET_SECONDS = 30.0
READINESS_IO_TIMEOUT_MS = 1000
READINESS_RETRY_SECONDS = 0.25
EXPECTED_VERSION = (10, 0, 3)


def canonical_path(value):
    if not isinstance(value, str) or not value or "\x00" in value or not os.path.isabs(value):
        raise ValueError("Expected absolute native path")
    return os.path.normcase(os.path.realpath(value))


def readiness_endpoint(environment):
    endpoint = environment.get("KICAD_API_SOCKET", "")
    temp_root, tmp_root = environment.get("TEMP", ""), environment.get("TMP", "")
    # Preserve the URI exactly. KiCad's listener uses the launched environment's
    # TEMP/TMP, not this supervisor's temporary directory or a client override.
    if (not endpoint.startswith("ipc://") or len(endpoint.encode("utf-8")) > 128
            or canonical_path(temp_root) != canonical_path(tmp_root)
            or canonical_path(endpoint[6:]) != canonical_path(os.path.join(temp_root, "kicad", "api.sock"))):
        raise ValueError("Invalid private editor endpoint")
    return endpoint


class NativeReadinessApi:
    """Pinned KiPy reads only; imports occur on the sole readiness worker."""

    def __init__(self):
        from kipy import KiCad
        from kipy.errors import ApiError, ConnectionError
        from kipy.proto.common.types import DocumentType
        import pynng
        self.client_type = KiCad
        self.api_error = ApiError
        self.connection_error = ConnectionError
        self.pcb_type = DocumentType.DOCTYPE_PCB
        self.transient_transport = (pynng.exceptions.Timeout, pynng.exceptions.ConnectionRefused,
                                    pynng.exceptions.TryAgain, pynng.exceptions.NoEntry,
                                    pynng.exceptions.DestinationUnreachable,
                                    pynng.exceptions.ConnectionReset, pynng.exceptions.ConnectionAborted)

    def create_client(self, endpoint, token):
        return self.client_type(socket_path=endpoint, client_name="evleda-owned-editor-readiness",
                                kicad_token=token, timeout_ms=READINESS_IO_TIMEOUT_MS)

    def classify_error(self, error):
        if isinstance(error, self.api_error):
            native_code = error.code if type(error.code) is int else None
            return ("NOT_READY" if native_code == 4 else "NATIVE_FAILURE", native_code)
        # KiPy wraps NNG failures with `from None`, retaining the typed error in
        # __context__. Never classify by exception text (which can contain tokens).
        transport = error.__context__ if isinstance(error, self.connection_error) else error
        if isinstance(transport, self.transient_transport + (TimeoutError, ConnectionRefusedError,
                                                            ConnectionResetError, ConnectionAbortedError,
                                                            FileNotFoundError)):
            return "CONNECTION_NOT_READY", None
        return "NATIVE_FAILURE", None

    @staticmethod
    def close_client(client):
        # KiPy has no public close method. Release only this worker's socket;
        # never touch the original Popen handle or wait for another thread.
        connection = getattr(getattr(client, "_client", None), "_conn", None)
        if connection is not None:
            connection.close()


class ReadinessMonitor:
    """Main-thread event owner with one cancellable, possibly blocked worker."""

    def __init__(self, board, environment, emit_event, *, started=None, clock=time.monotonic,
                 api_factory=NativeReadinessApi, worker_factory=threading.Thread,
                 cancel_event=None, updates=None):
        self.board, self.environment, self.emit_event = board, environment, emit_event
        self.clock = clock
        self.started = clock() if started is None else started
        self.deadline = self.started + EDITOR_START_BUDGET_SECONDS
        self.api_factory, self.worker_factory = api_factory, worker_factory
        self.cancel_event = cancel_event if cancel_event is not None else threading.Event()
        self.updates = updates if updates is not None else queue.Queue()
        self.wrong_document = threading.Event()
        self.worker_started = False
        self.finished = False
        self.stage, self.attempts, self.first_failure = "connection", 0, None

    def start(self):
        if self.worker_started or self.finished:
            return
        self.worker_started = True
        try:
            self.worker_factory(target=self._probe, daemon=True).start()
        except Exception:
            self.finish("NATIVE_FAILURE")

    def _publish(self, kind, **fields):
        self.updates.put((kind, fields))

    def _active(self):
        return not self.cancel_event.is_set() and self.clock() < self.deadline

    def _probe(self):
        try:
            endpoint = readiness_endpoint(self.environment)
            expected_board = canonical_path(self.board)
        except Exception:
            self._publish("failure", code="INVALID_ENDPOINT", nativeCode=None)
            return
        try:
            api = self.api_factory()
        except Exception:
            self._publish("failure", code="NATIVE_FAILURE", nativeCode=None)
            return
        attempt = 0
        while self._active():
            attempt += 1
            stage, client = "connection", None
            self._publish("progress", stage=stage, attempts=attempt, announce=True)
            try:
                client = api.create_client(endpoint, self.environment.get("KICAD_API_TOKEN", ""))
                if not self._active():
                    return
                stage = "version"
                self._publish("progress", stage=stage, attempts=attempt)
                version = client.get_version()
                if not self._active():
                    return
                if (version.major, version.minor, version.patch) != EXPECTED_VERSION:
                    self._publish("observed_failure", stage=stage, code="VERSION_MISMATCH",
                                  nativeCode=None, attempt=attempt)
                    self._publish("failure", code="VERSION_MISMATCH", nativeCode=None)
                    return
                stage = "ping"
                self._publish("progress", stage=stage, attempts=attempt)
                client.ping()
                if not self._active():
                    return
                stage = "document"
                self._publish("progress", stage=stage, attempts=attempt)
                documents = client.get_open_documents(api.pcb_type)
                matches = False
                if len(documents) == 1 and documents[0].type == api.pcb_type and documents[0].board_filename:
                    document = documents[0]
                    try:
                        matches = canonical_path(os.path.join(document.project.path, document.board_filename)) == expected_board
                    except (ValueError, OSError):
                        pass
                if not matches:
                    # Latch positive document mismatch even if cancellation raced
                    # the read. Main must reject any subsequent close request.
                    self.wrong_document.set()
                    self._publish("observed_failure", stage=stage, code="WRONG_DOCUMENT",
                                  nativeCode=None, attempt=attempt)
                    self._publish("failure", code="WRONG_DOCUMENT", nativeCode=None)
                    return
                if self._active():
                    self._publish("ready")
                return
            except Exception as error:
                code, native_code = api.classify_error(error)
                self._publish("observed_failure", stage=stage, code=code,
                              nativeCode=native_code, attempt=attempt)
                if code not in ("NOT_READY", "CONNECTION_NOT_READY"):
                    self._publish("failure", code="NATIVE_FAILURE", nativeCode=native_code)
                    return
            finally:
                if client is not None:
                    try:
                        api.close_client(client)
                    except Exception:
                        pass
            if self._active():
                self.cancel_event.wait(min(READINESS_RETRY_SECONDS, max(0, self.deadline - self.clock())))

    def _drain(self, accept_result, native_exit_code=None):
        while True:
            try:
                kind, fields = self.updates.get_nowait()
            except queue.Empty:
                return
            if kind == "progress":
                self.stage, self.attempts = fields["stage"], fields["attempts"]
                if accept_result and fields.get("announce", False):
                    self._emit_progress()
            elif kind == "observed_failure" and self.first_failure is None:
                self.first_failure = fields
                if accept_result and fields["code"] in ("NOT_READY", "CONNECTION_NOT_READY"):
                    self._emit_progress(fields["nativeCode"])
            elif accept_result and kind == "failure":
                self.finish(fields["code"], fields["nativeCode"])
                return
            elif accept_result and kind == "ready":
                # Emitting progress may have consumed the remaining budget, or
                # the original process may have exited since the loop's poll.
                if self.clock() >= self.deadline:
                    self.finish("DEADLINE")
                    return
                code = native_exit_code() if native_exit_code is not None else None
                if code is not None:
                    self.finish("EDITOR_EXITED", code)
                    return
                self.finished = True
                self.cancel_event.set()
                self.emit_event({"type": "ready", "attempts": self.attempts, "elapsedMs": self.elapsed_ms()})
                return

    def _emit_progress(self, native_code=None):
        self.emit_event({"type": "readiness_progress", "stage": self.stage, "attempts": self.attempts,
                         "elapsedMs": self.elapsed_ms(), "nativeCode": native_code,
                         "firstFailure": self.first_failure})

    def elapsed_ms(self):
        return max(0, int((self.clock() - self.started) * 1000))

    def poll(self, native_exit_code=None):
        if self.finished:
            return
        if self.clock() >= self.deadline:
            self.finish("DEADLINE")
        else:
            self._drain(True, native_exit_code)

    def finish(self, code, native_code=None):
        if self.finished:
            return
        self.cancel_event.set()
        self._drain(False)
        self.finished = True
        self.emit_event({"type": "readiness_failed", "code": code, "stage": self.stage,
                         "attempts": self.attempts, "elapsedMs": self.elapsed_ms(),
                         "nativeCode": native_code, "firstFailure": self.first_failure})


def supervise_owned_editor(process, commands, readiness, request_close, emit_event=None):
    emit_event = emit if emit_event is None else emit_event
    readiness.start()
    while True:
        # The original process HANDLE remains authoritative after every failure.
        if process.poll() is not None:
            code = process.wait()
            readiness.finish("EDITOR_EXITED", code)
            emit_event({"type": "native_exit", "code": code})
            return
        readiness.poll(process.poll)
        try:
            command = commands.get(timeout=0.05)
        except queue.Empty:
            continue
        try:
            if command != "close":
                raise RuntimeError("Only the fixed close request is accepted")
            readiness.finish("CANCELLED")
            if readiness.wrong_document.is_set():
                raise RuntimeError("Owned editor document differs from the launched board")
            request_close()
            emit_event({"type": "close_ack"})
        except Exception as error:
            emit_event({"type": "close_rejected", "message": str(error)})


def emit(value):
    try:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()
    except (BrokenPipeError, OSError):
        # A detached host must not cause loss of the retained native handle.
        pass


def main():
    if sys.platform != "win32":
        raise RuntimeError("Owned editor supervisor requires Windows")
    launch = json.loads(sys.stdin.readline(65537))
    if set(launch) != {"executablePath", "boardPath", "environment"}:
        raise RuntimeError("Invalid fixed launch request")
    executable, board, environment = launch["executablePath"], launch["boardPath"], launch["environment"]
    if not isinstance(executable, str) or not isinstance(board, str) or not os.path.isabs(executable) or not os.path.isabs(board):
        raise RuntimeError("Launch paths must be absolute")
    if not isinstance(environment, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k, v in environment.items()):
        raise RuntimeError("Invalid native environment")
    started = time.monotonic()
    process = subprocess.Popen([executable, board], cwd=os.path.dirname(board), env=environment,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    emit({"type": "spawn", "pid": process.pid})
    commands = queue.Queue()

    def read_commands():
        for line in sys.stdin:
            commands.put(line.rstrip("\r\n"))

    threading.Thread(target=read_commands, daemon=True).start()
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    user32.PostMessageW.restype = wintypes.BOOL

    def request_close():
        # poll uses the original Popen process HANDLE, never OpenProcess(pid).
        if process.poll() is not None:
            return
        windows, dialogs = [], []

        @callback_type
        def visit(hwnd, _):
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value != process.pid or not user32.IsWindowVisible(hwnd):
                return True
            name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, name, len(name))
            if name.value == "#32770" or user32.GetWindow(hwnd, 4):
                dialogs.append(hwnd)
            else:  # Unowned visible top-level window only.
                windows.append(hwnd)
            return True

        if not user32.EnumWindows(visit, 0):
            raise RuntimeError("Could not enumerate owned editor windows")
        if dialogs or len(windows) != 1:
            raise RuntimeError("Owned editor requires exactly one visible main window and no visible dialog")
        hwnd = windows[0]
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if process.poll() is not None or pid.value != process.pid or not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, 4):
            raise RuntimeError("Owned editor window changed before close")
        if readiness.wrong_document.is_set():
            raise RuntimeError("Owned editor document differs from the launched board")
        if not user32.PostMessageW(hwnd, 0x0010, 0, 0):  # WM_CLOSE; never dismiss a dialog.
            raise RuntimeError("Could not request owned editor close")

    readiness = ReadinessMonitor(board, environment, emit, started=started)
    supervise_owned_editor(process, commands, readiness, request_close)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
