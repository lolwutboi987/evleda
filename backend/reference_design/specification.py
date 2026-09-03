"""Exact parts, primary evidence, and hard constraints for the reference board."""

from __future__ import annotations

from backend.design_kernel import Component, PinDefinition, stable_hash

from .model import BomLine, DesignConstraint, SourceEvidence

PROJECT_ID = "reference-usb-c-3v3-r2"
SCHEMATIC_REVISION = "REV2"
OUTPUT_MARKING = "3V3 OUT 100mA MAX / DO NOT APPLY POWER"
BOARD_WIDTH_NM = 50_000_000
BOARD_HEIGHT_NM = 30_000_000
PCB_THICKNESS_NM = 800_000
QUALIFIED_OUTPUT_CURRENT_MA = 100

USB4105_SPEC_SHA256 = "372fe1bc0e0b1b4ce7e18b61514e967c7c2f883f0c7fe1f4586b567785ee9cd2"
KICAD_USB4105_FOOTPRINT_SHA256 = (
    "3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8"
)
KICAD_FOOTPRINT_COMMIT = "f6d77c54d79275c888daae4c60e4c9869ffa4aa5"
TPS2596_SHA256 = "66f6bae4494f7bfe7dfdc314e508f0291d9ca1e87265cca9b6fdfeaa5cb19fe9"
LP38692_SHA256 = "37d312bc1c8189f8fe4275ceaf8928d447cb6faaa2796e503d6120a891376352"
LP38692_PACKAGE_MATERIALS_SHA256 = (
    "66d625b45fbcf490aadf6a7fc21dff541020bfe54c09f0de5a58ed825cce0799"
)
LP38692_PRODUCT_SHA256 = "ffd6ccd9379b910b36798c39ab5297c8bddc47dd31c8ec1ec628923220eb745a"
PTVS_SHA256 = "dd54840b481bf99b3a1082dd08cd556e695991a1b36799e98eb43b7e890e00c1"
VISHAY_DCRCW_SHA256 = "504e687c8ff86ffc367637421ff0035d9999f663c62d9a8e352a0eab3dd5cd84"
VISHAY_WSLP_SHA256 = "5d20b5572767451d6a38e1e37c6f0f3113eb604e72593a6cd97a0a944458455b"
VISHAY_WSLP_PRODUCT_SHA256 = (
    "c82fdb1a9530a67f215e0d29417d0e47d08d86353783242aad4f93476665ca39"
)
WURTH_CAP_SHA256 = "eff87bfa4247a47581c55478f6785a150e90385c3d6ac9ccae441ed9a5903f18"
KEMET_CAP_SHA256 = "cf62230c9eab481767a04c96beb3822aa6328f65277ecd3e59697459c211043c"
KEMET_X7R_SHA256 = "08ff1421c1b73de93a93bebee13957da3e53bb2753d5653f3b9d59948542af01"
KEMET_BIAS_CSV_SHA256 = "5384950766c89e2a371687f114f0de8e46f01d6877b6c1c6126b4670ac123230"
KEMET_T59X_SHA256 = "64cc7925483d23bc88a92c0dde3bba58e60152765bed5602f859c04c0c5db729"
KEMET_C0G_FAMILY_SHA256 = (
    "02d179914aeb9585eb2229ba8e18ef9d6b01c77c056de2af295d6950a2a5cc0d"
)
KEMET_C1206C104_SHA256 = (
    "dbafe0002fa3f302ec182bbe37f000f47190256b73ee7c10b8066a55df835609"
)
WURTH_LED_SHA256 = "75685f7ae49ae4fa3c05ea3c6ad7a72d53747ca803320a8b96b8fdf38b368da7"
WURTH_HEADER_SHA256 = "a054dde42f94b42e1f34117df97a37071aa9e57febcb8375058a3fb7dbae6dbe"
KEYSTONE_TESTPOINT_SHA256 = "00919bf8da5da41c978fe22717f8b39d443d03bb69bdd0a853ced85479fb237c"
TI_USB_C_GUIDE_SHA256 = "628c876e0a9bc49f3605fded91eaef7f8a7b84914861d3a315fa8e8f61efc892"
USB_TYPE_C_R25_RELEASE_SHA256 = "603c2cb0ea356d367fea61f8747a21981f0da9abae4d8ec15556e0063edb81b5"
USB_TYPE_C_R25_PDF_SHA256 = "6636cd61387a2f78b0fa96c8ea86ccc0f39ec59f98821cdb57b206d31445a328"


def _pins(*pins: PinDefinition) -> tuple[PinDefinition, ...]:
    return tuple(pins)


def _pin(
    number: str,
    name: str,
    electrical_type: str,
    *,
    pad_number: str | None = None,
    required: bool = True,
) -> PinDefinition:
    return PinDefinition(number, name, electrical_type, pad_number or number, required)


def _pin_map_sha256(component_id: str, pins: tuple[PinDefinition, ...]) -> str:
    return stable_hash(
        {"component_id": component_id, "pins": pins},
        domain="flux-clone-reference-pin-map-v1",
    )


