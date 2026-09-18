"""Isolated KiCad 10.0.3 stock-load/cardinal-transform oracle; never opens a GUI.

Run with installed KiCad python.exe -I -B. Writes only this overlay's oracle/
directory. Existing oracle files are refused, not replaced. Config is private.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
if sys.argv[1:] not in ([], ["--final"]):
    raise RuntimeError("Only the bounded --final repeat is supported")
OUT = ROOT / ("oracle-final" if sys.argv[1:] else "oracle")
if shutil.disk_usage(ROOT).free < 155 * 1024 * 1024:
    raise RuntimeError("DOC11 oracle requires the 150 MiB reserve plus 5 MiB budget")
OUT.mkdir(exist_ok=True)
os.environ["KICAD_CONFIG_HOME"] = str(OUT / "config")
os.environ["KICAD_CACHE_HOME"] = str(OUT / "cache")

import pcbnew  # noqa: E402 - configuration is owned before importing native code

if pcbnew.GetBuildVersion() != "10.0.3":
    raise RuntimeError("Uncharacterized KiCad version")

def pin(filename):
    file = Path(filename).resolve()
    raw = file.read_bytes()
    return {"path": str(file), "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}

toolchain = {"python": pin(sys.executable), "pcbnewWrapper": pin(pcbnew.__file__),
             "pcbnewNative": pin(pcbnew._pcbnew.__file__)}

synthetic = '''(footprint "CardinalLocalAngles" (version 20260206) (generator "pcbnew")
  (layer "F.Cu")
  (property "Reference" "T1" (at 0 -2 90) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
  (property "Value" "Mixed local angles" (at 0 2 270) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
  (property "Extra" "retain (at 1 2 90) text" (at 2 2 180) (layer "F.Fab") (hide yes) (effects (font (size 1 1))))
  (fp_text user "angled text" (at 1 1 90 unlocked) (layer "F.Fab") (effects (font (size 1 1))))
  (fp_text user "second text" (at -1 1 270) (layer "F.Fab") (effects (font (size 1 1))))
  (fp_rect (start -3 -3) (end 3 3) (stroke (width 0.05) (type default)) (fill none) (layer "F.CrtYd"))
  (pad "1" smd roundrect (at -1 0 90) (size 0.4 1.2) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))
  (pad "2" thru_hole oval (at 1 0 270) (size 1.6 2.2) (drill oval 0.8 1.4) (layers "*.Cu" "*.Mask"))
  (pad "" smd rect (at 0 0 180) (size 0.3 0.6) (layers "F.Paste"))
  (model "exact model.step" (offset (xyz 0.1 0.2 0.3)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 90)))
  (embedded_fonts no))
'''
custom = OUT / "Fixture.pretty"
custom.mkdir(exist_ok=True)
custom_file = custom / "CardinalLocalAngles.kicad_mod"
with custom_file.open("x", encoding="utf-8", newline="\n") as handle:
    handle.write(synthetic)
stock = Path(r"C:\Program Files\KiCad\10.0\share\kicad\footprints")
fixtures = [
    ("capacitor", stock / "Capacitor_SMD.pretty", "C_0402_1005Metric"),
    ("sot523", stock / "Package_TO_SOT_SMD.pretty", "SOT-523"),
    ("qfn", stock / "Package_DFN_QFN.pretty", "QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm"),
    ("usb", stock / "Connector_USB.pretty", "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal"),
    ("local", custom, "CardinalLocalAngles"),
]
rows = []
for label, folder, name in fixtures:
    for rotation in [0, 90, 180, 270]:
        filename = OUT / (label + "-" + str(rotation) + ".kicad_pcb")
        if filename.exists():
            raise RuntimeError("Refusing to overwrite oracle evidence")
        board = pcbnew.BOARD()
        footprint = pcbnew.FootprintLoad(str(folder), name)
        if footprint is None:
            raise RuntimeError("Native FootprintLoad failed: " + name)
        footprint.SetReference("T1")
        board.Add(footprint)
        footprint.SetPosition(pcbnew.VECTOR2I(100000000, 100000000))
        footprint.SetOrientationDegrees(rotation)
        pads = [{"number": pad.GetNumber(), "positionNm": [pad.GetPosition().x, pad.GetPosition().y],
                 "orientationDeg": pad.GetOrientationDegrees(), "sizeNm": [pad.GetSize().x, pad.GetSize().y],
                 "drillNm": [pad.GetDrillSize().x, pad.GetDrillSize().y]} for pad in footprint.Pads()]
        if not pcbnew.SaveBoard(str(filename), board):
            raise RuntimeError("Native SaveBoard failed")
        raw = filename.read_bytes()
        rows.append({"fixture": label, "rotation": rotation, "source": str(folder / (name + ".kicad_mod")),
                     "sourceSha256": hashlib.sha256((folder / (name + ".kicad_mod")).read_bytes()).hexdigest(),
                     "file": filename.name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw), "nativePads": pads})
manifest = {"schemaVersion": "evleda.doc11-native-cardinal-oracle.v1", "nativeVersion": pcbnew.GetBuildVersion(),
            "scope": "Independent native FootprintLoad, SetPosition, SetOrientationDegrees and SaveBoard; isolated files only.",
            "toolchain": toolchain, "ownedConfig": os.environ["KICAD_CONFIG_HOME"], "ownedCache": os.environ["KICAD_CACHE_HOME"],
            "rows": rows}
if any(pin(value["path"]) != value for value in toolchain.values()):
    raise RuntimeError("Native oracle toolchain changed during characterization")
with (OUT / "manifest.json").open("x", encoding="utf-8", newline="\n") as handle:
    json.dump(manifest, handle, indent=2)
    handle.write("\n")
print(json.dumps({"oracle": str(OUT), "cases": len(rows), "bytes": sum(row["bytes"] for row in rows)}))
