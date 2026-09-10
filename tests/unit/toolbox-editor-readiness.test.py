"""Offline readiness/ownership tests. Never start or connect to a native editor."""
import importlib.util
import io
import json
import os
from pathlib import Path
import queue
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("editor_supervisor", ROOT / "src/mcp/toolbox-editor-supervisor.py")
SUPERVISOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPERVISOR)
BOARD = os.path.abspath(os.path.join(os.path.sep, "editor-readiness-fixture", "project", "test.kicad_pcb"))
TEMP_ROOT = os.path.abspath(os.path.join(os.path.sep, "editor-readiness-fixture", "temp"))
ENVIRONMENT = {"TEMP": TEMP_ROOT, "TMP": TEMP_ROOT,
               "KICAD_API_SOCKET": "ipc://" + os.path.join(TEMP_ROOT, "kicad", "api.sock")}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class FakeCancelEvent:
    def __init__(self, clock):
        self.clock, self.cancelled = clock, False

    def is_set(self):
        return self.cancelled

    def set(self):
        self.cancelled = True

    def wait(self, seconds):
        self.clock.advance(seconds)
        return self.cancelled


class InlineWorkers:
    def __init__(self):
        self.workers = []

    def __call__(self, *, target, daemon):
        self.workers.append(SimpleNamespace(daemon=daemon))
        return SimpleNamespace(start=target)


class FakeApiError(Exception):
    def __init__(self, code):
        super().__init__("sensitive raw response TOKEN-DO-NOT-EXPOSE")
        self.code = code


class FakeConnectionNotReady(Exception):
    pass


def document(filename=BOARD, document_type=1):
    return SimpleNamespace(type=document_type, project=SimpleNamespace(path=os.path.dirname(filename)),
                           board_filename=os.path.basename(filename))


class FakeClient:
    def __init__(self, *, errors=None, version=(10, 0, 3), documents=None, blocked=None):
        self.errors = errors or {}
        self.version = version
        self.documents = [document()] if documents is None else documents
        self.blocked = blocked
        self.calls = []
        self.closed = False

    def _call(self, stage):
        self.calls.append(stage)
        if stage in self.errors:
            raise self.errors[stage]

    def get_version(self):
        self._call("version")
        if self.blocked is not None:
            entered, release = self.blocked
            entered.set()
            # The supervisor must finish its command loop before this test releases
            # the blocked worker; its configured IPC timeout cannot unblock C dial.
            if not release.wait(5):
                raise RuntimeError("test did not release the blocked fake client")
        return SimpleNamespace(major=self.version[0], minor=self.version[1], patch=self.version[2])

    def ping(self):
        self._call("ping")

    def get_open_documents(self, document_type):
        self._call("document")
        if document_type != 1:
            raise AssertionError("Only PCB documents may be requested")
        return self.documents


class FakeApi:
    pcb_type = 1

    def __init__(self, clients):
        self.clients = iter(clients)
        self.connections = []

    def create_client(self, endpoint, token):
        self.connections.append((endpoint, token))
        client = next(self.clients)
        if isinstance(client, Exception):
            raise client
        return client

    @staticmethod
    def classify_error(error):
        if isinstance(error, FakeApiError):
            return ("NOT_READY" if error.code == 4 else "NATIVE_FAILURE"), error.code
        if isinstance(error, FakeConnectionNotReady):
            return "CONNECTION_NOT_READY", None
        return "NATIVE_FAILURE", None

    @staticmethod
    def close_client(client):
        client.closed = True


class FakeProcess:
    pid = 4321

    def __init__(self, code=None):
        self.code, self.wait_count = code, 0

    def poll(self):
        return self.code

    def wait(self):
        if self.code is None:
            raise AssertionError("Must not wait on a live editor")
        self.wait_count += 1
        return self.code


class CallbackCommands:
    def __init__(self, callbacks):
        self.callbacks = iter(callbacks)

    def get(self, timeout):
        if timeout != 0.05:
            raise AssertionError("The native command loop must stay responsive")
        return next(self.callbacks)()


