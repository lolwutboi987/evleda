import type { ContentIdentity } from "../domain/types.js";

export type ReferenceComponentKey =
  | "mcu"
  | "motor_driver"
  | "buck_5v"
  | "ldo_3v3"
  | "can_transceiver"
  | "usb_esd"
  | "encoder_buffer"
  | "sensor_power_switch";

export interface DatasheetLocator {
  readonly url: string;
  /** Date on which this URL was recorded in the built-in catalog. */
  readonly urlRecordedAt: string;
  /** Null is intentional when no exact source bytes have been captured. */
  readonly retrievedAt: string | null;
  readonly identity?: ContentIdentity;
  readonly sourcePolicy: "exact_bytes_identity_required";
}

export interface ComponentLifecycle {
  readonly status: "active" | "nrnd" | "obsolete" | "unknown";
  readonly checkedAt: string;
  readonly sourceUrl: string;
  readonly sourceIdentity?: ContentIdentity;
  readonly requiresReview: boolean;
}

export interface ReferenceCircuit {
  readonly id: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly sourceIdentity: ContentIdentity;
  readonly sectionLocator: string;
  readonly pageLocator: {
    readonly printedPages: readonly number[];
    readonly pdfPageIndexes: readonly number[];
    readonly convention: "printed_page_1_based_and_pdf_index_0_based";
  };
  readonly applicabilityLimits: readonly string[];
  readonly status: "starting_point_only";
  readonly reviewRequired: true;
}

export interface PinPadMappingReview {
  readonly status: "reviewed" | "unreviewed" | "mismatch";
  readonly checkedAt: string;
  readonly mappingIdentity?: ContentIdentity;
  readonly reviewIdentity?: ContentIdentity;
  readonly requiresReview: boolean;
}

export interface ReferenceComponent {
  readonly key: ReferenceComponentKey;
  readonly manufacturer: string;
  readonly partNumber: string;
  readonly quantity: number;
  readonly role: string;
  readonly package: string;
  readonly symbol: string;
  readonly footprint: string;
  readonly datasheet: DatasheetLocator;
  readonly lifecycle: ComponentLifecycle;
  readonly referenceCircuits: readonly ReferenceCircuit[];
  readonly layoutConstraintIds: readonly string[];
  readonly pinPadMappingReview: PinPadMappingReview;
  readonly declaredConstraints: Readonly<Record<string, string>>;
  readonly designUse: Readonly<Record<string, string>>;
}

export interface PowerRailContract {
  readonly name: string;
  readonly source: string;
  readonly nominalMv: number | null;
  readonly minimumMv: number;
  readonly maximumMv: number;
  readonly budgetMa: number;
  readonly consumers: readonly string[];
  readonly protection: readonly string[];
}

export interface PinAssignment {
  readonly signal: string;
  readonly physicalPin: number;
  readonly mcuPin: string;
  readonly peripheral: string;
  readonly direction: "input" | "output" | "bidirectional" | "analog";
  readonly voltageDomain: "3V3";
  readonly resetState: string;
  readonly externalBias: string;
  readonly safetyPurpose: string;
}

export interface ResourceAllocation {
  readonly owner: string;
  readonly resource: string;
  readonly irq: string | null;
  readonly dma: string | null;
  readonly priority: number;
  readonly notes: string;
}

export interface ProtocolContract {
  readonly name: "USB" | "CAN" | "UART" | "I2C" | "SPI" | "SWD" | "ENCODER";
  readonly electrical: string;
  readonly controller: string;
  readonly pins: readonly string[];
  readonly defaultConfiguration: string;
  readonly resetBehavior: string;
}

export interface LayoutConstraint {
  readonly id: string;
  readonly appliesTo: readonly string[];
  readonly rule: string;
  readonly verification: string;
}

export interface ReferenceControllerProfile {
  readonly schemaVersion: string;
  readonly profileId: string;
  readonly boardRevision: string;
  readonly lifecycle: "candidate";
  readonly inputVoltageMv: { readonly minimum: number; readonly maximum: number };
  readonly motor: {
    readonly channels: number;
    readonly rmsCurrentMaPerChannel: number;
    readonly currentChopMaPerChannel: number;
  };
  readonly stackup: {
    readonly layerCount: number;
    readonly layers: readonly string[];
  };
  readonly interfaceSelections: readonly ProtocolContract["name"][];
  readonly parameterValidation: {
    readonly supportStatus: "supported" | "unsupported";
    readonly unsupportedReasons: readonly string[];
  };
  readonly components: readonly ReferenceComponent[];
  readonly rails: readonly PowerRailContract[];
  readonly pins: readonly PinAssignment[];
  readonly resources: readonly ResourceAllocation[];
  readonly protocols: readonly ProtocolContract[];
  readonly layoutConstraints: readonly LayoutConstraint[];
  readonly exclusions: readonly string[];
}

export interface ReferenceControllerParameters {
  readonly boardRevision?: string;
  readonly inputVoltageMv?: { readonly minimum: number; readonly maximum: number };
  readonly motor?: {
    readonly channels: number;
    readonly rmsCurrentMaPerChannel: number;
    readonly currentChopMaPerChannel: number;
  };
  readonly stackup?: {
    readonly layerCount: number;
    readonly layers: readonly string[];
  };
  readonly interfaceSelections?: readonly ProtocolContract["name"][];
}

export const REFERENCE_CONTROLLER_V0_LIMITS = {
  profileId: "robotics-controller-v0",
  boardRevision: "EVL-RC-G0-REV-A",
  inputVoltageMv: { minimum: 7000, maximum: 16800 },
  motor: {
    channels: 2,
    maximumRmsCurrentMaPerChannel: 500,
    currentChopMaPerChannel: 1000
  },
  stackup: {
    layerCount: 6,
    layers: ["F.Cu", "In1.Signal", "In2.GND", "In3.Power", "In4.Signal", "B.Cu"] as const
  },
  interfaceSelections: ["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"] as const
} as const;

