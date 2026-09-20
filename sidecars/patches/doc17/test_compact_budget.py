"""Bounded resource regression only. No CAD process or acceptance receipt."""
import copy
import gzip
import importlib.util
import json
from pathlib import Path
import unittest

root=Path(__file__).resolve().parent
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
codec=load('doc17_codec',root/'evleda_plane_stage/compact_receipt.py')
prior=load('doc14_tests',root.parent/'doc14/test_compact_native_dicts.py')
prior.codec=codec
prior.prior_tests.codec=codec

class Doc17Tests(prior.NativeMappingTests):
    def test_modeled_real_board_resource_case(self):
        fixture=root.parents[2]/'tests/fixtures/fresh-project/modeled-plane-stage-507408.json.gz'
        study=json.loads(gzip.decompress(fixture.read_bytes()))
        self.assertEqual(study['logicalNodes'],507408)
        self.assertIn('not a native stage or authority',study['scope'])
        raw=study['transcript'];before=copy.deepcopy(raw)
        compact=codec.compact_plane_stage(raw)
        self.assertEqual(raw,before)
        self.assertLess(len(codec.canonical(compact).encode()),8*1024*1024)
        self.assertEqual(compact['schemaVersion'],'evleda.native-plane-stage.v2')

    def test_repeated_pads_still_have_a_finite_logical_bound(self):
        raw=prior.prior_tests.fixture()
        pad=raw['rpc'][1]['response']['items'][0]
        pad['large']=[{'x':i} for i in range(200)]
        raw['rpc'][1]['response']['items']=[pad]*3000
        with self.assertRaisesRegex(ValueError,'traversal budget'):
            codec.compact_plane_stage(raw)

if __name__=='__main__':
    unittest.main()
