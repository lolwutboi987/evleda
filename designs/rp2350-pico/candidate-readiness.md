# RP2350 candidate progress

The board is unfinished. The only project authored through public MCP still
contains U1 and J2 in its schematic and no PCB components or copper. It is closed
normally with its checkpoint preserved.

The checked-in [ready draft](design-ready-draft.json) is candidate06: 62 parts,
65 nets, four bores and the POWER_FINE class revision for 1V1/3V3. It was submitted
successfully, but no native project was allocated from it. Joint routing then
found additional problems that require a new candidate: crowded QSPI escapes,
power-pin trace overlap, and unnecessary external USBLC6 channel links.

The [USB feed-through revision](usb-feedthrough-revision.json) preserves every
physical pin on 67 total nets. A current-source compile with the approved v4
package passes, and a separate 41-track USB source-plan replay reaches all 14
signal anchors within the length/skew and escape-width budgets. One output-path
coupled-gap result remains unassessed. The [joint north plan](north-routing-revision.json)
and [QSPI plan](qspi-clock-route-plan.md) remain proposals; complete bus/power
coexistence and native realization are still in progress. Earlier native DRC
and placement passes retain their exact historical inputs.

## Candidate 05: retained placement and mounting evidence

The latest isolated whole-placement native DRC screen has zero targeted physical
placement errors with all 65 exact net classes and unchanged rules verified.
It retains all 66 footprints and 281 physical pads. Remaining findings are
238 silkscreen warnings, all involving Reference fields, and 194 expected
unrouted connections. This is an engineering placement screen, not an MCP-authored
or routed board. The original failing reports remain preserved.

The four Ø2.1 mm bores now sit at `(4,2)`, `(17,2)`, `(4,49)`, `(17,49)`.
Their **13 × 47 mm mounting pattern differs from Pico**; all forty header contacts
retain their Pico geometry. This clears the two earlier H1/H2-to-J1 courtyard
errors without changing the USB connector or weakening any clearance rule.
U4's target is `(9.6,12.15)`, rotation 90, inside its unchanged allowed region.

Candidate 05 retains candidate 04's R2 move north by 0.20 mm to `(11.085, 16.70)`, preserving its 90-degree
package orientation and all USB channel rules. Source-based geometry proves that
the original pose blocked U1.52's escape; the corrected pose admits both 45-degree
MCU launches. Full port-tree routing remains unverified. Nonconnector placement
constraints now provide bounded functional regions around deliberate target
poses; connector and mounting-hole positions remain fixed.

The original candidate 03 and its failure evidence remain preserved. It compiled,
opened and closed in native KiCad, but no symbols or copper were authored in it.
Compilation readiness does not establish routing or board acceptance.

Candidate05 compiled without unresolved inputs:
62 electrical components, 65 nets, 262 logical pins and four separate board-only
NPTH mounting features. The earlier [unresolved scaffold](design-draft.json)
remains historical input. Neither file is a placed or routed board.

Candidate05 has bundle identity
`b5e884ed1e2348ee042eb3a0334a446170cf00baeda4b745c75866128cb77cae`.
It was compiled using the checked immutable `integration-doc9-build-05` source
snapshot while schematic planner work continued in the active checkout.
The actual candidate 05 project is `e462414b-9e9e-48e6-abd5-67f46f38f41d`.
Public checked reads confirm U1 at `(172.72,85.09)` and J2 at `(250.19,64.77)`,
with exact values/library IDs/footprints. Both add requests exceeded the old
three-minute client observation window and were not retried; subsequent checked
reads, healthy status and normal checkpoint/close verified the resulting state.
The revised client has a ten-minute observation window, without changing native
admission, source or recovery checks. Remaining symbols, connectivity, PCB
synchronization and routing are unfinished. The native placement study described
above is a separate diagnostic and must not be mistaken for this public workflow.
The actual MCP workspace accepted candidate 03 and reported its native project
active with edit access and no recovery requirement. The initial create request
exceeded the client's observation timeout; the existing operation subsequently
completed, as confirmed by workspace and toolbox status. No duplicate was created.
It then checkpointed and closed normally with its lease released and client exit
code zero. This establishes native startup/close for the new contract; it does
not establish component placement, mounting-hole materialization or routing.
Local input/compiler and public-MCP receipts are retained outside Git under
`destination-verification/rp2350-candidate-05`, `rp2350-candidate-04`, `rp2350-candidate-03`, `rp2350-candidate-02`, and
`destination-rp2350-native-01/mcp-session-01` and `mcp-session-02`. The first connection performed
read-only submission/schema discovery and closed normally before native creation.
Candidate 05's U1 checkpoint and U1/J2 resumed observations are retained in
`mcp-session-04` and `mcp-session-05`; both connections closed normally with exit
code zero and released their leases.

The inputs combine four reviewed overlays:

- [Library selections](library-selection.md): exact selected symbols/lands; the
  v4 package adds a bare 2.1 mm hole without a fictional fastener envelope.
- [Operating constraints](operating-constraints.md): explicit candidate limits
  and load/edge assumptions, including 150 MHz operation and external VSYS intent.
- [USB construction](usb-construction.md): sourced nominal 1 mm layer geometry,
  exact 1.006 mm total, and explicitly labeled electrical-material idealizations.
- [Placement constraints](placement-constraints.md): deliberate poses, bounded
  routes, pin-local returns and a geometric screen of all 62 electrical parts.

J1 retains USB4105-GF-A but uses the [reviewed 1.3 mm mouth setback](usb-connector-fit.md)
at `(10.5, 4.975)`, rotation 180. Nominal top-bore copper clearance is 0.488235 mm;
body/etch/position tolerances, cable mating and fastener access remain conditions.
The lower mounting-hole y=49 positions are an explicit symmetric project choice,
not a separately dimensioned vendor fact.

Native drawing labels now use standard concise values and part names, with the
[full display-value map](display-values.json) retaining original descriptions and
exact selected MPNs. No tolerance, rating, circuit function or A4 stepping
requirement was removed. In particular, `3.3uH` permits readable planned L1 fields
with the current sidecar's inductor-arc limitation. The
[schematic plan](schematic-layout.md) supplies all 62 individual public-tool
arguments; its modeled page/label fit still needs native rendering and ERC.

These are design inputs, not newly invented measurements. USB hotplug/inrush,
startup behavior, masked impedance, actual fabrication materials, assembly
tolerances, thermal/current performance and the finished board's native checks
remain explicit engineering acceptance work. The nominal bare-line calculation
does not validate the masked USB channel. No manufacturing or firmware release is
authorized or implied.
