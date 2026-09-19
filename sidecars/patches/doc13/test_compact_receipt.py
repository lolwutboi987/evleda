"""Offline DOC13 storage tests. No KiCad process or native mutation."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("doc13_compact", ROOT / "evleda_plane_stage/compact_receipt.py")
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)


def fixture():
    pad = {"@type": codec.PAD_TYPE, "id": {"value": "same-id"}, "number": "", "position": {"x_nm": "123"}}
    source = '(kicad_pcb (text "quote\\\" 雪"))\r\n'
    return {"schemaVersion": "evleda.native-plane-stage.v1", "savedSourceBefore": source,
            "nativeSourceBefore": source, "savedSourceStaged": source,
            "rpc": [{"requestType": "kiapi.common.commands.SaveDocumentToString", "response": {"contents": source}},
                    {"responseType": "kiapi.common.commands.GetItemsResponse", "response": {"items": [pad, pad]}}]}


class CompactTests(unittest.TestCase):
    def test_exact_pool_values_and_order_without_input_mutation(self):
        raw = fixture()
        before = copy.deepcopy(raw)
        result = codec.compact_plane_stage(raw)
        self.assertEqual(raw, before)
        self.assertEqual(result["schemaVersion"], codec.SCHEMA)
        self.assertEqual(result["sourcePool"], [raw["savedSourceBefore"]])
        self.assertEqual(result["rpcPadPool"], [raw["rpc"][1]["response"]["items"][0]])
        self.assertEqual(result["rpc"][1]["response"]["items"], [{"padIndex": 0}, {"padIndex": 0}])
        self.assertEqual(result["rpc"][0]["response"]["contents"], {"sourceIndex": 0})

    def test_changed_versions_of_same_pad_are_not_merged(self):
        raw = fixture()
        raw["rpc"][1]["response"]["items"][1] = copy.deepcopy(raw["rpc"][1]["response"]["items"][0])
        raw["rpc"][1]["response"]["items"][1]["position"]["x_nm"] = "124"
        result = codec.compact_plane_stage(raw)
        self.assertEqual(len(result["rpcPadPool"]), 2)
        self.assertEqual(result["rpc"][1]["response"]["items"], [{"padIndex": 0}, {"padIndex": 1}])

    def test_recovery_observations_retained(self):
        raw = {"schemaVersion": "evleda.native-plane-stage.v1", "complete": False,
               "mutationDispatched": True, "recoveryRequired": True, "rpc": [],
               "error": {"message": "original failure"}, "currentSavedSource": "disk", "currentNativeSource": "live"}
        result = codec.compact_plane_stage(raw)
        for key in ("complete", "mutationDispatched", "recoveryRequired", "error"):
            self.assertEqual(result[key], raw[key])
        self.assertEqual(result["sourcePool"], ["disk", "live"])

    def test_reclaims_repeated_source_bytes_with_same_cap(self):
        raw = fixture()
        raw["rpc"] = [{"requestType": "kiapi.common.commands.SaveDocumentToString",
                       "response": {"contents": "x" * 900_000}} for _ in range(12)]
        self.assertGreater(len(codec.canonical(raw).encode()), codec.MAX_BYTES)
        self.assertLess(len(codec.canonical(codec.compact_plane_stage(raw)).encode()), 1024 * 1024)

    def test_no_truncation_when_compact_artifact_still_exceeds_cap(self):
        raw = fixture()
        raw["other"] = ["x" * 1_000_000 for _ in range(9)]
        with self.assertRaisesRegex(ValueError, "artifact cap"):
            codec.compact_plane_stage(raw)

    def test_source_and_logical_work_limits(self):
        raw = fixture()
        raw["savedSourceBefore"] = "x" * (1024 * 1024 + 1)
        with self.assertRaisesRegex(ValueError, "bounded text"):
            codec.compact_plane_stage(raw)
        raw = fixture()
        raw["other"] = [[0] * 100_000 for _ in range(5)]
        with self.assertRaisesRegex(ValueError, "traversal budget"):
            codec.compact_plane_stage(raw)

    def test_pool_fields_on_legacy_input_reject(self):
        raw = fixture()
        raw["sourcePool"] = []
        with self.assertRaisesRegex(ValueError, "Unexpected pools"):
            codec.compact_plane_stage(raw)


if __name__ == "__main__":
    unittest.main()
