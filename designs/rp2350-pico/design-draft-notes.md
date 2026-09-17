# RP2350 Pico-like unresolved V2 draft

Reviewed 2026-09-17. [design-draft.json](design-draft.json) is a **schema-valid unresolved design-intent draft**, not a compiler-ready bundle, accepted circuit, placed board or native project. Its schema is `evleda.pcb-design-intent-draft.v2`. The current source compiler returns `needs_clarification` and creates no contract, library binding or verification plan.

The source of component requirements, MPNs, functions, rating families, provenance and open decisions remains [circuit-inputs.json](circuit-inputs.json) and its [readable companion](circuit-inputs.md). Those records are retained without modification. The strict draft schema cannot carry arbitrary component procurement/rating metadata; its component `value` strings are copied exactly, and its grouped unresolved entries require review of the complete source inventory before closure. A generic descriptive value must not be mistaken for permission to substitute the source MPN.

## Preserved inventory and known requirements

| Check | Result |
| --- | --- |
| Components | 62, with the exact source reference set |
| Functional nets | 65, with exact names and endpoint membership |
| Logical pins | 262: 260 connected and 2 deliberate NCs |
| NC terminals | J1.A8/SBU1 and J1.B8/SBU2 only |
| Placement records | One for each of the 62 components |
| Routing records | One for each of the 65 nets |
| USB signal anchors | All 14 across the four signal nets |
| Grouped unresolved entries | 32; below the 128-entry limit |
| Pretty-printed JSON size | 119,822 bytes; below 256 KiB |

The established brief's 21 x 51 mm rectangular, two-copper-layer envelope is explicit. PCB traces retain `miter_45`, maximum turn 45 degrees, and prohibitions on right-angle corners, acute interior corners, backtracking and self-intersections. Straight-before-turn distance remains null. This trace policy does not apply to schematic wire appearance.

Every component pin assignment and every net endpoint was compared bidirectionally with the source inventory, including repeated supply/ground contacts, U1's full 61-pin map and both 20-contact headers. J2 local1..20 remains Pico1..20 top-left to bottom-left; J3 local1..20 remains Pico21..40 bottom-right to top-right. The target contact pitch is 2.54 mm and row spacing 17.78 mm. Exact lands, orientation, castellations and mounting features remain unresolved. AGND/Pico33 stays on GND with quiet analog placement requirements.

J1.SH remains one logical terminal whose eventual native footprint must retain all four physical shield stakes. All 16 connector contacts and both NPTH locators must survive native synchronization. The 262 count describes logical pins, not physical PCB pad/features or a native qualification result. The two NCs are `no_connect` assignments and are not functional nets or routing candidates.

## Library candidates are pending

The current [v2 manifest](../../resources/pcb-libraries/rp2350-pico/v2/manifest.json) existed when this draft was generated. Every `EvlEDA_Pico2350:` identifier in the draft was checked for membership in that manifest. This check establishes an existing package entry, not host admission, source binding, native parity or electrical acceptance.

| Ref | Present custom v2 candidate |
| --- | --- |
| U2 symbol | `EvlEDA_Pico2350:RT6150B-33GQW` |
| U2 footprint | `EvlEDA_Pico2350:RT6150B_WDFN-10-1EP_2.5x2.5mm_P0.5mm` |
| U3 symbol | `EvlEDA_Pico2350:W25Q32RVXHJQ` |
| U3 footprint | `EvlEDA_Pico2350:W25Q32RVXH_XSON-8-1EP_3x2mm_P0.5mm_EP0.2x1.6mm` |
| U4 symbol | `EvlEDA_Pico2350:USBLC6-2SC6` |
| L1 footprint | `EvlEDA_Pico2350:AOTA-B201610S3R3-101-T_RaspberryPi_Minimal` |

U3 uses the present v2 candidate for the exact Winbond XH selection, with grounded center metal represented by CAD pad9. Manufacturer numbering remains 1-8; CAD pad9 is a library convention. U4 uses the present custom six-terminal symbol so that pins1/6 and pins3/4 remain independent physical endpoints. These additions supersede the source inventory's missing U3 IDs and stock U4 symbol candidate at the draft level only.

Other non-null library IDs are copied from source candidates. Missing IDs remain null, including the L1/L2 symbols and unaccepted passive/header/button/crystal lands. No newly imagined custom asset name or generic land substitution is inserted. The passive-selection overlay is separate work; its recommendations are not silently promoted to accepted draft footprints or component capabilities.