def _component(
    component_id: str,
    reference: str,
    value: str,
    manufacturer_part_number: str,
    package: str,
    symbol_id: str,
    footprint_id: str,
    datasheet_sha256: str,
    pins: tuple[PinDefinition, ...],
) -> Component:
    return Component(
        component_id,
        reference,
        value,
        manufacturer_part_number,
        package,
        symbol_id,
        footprint_id,
        datasheet_sha256,
        _pin_map_sha256(component_id, pins),
        pins,
    )


def components() -> tuple[Component, ...]:
    """Return the exact fitted component set in reference order."""

    connector_pins = _pins(
        _pin("A1", "GND", "passive"),
        _pin("A4", "VBUS", "power_out"),
        _pin("A5", "CC1", "passive"),
        _pin("A6", "D+", "no_connect", required=False),
        _pin("A7", "D-", "no_connect", required=False),
        _pin("A8", "SBU1", "no_connect", required=False),
        _pin("A9", "VBUS", "passive"),
        _pin("A12", "GND", "passive"),
        _pin("B1", "GND", "passive"),
        _pin("B4", "VBUS", "passive"),
        _pin("B5", "CC2", "passive"),
        _pin("B6", "D+", "no_connect", required=False),
        _pin("B7", "D-", "no_connect", required=False),
        _pin("B8", "SBU2", "no_connect", required=False),
        _pin("B9", "VBUS", "passive"),
        _pin("B12", "GND", "passive"),
        _pin("S1", "SHIELD", "passive"),
    )
    efuse_pins = _pins(
        _pin("1", "GND", "passive"),
        _pin("2", "dVdt", "passive"),
        _pin("3", "EN/UVLO", "input"),
        _pin("4", "IN", "power_in"),
        _pin("5", "OUT", "power_out"),
        _pin("6", "FLT", "no_connect", required=False),
        _pin("7", "ILM", "passive"),
        _pin("8", "OVCSEL", "passive"),
        _pin("EP", "EXPOSED_PAD", "passive", pad_number="9"),
    )
    ldo_pins = _pins(
        _pin("1", "EN", "input"),
        _pin("2", "NC", "no_connect", required=False),
        _pin("3", "OUT", "power_out"),
        _pin("4", "IN", "power_in"),
        _pin("5", "GND/TAB", "passive"),
    )
    passive_pins = _pins(_pin("1", "1", "passive"), _pin("2", "2", "passive"))
    tvs_pins = _pins(_pin("1", "K", "passive"), _pin("2", "A", "passive"))
    led_pins = _pins(_pin("1", "K", "passive"), _pin("2", "A", "passive"))
    testpoint_pin = _pins(_pin("1", "TEST", "passive"))
    header_pins = _pins(_pin("1", "3V3", "passive"), _pin("2", "GND", "passive"))

    return (
        _component(
            "usb-j1",
            "J1",
            "USB-C 5V sink",
            "USB4105-GF-A",
            "USB-C-16P-SMT/PTH",
            "Connector_Generic:USB_C_Receptacle_USB2.0_16P",
            "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal",
            USB4105_SPEC_SHA256,
            connector_pins,
        ),
        _component(
            "efuse-u1",
            "U1",
            "0.247A eFuse/OVC latch-off",
            "TPS259620DDAR",
            "SOIC-8-EP-DDA",
            "Power_Management:TPS259620",
            "Package_SO:Texas_HSOP-8-1EP_3.9x4.9mm_P1.27mm",
            TPS2596_SHA256,
            efuse_pins,
        ),
        _component(
            "ldo-u2",
            "U2",
            "3.3V 1A LDO",
            "LP38692MPX-3.3/NOPB",
            "NDC/SOT-223-5",
            "Regulator_Linear:LP38692",
            "Package_TO_SOT_SMD:SOT-223-5_TabPin5",
            LP38692_SHA256,
            ldo_pins,
        ),
        _component(
            "tvs-d1",
            "D1",
            "5.5V unidirectional TVS",
            "PTVS5V5Z1UPC",
            "DFN1610-2",
            "Device:D_TVS",
            "Diode_SMD:Nexperia_DFN1610-2",
            PTVS_SHA256,
            tvs_pins,
        ),
        _component(
            "cc-r1",
            "R1",
            "5.1k 1%",
            "CRCW06035K10FKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "cc-r2",
            "R2",
            "5.1k 1%",
            "CRCW06035K10FKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "ilim-r3",
            "R3",
            "3.83k 1%",
            "CRCW06033K83FKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "ovc-r4",
            "R4",
            "200k 1%",
            "CRCW0603200KFKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "ovc-r5",
            "R5",
            "200k 1%",
            "CRCW0603200KFKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "en-hi-r6",
            "R6",
            "249k 1%",
            "CRCW0603249KFKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "en-lo-r7",
            "R7",
            "100k 1%",
            "CRCW0603100KFKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "led-r8",
            "R8",
            "1k 1%",
            "CRCW06031K00FKEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_DCRCW_SHA256,
            passive_pins,
        ),
        _component(
            "cout-esr-r9",
            "R9",
            "10mOhm 1%",
            "WSLP0603R0100FEA",
            "0603",
            "Device:R",
            "Resistor_SMD:R_0603_1608Metric",
            VISHAY_WSLP_SHA256,
            passive_pins,
        ),
        _component(
            "cin-c1",
            "C1",
            "1uF 16V X7R",
            "885012207051",
            "0805",
            "Device:C",
            "Capacitor_SMD:C_0805_2012Metric",
            WURTH_CAP_SHA256,
            passive_pins,
        ),
        _component(
            "cldo-c2",
            "C2",
            "4.7uF 25V X7R",
            "C0805C475K3RACTU",
            "0805",
            "Device:C",
            "Capacitor_SMD:C_0805_2012Metric",
            KEMET_CAP_SHA256,
            passive_pins,
        ),
        _component(
            "cout-c3",
            "C3",
            "22uF 10V polymer +/-20%",
            "T598B226M010ATE070",
            "B/3528-20 polarized",
            "Device:C_Polarized",
            "Capacitor_SMD:CP_EIA-3528-21_Kemet-B",
            KEMET_T59X_SHA256,
            passive_pins,
        ),
        _component(
            "dvdt-c4",
            "C4",
            "100nF 25V C0G +/-5%",
            "C1206C104J3GACTU",
            "1206",
            "Device:C",
            "Capacitor_SMD:C_1206_3216Metric",
            KEMET_C1206C104_SHA256,
            passive_pins,
        ),
        _component(
            "led-d2",
            "D2",
            "green 0603 LED",
            "150060VS75000",
            "0603",
            "Device:LED",
            "LED_SMD:LED_0603_1608Metric",
            WURTH_LED_SHA256,
            led_pins,
        ),
        _component(
            "out-j2",
            "J2",
            OUTPUT_MARKING,
            "61300211121",
            "1x02 P2.54 THT",
            "Connector_Generic:Conn_01x02",
            "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
            WURTH_HEADER_SHA256,
            header_pins,
        ),
        *tuple(
            _component(
                f"tp-{index}",
                f"TP{index}",
                name,
                "5015",
                "SMT test point",
                "Connector:TestPoint",
                "TestPoint:TestPoint_Keystone_5015_Micro_Miniature",
                KEYSTONE_TESTPOINT_SHA256,
                testpoint_pin,
            )
            for index, name in enumerate(("VBUS_RAW", "V5_PROTECTED", "3V3", "GND"), start=1)
        ),
    )


