# USB-C 5 V sink to 3.3 V reference design — R2

`reference-usb-c-3v3-r2` / `REV2` is the electrical reference subject. It is
a USB-C power-only sink with a USB4105-GF-A receptacle, TPS259620 latch-off
eFuse, LP38692MPX-3.3/NOPB regulator, test points, power LED, and an output-only
3.3 V header. It carries neither USB data nor USB Power Delivery negotiation.

The public interface text is exact:

`3V3 OUT 100mA MAX / DO NOT APPLY POWER`

J2 pin 1 and TP3 remain directly on `3V3`. The 100 mA allowance is available at
J2 in addition to the onboard LED and qualified leakage/overhead. It is still a
design target, not a production-qualified guarantee.

The accepted input is only a compliant USB Type-C default 5 V source from
4.75 V to 5.50 V. R2 makes no sustained 9 V, 12 V, 19 V, or 21 V survival
claim. TPS259620 component ratings and its 5.61 V clamp-table corner at 10 mA
are not an end-product input rating.

## Canonical R2 electrical architecture

The fitted subject has exactly 23 components, 67 logical pins, 59 connected
pins, eight explicit NC pins, and 13 nets. Those figures are checked after
deriving the inventories from `components()` and `build_circuit()`.

- U2 is `LP38692MPX-3.3/NOPB` in NDC/SOT-223-5: pin 1 EN and pin 4 IN are on
  `V5_PROTECTED`, pin 2 is NC, pin 3 OUT is on `3V3`, and pin 5/tab is GND.
- C2 remains `C0805C475K3RACTU`, 4.7 uF/25 V X7R, from U2 IN to GND.
- R3 is `CRCW06033K83FKEA`, 3.83 kOhm +/-1 percent, from U1 ILM to GND.
- C4 is `C1206C104J3GACTU`, 100 nF +/-5 percent, 25 V C0G/NP0 in 1206,
  from U1 pin 2 dVdt on `DVDT_SET` to GND. U1 pin 2 is no longer NC.
- C3 is polarized `T598B226M010ATE070`, 22 uF +/-20 percent, 10 V,
  B/3528-20. Its positive pin is on `COUT_DAMPED`; its negative pin is GND.
- R9 is `WSLP0603R0100FEA`, 10 mOhm +/-1 percent. It is only in the output-
  capacitor branch: `3V3 -> R9 -> COUT_DAMPED -> C3(+) -> GND`. Main load
  current to J2, TP3, and the LED does not pass through R9.
- U3 and LM66100 are absent. There is no `3V3_INTERNAL` split.

The eight NC pins are J1 A6/A7/A8/B6/B7/B8, U1 pin 6 FLT, and U2 pin 2.

## Retained calculation evidence

`BoardAudit.electrical_calculations` contains the complete canonical payload,
not only its SHA-256. Every bound is a reduced rational with an explicit unit,
basis, and source-evidence IDs. Its digest separately protects the payload.

The principal current/startup receipts are:

- TPS2596's direct RILM=3.83 kOhm row: 224/247/269 mA minimum/typical/maximum.
- Engineering extension for R3 +/-1 percent and +/-100 ppm/K over 65 K:
  approximately 220.350 to 273.500 mA. This is not another TI guarantee.
- LP38692 loaded quiescent current: 100 uA maximum over the specified
  100 uA-to-1 A load and -40 C-to-+125 C conditions.
- Protected-path static screen: 103.846533 mA (about 103.847 mA), comprising
  100 mA header, a 3.522899 mA LED-short screen, 0.220 mA C3 leakage,
  0.100 mA loaded IQ, 0.001 mA EN leakage, and a provisional 0.002634 mA C2
  leakage screen. TPS2596's own IQ is upstream of its monitored OUT current.