class ReadinessTests(unittest.TestCase):
    def monitor(self, clients, *, environment=None):
        events, clock, workers = [], FakeClock(), InlineWorkers()
        api = FakeApi(clients)
        monitor = SUPERVISOR.ReadinessMonitor(
            BOARD, ENVIRONMENT if environment is None else environment, events.append,
            clock=clock, api_factory=lambda: api, worker_factory=workers,
            cancel_event=FakeCancelEvent(clock))
        return monitor, events, clock, workers, api

    def terminal(self, events):
        return [event for event in events if event["type"] in ("ready", "readiness_failed")]

    def test_not_ready_then_ready_retains_first_failure_and_exact_endpoint(self):
        first = FakeClient(errors={"version": FakeApiError(4)})
        second = FakeClient()
        value, events, clock, workers, api = self.monitor([first, second])
        value.start()
        self.assertEqual(events, [], "The worker must never emit protocol events")
        value.poll()
        value.start()
        self.assertEqual(self.terminal(events), [{"type": "ready", "attempts": 2, "elapsedMs": 250}])
        self.assertEqual(len(workers.workers), 1)
        self.assertTrue(workers.workers[0].daemon)
        self.assertEqual(first.calls, ["version"])
        self.assertEqual(second.calls, ["version", "ping", "document"])
        self.assertTrue(first.closed and second.closed)
        self.assertEqual(api.connections, [(ENVIRONMENT["KICAD_API_SOCKET"], "")] * 2)
        progress = [event for event in events if event["type"] == "readiness_progress"]
        self.assertEqual(len(progress), 3)
        self.assertEqual(progress[0]["stage"], "connection")
        self.assertEqual(progress[-1]["firstFailure"],
                         {"stage": "version", "code": "NOT_READY", "nativeCode": 4, "attempt": 1})
        self.assertNotIn("TOKEN-DO-NOT-EXPOSE", json.dumps(events))

    def test_transient_connection_can_retry_but_permanent_errors_stop(self):
        value, events, _, _, api = self.monitor([FakeConnectionNotReady("private socket"), FakeClient()])
        value.start()
        value.poll()
        self.assertEqual(self.terminal(events)[0]["type"], "ready")
        self.assertEqual(len(api.connections), 2)
        self.assertEqual(value.first_failure["code"], "CONNECTION_NOT_READY")
        for error in (FakeApiError(1), FakeApiError(5), RuntimeError("TOKEN-DO-NOT-EXPOSE")):
            with self.subTest(error_type=type(error).__name__):
                client = FakeClient(errors={"ping": error})
                value, events, _, _, api = self.monitor([client, FakeClient()])
                value.start()
                value.poll()
                failure = self.terminal(events)[0]
                self.assertEqual((failure["code"], failure["stage"], failure["attempts"]),
                                 ("NATIVE_FAILURE", "ping", 1))
                self.assertEqual(len(api.connections), 1)
                self.assertNotIn("TOKEN-DO-NOT-EXPOSE", json.dumps(events))

    def test_not_ready_at_later_stages_restarts_complete_probe(self):
        for stage in ("ping", "document"):
            with self.subTest(stage=stage):
                value, events, _, _, _ = self.monitor([
                    FakeClient(errors={stage: FakeApiError(4)}), FakeClient()])
                value.start()
                value.poll()
                self.assertEqual(self.terminal(events)[0]["type"], "ready")
                self.assertEqual(value.first_failure["stage"], stage)

    def test_later_permanent_failure_preserves_first_not_ready_diagnostic(self):
        value, events, _, _, _ = self.monitor([
            FakeClient(errors={"version": FakeApiError(4)}), FakeClient(errors={"ping": FakeApiError(5)})])
        value.start()
        value.poll()
        failure = self.terminal(events)[0]
        self.assertEqual((failure["code"], failure["nativeCode"], failure["stage"], failure["attempts"]),
                         ("NATIVE_FAILURE", 5, "ping", 2))
        self.assertEqual(failure["firstFailure"],
                         {"stage": "version", "code": "NOT_READY", "nativeCode": 4, "attempt": 1})

    def test_wrong_or_ambiguous_document_stops_and_rejects_native_close(self):
        other = os.path.join(os.path.dirname(os.path.dirname(BOARD)), "other", "test.kicad_pcb")
        missing_filename = SimpleNamespace(type=1, project=SimpleNamespace(path=BOARD), board_filename="")
        for documents in ([document(other)], [], [document(), document()], [document(document_type=2)], [missing_filename]):
            with self.subTest(document_count=len(documents)):
                value, events, _, _, api = self.monitor([FakeClient(documents=documents), FakeClient()])
                process, closed = FakeProcess(), []

                def exit_after_rejection():
                    process.code = 0
                    raise queue.Empty

                commands = CallbackCommands([lambda: "close", exit_after_rejection])
                SUPERVISOR.supervise_owned_editor(process, commands, value, lambda: closed.append(True), events.append)
                self.assertEqual(closed, [])
                self.assertEqual(len(api.connections), 1)
                self.assertEqual(self.terminal(events)[0]["code"], "WRONG_DOCUMENT")
                self.assertEqual(events[-2]["type"], "close_rejected")
                self.assertEqual(events[-1], {"type": "native_exit", "code": 0})

    def test_version_mismatch_has_no_further_native_reads(self):
        client = FakeClient(version=(10, 0, 2))
        value, events, _, _, _ = self.monitor([client, FakeClient()])
        value.start()
        value.poll()
        self.assertEqual(client.calls, ["version"])
        failure = self.terminal(events)[0]
        self.assertEqual(failure["code"], "VERSION_MISMATCH")
        self.assertEqual(failure["firstFailure"],
                         {"stage": "version", "code": "VERSION_MISMATCH", "nativeCode": None, "attempt": 1})

    def test_invalid_endpoint_never_constructs_native_client(self):
        for update in ({"KICAD_API_SOCKET": "tcp://127.0.0.1:9999"}, {"TMP": "relative"},
                       {"KICAD_API_SOCKET": "ipc://" + os.path.join(TEMP_ROOT, "other.sock")},
                       {"KICAD_API_SOCKET": "ipc://" + "x" * 129}):
            with self.subTest(update=update):
                value, events, _, _, api = self.monitor([], environment={**ENVIRONMENT, **update})
                value.start()
                value.poll()
                self.assertEqual(api.connections, [])
                self.assertEqual(self.terminal(events)[0],
                                 {"type": "readiness_failed", "code": "INVALID_ENDPOINT", "stage": "connection",
                                  "attempts": 0, "elapsedMs": 0, "nativeCode": None, "firstFailure": None})

    def test_retries_stop_at_budget_without_replacing_worker(self):
        clients = [FakeClient(errors={"version": FakeApiError(4)}) for _ in range(121)]
        value, events, clock, workers, api = self.monitor(clients)
        value.start()
        value.poll()
        value.start()
        self.assertEqual(clock(), 30.0)
        self.assertEqual(len(api.connections), 120)
        self.assertEqual(len(workers.workers), 1)
        failure = self.terminal(events)[0]
        self.assertEqual((failure["code"], failure["attempts"], failure["elapsedMs"]), ("DEADLINE", 120, 30000))
        self.assertEqual(failure["firstFailure"]["nativeCode"], 4)

    def test_permanent_failure_retains_owned_process_close_and_exit(self):
        value, events, _, _, _ = self.monitor([FakeClient(errors={"version": FakeApiError(5)})])
        process, closed = FakeProcess(), []

        def close():
            closed.append(process.pid)
            process.code = 7

        SUPERVISOR.supervise_owned_editor(process, CallbackCommands([lambda: "close"]), value, close, events.append)
        self.assertEqual(closed, [4321])
        self.assertEqual([event["type"] for event in events[-3:]],
                         ["readiness_failed", "close_ack", "native_exit"])
        self.assertEqual(process.wait_count, 1)

    def test_blocked_worker_does_not_block_deadline_cancellation_or_early_exit(self):
        for mode in ("deadline", "cancel", "exit"):
            with self.subTest(mode=mode):
                entered, release, clock = threading.Event(), threading.Event(), FakeClock()
                client = FakeClient(blocked=(entered, release))
                api, events, threads = FakeApi([client]), [], []

                def worker_factory(**kwargs):
                    thread = threading.Thread(**kwargs)
                    threads.append(thread)
                    return thread

                value = SUPERVISOR.ReadinessMonitor(BOARD, ENVIRONMENT, events.append, clock=clock,
                                                   api_factory=lambda: api, worker_factory=worker_factory)
                process, closed = FakeProcess(), []

                def while_blocked():
                    self.assertTrue(entered.wait(1))
                    if mode == "deadline":
                        clock.advance(30)
                    elif mode == "exit":
                        process.code = 23
                    else:
                        return "close"
                    raise queue.Empty

                def close():
                    closed.append(process.pid)
                    process.code = 0

                callbacks = [while_blocked] + ([lambda: "close"] if mode == "deadline" else [])
                try:
                    SUPERVISOR.supervise_owned_editor(process, CallbackCommands(callbacks), value, close, events.append)
                    self.assertTrue(threads[0].is_alive(), "The command loop must finish without joining blocked IPC")
                    self.assertTrue(threads[0].daemon)
                    self.assertEqual(len(threads), 1)
                    expected = {"deadline": "DEADLINE", "cancel": "CANCELLED", "exit": "EDITOR_EXITED"}[mode]
                    terminal = self.terminal(events)
                    self.assertEqual(len(terminal), 1)
                    self.assertEqual((terminal[0]["code"], terminal[0]["stage"], terminal[0]["attempts"]),
                                     (expected, "version", 1))
                    self.assertEqual(closed, [] if mode == "exit" else [4321])
                    self.assertEqual(events[-1], {"type": "native_exit", "code": 23 if mode == "exit" else 0})
                    self.assertEqual(process.wait_count, 1)
                finally:
                    release.set()
                    for thread in threads:
                        thread.join(1)  # Test cleanup only; never performed by supervisor.
                snapshot = list(events)
                value.poll()
                value.start()
                self.assertEqual(events, snapshot, "Late worker completion must not emit or replace terminal readiness")
                self.assertEqual(client.calls, ["version"])

    def test_exit_before_any_probe_still_emits_failure_before_native_exit(self):
        events, workers = [], []

        def never_scheduled(**kwargs):
            workers.append(kwargs)
            return SimpleNamespace(start=lambda: None)

        value = SUPERVISOR.ReadinessMonitor(BOARD, ENVIRONMENT, events.append, clock=FakeClock(),
                                           worker_factory=never_scheduled)
        process = FakeProcess(19)
        SUPERVISOR.supervise_owned_editor(process, CallbackCommands([]), value,
                                         lambda: self.fail("Exited process must not close"), events.append)
        self.assertEqual([event["type"] for event in events], ["readiness_failed", "native_exit"])
        self.assertEqual((events[0]["code"], events[0]["attempts"], events[0]["nativeCode"]),
                         ("EDITOR_EXITED", 0, 19))

    def test_ready_is_rechecked_against_deadline_and_original_process(self):
        for mode in ("deadline", "exit"):
            with self.subTest(mode=mode):
                value, events, clock, _, _ = self.monitor([FakeClient()])
                value.start()

                def emit(event):
                    events.append(event)
                    if event["type"] == "readiness_progress" and mode == "deadline":
                        clock.advance(30)

                value.emit_event = emit
                value.poll(lambda: 31 if mode == "exit" else None)
                failure = self.terminal(events)[0]
                self.assertEqual(failure["code"], "DEADLINE" if mode == "deadline" else "EDITOR_EXITED")
                self.assertEqual(failure["nativeCode"], None if mode == "deadline" else 31)

    def test_spawn_is_immediate_and_wrong_document_is_rechecked_after_window_enumeration(self):
        events, posted, observed = [], [], []
        process = FakeProcess()
        value, _, _, _, _ = self.monitor([])
        value.emit_event = events.append
        pid_reads = []

        def read_window_pid(hwnd, pid):
            pid._obj.value = process.pid
            pid_reads.append(hwnd)
            if len(pid_reads) == 2:
                # Simulate a mismatch completing during main-window enumeration.
                value.wrong_document.set()
            return 1

        def window_class(hwnd, name, size):
            name.value = "PcbFrame"
            return len(name.value)

        user32 = SimpleNamespace(
            EnumWindows=mock.Mock(side_effect=lambda visit, _: visit(77, 0)),
            IsWindowVisible=mock.Mock(return_value=True),
            GetWindow=mock.Mock(return_value=0),
            GetWindowThreadProcessId=mock.Mock(side_effect=read_window_pid),
            GetClassNameW=mock.Mock(side_effect=window_class),
            PostMessageW=mock.Mock(side_effect=lambda *args: posted.append(args)))

        def monitor_factory(*args, **kwargs):
            self.assertEqual(events, [{"type": "spawn", "pid": process.pid}])
            return value

        def supervise(actual_process, commands, readiness, request_close):
            self.assertIs(actual_process, process)
            self.assertIs(readiness, value)
            self.assertFalse(value.wrong_document.is_set())
            with self.assertRaisesRegex(RuntimeError, "document differs"):
                request_close()
            observed.append(True)

        launch = {"executablePath": os.path.join(os.path.dirname(BOARD), "pcbnew.exe"),
                  "boardPath": BOARD, "environment": ENVIRONMENT}
        with mock.patch.object(SUPERVISOR.sys, "platform", "win32"), \
                mock.patch.object(SUPERVISOR.sys, "stdin", io.StringIO(json.dumps(launch) + "\n")), \
                mock.patch.object(SUPERVISOR.subprocess, "Popen", return_value=process) as popen, \
                mock.patch.object(SUPERVISOR.ctypes, "WinDLL", return_value=user32, create=True), \
                mock.patch.object(SUPERVISOR.ctypes, "WINFUNCTYPE", return_value=lambda callback: callback, create=True), \
                mock.patch.object(SUPERVISOR.threading, "Thread", return_value=SimpleNamespace(start=lambda: None)), \
                mock.patch.object(SUPERVISOR, "ReadinessMonitor", side_effect=monitor_factory), \
                mock.patch.object(SUPERVISOR, "supervise_owned_editor", side_effect=supervise), \
                mock.patch.object(SUPERVISOR, "emit", side_effect=events.append):
            SUPERVISOR.main()
        self.assertEqual(observed, [True])
        self.assertEqual(posted, [])
        self.assertEqual(popen.call_args.args, ([launch["executablePath"], BOARD],))
        self.assertEqual(popen.call_args.kwargs["env"], ENVIRONMENT)

    def test_native_classifier_uses_typed_context_without_sensitive_text(self):
        # Importing pinned KiPy types is offline. No client or socket is created.
        api = SUPERVISOR.NativeReadinessApi()
        import pynng
        for transport, retry in ((pynng.exceptions.Timeout, True),
                                 (pynng.exceptions.ConnectionRefused, True),
                                 (pynng.exceptions.PermissionDenied, False),
                                 (pynng.exceptions.AddressInvalid, False),
                                 (pynng.exceptions.AuthenticationError, False)):
            try:
                try:
                    raise transport("TOKEN-DO-NOT-EXPOSE", 1)
                except Exception:
                    raise api.connection_error("TOKEN-DO-NOT-EXPOSE") from None
            except Exception as error:
                self.assertEqual(api.classify_error(error),
                                 ("CONNECTION_NOT_READY" if retry else "NATIVE_FAILURE", None))
        self.assertEqual(api.classify_error(api.api_error("private", code=4)), ("NOT_READY", 4))
        self.assertEqual(api.classify_error(api.api_error("private", code=5)), ("NATIVE_FAILURE", 5))
        self.assertEqual(api.classify_error(api.connection_error("timeout text alone is not evidence")),
                         ("NATIVE_FAILURE", None))

    def test_native_client_receives_exact_uri_explicit_token_and_short_io_timeout(self):
        api = SUPERVISOR.NativeReadinessApi()
        api.client_type = mock.Mock(return_value=SimpleNamespace())
        endpoint = ENVIRONMENT["KICAD_API_SOCKET"]
        with mock.patch.dict(os.environ, {"KICAD_API_SOCKET": "ipc://ambient.sock", "KICAD_API_TOKEN": "ambient-private"}):
            api.create_client(endpoint, "")
        api.client_type.assert_called_once_with(socket_path=endpoint, client_name="evleda-owned-editor-readiness",
                                                kicad_token="", timeout_ms=1000)


if __name__ == "__main__":
    unittest.main()
