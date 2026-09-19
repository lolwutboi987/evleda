"""Exercise the native protobuf mapping type missed by DOC13's JSON replay."""
from collections import OrderedDict
import importlib.util
from pathlib import Path
import unittest

root = Path(__file__).resolve().parent
def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

codec = load('doc14_compact', root / 'evleda_plane_stage/compact_receipt.py')
prior_tests = load('doc13_tests', root.parent / 'doc13/test_compact_receipt.py')
prior_tests.codec = codec


class NativeMappingTests(prior_tests.CompactTests):
    def test_ordered_native_any_pads_are_interned(self):
        raw = prior_tests.fixture()
        items = raw['rpc'][1]['response']['items']
        raw['rpc'][1]['response'] = OrderedDict(items=[OrderedDict(item) for item in items])
        result = codec.compact_plane_stage(raw)
        self.assertEqual(len(result['rpcPadPool']), 1)
        self.assertEqual(result['rpc'][1]['response']['items'], [{'padIndex': 0}, {'padIndex': 0}])
        self.assertEqual(result['rpcPadPool'][0], items[0])

    def test_ordered_mappings_do_not_escape_logical_work_budget(self):
        raw = prior_tests.fixture()
        raw['other'] = OrderedDict(values=[[0] * 100_000 for _ in range(5)])
        with self.assertRaisesRegex(ValueError, 'traversal budget'):
            codec.compact_plane_stage(raw)


if __name__ == '__main__':
    unittest.main()