def sources() -> tuple[SourceEvidence, ...]:
    return (
        SourceEvidence(
            "src-usb-type-c-r25",
            "USB-IF USB Type-C 2.5 release",
            "https://www.usb.org/sites/default/files/USB%20Type-C%202.5%20Release%20202603.zip",
            USB_TYPE_C_R25_RELEASE_SHA256,
            "USB-Type-C-R2.5-release-202603",
            (
                "The release ZIP contains the reviewed main specification PDF with SHA-256 "
                + USB_TYPE_C_R25_PDF_SHA256
                + ".",
                "A sink-only receptacle uses separate Rd terminations on CC1 and CC2.",
                "This design remains at default 5 V behavior and does not "
                "negotiate USB Power Delivery.",
            ),
            ("usb-j1", "cc-r1", "cc-r2"),
        ),
        SourceEvidence(
            "src-kicad-footprint-usb4105",
            "Official KiCad USB4105 connector footprint",
            "https://gitlab.com/kicad/libraries/kicad-footprints/-/raw/"
            + KICAD_FOOTPRINT_COMMIT
            + "/Connector_USB.pretty/"
            "USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal.kicad_mod",
            KICAD_USB4105_FOOTPRINT_SHA256,
            "kicad-footprints-" + KICAD_FOOTPRINT_COMMIT,
            (
                "The public KiCad library footprint names USB4105-GF-A among its supported "
                "variants and publishes the contact, shell-slot, locator-hole, body, courtyard, "
                "and PCB-edge geometry used by this reference design.",
                "The reference connector land pattern is an integer-nanometre transcription of "
                "the pads and holes in this exact commit-pinned public footprint.",
                "This CC BY-SA 4.0 design-library geometry does not qualify connector fit, "
                "board-thickness compatibility, retention, fabrication, or mechanical mating.",
            ),
            ("usb-j1",),
        ),
        SourceEvidence(
            "src-usb4105-spec",
            "GCT USB4105 product specification",
            "https://gct.co/files/specs/usb4105-spec.pdf",
            USB4105_SPEC_SHA256,
            "A3-2023-02-27",
            (
                "USB4105 is an active USB 2.0 Type-C receptacle; ratings do not "
                "certify this end product.",
            ),
            ("usb-j1",),
        ),
        SourceEvidence(
            "src-ti-usb-c-guide",
            "TI USB Type-C implementation guide",
            "https://www.ti.com/lit/pdf/slyy228",
            TI_USB_C_GUIDE_SHA256,
            "November-2024",
            (
                "A simple 5 V sink uses one 5.1 kOhm Rd from each CC pin to ground.",
                "A passive sink keeps VBUS capacitance below 10 uF or controls the power path.",
            ),
            ("usb-j1", "cc-r1", "cc-r2"),
        ),
        SourceEvidence(
            "src-tps2596",
            "Texas Instruments TPS2596 datasheet",
            "https://www.ti.com/lit/ds/symlink/tps2596.pdf",
            TPS2596_SHA256,
            "SLVSET8A-August-2019",
            (
                "TPS259620 is the latch-off 5.7 V selectable-clamp variant.",
                "The exact RILM 3.83 kOhm table row is 0.224 A minimum, "
                "0.247 A typical, and 0.269 A maximum.",
                "dVdt charging current is 1.89/2.11/2.33 uA and dVdt gain is "
                "20.31/20.93/21.50 V over the electrical-characteristics conditions.",
                "TPS25962x input quiescent current is specified at 266 uA maximum.",
                "Two series 200 kOhm resistors implement 400 kOhm OVCSEL-to-ground.",
                "The exposed pad is ground and must be soldered to the ground plane.",
                "The DDA land-pattern example uses 2.95 x 4.90 mm center copper "
                "and a 2.40 x 3.10 mm solder-mask-defined opening.",
                "Its 0.127 mm stencil example uses a 3.10 x 2.40 mm center "
                "aperture; final stencil design remains assembler-dependent.",
            ),
            (
                "efuse-u1",
                "ilim-r3",
                "ovc-r4",
                "ovc-r5",
                "en-hi-r6",
                "en-lo-r7",
                "dvdt-c4",
            ),
        ),
        SourceEvidence(
            "src-ti-lp38692-datasheet",
            "Texas Instruments LP38690/LP38692 datasheet",
            "https://www.ti.com/lit/ds/symlink/lp38692.pdf",
            LP38692_SHA256,
            "SNVS322M-December-2004-Revised-December-2015",
            (
                "The retained datasheet body identifies itself as SNVS322M, "
                "December 2004, revised December 2015; the generic notice's "
                "10/2025 footer is not the datasheet revision.",
                "LP38692 NDC pins are EN 1, NC 2, OUT 3, IN 4, and GND/tab 5.",
                "Loaded quiescent current is specified at 100 uA maximum for "
                "100 uA through 1 A load over -40 C to +125 C.",
                "Application guidance calls for at least 1 uF output capacitance "
                "and 5 mOhm to 500 mOhm ESR, but TI marks application-section "
                "information as not part of the component specification.",
                "The repeated-enable foldback limitation, output-to-input reverse "
                "current paths, and NDC0005A thermal land requirements require "
                "board-level qualification.",
            ),
            ("ldo-u2", "cldo-c2", "cout-c3"),
        ),
        SourceEvidence(
            "src-ti-lp38692-package-materials",
            "Texas Instruments LP38690/LP38692 package materials",
            "https://www.ti.com/ods/sysadd/pm/symlink/lp38690_pm.pdf",
            LP38692_PACKAGE_MATERIALS_SHA256,
            "LP38690-package-materials-retrieved-2026-08-31",
            (
                "The exact LP38692MPX-3.3/NOPB orderable row uses the five-pin "
                "NDC/SOT-223 package.",
            ),
            ("ldo-u2",),
        ),
        SourceEvidence(
            "src-ti-lp38692-product",
            "Texas Instruments LP38692MPX-3.3/NOPB product page",
            "https://www.ti.com/product/LP38692/part-details/LP38692MPX-3.3/NOPB",
            LP38692_PRODUCT_SHA256,
            "retrieved-2026-08-31",
            (
                "TI identifies LP38692MPX-3.3/NOPB as the active fixed-3.3 V, "
                "five-pin NDC/SOT-223 orderable part.",
            ),
            ("ldo-u2",),
        ),
        SourceEvidence(
            "src-kemet-t59x",
            "KEMET T591/T598/T597/T599 polymer tantalum datasheet",
            "https://content.kemet.com/datasheets/KEM_T2073_T59X.pdf",
            KEMET_T59X_SHA256,
            "KEM-T2073-T59X-2025-11-05",
            (
                "T598B226M010ATE070 is a polarized 22 uF +/-20 percent, 10 V, "
                "B/3528-20 polymer capacitor with 70 mOhm maximum ESR at "
                "+25 C and 100 kHz.",
                "The 70 mOhm row is not a guaranteed instantaneous ESR bound "
                "over the board's full -40 C to +80 C qualification range.",
            ),
            ("cout-c3",),
        ),
        SourceEvidence(
            "src-vishay-wslp",
            "Vishay WSLP power metal strip resistor datasheet",
            "https://www.vishay.com/docs/30122/wslp.pdf",
            VISHAY_WSLP_SHA256,
            "30122-Rev-09-Sep-2024",
            (
                "WSLP0603R0100FEA is 10 mOhm +/-1 percent in 0603 with "
                "+/-110 ppm/C component TCR for the 10 mOhm value range.",
                "The 0.4 W rating is specified at +70 C and requires the "
                "manufacturer derating curve outside that condition.",
            ),
            ("cout-esr-r9",),
        ),
        SourceEvidence(
            "src-vishay-wslp-product",
            "Vishay WSLP official product page",
            "https://www.vishay.com/en/product/30122/",
            VISHAY_WSLP_PRODUCT_SHA256,
            "retrieved-2026-08-31",
            ("Vishay identifies the official WSLP series and its quality resources.",),
            ("cout-esr-r9",),
        ),
        SourceEvidence(
            "src-kemet-c0g-family",
            "KEMET C0G commercial-grade SMD MLCC datasheet",
            "https://content.kemet.com/datasheets/kem_c1003_c0g_smd.pdf",
            KEMET_C0G_FAMILY_SHA256,
            "KEM-C1003-C0G-2025-02-20",
            (
                "The family table places 100 nF C0G at 25 V in 1206 rather "
                "than 0603 or 0805 and specifies the C0G temperature behavior.",
                "The IPC-7351 nominal density-B 1206 land-pattern dimensions "
                "are C=1.50 mm, Y=1.15 mm, X=1.80 mm, V1=4.70 mm, and V2=2.30 mm.",
            ),
            ("dvdt-c4",),
        ),
        SourceEvidence(
            "src-kemet-c1206c104",
            "KEMET C1206C104J3GACTU exact-part specification",
            "https://search.kemet.com/component-documentation/download/specsheet/C1206C104J3GACTU",
            KEMET_C1206C104_SHA256,
            "C1206C104J3GACTU-retrieved-2026-08-31",
            (
                "C1206C104J3GACTU is 100 nF +/-5 percent, 25 V, C0G/NP0 in 1206.",
                "Combining tolerance with a conservative +/-0.30 percent C0G "
                "temperature envelope gives a 94.715 nF to 105.315 nF timing screen.",
            ),
            ("dvdt-c4",),
        ),
        SourceEvidence(
            "src-ptvs",
            "Nexperia PTVS5V5Z1UPC datasheet",
            "https://assets.nexperia.com/documents/data-sheet/PTVS5V5Z1UPC.pdf",
            PTVS_SHA256,
            "v1-2024-10-28",
            (
                "Pin 1 is cathode, pin 2 is anode, and reverse standoff is 5.5 V.",
                "This part is transient and ESD protection, not sustained overvoltage regulation.",
                "Each reflow terminal uses 0.70 x 1.20 mm copper, 0.60 x 1.10 mm "
                "solder resist, and 0.35 x 1.00 mm paste for the 0.10 mm stencil "
                "example.",
            ),
            ("tvs-d1",),
        ),
        SourceEvidence(
            "src-vishay-resistors",
            "Vishay D/CRCW e3 resistor datasheet",
            "https://www.vishay.com/docs/20035/dcrcwe3.pdf",
            VISHAY_DCRCW_SHA256,
            "Rev-2026-04-14",
            ("Every fitted CRCW0603 value is a 1 percent thick-film part in the reviewed series.",),
            tuple(
                component.component_id
                for component in components()
                if component.reference.startswith("R")
                and component.component_id != "cout-esr-r9"
            ),
        ),
        SourceEvidence(
            "src-wurth-cap",
            "Wuerth Elektronik 885012207051 datasheet",
            "https://www.we-online.com/components/products/datasheet/885012207051.pdf",
            WURTH_CAP_SHA256,
            "PSL-002.000-2021-01-03",
            (
                "The fitted part is 1 uF, 16 V, X7R, 0805; effective capacitance "
                "under DC bias remains to be measured.",
            ),
            ("cin-c1",),
        ),
        SourceEvidence(
            "src-kemet-cap",
            "KEMET C0805C475K3RACTU specification and K-SIM bias screen",
            "https://search.kemet.com/component-documentation/download/specsheet/C0805C475K3RACTU",
            KEMET_CAP_SHA256,
            "C0805C475K3RACTU-reviewed-2026-08-31",
            (
                "The fitted part is 4.7 uF, 25 V, X7R, 0805 with +/-10 percent tolerance.",
                "The general X7R datasheet SHA-256 is " + KEMET_X7R_SHA256 + ".",
                "The reviewed K-SIM DC-bias CSV SHA-256 is " + KEMET_BIAS_CSV_SHA256 + ".",
                "A tolerance, TCC, aging, and typical DC-bias screen estimates at "
                "least 2.827 uF at 5.61 V.",
                "K-SIM values are typical simulations rather than guaranteed "
                "production minima, so C2 remains a release qualification item.",
            ),
            ("cldo-c2",),
        ),
        SourceEvidence(
            "src-wurth-led",
            "Wuerth Elektronik 150060VS75000 datasheet",
            "https://www.we-online.com/components/products/datasheet/150060VS75000.pdf",
            WURTH_LED_SHA256,
            "PLD-002.009-2019-02-26",
            (
                "The fitted indicator is a green 0603 LED with explicit cathode "
                "and anode orientation.",
            ),
            ("led-d2",),
        ),
        SourceEvidence(
            "src-wurth-header",
            "Wuerth Elektronik 61300211121 datasheet",
            "https://www.we-online.com/components/products/datasheet/61300211121.pdf",
            WURTH_HEADER_SHA256,
            "CPo-003.000-2023-01-08",
            ("Two positions at 2.54 mm pitch use recommended 1.10 mm finished holes.",),
            ("out-j2",),
        ),
        SourceEvidence(
            "src-keystone-testpoint",
            "Keystone SMT test point catalog",
            "https://www.keystone-europe.com/wp-content/uploads/2025/08/terminal-test-points.pdf",
            KEYSTONE_TESTPOINT_SHA256,
            "M75-S3-complete-R4-2025",
            ("Part 5015 is an SMT micro-miniature probe point with a 3.4 mm by 1.8 mm land.",),
            ("tp-1", "tp-2", "tp-3", "tp-4"),
        ),
    )