- C4 effective screen: 94.715 to 105.315 nF.
- TPS2596 tabulated IDVDT/GDVDT bounds give 0.3645 to 0.5289 mV/us slew.
- At 26.7 uF fitted nominal downstream capacitance, exact capacitive inrush is
  9.73215 to 14.12163 mA and the 5 V ramp screen is 9.454 to 13.718 ms.
- Static plus maximum nominal-capacitance inrush is 117.968163 mA, leaving
  102.381837 mA to the tolerance/TCR-screened 220.350 mA floor.

This supports the setpoint and timing choices but does not qualify startup.
Repeat with maximum fitted and attached capacitance, actual load behavior,
source droop, pre-bias, ESR/ESL, and temperature. Scope `VBUS_RAW`,
`V5_PROTECTED`, `3V3`, and input current during cold start, hot start, USB
bounce, brownout, and eFuse re-enable.

## Stability, reverse current, and thermal boundaries

The R9 resistance calculation is 9.829215 to 10.172215 mOhm over the board
temperature excursion. It proves the lower ESR floor even if C3 ESR approached
zero. C3's 70 mOhm maximum is only at +25 C/100 kHz, so the combined
80.172215 mOhm maximum applies only at that stated condition. Vendor delivery
data or worst-lot testing must bound capacitance and ESR over -40 C to +80 C
and frequency. Stability plus line/load transients must be tested at no,
minimum, and maximum load. R9-open removes the output capacitor; R9-short
removes the guaranteed ESR floor. Either is release-failing.

LP38692 does not block sustained OUT-to-IN reverse current. R9 is not in that
path, and no LM66100 is fitted. J2 therefore remains output-only. If external
drive is permitted, R2 is architecturally blocked and requires a separately
qualified reverse-blocking design.

The LP38692 worst-corner screen is 0.25733 W. At +80 C ambient, the assembled
board must demonstrate effective thetaJA below 174.87 C/W with margin. TI's
68.5 C/W High-K test-board figure is not transferable evidence. U2 pin 5/tab
needs a reviewed NDC0005A land, useful top GND copper, and multiple
low-impedance thermal/ground stitches; board-specific modeling or measurement
is mandatory.

## Evidence manifest

The live R2 manifest contains 20 source records. Seventeen official source
blobs are retained and rehashed locally; the USB-IF release and Keystone
catalog remain manifest-only. USB4105 connector geometry is instead bound to
the openly accessible official KiCad footprint at commit
`f6d77c54d79275c888daae4c60e4c9869ffa4aa5`, raw-file SHA-256
`3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8`.
No restricted manufacturer drawing is a public dependency. New retained
evidence includes the LP38692 datasheet/package materials/product page, the
T598 and WSLP documents, and the C4 family/exact-part specifications.

The retained LP38692 datasheet body is `SNVS322M`, December 2004, revised
December 2015. The generic notice appended to those bytes has a 10/2025 update
footer; it is not the LP38692 document revision.

The historical AP2112 PDF remains in the content-addressed blob store so old
receipts remain inspectable, but `src-ap2112` is absent from the live R2
manifest and from all R2 BOM/constraint bindings.

Run the fail-closed evidence verifier with:

```powershell
python -m backend.evidence.reference_sources
```

## Sealed-package KiCad workflow and visual review

The canonical compiler is deliberately an emitter/reparser, not the native
KiCad execution authority. It creates the complete 29-file project subject:
the three primary KiCad files, both local library tables, one generated symbol
library, and 23 component-specific footprint modules. It preserves the R2
placement, the reviewed frozen route, source-backed F.Fab/F.CrtYd geometry,
board silkscreen, and model-decision inventory (15 trusted models, eight
explicit omissions).

Do not open a sealed publication in KiCad. Instead materialize the exact
compiler-bound subject into a separate disposable directory:

```python
from pathlib import Path

from backend.reference_design.artifacts import materialize_reference_kicad_working_copy

materialize_reference_kicad_working_copy(
    Path(r"C:\sealed\reference_usb_c_3v3_r2"),
    Path(r"C:\sessions\reference_usb_c_3v3_r2_review"),
)
```