export const REFERENCE_CONTROLLER_PROFILE_IDENTITY_SCHEMA = "evleda.reference-profile.v1";
export const REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_SCHEMA =
  "evleda.reference-controller-template-instantiation.v1";
export const REFERENCE_CONTROLLER_V0_TEMPLATE_INSTANTIATION_MODE =
  "parameterized-reviewed-template-instantiation";

const RECORDED_AT = "2026-09-03";
const RECONCILED_AT = "2026-09-04";

interface VerifiedDatasheetLocator extends DatasheetLocator {
  readonly retrievedAt: string;
  readonly identity: ContentIdentity;
}

const verifiedDatasheet = (
  url: string,
  size: number,
  digest: string,
  recordedAt: string = RECORDED_AT
): VerifiedDatasheetLocator => ({
  url,
  urlRecordedAt: recordedAt,
  retrievedAt: recordedAt,
  identity: { algorithm: "sha256", size, digest },
  sourcePolicy: "exact_bytes_identity_required"
});

const unknownLifecycle = (
  sourceUrl: string,
  checkedAt: string = RECORDED_AT
): ComponentLifecycle => ({
  status: "unknown",
  checkedAt,
  sourceUrl,
  requiresReview: true
});

const unreviewedPinPadMapping = (): PinPadMappingReview => ({
  status: "unreviewed",
  checkedAt: RECONCILED_AT,
  requiresReview: true
});

const referenceCircuit = (
  id: string,
  title: string,
  source: VerifiedDatasheetLocator,
  sectionLocator: string,
  printedPages: readonly number[],
  pdfPageIndexes: readonly number[],
  applicabilityLimits: readonly string[]
): ReferenceCircuit => ({
  id,
  title,
  sourceUrl: source.url,
  sourceIdentity: source.identity,
  sectionLocator,
  pageLocator: {
    printedPages,
    pdfPageIndexes,
    convention: "printed_page_1_based_and_pdf_index_0_based"
  },
  applicabilityLimits,
  status: "starting_point_only",
  reviewRequired: true
});

const MCU_DATASHEET = verifiedDatasheet(
  "https://www.st.com/resource/en/datasheet/stm32g0b1cb.pdf",
  3971768,
  "8433e47bc5da5cac459a1d3d5a6add183655061f5655d3c653248de65ca535c9"
);
const MOTOR_DRIVER_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/drv8874.pdf",
  2536495,
  "e28fdb554c58e0c949a21f825a7c985bafc807e9f190575eb02d531afb715c64"
);
const BUCK_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/lmr51420.pdf",
  2117875,
  "8cc7e8bc4ef9adbaaebf47d6059a847796b004ad3cd82ce99102a0fa590693ea"
);
const LDO_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/tlv755p.pdf",
  3072276,
  "c0fe7be9fea4e4c8d933142f59758f7a951e195a45ca4e7e17684153da018cbb"
);
const CAN_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/tcan3413.pdf",
  2080472,
  "2c0e8963e7762bc91edf30a365cc10c31ce88e2ddda3b67a120c4158ae52930b"
);
const USB_ESD_DATASHEET = verifiedDatasheet(
  "https://www.st.com/resource/en/datasheet/usblc6-2.pdf",
  575521,
  "bc30154f310cd631043214ed52571daefe04270587ec55072d49a23bd18b9068"
);
const ENCODER_BUFFER_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/sn74lvc2g17.pdf",
  1888823,
  "624dbe55679d2fed4123b0d7708cd0d295efcc78de395e71a0caf5cd13cbc216"
);
// The captured TPS2553 family PDF explicitly covers the latch-off TPS2553-1
// variant. Keep its recorded URL and identity until replacement bytes are persisted.
const SENSOR_SWITCH_DATASHEET = verifiedDatasheet(
  "https://www.ti.com/lit/ds/symlink/tps2553.pdf",
  2091685,
  "8ab20570d3e126d7a13719135f2b6a8858244de7f6c771d7a4329b23e06afca8"
);