## USB source-series intent

The current source schema and `tests/helpers/usb-channel-bundle.ts` were inspected for the explicit four-net channel representation. Only the representation was reused; the fixture's fictional components, 22 ohm values, electrical constants and geometry were not copied.

| Polarity | Source and launch net | Series part | Port net and all external anchors |
| --- | --- | --- | --- |
| D+ | U1.52 on USB_DP_MCU | R1.1 -> R1.2, 27 ohm | USB_DP_PORT: J1.A6, J1.B6, U4.1, U4.6, R1.2 |
| D- | U1.51 on USB_DM_MCU | R2.1 -> R2.2, 27 ohm | USB_DM_PORT: J1.A7, J1.B7, U4.3, U4.4, R2.2 |

Primary connector roles are A6/A7; B6/B7 are additional receiver contacts. These are channel bookkeeping roles for the complete USB device connection, not a claim of a unidirectional PHY. Protection returns remain U4.2=GND and U4.5=VBUS. No internal resistor/protection segment is treated as PCB copper, and no endpoint is dropped because the device has internally connected pins.

The source inventory's 90 ohm differential target is retained. Tolerance, analysis frequency, body width/gap, etch/uncoupled/skew budgets, launch length, branch length, aggregate copper length, resistor distance and receiver termination assumptions remain null. All four signal nets require a continuous ground reference path and preserve polarity; the selected signal/plane layers, coverage margin and terminal return anchors remain pending. Port nets have the schema-required tree topology because each has multiple anchors; the two launch nets are point-to-point. Uncontrolled stubs and layer transitions are forbidden by this bounded interface representation; the explicitly declared connector branches remain part of the complete channel.

`channel.escapes` is null. Each escape would require a fully numeric `traceWidthMm` interval even in the current draft schema, while only `maximumRoutedLengthMm` is nullable. No interval was guessed to populate it. Later escape declarations must cover justified terminal launches and prove each narrow edge's actual routed distance to its exact terminal. All 14 known anchors already remain in connectivity and channel mappings.

## Deliberately unresolved engineering values

Every net's electrical object is null: the schema requires complete voltage/current/speed objects and cannot safely store only a known nominal voltage. Known source requirements still apply, including nominal 3.3 V with the combined 3.135-3.6 V rail envelope and the reference VSYS range 1.8-5.5 V. These are not demonstrated operating envelopes or external-current guarantees. No default current, edge rate, frequency, pulse duration, zero-via allowance or unbounded route length is supplied.

Only ground, explicit power rails, external USB VBUS and the four USB signal roles are classified; other roles remain null. Every net-class assignment remains null. The single `PENDING` class has null width, clearance, copper-to-edge and layer values and exists only because the draft schema requires at least one class. It is not a usable manufacturing rule set.

All 62 placement records have null side, region, rotation, edge/courtyard clearance and edge preference. Every route has null selected layer, via count and length constraint. Other than the required USB and GND representations, topology and reference-path decisions remain null. The GND plane record has null layer, boundary, clearance, minimum copper width, fill, pad connection and island policy. No copper has been generated.

The two-layer construction record retains its intended mode but leaves every consequential material/construction field null: total/copper/dielectric thicknesses, permittivity, loss, material frequency, permeability, conductivity/roughness, masks, exterior and finish. Board thickness is not substituted for signal-to-reference spacing, and no FR-4 or copper-weight default is invented.

The unresolved families also retain the source inventory's requirements for passive MPNs and effective capacitance, C1/C2 ESR/ESL, local decoupling associations, L1 marking and regulator loop/quiet-return geometry, L2 current/rolloff, LED operating point, all selected-part lands, header mechanics, U1 A4 traceability, special-order flash procurement, held-BOOT cold-start sequencing, source-current/inrush and ESD compatibility, thermal budgets and allowed power combinations. The complete source inventory remains the detailed checklist; the schema's grouped questions do not waive it.

## Power assertions and pending VSYS qualification

The USB external-input declaration names physical connector supply J1.A4 and return J1.A1. Every duplicate VBUS/GND contact remains in the same exact nets. This only records the intended off-board USB source; it does not establish an attached source, voltage, current entitlement, inrush compliance or permission for 3 A. No external 3V3 injection is declared. A permitted external VSYS mode and coexistence rules must be reviewed separately; it is not assumed active to satisfy USB-only ERC.

Three candidate derived declarations retain the known source paths with null operating assumptions:

