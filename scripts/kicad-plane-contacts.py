"""Read-only KiCad 10.0.3 saved-board direct-zone-contact observation.

Invoke the pinned bundled python.exe with -I -s -E -B -S. The caller must
authenticate the executable, this helper, and its runtime closure BEFORE launch,
and apply a process deadline/output limit. Reported hashes are observations,
not runtime approval. Never infer component connectivity from an aggregate zone
unless a separate check certifies its single native filled subpolygon scope.
"""
import sys

# In particular, -I alone does not suppress KiCad's sitecustomize.py, which adds
# user-controlled third-party package paths. Refuse before importing anything else.
if not (sys.flags.isolated and sys.flags.no_user_site and sys.flags.ignore_environment
        and sys.flags.dont_write_bytecode and sys.flags.no_site):
    sys.stdout.write('{"schemaVersion":"evleda.native-plane-contacts.v1","ok":false,"error":{"code":"ISOLATED_STARTUP_REQUIRED"}}\n')
    raise SystemExit(2)

import os

BIN_ROOT = os.path.dirname(os.path.realpath(sys.executable))
INITIAL_IMPORT_PATHS = list(sys.path)
INITIAL_PREFIX = sys.prefix
INITIAL_BASE_PREFIX = sys.base_prefix
sys.path[:] = [os.path.join(BIN_ROOT, "DLLs"), os.path.join(BIN_ROOT, "Lib"),
               os.path.join(BIN_ROOT, "Lib", "site-packages")]

import ctypes
import hashlib
import json
import re

SCHEMA = "evleda.native-plane-contacts.v1"
EXPECTED_VERSION = "10.0.3"
EXPECTED_COMMIT = "146a4f2a7585c65bc580427a19b6fe2ec4a3f622"
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_ITEMS = 100000
MAX_POINTS = 250000
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class ObservationError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ObservationError(code)