The materializer accepts only a complete sealed publication and copies only
files enumerated by its compiler manifest. It rejects symlinks, files that do
not match their manifest hashes, and KiCad UI state, locks, backups, and caches
in a reusable session directory. This protects the source package from the
normal `.kicad_prl` and backup side effects of interactive review.

The independent KiCad 10.0.6 review was performed from such an isolated copy:
the exact unfilled source passed ERC 0 and DRC 0, and a separately filled CAM
derivative also passed DRC 0. The receipts are evidence for review, not an
approval to fabricate. The interactive 3D PDF may not work in every PDF viewer;
when it does not, review the matching static top-view PNG generated with the
same evidence set, then open the isolated project in KiCad for the authoritative
interactive inspection. Neither visual representation replaces assembly or
manufacturing sign-off.

## Physical and release status

The R2 route is now a compressed, content-addressed copper authority. Its
authority version is `reviewed-r2-compact-content-addressed-route-v2`; its
13-net input hash is
`94a2443dd4ee204880ab2a33b37807a8ff87d01c99b763cbe8656fcd27469dc7`;
the reviewed positive-margin plan hash is
`83b40173cac389920ad3c68cd616344c0e9bd39f61383b76d9aee6da7a313cee`.
The route-review receipt hash is
`4ffb3fa4fde0237c7b6fecfdb396df44e00e3c5b07555855f31c15befec3a567`.
It contains 126 tracks, 13 vias, 13 route trees, 381.970 mm of Manhattan
centerline, and 90 orthogonal turn/tee junctions.

The route audit proves the R9 leaf is only the output-capacitor branch, while
the U2-to-J2 and U2-to-TP3 paths exclude R9. VBUS_RAW, V5_PROTECTED, 3V3, and
COUT_DAMPED use 0.8 mm trunks except for the exact enumerated 0.3 mm USB/U1
and local pad throats; COUT_DAMPED is 0.8 mm throughout. The audit also binds
two external U2 thermal/ground stitches, rejects via overlap with any of the
64 SMD lands, splits tees for graph proofs, rejects positive-length same-net
overlap/redundant copper, and proves all 13 nets connected.

An exact 0.20 mm policy run has no route-authored clearance finding. Its only
copper-clearance findings are the two pinned-public-footprint USB4105
pad-to-locating-NPTH relations already enumerated by the footprint audit. Their
approximately 0.1751 mm computed gap is preserved as a project-local DRC
exception, not a manufacturer-authorized minimum. The independently
found VBUS-high-via and VBUS-spine/GND-via pairs were corrected with positive
margin rather than being left exactly on the 0.20 mm boundary. The B.Cu GND
zone remains explicit unfilled source intent: the exact source has the expected
native fill warning and passed the independent unfilled ERC/DRC gates. A filled
CAM derivative passed DRC separately. Those are distinct revisioned artifacts;
the derivative is not silently substituted for the source or a release package.

Output-warning F.SilkS placement, source-backed body/courtyard clearance, and
compiler emission are complete review artifacts. They must still be assessed
against the selected assembler's stencil, paste, secondary-solder, voiding, and
inspection process before use in production.

The nominal 0.80 mm finished PCB thickness is a conservative project choice,
not a connector-vendor requirement. Connector fit, shell retention,
board-thickness compatibility, insertion/extraction behavior, and mechanical
mating remain unqualified and release-blocking until physically validated.

Manufacturing release remains false. The remaining gates are full-temperature
C2/C3 and LP38692 stability evidence; U1/U2 thermal and startup evidence;
J2 reverse-current/output-only approval; USB/ESD and end-product compliance;
stackup, drill, fabricator, and assembly approval; source-retention closure;
CAM-derivative/release-packet binding; and accountable human release approval.
No deterministic calculation, compiler result, native KiCad gate, or render
can authorize manufacture on its own.