const BASE_ROBOTICS_CONTROLLER_V0: ReferenceControllerProfile = {
  schemaVersion: "evleda.reference-controller.v0",
  profileId: "robotics-controller-v0",
  boardRevision: "EVL-RC-G0-REV-A",
  lifecycle: "candidate",
  inputVoltageMv: { minimum: 7000, maximum: 16800 },
  motor: {
    channels: 2,
    rmsCurrentMaPerChannel: 500,
    currentChopMaPerChannel: 1000
  },
  stackup: {
    layerCount: 6,
    layers: ["F.Cu", "In1.Signal", "In2.GND", "In3.Power", "In4.Signal", "B.Cu"]
  },
  interfaceSelections: ["USB", "CAN", "UART", "I2C", "SPI", "SWD", "ENCODER"],
  parameterValidation: {
    supportStatus: "supported",
    unsupportedReasons: []
  },
  components: [
    {
      key: "mcu",
      manufacturer: "STMicroelectronics",
      partNumber: "STM32G0B1CET6",
      quantity: 1,
      role: "main controller with USB device and FDCAN",
      package: "LQFP-48",
      symbol: "MCU_ST_STM32G0:STM32G0B1CETx",
      footprint: "Package_QFP:LQFP-48_7x7mm_P0.5mm",
      datasheet: MCU_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.st.com/en/microcontrollers-microprocessors/stm32g0b1ce.html",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_mcu_supply_reset_usb",
          "STM32G0B1 supply, reset, clock, USB, and debug starting point",
          MCU_DATASHEET,
          "Power supply scheme, reset/clock, USB, and standard LQFP48 pin/alternate-function sections",
          [17, 38],
          [16, 37],
          [
            "Applies only to STM32G0B1CET6 standard non-N LQFP48 pinout.",
            "Decoupling, internal-HSI clock configuration, USB electrical details, and boot/reset behavior require schematic review.",
            "Datasheet diagrams are starting points and do not prove the generated board implementation."
          ]
        )
      ],
      layoutConstraintIds: ["layout_decoupling", "layout_sense", "layout_usb"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        supply: "1.7-3.6 V; design rail 3.3 V",
        usb: "USB 2.0 full-speed device interface",
        can: "FDCAN controller; external transceiver required"
      },
      designUse: {
        supply: "3V3",
        package_variant: "standard LQFP48 pinout, not N-suffix alternate pinout"
      }
    },
    {
      key: "motor_driver",
      manufacturer: "Texas Instruments",
      partNumber: "DRV8874PWPR",
      quantity: 2,
      role: "one brushed-DC H-bridge per motor channel",
      package: "HTSSOP-16 PowerPAD (PWP)",
      symbol: "robotics_drv8874:DRV8874",
      footprint: "robotics_motor:DRV8874_PWP0016J",
      datasheet: MOTOR_DRIVER_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/product/DRV8874/part-details/DRV8874PWPR",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_drv8874_half_amp",
          "DRV8874 0.5 A RMS and 1 A trip worked-example starting point",
          MOTOR_DRIVER_DATASHEET,
          "Typical Application and Detailed Design Procedure, Current Sense and Regulation",
          [20, 21, 31],
          [19, 20, 30],
          [
            "The worked values are a starting point for 0.5 A RMS, 20 kHz PWM, and 1 A ITRIP only.",
            "IPROPI gain, VREF, resistor tolerance, motor inductance, copper, ambient, and duty cycle require modeled and physical validation.",
            "Peak device capability is not a board continuous-current rating."
          ]
        )
      ],
      layoutConstraintIds: ["layout_motor_loop", "layout_powerpad", "layout_sense", "layout_decoupling"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        motor_supply: "4.5-37 V operating range",
        bridge_peak: "6 A peak capability; not a continuous-board rating",
        control: "PH/EN mode with current regulation and IPROPI feedback"
      },
      designUse: {
        motor_supply: "VBAT_PROTECTED (7-16.8 V)",
        rms_limit: "0.5 A per channel",
        chop_target: "1.0 A per channel",
        reset_policy: "external pulls hold EN low and nSLEEP low"
      }
    },
    {
      key: "buck_5v",
      manufacturer: "Texas Instruments",
      partNumber: "LMR51420XFDDCR",
      quantity: 1,
      role: "battery-to-5 V synchronous buck regulator",
      package: "SOT-23-6 (DDC)",
      symbol: "robotics_lmr51420:LMR51420",
      footprint: "robotics_power:TI_DDC0006A",
      datasheet: BUCK_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/product/LMR51420/part-details/LMR51420XFDDCR",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_lmr51420_5v",
          "LMR51420 5 V buck application starting point",
          BUCK_DATASHEET,
          "Application and Implementation, Typical Application, and Layout sections",
          [16, 23],
          [15, 22],
          [
            "Must be recalculated for LMR51420XFDDCR, 7-16.8 V input, 5 V output, and the declared load envelope.",
            "Inductor, feedback, enable, input/output capacitors, ripple, transient response, and thermal margins require review.",
            "Reference layout is not proof that the generated copper preserves the hot-loop constraints."
          ]
        )
      ],
      layoutConstraintIds: ["layout_buck", "layout_decoupling"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        input: "4.5-36 V",
        rated_output: "2 A",
        topology: "synchronous buck"
      },
      designUse: {
        input: "VBAT_PROTECTED",
        output: "5V0 at 2 A design ceiling",
        switching: "500 kHz forced-PWM variant",
        note: "feedback, inductor, input/output capacitor, and enable network require source-bound calculation"
      }
    },
    {
      key: "ldo_3v3",
      manufacturer: "Texas Instruments",
      partNumber: "TLV75533PDBVR",
      quantity: 1,
      role: "5 V-to-3.3 V logic regulator",
      package: "SOT-23-5 (DBV)",
      symbol: "Regulator_Linear:TLV75533PDBV",
      footprint: "Package_TO_SOT_SMD:SOT-23-5",
      datasheet: LDO_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/product/TLV755P/part-details/TLV75533PDBVR",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_tlv75533_3v3",
          "TLV75533P 3.3 V regulator application starting point",
          LDO_DATASHEET,
          "Application and Implementation and Layout sections",
          [15, 21, 22],
          [14, 20, 21],
          [
            "Applies to the DBV fixed 3.3 V variant powered from the generated 5 V rail.",
            "Input/output capacitance, dropout, startup, dissipation, load transients, and enable bias require review.",
            "The diagram does not establish board-level rail stability."
          ]
        )
      ],
      layoutConstraintIds: ["layout_decoupling"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        input: "1.45-5.5 V",
        rated_output: "500 mA",
        fixed_output: "3.3 V"
      },
      designUse: { input: "5V0", output: "3V3", reset_policy: "EN pulled up to 5V0 so logic starts without MCU intervention" }
    },
    {
      key: "can_transceiver",
      manufacturer: "Texas Instruments",
      partNumber: "TCAN3413DR",
      quantity: 1,
      role: "3.3 V CAN FD physical layer",
      package: "SOIC-8 (D)",
      symbol: "robotics_tcan3413:TCAN3413",
      footprint: "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
      datasheet: CAN_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/product/TCAN3413/part-details/TCAN3413DR",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_tcan3413_canfd",
          "TCAN3413 CAN FD node application starting point",
          CAN_DATASHEET,
          "Application and Implementation, Typical Application, and Layout sections",
          [24, 29],
          [23, 28],
          [
            "Termination population depends on physical bus position and is DNP by default.",
            "Bus protection, common-mode behavior, timing, cable, connector, and EMC performance require system review.",
            "Standby bias and MCU I/O voltage compatibility must be verified in the generated schematic."
          ]
        )
      ],
      layoutConstraintIds: ["layout_can", "layout_decoupling"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        logic_supply: "3.3 V",
        bus_standoff: "+/-58 V",
        mode: "standby-capable CAN FD transceiver"
      },
      designUse: {
        supply: "3V3",
        reset_policy: "external bias selects standby until firmware configures FDCAN"
      }
    },
    {
      key: "usb_esd",
      manufacturer: "STMicroelectronics",
      partNumber: "USBLC6-2SC6",
      quantity: 1,
      role: "USB D+/D- and VBUS ESD protection",
      package: "SOT-23-6L",
      symbol: "robotics_usblc6:USBLC6-2SC6",
      footprint: "Package_TO_SOT_SMD:SOT-23-6",
      datasheet: USB_ESD_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.st.com/en/protections-and-emi-filters/usblc6-2.html",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_usblc6_2_usb",
          "USBLC6-2SC6 USB protection application starting point",
          USB_ESD_DATASHEET,
          "Application Information and USB 2.0 protection diagrams",
          [4, 5, 9],
          [3, 4, 8],
          [
            "Applies to the SC6 SOT23-6L variant and a USB 2.0 full-speed device path.",
            "Connector ordering, VBUS treatment, trace stubs, return path, and ESD current path require layout review.",
            "Device-level protection claims do not prove system immunity."
          ]
        )
      ],
      layoutConstraintIds: ["layout_usb"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: {
        protected_lines: "two high-speed data lines plus VBUS",
        line_capacitance: "3.5 pF maximum"
      },
      designUse: { placement: "adjacent to USB receptacle before branch or test stubs" }
    },
    {
      key: "encoder_buffer",
      manufacturer: "Texas Instruments",
      partNumber: "SN74LVC2G17DBVR",
      quantity: 2,
      role: "dual Schmitt-trigger encoder input buffer",
      package: "SOT-23-6 (DBV)",
      symbol: "robotics_sn74lvc2g17:SN74LVC2G17",
      footprint: "Package_TO_SOT_SMD:SOT-23-6",
      datasheet: ENCODER_BUFFER_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/quality-reliability-packaging-download/en-us/report?opn=SN74LVC2G17DBVR",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_sn74lvc2g17_encoder",
          "SN74LVC2G17 input-conditioning starting point",
          ENCODER_BUFFER_DATASHEET,
          "Application and Implementation, Typical Application, and Layout sections",
          [9, 10, 11],
          [8, 9, 10],
          [
            "External encoder voltage, source impedance, ESD/protection, cable length, threshold margin, and maximum edge rate require review.",
            "The buffer does not provide isolation or arbitrary overvoltage tolerance.",
            "Both DCK symbol units must be checked against the reviewed pad mapping."
          ]
        )
      ],
      layoutConstraintIds: ["layout_decoupling", "layout_sense"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: { supply: "1.65-5.5 V", inputs: "Schmitt-trigger, non-inverting" },
      designUse: { supply: "3V3", channels: "two A/B quadrature encoders" }
    },
    {
      key: "sensor_power_switch",
      manufacturer: "Texas Instruments",
      partNumber: "TPS2553DBVR-1",
      quantity: 1,
      role: "current-limited switched 5 V sensor supply",
      package: "SOT-23-6 (DBV)",
      symbol: "robotics_tps2553:TPS2553-1",
      footprint: "Package_TO_SOT_SMD:SOT-23-6",
      datasheet: SENSOR_SWITCH_DATASHEET,
      lifecycle: unknownLifecycle(
        "https://www.ti.com/product/TPS2553-1/part-details/TPS2553DBVR-1",
        RECONCILED_AT
      ),
      referenceCircuits: [
        referenceCircuit(
          "rc_tps2553_sensor_power",
          "TPS2553-1 current-limited sensor-rail starting point",
          SENSOR_SWITCH_DATASHEET,
          "Application and Implementation, Current-Limit Programming, and Layout sections",
          [17, 18, 25],
          [16, 17, 24],
          [
            "Current-limit resistor, capacitive-load startup, reverse current, fault timing, and connector fault energy require calculation and test.",
            "The enable network must keep 5V_SENSOR off through MCU reset and loss of 3V3.",
            "A load-switch reference circuit is not evidence of safe external wiring."
          ]
        )
      ],
      layoutConstraintIds: ["layout_decoupling"],
      pinPadMappingReview: unreviewedPinPadMapping(),
      declaredConstraints: { supply: "2.5-6.5 V", function: "adjustable current limit and fault flag" },
      designUse: {
        input: "5V0",
        output: "5V_SENSOR",
        reset_policy: "EN external pull-down; sensor rail off during reset"
      }
    }
  ],
  rails: [
    {
      name: "VBAT_PROTECTED",
      source: "7-16.8 V battery input after fuse, reverse-polarity, and transient protection",
      nominalMv: null,
      minimumMv: 7000,
      maximumMv: 16800,
      budgetMa: 2000,
      consumers: ["DRV8874 channel A", "DRV8874 channel B", "LMR51420"],
      protection: ["replaceable fuse", "reverse-polarity stage", "TVS footprint", "bulk decoupling"]
    },
    {
      name: "5V0",
      source: "LMR51420 synchronous buck",
      nominalMv: 5000,
      minimumMv: 4750,
      maximumMv: 5250,
      budgetMa: 2000,
      consumers: ["TLV75533P", "TPS2553-1 sensor switch", "status and expansion loads"],
      protection: ["buck cycle-by-cycle protection", "output test point"]
    },
    {
      name: "3V3",
      source: "TLV75533P",
      nominalMv: 3300,
      minimumMv: 3201,
      maximumMv: 3399,
      budgetMa: 400,
      consumers: ["STM32G0B1", "TCAN3413", "SN74LVC2G17 buffers"],
      protection: ["LDO current limit", "local high-frequency decoupling", "output test point"]
    },
    {
      name: "5V_SENSOR",
      source: "TPS2553-1 load switch",
      nominalMv: 5000,
      minimumMv: 4500,
      maximumMv: 5250,
      budgetMa: 500,
      consumers: ["external sensor connector"],
      protection: ["programmable current limit", "fault flag", "default-off enable"]
    }
  ],
  pins: [
    { signal: "NRST", physicalPin: 10, mcuPin: "PF2", peripheral: "NRST", direction: "bidirectional", voltageDomain: "3V3", resetState: "hardware reset input asserted low", externalBias: "pull-up plus SWD reset connection", safetyPurpose: "hardware reset and programming recovery" },
    { signal: "ENC_A_A", physicalPin: 11, mcuPin: "PA0", peripheral: "TIM2_CH1", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "buffer output has pull-down", safetyPurpose: "defined stopped count" },
    { signal: "ENC_A_B", physicalPin: 12, mcuPin: "PA1", peripheral: "TIM2_CH2", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "buffer output has pull-down", safetyPurpose: "defined stopped count" },
    { signal: "UART_TX", physicalPin: 13, mcuPin: "PA2", peripheral: "USART2_TX", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "none", safetyPurpose: "diagnostic output" },
    { signal: "UART_RX", physicalPin: 14, mcuPin: "PA3", peripheral: "USART2_RX", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "weak pull-up", safetyPurpose: "defined idle state" },
    { signal: "MOTOR_A_ISENSE", physicalPin: 15, mcuPin: "PA4", peripheral: "ADC1_IN4", direction: "analog", voltageDomain: "3V3", resetState: "high impedance analog", externalBias: "RC filter to ground", safetyPurpose: "measure DRV8874 A IPROPI" },
    { signal: "MOTOR_B_ISENSE", physicalPin: 16, mcuPin: "PA5", peripheral: "ADC1_IN5", direction: "analog", voltageDomain: "3V3", resetState: "high impedance analog", externalBias: "RC filter to ground", safetyPurpose: "measure DRV8874 B IPROPI" },
    { signal: "MOTOR_A_DIR", physicalPin: 17, mcuPin: "PA6", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "deterministic polarity before enable" },
    { signal: "MOTOR_B_DIR", physicalPin: 18, mcuPin: "PA7", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "deterministic polarity before enable" },
    { signal: "MOTOR_A_NFAULT", physicalPin: 19, mcuPin: "PB0", peripheral: "GPIO_EXTI0", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "pull-up to 3V3", safetyPurpose: "asynchronous bridge fault input" },
    { signal: "MOTOR_B_NFAULT", physicalPin: 20, mcuPin: "PB1", peripheral: "GPIO_EXTI1", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "pull-up to 3V3", safetyPurpose: "asynchronous bridge fault input" },
    { signal: "SENSOR_PWR_EN", physicalPin: 21, mcuPin: "PB2", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "sensor rail remains off during reset" },
    { signal: "SENSOR_PWR_NFAULT", physicalPin: 22, mcuPin: "PB10", peripheral: "GPIO_EXTI", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "pull-up to 3V3", safetyPurpose: "sensor overload detection" },
    { signal: "RUN", physicalPin: 23, mcuPin: "PB11", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "series LED path holds off", safetyPurpose: "non-safety run status only" },
    { signal: "MOTOR_A_NSLEEP", physicalPin: 24, mcuPin: "PB12", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "bridge disabled during reset" },
    { signal: "MOTOR_B_NSLEEP", physicalPin: 25, mcuPin: "PB13", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "bridge disabled during reset" },
    { signal: "BOARD_REV0", physicalPin: 26, mcuPin: "PB14", peripheral: "GPIO", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "fixed revision strap", safetyPurpose: "bind firmware to board hardware revision bit 0" },
    { signal: "BOARD_REV1", physicalPin: 27, mcuPin: "PB15", peripheral: "GPIO", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "fixed revision strap", safetyPurpose: "bind firmware to board hardware revision bit 1" },
    { signal: "MOTOR_A_PWM", physicalPin: 28, mcuPin: "PA8", peripheral: "TIM1_CH1", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "zero duty through reset" },
    { signal: "MOTOR_B_PWM", physicalPin: 29, mcuPin: "PA9", peripheral: "TIM1_CH2", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-down", safetyPurpose: "zero duty through reset" },
    { signal: "ENC_B_A", physicalPin: 30, mcuPin: "PC6", peripheral: "TIM3_CH1", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "buffer output has pull-down", safetyPurpose: "defined stopped count" },
    { signal: "ENC_B_B", physicalPin: 31, mcuPin: "PC7", peripheral: "TIM3_CH2", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "buffer output has pull-down", safetyPurpose: "defined stopped count" },
    { signal: "CAN_STB", physicalPin: 32, mcuPin: "PA10", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm bias to standby", safetyPurpose: "transceiver standby during reset" },
    { signal: "USB_DM", physicalPin: 33, mcuPin: "PA11", peripheral: "USB_DM", direction: "bidirectional", voltageDomain: "3V3", resetState: "USB peripheral disconnected", externalBias: "USB network and USBLC6-2SC6", safetyPurpose: "data only; USB VBUS does not power motor or logic rails" },
    { signal: "USB_DP", physicalPin: 34, mcuPin: "PA12", peripheral: "USB_DP", direction: "bidirectional", voltageDomain: "3V3", resetState: "USB peripheral disconnected", externalBias: "USB network and USBLC6-2SC6", safetyPurpose: "data only; USB VBUS does not power motor or logic rails" },
    { signal: "SWDIO", physicalPin: 35, mcuPin: "PA13", peripheral: "SWDIO", direction: "bidirectional", voltageDomain: "3V3", resetState: "debug port active", externalBias: "standard SWD bias", safetyPurpose: "recoverable programming" },
    { signal: "SWCLK", physicalPin: 36, mcuPin: "PA14", peripheral: "SWCLK", direction: "input", voltageDomain: "3V3", resetState: "debug port active", externalBias: "standard SWD bias", safetyPurpose: "recoverable programming" },
    { signal: "SPI_CS", physicalPin: 37, mcuPin: "PA15", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "10 kohm pull-up", safetyPurpose: "external SPI device deselected" },
    { signal: "VBUS_PRESENT", physicalPin: 40, mcuPin: "PD2", peripheral: "GPIO_EXTI2", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "USB VBUS resistor divider with pull-down sized for 3.3 V domain", safetyPurpose: "detect USB attachment without back-powering logic" },
    { signal: "FAULT_STATUS", physicalPin: 41, mcuPin: "PD3", peripheral: "GPIO", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "series LED path holds off", safetyPurpose: "non-safety latched-fault status only" },
    { signal: "SPI_SCK", physicalPin: 42, mcuPin: "PB3", peripheral: "SPI1_SCK", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "weak pull-down", safetyPurpose: "defined clock idle" },
    { signal: "SPI_MISO", physicalPin: 43, mcuPin: "PB4", peripheral: "SPI1_MISO", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "weak pull-down", safetyPurpose: "defined undriven input" },
    { signal: "SPI_MOSI", physicalPin: 44, mcuPin: "PB5", peripheral: "SPI1_MOSI", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "weak pull-down", safetyPurpose: "defined data state" },
    { signal: "I2C_SCL", physicalPin: 45, mcuPin: "PB6", peripheral: "I2C1_SCL", direction: "bidirectional", voltageDomain: "3V3", resetState: "high impedance", externalBias: "pull-up to 3V3", safetyPurpose: "defined bus idle" },
    { signal: "I2C_SDA", physicalPin: 46, mcuPin: "PB7", peripheral: "I2C1_SDA", direction: "bidirectional", voltageDomain: "3V3", resetState: "high impedance", externalBias: "pull-up to 3V3", safetyPurpose: "defined bus idle" },
    { signal: "CAN_RX", physicalPin: 47, mcuPin: "PB8", peripheral: "FDCAN1_RX", direction: "input", voltageDomain: "3V3", resetState: "high impedance", externalBias: "transceiver-defined recessive state", safetyPurpose: "CAN receive path" },
    { signal: "CAN_TX", physicalPin: 48, mcuPin: "PB9", peripheral: "FDCAN1_TX", direction: "output", voltageDomain: "3V3", resetState: "high impedance", externalBias: "weak pull-up for recessive request", safetyPurpose: "avoid dominant bus drive during reset" }
  ],
  resources: [
    { owner: "motor_pwm", resource: "TIM1 CH1/CH2 at 20 kHz center-aligned", irq: "TIM1_BRK_UP_TRG_COM", dma: null, priority: 0, notes: "break/fault handling preempts communications" },
    { owner: "motor_current", resource: "ADC1 regular scan PA4/PA5", irq: "ADC1_COMP", dma: "DMA1_CH1 via DMAMUX", priority: 1, notes: "timer-triggered samples; no actuator enable before calibration checks" },
    { owner: "encoder_a", resource: "TIM2 encoder mode PA0/PA1 CH1/CH2", irq: "TIM2", dma: null, priority: 2, notes: "32-bit timer count with overflow/error validation" },
    { owner: "encoder_b", resource: "TIM3 encoder mode PC6/PC7 CH1/CH2", irq: "TIM3", dma: null, priority: 2, notes: "16-bit timer count with software extension and overflow validation" },
    { owner: "can", resource: "FDCAN1 PB8/PB9 RX/TX", irq: "TIM16_FDCAN_IT0 / TIM17_FDCAN_IT1", dma: null, priority: 1, notes: "nominal/data timing must be configured by application; PA10 controls standby" },
    { owner: "usb", resource: "USB FS PA11/PA12 plus PD2 VBUS-present", irq: "USB_UCPD1_2 / EXTI2", dma: null, priority: 3, notes: "communications only; divided VBUS input never back-powers the board" },
    { owner: "uart", resource: "USART2 PA2/PA3", irq: "USART2_LPUART2", dma: "DMA1_CH3 RX / DMA1_CH4 TX via DMAMUX", priority: 4, notes: "diagnostic channel" },
    { owner: "spi", resource: "SPI1 PA15 CS, PB3/PB4/PB5 SCK/MISO/MOSI", irq: "SPI1", dma: "DMA1_CH5 RX / DMA1_CH6 TX via DMAMUX", priority: 4, notes: "external device CS is software-controlled and reset-high" },
    { owner: "i2c", resource: "I2C1 PB6/PB7 SCL/SDA", irq: "I2C1", dma: "DMA1_CH7 RX / DMA2_CH1 TX via DMAMUX", priority: 4, notes: "timeouts force peripheral recovery without enabling actuators" },
    { owner: "fault_inputs", resource: "EXTI PB0/PB1/PB10", irq: "EXTI0_1 / EXTI4_15", dma: null, priority: 0, notes: "latch fault, disable both bridges, record cause; PD3 reports latched status" },
    { owner: "board_revision", resource: "GPIO straps PB14/PB15", irq: null, dma: null, priority: 1, notes: "sample before actuator configuration and require EVL-RC-G0-REV-A code" },
    { owner: "clock_and_reset", resource: "internal HSI clock and PF2 NRST", irq: "RCC_CRS", dma: null, priority: 0, notes: "PF0/PF1 are intentionally unconnected; firmware uses the internal HSI clock and NRST remains available at SWD" },
    { owner: "status", resource: "GPIO PB11 RUN and PD3 FAULT_STATUS", irq: null, dma: null, priority: 5, notes: "diagnostic indicators only; never serve as safety evidence" }
  ],
  protocols: [
    { name: "USB", electrical: "USB 2.0 full-speed device, protected D+/D-, divided digital VBUS-present input, no USB rail backfeed", controller: "STM32 USB FS", pins: ["USB_DM", "USB_DP", "VBUS_PRESENT"], defaultConfiguration: "device-only CDC diagnostic scaffold", resetBehavior: "disconnected until clocks, descriptors, and VBUS state validate" },
    { name: "CAN", electrical: "ISO 11898-2 physical layer through TCAN3413; switchable/DNP 120 ohm termination", controller: "FDCAN1", pins: ["CAN_RX", "CAN_TX", "CAN_STB"], defaultConfiguration: "nominal timing intentionally application-supplied", resetBehavior: "TCAN3413 held in standby" },
    { name: "UART", electrical: "3.3 V CMOS, not RS-232 tolerant", controller: "USART2", pins: ["UART_TX", "UART_RX"], defaultConfiguration: "115200 8-N-1 diagnostic scaffold", resetBehavior: "pins high impedance; RX externally idle-high" },
    { name: "I2C", electrical: "3.3 V open-drain bus", controller: "I2C1", pins: ["I2C_SCL", "I2C_SDA"], defaultConfiguration: "100 kHz bring-up, 400 kHz only after rise-time validation", resetBehavior: "external pull-ups hold idle-high" },
    { name: "SPI", electrical: "3.3 V CMOS controller mode", controller: "SPI1", pins: ["SPI_CS", "SPI_SCK", "SPI_MISO", "SPI_MOSI"], defaultConfiguration: "mode and rate application-supplied; scaffold starts disabled", resetBehavior: "CS high; clock/data externally biased low" },
    { name: "SWD", electrical: "3.3 V SWD with PF2 NRST and reference ground", controller: "ARM debug port", pins: ["SWDIO", "SWCLK", "NRST"], defaultConfiguration: "always recoverable in prototype builds", resetBehavior: "debug port and PF2 hardware reset remain available" },
    { name: "ENCODER", electrical: "external encoder inputs conditioned by two SN74LVC2G17 devices into 3.3 V timers", controller: "TIM2 and TIM3 encoder mode", pins: ["ENC_A_A", "ENC_A_B", "ENC_B_A", "ENC_B_B"], defaultConfiguration: "both-edge quadrature count with index unsupported in v0", resetBehavior: "buffer outputs pulled to stopped/zero state" }
  ],
  layoutConstraints: [
    { id: "layout_motor_loop", appliesTo: ["DRV8874PWP", "motor connectors", "VBAT bulk capacitors"], rule: "Keep each high-di/dt bridge loop compact and separate from MCU, encoder, USB, and CAN returns.", verification: "KiCad geometry report plus human copper/return-path review" },
    { id: "layout_powerpad", appliesTo: ["DRV8874PWP"], rule: "Connect exposed pads to solid ground copper with a reviewed thermal-via array.", verification: "footprint-pad and thermal-via report" },
    { id: "layout_buck", appliesTo: ["LMR51420", "buck input capacitor", "inductor", "buck output capacitor"], rule: "Minimize switch-node area and hot-loop length; keep switch node away from analog and connector traces.", verification: "placement and copper-geometry report" },
    { id: "layout_usb", appliesTo: ["USB_DM", "USB_DP", "USBLC6-2SC6"], rule: "Route D+/D- as a short matched pair over uninterrupted ground and place ESD protection at the connector.", verification: "differential-pair and reference-plane report" },
    { id: "layout_can", appliesTo: ["CANH", "CANL", "TCAN3413DR"], rule: "Route CAN as a pair, minimize stubs, and keep termination configurable at the connector edge.", verification: "pair-spacing, stub, and termination-connectivity report" },
    { id: "layout_sense", appliesTo: ["MOTOR_A_ISENSE", "MOTOR_B_ISENSE"], rule: "Kelvin-route sense references away from motor and buck switching currents.", verification: "connectivity and return-path review" },
    { id: "layout_board_revision", appliesTo: ["BOARD_REV0", "BOARD_REV1"], rule: "Place fixed revision straps near PB14/PB15 and away from connector-accessible or switching nets.", verification: "connectivity, stuffing, and firmware-contract review" },
    { id: "layout_decoupling", appliesTo: ["all IC supply pins"], rule: "Place local decoupling adjacent to each supply pin with a short ground return to the uninterrupted In2.GND plane.", verification: "placement-distance report" },
    { id: "layout_hdi_microvia", appliesTo: ["BOARD_ID0", "M1_DIR", "M1_FAULT", "M2_DIR", "M2_FAULT", "CAN_RX"], rule: "Use only non-stacked F.Cu-to-In1.Signal laser microvias with at least 0.26 mm finished pad diameter, 0.10 mm nominal laser drill, at least 0.08 mm annular ring, and no signal copper on In2.GND or In3.Power.", verification: "native microvia geometry, layer-span, plane-integrity, and fabrication-capability report" }
  ],
  exclusions: [
    "No mains input",
    "No battery charging or battery-management function",
    "No human-carrying, medical, or safety-rated control function",
    "No autonomous qualification or manufacturing release",
    "No fabrication claim for the 1+4+1 HDI stack or laser microvias without manufacturer engineering approval",
    "No claim that a clean generated report proves electrical or thermal safety"
  ]
};

const sameOrderedStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

/**
 * Instantiate the reviewed v0 template contract for one requested operating envelope.
 *
 * A `supported` result means only that the requested voltage/current envelope is a
 * subset of Rev-A and that every topology-bearing parameter remains fixed. It does
 * not mean that a new schematic or PCB topology was generated. Consumers that reuse
 * the native Rev-A design must additionally require the returned profile to match
 * this canonical factory output exactly.
 */
export const createReferenceControllerProfile = (
  parameters: ReferenceControllerParameters = {}
): ReferenceControllerProfile => {
  const inputVoltageMv =
    parameters.inputVoltageMv ?? REFERENCE_CONTROLLER_V0_LIMITS.inputVoltageMv;
  const motor = parameters.motor ?? {
    channels: REFERENCE_CONTROLLER_V0_LIMITS.motor.channels,
    rmsCurrentMaPerChannel:
      REFERENCE_CONTROLLER_V0_LIMITS.motor.maximumRmsCurrentMaPerChannel,
    currentChopMaPerChannel:
      REFERENCE_CONTROLLER_V0_LIMITS.motor.currentChopMaPerChannel
  };
  const stackup = parameters.stackup ?? REFERENCE_CONTROLLER_V0_LIMITS.stackup;
  const requestedInterfaces =
    parameters.interfaceSelections ?? REFERENCE_CONTROLLER_V0_LIMITS.interfaceSelections;
  const interfaceSelections = REFERENCE_CONTROLLER_V0_LIMITS.interfaceSelections.filter(
    (entry) => requestedInterfaces.includes(entry)
  );
  const boardRevision =
    parameters.boardRevision ?? REFERENCE_CONTROLLER_V0_LIMITS.boardRevision;
  const unsupportedReasons: string[] = [];

  if (
    !Number.isSafeInteger(inputVoltageMv.minimum) ||
    !Number.isSafeInteger(inputVoltageMv.maximum) ||
    inputVoltageMv.minimum < REFERENCE_CONTROLLER_V0_LIMITS.inputVoltageMv.minimum ||
    inputVoltageMv.maximum > REFERENCE_CONTROLLER_V0_LIMITS.inputVoltageMv.maximum ||
    inputVoltageMv.minimum > inputVoltageMv.maximum
  ) {
    unsupportedReasons.push("INPUT_VOLTAGE_OUTSIDE_7000_16800_MV");
  }
  if (motor.channels !== REFERENCE_CONTROLLER_V0_LIMITS.motor.channels) {
    unsupportedReasons.push("MOTOR_CHANNEL_COUNT_REQUIRES_NEW_CIRCUIT");
  }
  if (
    !Number.isSafeInteger(motor.rmsCurrentMaPerChannel) ||
    motor.rmsCurrentMaPerChannel <= 0 ||
    motor.rmsCurrentMaPerChannel >
      REFERENCE_CONTROLLER_V0_LIMITS.motor.maximumRmsCurrentMaPerChannel
  ) {
    unsupportedReasons.push("MOTOR_RMS_CURRENT_OUTSIDE_V0_LIMIT");
  }
  if (
    motor.currentChopMaPerChannel !==
    REFERENCE_CONTROLLER_V0_LIMITS.motor.currentChopMaPerChannel
  ) {
    unsupportedReasons.push("CURRENT_CHOP_CHANGE_REQUIRES_NEW_SOURCE_BOUND_CALCULATION");
  }
  if (boardRevision !== REFERENCE_CONTROLLER_V0_LIMITS.boardRevision) {
    unsupportedReasons.push("BOARD_REVISION_STRAPS_REQUIRE_NEW_REVIEW");
  }
  if (
    stackup.layerCount !== REFERENCE_CONTROLLER_V0_LIMITS.stackup.layerCount ||
    !sameOrderedStrings(stackup.layers, REFERENCE_CONTROLLER_V0_LIMITS.stackup.layers)
  ) {
    unsupportedReasons.push("STACKUP_CHANGE_REQUIRES_NEW_LAYOUT_VALIDATION");
  }
  if (
    requestedInterfaces.length !== interfaceSelections.length ||
    !sameOrderedStrings(interfaceSelections, REFERENCE_CONTROLLER_V0_LIMITS.interfaceSelections)
  ) {
    unsupportedReasons.push("INTERFACE_SET_CHANGE_REQUIRES_NEW_PIN_AND_CIRCUIT_PROFILE");
  }

  const base = structuredClone(BASE_ROBOTICS_CONTROLLER_V0);
  return {
    ...base,
    boardRevision,
    inputVoltageMv: { ...inputVoltageMv },
    motor: { ...motor },
    stackup: { layerCount: stackup.layerCount, layers: [...stackup.layers] },
    interfaceSelections,
    parameterValidation: {
      supportStatus: unsupportedReasons.length === 0 ? "supported" : "unsupported",
      unsupportedReasons
    },
    components: base.components.map((component) =>
      component.key === "motor_driver"
        ? {
            ...component,
            designUse: {
              ...component.designUse,
              motor_supply: `VBAT_PROTECTED (${inputVoltageMv.minimum}-${inputVoltageMv.maximum} mV)`,
              rms_limit: `${motor.rmsCurrentMaPerChannel} mA per channel`,
              chop_target: `${motor.currentChopMaPerChannel} mA per channel`
            }
          }
        : component
    ),
    rails: base.rails.map((rail) =>
      rail.name === "VBAT_PROTECTED"
        ? {
            ...rail,
            source: `${inputVoltageMv.minimum}-${inputVoltageMv.maximum} mV battery input after fuse, reverse-polarity, and transient protection`,
            minimumMv: inputVoltageMv.minimum,
            maximumMv: inputVoltageMv.maximum
          }
        : rail
    ),
    pins: base.pins.map((pin) =>
      pin.signal === "BOARD_REV0" || pin.signal === "BOARD_REV1"
        ? {
            ...pin,
            safetyPurpose: `bind firmware to ${boardRevision} hardware revision`
          }
        : pin
    ),
    resources: base.resources.map((resource) =>
      resource.owner === "board_revision"
        ? {
            ...resource,
            notes: `sample before actuator configuration and require ${boardRevision} code`
          }
        : resource
    ),
    protocols: base.protocols.filter((protocol) =>
      interfaceSelections.includes(protocol.name)
    )
  };
};

export const ROBOTICS_CONTROLLER_V0 = createReferenceControllerProfile();

export const referenceComponentKeys = (): readonly ReferenceComponentKey[] =>
  ROBOTICS_CONTROLLER_V0.components.map((component) => component.key);
