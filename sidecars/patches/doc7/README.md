# DOC7: source-bound power flag connectivity

DOC6's connectivity grouper treated the Value of every `power:` symbol as a net
name. Two `power:PWR_FLAG` symbols consequently merged unrelated VIN and GND
groups, while neither flag's pin was represented. The retained DOC6 public graph
contains `GND, PWR_FLAG, VIN | pins=J1:1, J1:2, U1:1, U1:3`.

DOC7 adds source-derived flag pin membership without adding the flag Value to net
names. Its supported flag is exactly `power:PWR_FLAG`, unit 1, with one embedded
`power_out` pin numbered `1` at the placement origin, applicable to unit 0 or 1.
The pin's reference, value, number, electrical type and name come from the placed
symbol and its embedded definition. The qualified KiCad 10 fixture's pin name is
the empty string. Unsupported/missing/ambiguous definitions, other pin units and
offset geometry reject. A disconnected flag stays unnamed and unconnected.

Ordinary power symbols retain their value-based naming and union behavior.
`sch_trace_net` also excludes exact flag Values when inspecting child sheets;
ordinary power names and explicit labels retain their previous semantics.

The actual `sch_get_connectivity_graph` FastMCP adapter declares exactly:

```json
{"evledaExternalPowerFlagConnectivity":"evleda.kicad-external-power-flag-connectivity.v1"}
```

The host checks this `_meta` value and the entire descriptor normalized through
`@modelcontextprotocol/client@2.0.0`'s `specTypeSchemas.Tool.parse`. Its canonical
SHA-256 is `eddb2180b77bf4aa528bc9f007c5ab07cdd54dbc310d661e79c4a8fb368ad54d`.
An absent declaration retains ordinary graph reads but grants no qualified flag
semantics. A malformed claimed declaration rejects session initialization. An
open, bound, healthy session with graph read authority can expose the capability
in either readonly or write mode. Mutation permissions are checked separately.

## Qualification and reproduction

`test_power_flag_connectivity.py` runs 13 pure-file tests using the actual imported
runtime modules and actual KiCadFastMCP registration. The test retains separate
VIN/GND groups, full `#FLG01:1` and `#FLG02:1` membership, unnamed isolated flags,
source pin metadata, malformed-definition rejection, authentic stock GND behavior,
the public graph and child trace paths, and physical parity with the retained
native CLI XML. Its source fixtures are immutable copies from the preceding
native-format qualification. It does not perform a new native export.

```powershell
C:\EvlEDA-DOC7-20260910\environment\Scripts\python.exe -I -s -E -B -X utf8 `
  sidecars/patches/doc7/test_power_flag_connectivity.py
node node_modules/vitest/vitest.mjs run tests/integration/kicad-mcp.test.ts `
  -t 'external power flag connectivity' --maxWorkers=1
```

The 13 Python tests and 16 focused host session tests pass. The same final Python
driver fails against DOC6 and preserves its erroneous graph. Earlier failure
reports are retained: the first DOC7 test run caught two incorrect test
expectations for the pin name, and publication stopped before a manifest existed.
Correcting the expectations to the observed empty source name did not change the
runtime modules.

`build-runtime.mjs` refuses existing output targets, pins DOC6 and the reviewed
patch, copies the complete runtime, replaces the three reviewed sources and only
the actual `pyvenv.cfg` home, and uses the existing manifest builder/verifier.
`finalize-runtime.mjs` completed the owned unpublished copy after that retained
test failure; it first rebuilt its full inventory and required the exact same
DOC6-plus-four-file delta. Both paths preserve existing profiles and runtimes.

`power-flag-connectivity.patch` reproduces all three source snapshots byte for
byte when applied to copied DOC6 source with `git -c core.autocrlf=false apply`.
The explicit setting preserves the frozen runtime's LF bytes on Windows.

The new runtime has 8,467 files, 1,159 directories and 150,423,640 bytes.
`provenance.json` binds its source mappings, manifest, patch, test driver, final
baseline, passing result, and actual descriptor. The transfer's `working-profiles`
contains the complete reports. DOC6 was fully verified before and after.

This is offline runtime and host protocol qualification. No editor, MCP server
loop, native API operation, design run, active-profile update or build output was
performed by this qualification.
