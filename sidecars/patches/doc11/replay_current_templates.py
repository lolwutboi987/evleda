"""Read-only current 66-template projection replay; writes small owned receipts.

No native API/CLI/editor calls. No managed-project source read or mutation.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[2]
if shutil.disk_usage(ROOT).free < 155 * 1024 * 1024:
    raise RuntimeError("DOC11 replay requires 150 MiB reserve plus 5 MiB budget")
spec = importlib.util.spec_from_file_location("doc11_replay_tests", ROOT / "test_sync_footprint_pose.py")
test = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = test
spec.loader.exec_module(test)
model_file = REPO / "designs/rp2350-pico/north-routing-revision.json"
proposal = json.loads(model_file.read_text(encoding="utf-8"))["nextCandidateProposal"]
model = proposal["active22SourceWorkset"]["sourceModel"]
model_bytes = json.dumps(model, ensure_ascii=False, separators=(",", ":")).encode()
# JSON.stringify number formatting is JS-specific; host-published pinned identity
# is retained and the independent TS physical replay binds its exact bytes.
model_pin = proposal["active22SourceWorkset"]["sourceModelIdentity"]
if model_pin["digest"] != "421df1f6f7fad2857b58fcd7d9a6afb0d3d71792827094516ec423f1fcfc63c4":
    raise RuntimeError("Current source model selection changed")
sources = {pad["reference"]: Path(pad["sourcePath"]) for pad in model["pads"]}
for feature in model["ready"]["boardFeatures"]:
    sources[feature["reference"]] = REPO / "resources/pcb-libraries/rp2350-pico/v4/footprints/EvlEDA_Pico2350.pretty" / (feature["footprintLibId"].split(":")[1] + ".kicad_mod")
rows = []
for reference, file in sorted(sources.items()):
    source = file.read_text(encoding="utf-8").strip()
    original = test.helper._parse(source)
    old_poses = test.child_poses(original)
    for rotation in [0, 90, 180, 270]:
        projected = test.helper.project_library_footprint_angles(source, rotation)
        parsed = test.helper._parse(projected)
        expected = {key: (pose[0], pose[1], (pose[2] + rotation) % 360) for key, pose in old_poses.items()}
        if test.child_poses(parsed) != expected:
            raise AssertionError("Source content or child frame changed: " + reference)
        test.assert_only_angle_tokens_changed(source, projected)
        rows.append({"reference": reference, "rotation": rotation, "sourceSha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                     "physicalPadCount": len(test.direct(original, "pad")), "childCount": len(original.children)})
descriptor_server = test.target.FastMCP("doc11-descriptor")
test.target._register_schematic_sync_tools(descriptor_server)
descriptor = next(item.model_dump(mode="json", by_alias=True, exclude_none=True)
                  for item in asyncio.run(descriptor_server.list_tools()) if item.name == "pcb_sync_from_schematic")
report = {"schemaVersion": "evleda.doc11-template-projection-replay.v1", "sourceModelIdentity": model_pin,
          "templates": len(sources), "cardinalCases": len(rows), "physicalMembersPerCompleteRotation": sum(row["physicalPadCount"] for row in rows if row["rotation"] == 0),
          "everyOtherTemplateBytePreserved": True, "nativeCalls": False, "rows": rows}
suffix = "-final" if "--final" in sys.argv[1:] else ""
for name, payload in [("registered-descriptor" + suffix + ".json", descriptor), ("template-replay" + suffix + ".json", report)]:
    with (ROOT / name).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
print(json.dumps({key: report[key] for key in ["templates", "cardinalCases", "physicalMembersPerCompleteRotation", "everyOtherTemplateBytePreserved"]}))
