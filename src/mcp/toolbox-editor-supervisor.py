"""Fixed host-only Windows PCB editor supervisor; never accepts PID/window targets."""
import ctypes
from ctypes import wintypes
import json
import os
import queue
import subprocess
import sys
import threading


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
        if not user32.PostMessageW(hwnd, 0x0010, 0, 0):  # WM_CLOSE; never dismiss a dialog.
            raise RuntimeError("Could not request owned editor close")

    while process.poll() is None:
        try:
            command = commands.get(timeout=0.05)
        except queue.Empty:
            continue
        try:
            if command != "close":
                raise RuntimeError("Only the fixed close request is accepted")
            request_close()
            emit({"type": "close_ack"})
        except Exception as error:
            emit({"type": "close_rejected", "message": str(error)})
    emit({"type": "native_exit", "code": process.wait()})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"type": "error", "message": str(error)})
        sys.exit(1)