def bom() -> tuple[BomLine, ...]:
    source_by_component: dict[str, tuple[str, ...]] = {}
    for source in sources():
        for component_id in source.component_ids:
            source_by_component.setdefault(component_id, ())
            source_by_component[component_id] += (source.evidence_id,)
    manufacturers = {
        "J1": "GCT",
        "U1": "Texas Instruments",
        "U2": "Texas Instruments",
        "D1": "Nexperia",
        "D2": "Wuerth Elektronik",
        "J2": "Wuerth Elektronik",
        "C1": "Wuerth Elektronik",
        "C2": "KEMET/YAGEO",
        "C3": "KEMET/YAGEO",
        "C4": "KEMET/YAGEO",
        "R9": "Vishay",
    }
    roles = {
        "J1": "USB-C receptacle",
        "U1": "input eFuse, current limit, and overvoltage clamp",
        "U2": "3.3 V linear regulator",
        "D1": "VBUS transient and ESD shunt",
        "D2": "3.3 V power indicator",
        "J2": "output-only 3.3 V and ground header",
        "C1": "raw VBUS eFuse bypass",
        "C2": "LDO input bypass",
        "C3": "polarized LDO output capacitor behind the damping resistor",
        "C4": "eFuse dVdt timing capacitor",
        "R9": "LDO output-capacitor ESR-floor resistor; capacitor branch only",
    }
    lines: list[BomLine] = []
    for component in components():
        manufacturer = manufacturers.get(
            component.reference,
            "Keystone Electronics" if component.reference.startswith("TP") else "Vishay",
        )
        role = roles.get(
            component.reference,
            "accessible voltage test point"
            if component.reference.startswith("TP")
            else "precision programming or indicator resistor",
        )
        lines.append(
            BomLine(
                component.reference,
                component.component_id,
                manufacturer,
                component.manufacturer_part_number,
                component.value,
                component.package,
                role,
                tuple(sorted(set(source_by_component[component.component_id]))),
            )
        )
    return tuple(sorted(lines, key=lambda line: line.reference))


