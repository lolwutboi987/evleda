# RP2350 Pico exact library selection

Reviewed 2026-09-17. This overlay selects exact sources for **62 references and 262 logical pins**, preserving every circuit pin/net assignment. The actual approved-package/stock resolver confirms all 62 pin sets match. Isolated KiCad 10.0.3 exports all 15 unique symbols and 18 footprints, including the unused alternate AOTA footprint. **No library-ID, inheritance or pin-set structural blockers remain.** Runtime host admission and native board placement/copper/ERC/DRC remain integration work.

Package: `resources/pcb-libraries/rp2350-pico/v3`. Manifest SHA-256: `66b34c26e3c789da6506772bff13fa6553faa895d3319738643613d261d51875`, 10,088 bytes. Counts: 4 symbols / 7 footprints / 12 provenance records, below the 16-entry limits. The source identities are in the JSON overlay. v1, v2 and the original circuit, component-selection, draft and placement inputs remain unchanged.

## Decisions

- **SW1/SW2:** the new Wuerth symbol and footprint retain four vendor-numbered contacts: 1/2 common and 3/4 common. Recommended rectangular lands are 1.05 x 0.65 mm at x = +/-2.075, y = +/-1.075 mm. Stock's merged pin numbering and 25 um lower-right asymmetry are not carried forward. Every physical terminal remains a PCB endpoint.
- **C20/C21:** retain TDK C3225X5R1A476M250AC. Select PA = 2.20 mm gap, PB = 1.10 mm length, PC = 2.20 mm width within the [manufacturer ranges](https://product.tdk.com/en/search/capacitor/ceramic/mlcc/info?part_no=C3225X5R1A476M250AC). Lands are 1.10 x 2.20 mm at x = +/-1.65. The courtyard includes the maximum 3.65 x 2.85 mm body. This closes the stock-land discrepancy; effective capacitance and assembly qualification remain separate.
- **J2/J3:** explicitly unpopulated PTH contacts, without fitted plastic header, castellations or a 3D body. Full stock electrical pads remain 1.7 mm copper / 1 mm bore at 2.54 mm pitch. With pad 1 anchors J2 = (1.61,1.37), angle 0 and J3 = (19.39,49.63), angle 180, the 21 x 51 mm board has 0.76 mm side and 0.52 mm end copper margin. The documented courtyard is a bare-contact access envelope, copper plus 0.25 mm. No copper clearance is reduced. J4 retains its complete stock fitted-header envelope.
- **D1:** replace the nonexistent `Diode_SMD:D_SOD-123W` with `Diode_SMD:Nexperia_CFP3_SOD-123W`. PMEG6010ELR pin 1 is K and pin 2 A; nominal body is 2.6 x 1.7 mm and copper lands are 1.2 mm squares at 2.8 mm centers. Manufacturer 1.1 mm paste / 0.1 mm stencil differs from stock full-pad paste and remains a process review.
- **Q1/Y1/L2:** select stock SOT-523 with G1/S2/D3, the ABM8-compatible crystal pad arrangement with case grounds 2/4, and Coilcraft XFL4020 lands. Y1's stacked symbol ground pins remain two physical PCB terminals. Actual MPNs govern body-diode orientation, crystal startup and inductor electrical limits.
- **U1/U2/U3/U4, J1, L1 and ordinary passives:** preserve the known exact sources and component-selection MPNs. Flash CAD 9 remains internally unconnected center metal assigned board GND. USB duplicate physical contacts and marked core-inductor orientation remain required.

Details are in the v3 provenance records. Manufacturer PDFs are not redistributed. Procurement and physical tests are later qualifications; they do not leave exact-ID selection pending.

## Exact per-reference mapping

| Ref | MPN / population | Symbol ID | Footprint ID |
| --- | --- | --- | --- |
| U1 | RP2350A | `MCU_RaspberryPi:RP2350A` | `Package_DFN_QFN:QFN-60-1EP_7x7mm_P0.4mm_EP3.4x3.4mm` |
| U2 | RT6150B-33GQW | `EvlEDA_Pico2350:RT6150B-33GQW` | `EvlEDA_Pico2350:RT6150B_WDFN-10-1EP_2.5x2.5mm_P0.5mm` |
| U3 | W25Q32RVXHJQ | `EvlEDA_Pico2350:W25Q32RVXHJQ` | `EvlEDA_Pico2350:W25Q32RVXH_XSON-8-1EP_3x2mm_P0.5mm_EP0.2x1.6mm` |
| U4 | USBLC6-2SC6 | `EvlEDA_Pico2350:USBLC6-2SC6` | `Package_TO_SOT_SMD:SOT-23-6` |
| J1 | USB4105-GF-A | `Connector:USB_C_Receptacle_USB2.0_16P` | `Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal` |
| J2 | unpopulated PCB contacts; no fitted header strip | `Connector_Generic:Conn_01x20` | `EvlEDA_Pico2350:Pico_BarePTH_1x20_P2.54mm_D1.0mm_Pad1.7mm` |
| J3 | unpopulated PCB contacts; no fitted header strip | `Connector_Generic:Conn_01x20` | `EvlEDA_Pico2350:Pico_BarePTH_1x20_P2.54mm_D1.0mm_Pad1.7mm` |
| J4 | fit | `Connector_Generic:Conn_01x03` | `Connector_PinHeader_2.54mm:PinHeader_1x03_P2.54mm_Vertical` |
| L1 | AOTA-B201610S3R3-101-T | `Device:L` | `EvlEDA_Pico2350:AOTA-B201610S3R3-101-T_RaspberryPi_Minimal` |
| L2 | XFL4020-222MEC | `Device:L` | `Inductor_SMD:L_Coilcraft_XxL4020` |
| Q1 | DMG1012T-7 | `Transistor_FET:Q_NMOS_GSD` | `Package_TO_SOT_SMD:SOT-523` |
| D1 | PMEG6010ELR | `Device:D_Schottky` | `Diode_SMD:Nexperia_CFP3_SOD-123W` |
| D2 | APT1608CGCK | `Device:LED` | `LED_SMD:LED_0603_1608Metric` |
| SW1 | 434133025816 | `EvlEDA_Pico2350:Wuerth_434133025816` | `EvlEDA_Pico2350:Wuerth_434133025816_4Terminal` |
| SW2 | 434133025816 | `EvlEDA_Pico2350:Wuerth_434133025816` | `EvlEDA_Pico2350:Wuerth_434133025816_4Terminal` |
| Y1 | ABM8-272-T3 | `Device:Crystal_GND24` | `Crystal:Crystal_SMD_3225-4Pin_3.2x2.5mm` |
| R1 | RC0402FR-0727RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R2 | RC0402FR-0727RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R3 | RC0402FR-075K1L | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R4 | RC0402FR-075K1L | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R5 | RC0402FR-071KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R6 | RC0402FR-0710KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R7 | RC0402FR-071KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R8 | RC0402FR-0733RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R9 | RC0402FR-07100KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R10 | RC0402FR-07100KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R11 | RC0402FR-075K6L | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R12 | RC0402FR-0710KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R13 | RC0402FR-07100KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R14 | RC0402FR-07100KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R15 | RC0402FR-07100KL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R16 | RC0402FR-07200RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R17 | RC0402FR-071RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R18 | RC0402FR-07470RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R19 | RC0402FR-07100RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| R20 | RC0402FR-07100RL | `Device:R` | `Resistor_SMD:R_0402_1005Metric` |
| C1 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C2 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C3 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C4 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C5 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C6 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C7 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C8 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C9 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C10 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C11 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C12 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C13 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C14 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C15 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C16 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C17 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C18 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C19 | GRM155R60J475ME47D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C20 | C3225X5R1A476M250AC | `Device:C` | `EvlEDA_Pico2350:C3225X5R1A476M250AC_TDK_PA2.2_PB1.1_PC2.2` |
| C21 | C3225X5R1A476M250AC | `Device:C` | `EvlEDA_Pico2350:C3225X5R1A476M250AC_TDK_PA2.2_PB1.1_PC2.2` |
| C22 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C23 | C1005X7R1H102K050BA | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C24 | GRM1555C1H150JA01D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C25 | GRM1555C1H150JA01D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |
| C26 | GRM155R71E104KE14D | `Device:C` | `Capacitor_SMD:C_0402_1005Metric` |

## Verification and limits

Independent checks cover manufacturer switch pin groups and land arithmetic, TDK intervals, bare-contact stock pad equivalence, edge margins, stock diode/MOSFET/crystal/inductor geometry, polarized symbol pin functions and immutable input/source preservation. The actual bounded reader checks hashes, schemas, terminal geometry and all pin sets. Native exports confirm KiCad parseability. Fresh visual review covered the four new assets; remaining stock assets received source/geometry and native-export checks.

Evidence is outside Git at `../rp2350-reference-inputs-01/vendor-assets/v3/`: `bounded-inspection.json`, `validation-report.json`, `native-command-results.json`, native exports and `QUALIFICATION.md`.

This overlay establishes no completed-board, electrical, assembly, procurement or manufacturing acceptance. Preserve review of the original power, USB, thermal and effective-capacitance requirements; physical return paths; board clearances; hole/plating/stencil tolerances; and mechanical access.

## v4 mechanical package extension

The new `resources/pcb-libraries/rp2350-pico/v4` adds `EvlEDA_Pico2350:MountingHole_D2.1_Pico` for four board-only mounting bores. All v3 electrical CAD bytes are preserved. This section does not change the 62-reference selection above: its package pointer and inspection identities remain historical v3 evidence. Integration must recapture the complete v4 source binding.

The new asset is one centered, netless circular NPTH, empty pad number, size = drill = 2.1 mm. Official Pico 2 Figure 3 specifies a nominal 2.1 mm (+/-0.05 mm) bore. Exact attributes are `board_only exclude_from_pos_files exclude_from_bom`; there is no electrical symbol or BOM component. Fabrication graphics depict only the bore. No head, washer, screw-body or courtyard is invented. The board-feature contract supplies positions and the 0.25 mm minimum hole-to-copper clearance. Native instance UUIDs are assigned by the host.

v4 manifest SHA-256: `465ab0fae74b2ad0d8dca3d068e8196e885b3de9b9f0a5b33b81d6e2401a2514`, 10,953 bytes. Footprint SHA-256: `90c2eda973e65bf3faaa73f6ca6c8e829923f73963d783357d5bc17ff33f6ca6`, 796 bytes. Counts: 4 symbols / 8 footprints / 13 provenance records. Actual package inspection, strict mechanical source guards and isolated KiCad 10.0.3 export passed; no board-level or fabrication-accuracy acceptance is implied. Evidence is in `../rp2350-reference-inputs-01/vendor-assets/v4/`.