def identity(file_path, source=False):
    info = os.stat(file_path)
    require(os.path.isfile(file_path) and (not source or 0 < info.st_size <= MAX_SOURCE_BYTES),
            "SOURCE_SIZE_OR_TYPE_INVALID" if source else "RUNTIME_FILE_UNAVAILABLE")
    digest = hashlib.sha256()
    with open(file_path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    require(os.stat(file_path).st_size == info.st_size, "FILE_CHANGED_DURING_READ")
    return {"sha256": digest.hexdigest(), "sizeBytes": info.st_size}


def file_identity(file_path):
    return {"path": os.path.realpath(file_path), **identity(file_path)}


def canonical(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("ascii")).hexdigest()


def integer(value):
    require(type(value) is int, "NATIVE_INTEGER_MALFORMED")
    return value


def optional_integer(value):
    require(value is None or type(value) is int, "NATIVE_OPTIONAL_MALFORMED")
    return value


def uuid(item):
    value = str(item.m_Uuid.AsString()).lower()
    require(UUID.fullmatch(value) is not None and value != "00000000-0000-0000-0000-000000000000",
            "NATIVE_UUID_MALFORMED")
    return value


def native_item(item):
    return {"uuid": uuid(item), "nativeType": integer(item.Type()),
            "nativeClass": str(item.GetClass()), "netCode": integer(item.GetNetCode()),
            "netName": str(item.GetNetname())}


def unique_inventory(items):
    require(len(items) <= MAX_ITEMS, "NATIVE_INVENTORY_LIMIT")
    result = {}
    for item in items:
        key = uuid(item)
        require(key not in result, "NATIVE_DUPLICATE_UUID")
        result[key] = item
    return result


def layers(item, board):
    values = list(item.GetLayerSet().Seq())
    require(len(values) <= 128 and len(values) == len(set(values)), "NATIVE_LAYER_INVENTORY_MALFORMED")
    return [{"id": integer(value), "name": str(board.GetLayerName(value))} for value in sorted(values)]


def contour(chain, budget):
    count = integer(chain.PointCount())
    require(count >= 3 and chain.IsClosed() is True and chain.ArcCount() == 0,
            "NATIVE_FILLED_CONTOUR_UNSUPPORTED")
    budget[0] += count
    require(budget[0] <= MAX_POINTS, "NATIVE_GEOMETRY_LIMIT")
    return [[integer(chain.CPoint(i).x), integer(chain.CPoint(i).y)] for i in range(count)]


def zone_geometry(zone, board, budget):
    result = []
    for layer in layers(zone, board):
        layer_id = layer["id"]
        present = zone.HasFilledPolysForLayer(layer_id)
        require(type(present) is bool, "NATIVE_FILLED_STATE_MALFORMED")
        polygons = []
        if present:
            native_polys = zone.GetFilledPolysList(layer_id)
            count = integer(native_polys.OutlineCount())
            require(0 <= count <= MAX_ITEMS, "NATIVE_GEOMETRY_LIMIT")
            for index in range(count):
                holes = integer(native_polys.HoleCount(index))
                require(0 <= holes <= MAX_ITEMS, "NATIVE_GEOMETRY_LIMIT")
                geometry = {"outline": contour(native_polys.COutline(index), budget),
                            "holes": [contour(native_polys.CHole(index, hole), budget) for hole in range(holes)]}
                polygons.append({"index": index, "sha256": digest(geometry),
                                 "isIsland": bool(zone.IsIsland(layer_id, index)), **geometry})
        layer.update({"hasFilledPolys": present, "fillFlag": integer(zone.GetFillFlag(layer_id)),
                      "filledSubpolygonCount": len(polygons),
                      "filledGeometrySha256": digest([{"outline": p["outline"], "holes": p["holes"]} for p in polygons]),
                      "subpolygons": polygons})
        result.append(layer)
    return result


def pad_observation(pad, board):
    item = native_item(pad)
    item.update({"footprintUuid": uuid(pad.GetParentFootprint()),
                 "reference": str(pad.GetParentFootprint().GetReference()), "number": str(pad.GetNumber()),
                 "attribute": integer(pad.GetAttribute()),
                 "localZoneConnection": integer(pad.GetLocalZoneConnection()),
                 "resolvedZoneConnectionOverride": integer(pad.GetZoneConnectionOverrides()),
                 "localThermalGapOverride": optional_integer(pad.GetLocalThermalGapOverride()),
                 "localThermalSpokeWidthOverride": optional_integer(pad.GetLocalThermalSpokeWidthOverride()),
                 "padstackMode": integer(pad.Padstack().Mode()),
                 "padstackUniqueLayers": list(pad.Padstack().UniqueLayers())})
    item["layers"] = [{**layer,
                       "zoneLayerOverride": integer(pad.GetZoneLayerOverride(layer["id"])),
                       "effectivePadstackLayer": integer(pad.Padstack().EffectiveLayerFor(layer["id"])),
                       "hasExplicitPadstackDefinition": bool(pad.Padstack().HasExplicitDefinitionForLayer(layer["id"]))}
                      for layer in layers(pad, board)]
    return item


def contacts(native_values, inventory, classes):
    result = []
    seen = set()
    for value in native_values:
        item = native_item(value)
        key = item["uuid"]
        require(key in inventory and key not in seen, "NATIVE_CONTACT_INVENTORY_MISMATCH")
        require(item == native_item(inventory[key]) and item["nativeClass"] in classes,
                "NATIVE_CONTACT_TYPE_MISMATCH")
        seen.add(key)
        # TRACKS_VEC deliberately exposes PCB_TRACK proxies even for PCB_VIA.
        item["proxyType"] = type(value).__name__
        result.append(item)
    return sorted(result, key=lambda value: value["uuid"])


def native_dependencies():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    kernel32.K32EnumProcessModules.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    kernel32.K32EnumProcessModules.restype = ctypes.c_int
    kernel32.K32GetModuleFileNameExW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32]
    kernel32.K32GetModuleFileNameExW.restype = ctypes.c_uint32
    kernel32.GetWindowsDirectoryW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32]
    kernel32.GetWindowsDirectoryW.restype = ctypes.c_uint32
    process = kernel32.GetCurrentProcess()
    module_array = (ctypes.c_void_p * 1024)()
    needed = ctypes.c_uint32()
    require(kernel32.K32EnumProcessModules(process, module_array, ctypes.sizeof(module_array), ctypes.byref(needed)) != 0
            and needed.value <= ctypes.sizeof(module_array), "NATIVE_DEPENDENCY_INVENTORY_FAILED")
    windows_buffer = ctypes.create_unicode_buffer(32768)
    require(kernel32.GetWindowsDirectoryW(windows_buffer, 32768) != 0, "WINDOWS_DIRECTORY_UNAVAILABLE")
    system_roots = [os.path.normcase(os.path.realpath(os.path.join(windows_buffer.value, name)))
                    for name in ("System32", "SysWOW64", "WinSxS")]
    bundled, system = [], []
    for module in module_array[:needed.value // ctypes.sizeof(ctypes.c_void_p)]:
        path_buffer = ctypes.create_unicode_buffer(32768)
        length = kernel32.K32GetModuleFileNameExW(process, module, path_buffer, 32768)
        require(0 < length < 32768, "NATIVE_DEPENDENCY_PATH_FAILED")
        module_path = os.path.realpath(path_buffer.value)
        normalized = os.path.normcase(module_path)
        if os.path.commonpath([os.path.normcase(BIN_ROOT), normalized]) == os.path.normcase(BIN_ROOT):
            bundled.append(file_identity(module_path))
        else:
            require(any(os.path.commonpath([root, normalized]) == root for root in system_roots),
                    "UNEXPECTED_NATIVE_DEPENDENCY_PATH")
            system.append(module_path)
    return sorted(bundled, key=lambda item: item["path"]), sorted(system)


def runtime_observation(pcbnew):
    native = sys.modules["_pcbnew"]
    require(os.path.normcase(os.path.realpath(pcbnew.__file__)) == os.path.normcase(os.path.join(BIN_ROOT, "Lib", "site-packages", "pcbnew.py")), "PCBNEW_MODULE_PATH_MISMATCH")
    require(os.path.normcase(os.path.realpath(native.__file__)) == os.path.normcase(os.path.join(BIN_ROOT, "Lib", "site-packages", "_pcbnew.pyd")), "PCBNEW_EXTENSION_PATH_MISMATCH")
    loaded = {}
    for name, module in sorted(sys.modules.items()):
        if name == "__main__":
            continue
        module_path = getattr(module, "__file__", None)
        if module_path:
            module_path = os.path.realpath(module_path)
            require(os.path.commonpath([BIN_ROOT, module_path]) == BIN_ROOT, "UNEXPECTED_PYTHON_MODULE_PATH")
            cached_path = getattr(module, "__cached__", None)
            if cached_path:
                cached_path = os.path.realpath(cached_path)
                require(os.path.commonpath([BIN_ROOT, cached_path]) == BIN_ROOT, "UNEXPECTED_PYTHON_CACHE_PATH")
            loaded[name] = {**file_identity(module_path),
                            "origin": getattr(getattr(module, "__spec__", None), "origin", None),
                            "bytecodeCachePath": cached_path,
                            "bytecodeCache": file_identity(cached_path) if cached_path and os.path.isfile(cached_path) else None}
    bundled_native, system_native = native_dependencies()
    return {"buildVersion": pcbnew.GetBuildVersion(), "commitHash": pcbnew.GetCommitHash(),
            "pythonVersion": sys.version, "pythonExecutable": file_identity(sys.executable),
            "pcbnewModule": file_identity(pcbnew.__file__), "nativeExtension": file_identity(native.__file__),
            "helper": file_identity(__file__),
            "importPaths": list(sys.path), "siteInitializationDisabled": True,
            "initialImportPaths": INITIAL_IMPORT_PATHS, "initialPrefix": INITIAL_PREFIX,
            "initialBasePrefix": INITIAL_BASE_PREFIX,
            "loadedPythonModules": loaded, "bundledNativeDependencies": bundled_native,
            "windowsSystemNativeDependencyPaths": system_native}


def observe(board_path, expected_hash):
    require(os.name == "nt", "WINDOWS_KICAD_RUNTIME_REQUIRED")
    expected_initial_paths = [os.path.join(BIN_ROOT, "python311.zip"), os.path.join(BIN_ROOT, "DLLs"),
                              os.path.join(BIN_ROOT, "Lib"), BIN_ROOT]
    require([os.path.normcase(os.path.realpath(value)) for value in INITIAL_IMPORT_PATHS]
            == [os.path.normcase(value) for value in expected_initial_paths]
            and os.path.normcase(os.path.realpath(INITIAL_PREFIX)) == os.path.normcase(BIN_ROOT)
            and os.path.normcase(os.path.realpath(INITIAL_BASE_PREFIX)) == os.path.normcase(BIN_ROOT),
            "INITIAL_PYTHON_PATH_MISMATCH")
    require(os.path.isabs(board_path) and board_path.lower().endswith(".kicad_pcb"), "SOURCE_PATH_INVALID")
    before = identity(board_path, source=True)
    require(before["sha256"] == expected_hash, "SOURCE_HASH_MISMATCH")
    with open(board_path, "rb") as stream:
        require(stream.read(64).lstrip().startswith(b"(kicad_pcb"), "SOURCE_HEADER_INVALID")
    # Restrict this process's native dependency lookup to the application,
    # explicitly added directories, and Windows system directories (no CWD/PATH).
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.SetDefaultDllDirectories.argtypes = [ctypes.c_uint32]
    kernel32.SetDefaultDllDirectories.restype = ctypes.c_int
    require(kernel32.SetDefaultDllDirectories(0x1000) != 0, "DLL_SEARCH_ISOLATION_FAILED")
    dll_handle = os.add_dll_directory(BIN_ROOT)
    try:
        import pcbnew
        require(pcbnew.GetBuildVersion() == EXPECTED_VERSION and pcbnew.GetCommitHash() == EXPECTED_COMMIT,
                "KICAD_BUILD_MISMATCH")
        board = pcbnew.LoadBoard(board_path)
        require(board is not None, "NATIVE_LOAD_FAILED")
        require(board.BuildConnectivity() is True, "NATIVE_CONNECTIVITY_BUILD_FAILED")
        connectivity = board.GetConnectivity()
        require(connectivity is not None, "NATIVE_CONNECTIVITY_UNAVAILABLE")
        footprint_inventory = unique_inventory(list(board.GetFootprints()))
        # BOARD.Zones() excludes footprint-owned zones. GetZoneList(True) is an
        # opaque std::list in this SWIG build, so traverse both owned collections.
        zone_items = list(board.Zones())
        for footprint in footprint_inventory.values():
            zone_items.extend(list(footprint.Zones()))
        zone_inventory = unique_inventory(zone_items)
        pad_inventory = unique_inventory(list(board.GetPads()))
        track_inventory = unique_inventory(list(board.GetTracks()))
        all_keys = [key for inventory in (zone_inventory, pad_inventory, footprint_inventory, track_inventory) for key in inventory]
        require(len(all_keys) == len(set(all_keys)), "NATIVE_DUPLICATE_UUID")
        budget = [0]
        zones = []
        for key, zone in sorted(zone_inventory.items()):
            direct_pads = contacts(connectivity.GetConnectedPads(zone), pad_inventory, {"PAD"})
            direct_tracks = contacts(connectivity.GetConnectedTracks(zone), track_inventory, {"PCB_TRACK", "PCB_ARC", "PCB_VIA"})
            zones.append({**native_item(zone), "layers": zone_geometry(zone, board, budget),
                          "isRuleArea": bool(zone.GetIsRuleArea()), "isFilled": bool(zone.IsFilled()),
                          "needRefill": bool(zone.NeedRefill()), "padConnection": integer(zone.GetPadConnection()),
                          "minimumThicknessNm": integer(zone.GetMinThickness()),
                          "directPads": direct_pads,
                          "directTracks": [item for item in direct_tracks if item["nativeClass"] != "PCB_VIA"],
                          "directVias": [item for item in direct_tracks if item["nativeClass"] == "PCB_VIA"]})
        pads = [pad_observation(pad, board) for _, pad in sorted(pad_inventory.items())]
        footprints = [{"uuid": key, "reference": str(footprint.GetReference()),
                       "localZoneConnection": integer(footprint.GetLocalZoneConnection()),
                       "resolvedZoneConnectionOverride": integer(footprint.GetZoneConnectionOverrides(None))}
                      for key, footprint in sorted(footprint_inventory.items())]
        tracks = [{**native_item(track), "layers": layers(track, board)} for _, track in sorted(track_inventory.items())]
        result = {"schemaVersion": SCHEMA, "ok": True,
                  "source": {"basename": os.path.basename(board_path), "before": before},
                  "runtime": runtime_observation(pcbnew),
                  "connectivity": {"built": True, "api": "direct-zone-neighbors",
                                   "zoneScope": "aggregate-native-subpolygons"},
                  "inventory": {"zoneCount": len(zones), "padCount": len(pads),
                                "footprintCount": len(footprints), "trackCount": len(tracks)},
                  "capabilities": {"perLayerPadstackZoneConnectionAvailable": False,
                                   "effectivePadZoneConnectionAvailable": False,
                                   "physicalThermalSpokeCountAvailable": False},
                  "zones": zones, "allPads": pads, "allFootprints": footprints, "allTracks": tracks}
        result["source"]["after"] = identity(board_path, source=True)
        require(result["source"]["before"] == result["source"]["after"], "SOURCE_CHANGED")
        return result
    finally:
        dll_handle.close()
        require(before == identity(board_path, source=True), "SOURCE_CHANGED")


def main():
    # Static error codes only: KiCad parser exceptions may contain source text,
    # paths, or arbitrary labels. Suppress both Python and native diagnostics.
    original_stdout, original_stderr = os.dup(1), os.dup(2)
    code = 0
    result = None
    try:
        with open(os.devnull, "w") as sink:
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            args = sys.argv[1:]
            require(len(args) == 4 and args[0] == "--board" and args[2] == "--expected-source-sha256"
                    and re.fullmatch(r"[a-f0-9]{64}", args[3]) is not None, "ARGUMENTS_INVALID")
            result = observe(args[1], args[3])
    except ObservationError as error:
        code = 2
        result = {"schemaVersion": SCHEMA, "ok": False, "error": {"code": str(error)}}
    except BaseException:
        code = 2
        result = {"schemaVersion": SCHEMA, "ok": False, "error": {"code": "NATIVE_OBSERVATION_FAILED"}}
    finally:
        # Keep native stdout/stderr suppressed through interpreter teardown so
        # delayed CRT or native destructor diagnostics cannot escape after JSON.
        os.close(original_stderr)
    remaining = memoryview((canonical(result) + "\n").encode("ascii"))
    try:
        while remaining:
            written = os.write(original_stdout, remaining)
            require(written > 0, "OUTPUT_WRITE_FAILED")
            remaining = remaining[written:]
    finally:
        os.close(original_stdout)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