| Candidate rail | Driver, passive path and anchor | Return anchor |
| --- | --- | --- |
| 1V1 | U1.48 -> L1.2-to-1 -> U1.6/DVDD | U1.61/GND |
| VREG_AVDD | U2.1 -> R8.1-to-2 -> U1.46 | U2.3 |
| ADC_AVDD | U2.1 -> R16.1-to-2 -> R17.1-to-2 -> U1.44 | U2.3 |

The core annotation anchors are source-verified U1.6/DVDD (`power_in`) and U1.61/GND (`power_in`), satisfying the binding's supply type and exact GND/PGND return-name rules. U1.50/VREG_FB remains a passive feedback pin on 1V1; U1.47/VREG_PGND remains physically on GND. Annotation anchors do not choose copper routes or replace VREG_PGND, exposed-pad, C2 feedback or quiet-return placement requirements. All actual pin/net memberships remain unchanged.

Capacitors, intermediate ADC_VREF/header35 and feedback pins remain real connected endpoints; shunt capacitors and feedback are not inserted as series source-path steps. Driver `power_out` authority, exact stock Device:L/Device:R bindings and all operating assumptions still require source-pinned checks before any assertion can be authored. In particular, L1's symbol is still null.

`VSYS_DIODE_PENDING` now records the software-supported external-diode mapping: **J1.A4/VBUS -> D1.2/anode -> D1.1/cathode -> U2.5/VIN on VSYS**, with U2.3/GND as the consumer annotation return on the same net as J1.A1. Its `externalPowerInput.id` binds the existing `USB_VBUS` declaration exactly. D1 retains the source-selected `Device:D_Schottky` symbol, its two physical pins and their original net assignments. The stable declaration ID remains unchanged.

The current `pcb-derived-power.ts` draft schema explicitly supports this one-diode extension; closing and binding it still require a source-inspected stock connector, one forward stock Schottky A2-to-K1 path, an inspected `power_in` consumer, and its inspected GND/PGND return. Software representation is not native or electrical qualification. `diodeForwardDropAssumption`, `operatingModes` and `operatingAssumptions` remain null because the source inventory supplies no reviewed complete values. Absent, reverse-biased, disabled, alternate-source and simultaneous-source behavior must be reviewed explicitly, together with forward drop over actual current/temperature and downstream operating margins. No diode-path support or qualification is claimed from USB04 connector checks.

The downstream VSYS rail remains internal. The draft does not relabel it as an external source, change passive electrical types, invent a driver, add physical flags or alter existing external-input/derived-source declarations. Native source binding, saved connector/diode/consumer/return parity, independent ERC and electrical qualification remain pending.

D1 blocks VSYS backfeeding VBUS but does not stop USB from driving an attached external VSYS source. Simultaneous sources need external blocking/power-path circuitry; a directly attached raw cell is not an accepted combination. Derived annotations, if eventually supported and qualified, remain schematic-only assertions and must not change the 62-component/262-logical-pin physical inventory.

## Verification performed

A read-only Node process using `node --import tsx --input-type=module` imported the actual TypeScript source parser and compiler. It did not use generated `dist` output or launch KiCad. Checks passed for schema parsing, exact reference/pin/value/net/endpoint correspondence, one-to-one connected assignment coverage, duplicate exclusion, both NCs, 62 placement records, 65 routing records, all 14 USB anchors, 27 ohm source resistors, present custom manifest IDs, null engineering fields, 45-degree policy and size/count bounds. The subsequent external-diode mapping check also preserved the exact USB_VBUS declaration, existing IC-derived paths and physical inventory, and retained null forward-drop/mode/operating assumptions.

Closing the draft correctly throws for unresolved questions. Source compilation returns `needs_clarification` with the parsed draft retained, `contract: null`, `libraryBinding: null`, `verificationPlan: null`, and `nativeAuthoringPerformed: false`. A throwing read-only library resolver was supplied; it received zero calls, proving this unresolved input stopped before library resolution.

| Checked file | SHA-256 |
| --- | --- |
| circuit-inputs.json | `ec7187cda1608ace6f8ba88749341241b97082c2787f5d0a8fe73ad0c99778f2` |
| design-draft.json | `90aae1207cfb4b14aadd9f6613070a452a5f206ebf16896c60685b1dc58c7295` |

No application build, native authoring, native ERC/DRC, stackup analysis, routing, manufacturing export or physical qualification was performed by this draft task. Source/native/runtime/global configuration files were not changed. Independent connector/library qualification belongs to its own evidence and cannot be inferred from these structural checks.