def constraints() -> tuple[DesignConstraint, ...]:
    return (
        DesignConstraint(
            "usb-mode",
            "electrical",
            "5 V sink only; no USB data and no USB Power Delivery negotiation.",
            source_evidence_ids=("src-usb-type-c-r25", "src-ti-usb-c-guide"),
        ),
        DesignConstraint(
            "usb-input-scope",
            "safety",
            "Qualified input is a compliant USB Type-C default 5 V source from "
            "4.75 V to 5.50 V only. The board makes no sustained 9 V, 12 V, 19 V, "
            "or 21 V survival claim; TPS259620 component ratings are not the "
            "product input rating.",
            4_750,
            5_500,
            5_000,
            "mV",
            ("src-usb-type-c-r25", "src-ti-usb-c-guide", "src-tps2596", "src-ptvs"),
        ),
        DesignConstraint(
            "usb-rd-cc1",
            "electrical",
            "CC1 has its own 5.1 kOhm 1 percent Rd to ground.",
            5_049,
            5_151,
            5_100,
            "ohm",
            ("src-usb-type-c-r25", "src-ti-usb-c-guide", "src-vishay-resistors"),
        ),
        DesignConstraint(
            "usb-rd-cc2",
            "electrical",
            "CC2 has its own 5.1 kOhm 1 percent Rd to ground.",
            5_049,
            5_151,
            5_100,
            "ohm",
            ("src-usb-type-c-r25", "src-ti-usb-c-guide", "src-vishay-resistors"),
        ),
        DesignConstraint(
            "vbus-capacitance",
            "electrical",
            "Capacitance directly on raw VBUS remains below the passive-sink 10 uF limit.",
            maximum=10_000,
            nominal=1_000,
            unit="nF",
            source_evidence_ids=("src-ti-usb-c-guide", "src-wurth-cap"),
        ),
        DesignConstraint(
            "ldo-input-effective-capacitance",
            "electrical",
            "C2's engineering screen remains above the LP38692 1.0 uF input "
            "guidance at 5.61 V after tolerance, X7R TCC, aging, and typical K-SIM bias loss.",
            minimum=1_000,
            nominal=2_827,
            unit="nF",
            source_evidence_ids=("src-ti-lp38692-datasheet", "src-kemet-cap"),
        ),
        DesignConstraint(
            "ldo-output-capacitance-screen",
            "electrical",
            "C3 is polarized with positive pin 1 on COUT_DAMPED; a -20 percent "
            "initial-tolerance and -20 percent temperature-stability screen gives "
            "14.08 uF, above the LP38692 1.0 uF application-guidance floor.",
            minimum=1_000,
            nominal=14_080,
            unit="nF",
            source_evidence_ids=("src-ti-lp38692-datasheet", "src-kemet-t59x"),
        ),
        DesignConstraint(
            "ldo-output-esr-screen",
            "electrical",
            "R9 is in only the C3 branch. Its tolerance/TCR screen gives a "
            "9.8292 mOhm ESR floor; C3 plus R9 is at most 80.1722 mOhm only "
            "at C3's specified +25 C/100 kHz condition.",
            minimum=9_829_200,
            maximum=80_172_200,
            nominal=10_000_000,
            unit="nOhm",
            source_evidence_ids=(
                "src-ti-lp38692-datasheet",
                "src-kemet-t59x",
                "src-vishay-wslp",
            ),
        ),
        DesignConstraint(
            "ldo-capacitor-production-qualification",
            "release",
            "Vendor delivery data or worst-lot bench evidence must bound C3 "
            "capacitance and ESR over -40 C to +80 C and frequency, and stability "
            "plus line/load transients must pass at no, minimum, and maximum load. "
            "The 70 mOhm C3 limit applies only at +25 C and 100 kHz.",
            source_evidence_ids=(
                "src-ti-lp38692-datasheet",
                "src-kemet-t59x",
                "src-vishay-wslp",
            ),
        ),
        DesignConstraint(
            "output-current",
            "electrical",
            "J2 provides at most 100 mA from -40 C to +80 C in addition to the "
            "onboard LED and qualified leakage/overhead. This is a design target, "
            "not a production qualification.",
            maximum=100,
            nominal=100,
            unit="mA",
            source_evidence_ids=("src-tps2596", "src-ti-lp38692-datasheet"),
        ),
        DesignConstraint(
            "efuse-current-limit",
            "electrical",
            "The exact TPS2596 RILM=3.83 kOhm table row is 224/247/269 mA "
            "minimum/typical/maximum.",
            224,
            269,
            247,
            "mA",
            ("src-tps2596",),
        ),
        DesignConstraint(
            "efuse-current-limit-engineering-screen",
            "electrical",
            "Applying R3's +/-1 percent tolerance and +/-100 ppm/K TCR over a "
            "65 K excursion gives approximately 220.350 to 273.500 mA. This is "
            "an engineering extension, not an additional TI table guarantee.",
            220_350,
            273_500,
            247_000,
            "uA",
            ("src-tps2596", "src-vishay-resistors"),
        ),
        DesignConstraint(
            "efuse-dvdt-capacitance",
            "electrical",
            "C4 is 100 nF C0G on U1 pin 2 dVdt to GND; tolerance plus the "
            "conservative temperature envelope gives 94.715 to 105.315 nF.",
            94_715,
            105_315,
            100_000,
            "pF",
            ("src-tps2596", "src-kemet-c1206c104", "src-kemet-c0g-family"),
        ),
        DesignConstraint(
            "efuse-startup-slew",
            "electrical",
            "The TPS2596 IDVDT/GDVDT extrema and C4 screen give "
            "0.3645 to 0.5289 mV/us slew.",
            364_500,
            528_900,
            441_600,
            "nV_per_us",
            ("src-tps2596", "src-kemet-c1206c104"),
        ),
        DesignConstraint(
            "efuse-capacitive-inrush",
            "electrical",
            "At 26.7 uF fitted nominal downstream capacitance the bounded slew gives "
            "exactly 9.73215 to 14.12163 mA capacitive inrush; attached capacitance and active "
            "startup load remain outside this screen.",
            9_732_150,
            14_121_630,
            11_790_720,
            "nA",
            (
                "src-tps2596",
                "src-kemet-c1206c104",
                "src-kemet-cap",
                "src-kemet-t59x",
            ),
        ),
        DesignConstraint(
            "ldo-thermal-board-qualification",
            "release",
            "The 0.25733 W worst-corner screen requires assembled-board thetaJA "
            "below 174.87 C/W at +80 C ambient with margin. TI's 68.5 C/W High-K "
            "test-board value is not transferable board evidence.",
            maximum=174_870,
            nominal=174_870,
            unit="mC_per_W",
            source_evidence_ids=("src-ti-lp38692-datasheet",),
        ),
        DesignConstraint(
            "efuse-ovcsel",
            "electrical",
            "Two series 200 kOhm resistors select the 5.7 V eFuse clamp range.",
            396_000,
            404_000,
            400_000,
            "ohm",
            ("src-tps2596", "src-vishay-resistors"),
        ),
        DesignConstraint(
            "efuse-uvlo",
            "electrical",
            "The 249 kOhm/100 kOhm divider keeps EN below absolute maximum and sets "
            "UVLO rising between 4.06 V and 4.32 V.",
            4_060,
            4_320,
            4_190,
            "mV",
            ("src-tps2596", "src-vishay-resistors"),
        ),
        DesignConstraint(
            "pcb-thickness",
            "fabrication",
            "Use 0.80 mm nominal finished PCB thickness as a conservative project choice. "
            "It is not a connector-vendor requirement, and board-thickness compatibility "
            "and mechanical mating remain unqualified.",
            nominal=PCB_THICKNESS_NM,
            unit="nm",
        ),
        DesignConstraint(
            "u1-dda-layer-apertures",
            "fabrication",
            "U1 uses 2.95 x 4.90 mm center copper and separate 2.40 x 3.10 mm "
            "mask/paste apertures; the 0.127 mm source stencil example requires "
            "assembler approval.",
            source_evidence_ids=("src-tps2596",),
        ),
        DesignConstraint(
            "d1-dfn-layer-apertures",
            "fabrication",
            "Each D1 terminal uses 0.70 x 1.20 mm copper, 0.60 x 1.10 mm mask, "
            "and 0.35 x 1.00 mm paste; the source example assumes a 0.10 mm stencil.",
            source_evidence_ids=("src-ptvs",),
        ),
        DesignConstraint(
            "usb-shell-solder-process",
            "fabrication",
            "The pinned public KiCad footprint includes four plated shell slots. Their "
            "pin-in-paste or secondary-solder process requires assembler approval; shell "
            "retention and mechanical mating remain unqualified.",
            source_evidence_ids=("src-kicad-footprint-usb4105",),
        ),
        DesignConstraint(
            "authored-routing-clearance",
            "routing",
            "Every authored track, via, and nonconnector copper relation keeps at "
            "least 0.20 mm clearance.",
            minimum=200_000,
            nominal=200_000,
            unit="nm",
        ),
        DesignConstraint(
            "usb4105-public-footprint-local-clearance",
            "fabrication",
            "Only the pinned-public-footprint USB4105 pairs "
            "{pad:usb-j1:A1:0,pad:usb-j1:B12:0}/usb-j1-shared-gnd-left to "
            "hole:usb-j1:locating:0 and "
            "{pad:usb-j1:A12:0,pad:usb-j1:B1:0}/usb-j1-shared-gnd-right to "
            "hole:usb-j1:locating:1 have about 0.1751 mm computed geometric clearance. "
            "The reference design preserves that public library geometry as a project-local DRC "
            "exception, not a manufacturer-authorized minimum or mechanical qualification; "
            "every other authored relation remains at least 0.20 mm.",
            nominal=175_100,
            unit="nm",
            source_evidence_ids=("src-kicad-footprint-usb4105",),
        ),
        DesignConstraint(
            "minimum-edge-clearance",
            "routing",
            "Copper other than the pinned-public-footprint connector lands keeps at least "
            "0.50 mm board-edge clearance.",
            minimum=500_000,
            nominal=500_000,
            unit="nm",
            source_evidence_ids=("src-kicad-footprint-usb4105",),
        ),
        DesignConstraint(
            "usb4105-mechanical-mating-unqualified",
            "release",
            "Connector fit, shell retention, board-thickness compatibility, insertion and "
            "extraction behavior, and mechanical mating are unqualified. Manufacturing "
            "release remains blocked pending accountable review and physical validation.",
            source_evidence_ids=("src-kicad-footprint-usb4105",),
        ),
        DesignConstraint(
            "power-track-width",
            "routing",
            "VBUS, protected 5 V, 3V3, and primary ground trunks use at least 0.80 mm tracks.",
            minimum=800_000,
            nominal=800_000,
            unit="nm",
        ),
        DesignConstraint(
            "signal-track-width",
            "routing",
            "CC and programming nets use at least 0.25 mm tracks.",
            minimum=250_000,
            nominal=250_000,
            unit="nm",
        ),
        DesignConstraint(
            "via-annular-ring",
            "fabrication",
            "Signal and thermal vias retain at least 0.20 mm radial annular ring.",
            minimum=200_000,
            nominal=200_000,
            unit="nm",
        ),
        DesignConstraint(
            "header-output-only",
            "safety",
            OUTPUT_MARKING + ". J2 and TP3 stay directly on 3V3. LP38692 does "
            "not block sustained OUT-to-IN reverse current, and R9 is only in the "
            "capacitor branch. No LM66100 or U3 is fitted.",
            source_evidence_ids=("src-ti-lp38692-datasheet", "src-wurth-header"),
        ),
        DesignConstraint(
            "native-commit-not-approval",
            "authority",
            "A passing deterministic technical gate is not human approval, release "
            "approval, or manufacturing authorization.",
        ),
        DesignConstraint(
            "manufacturing-gate",
            "release",
            "Manufacturing remains blocked until pinned KiCad compilation, reopen "
            "parity, ERC, DRC, and human release approval bind this exact revision.",
        ),
    )


__all__ = (
    "BOARD_HEIGHT_NM",
    "BOARD_WIDTH_NM",
    "PCB_THICKNESS_NM",
    "OUTPUT_MARKING",
    "PROJECT_ID",
    "QUALIFIED_OUTPUT_CURRENT_MA",
    "SCHEMATIC_REVISION",
    "bom",
    "components",
    "constraints",
    "sources",
)
