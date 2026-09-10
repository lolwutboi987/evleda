import {
  REFERENCE_CONTROLLER_V0_LIMITS,
  type ReferenceControllerProfile
} from "./reference-controller-v0.js";
import type {
  PhysicalAcceptanceTest,
  PhysicalCaptureRequirement,
  PhysicalRequiredCondition
} from "../contracts/operations.js";

export const PHYSICAL_ACCEPTANCE_POLICY_SCHEMA =
  "evleda.physical-acceptance-policy.v2" as const;

export interface PhysicalAcceptancePolicyCase {
  readonly caseId: string;
  readonly procedureStepId: string;
  readonly endpointId: string;
  readonly title: string;
  readonly procedure: readonly string[];
  readonly requiredConditions: readonly PhysicalRequiredCondition[];
  /** Null means no reviewed minimum duration exists and must block generation. */
  readonly minimumDurationMs: number | null;
  readonly captureRequirements: readonly PhysicalCaptureRequirement[];
}

export type PhysicalAcceptancePolicyTest =
  | (Omit<Extract<PhysicalAcceptanceTest, { readonly kind: "numeric_range" }>, "minimum" | "maximum"> & {
      /** Null values are unresolved policy, never executable acceptance limits. */
      readonly minimum: number | null;
      readonly maximum: number | null;
    })
  | (Omit<Extract<PhysicalAcceptanceTest, { readonly kind: "expected_value" }>, "expected"> & {
      /** Null means the expected value has not been approved. */
      readonly expected: boolean | string | null;
    });

export interface PhysicalAcceptancePolicy {
  readonly schemaVersion: typeof PHYSICAL_ACCEPTANCE_POLICY_SCHEMA;
  readonly profileId: string;
  readonly boardRevision: string;
  readonly procedureId: string;
  readonly approvalStatus: "approved" | "incomplete";
  readonly unresolvedItems: readonly string[];
  readonly cases: readonly PhysicalAcceptancePolicyCase[];
  readonly tests: readonly PhysicalAcceptancePolicyTest[];
}

const exact = (conditionId: string, expected: boolean | string): PhysicalRequiredCondition => ({
  conditionId,
  kind: "exact",
  expected
});

const range = (
  conditionId: string,
  unit: "V" | "A" | "degC" | "Hz" | "bps",
  minimum: number,
  maximum: number
): PhysicalRequiredCondition => ({ conditionId, kind: "numeric_range", unit, minimum, maximum });

const capture = (
  captureRequirementId: string,
  kind: PhysicalCaptureRequirement["kind"],
  description: string,
  instrumentCapability: PhysicalCaptureRequirement["instrumentCapability"],
  allowedMediaTypes: PhysicalCaptureRequirement["allowedMediaTypes"],
  minimumSamples?: number
): PhysicalCaptureRequirement => ({
  captureRequirementId,
  kind,
  description,
  instrumentCapability,
  allowedMediaTypes,
  ...(minimumSamples === undefined ? {} : { minimumSamples })
});

const caseEntry = (
  caseId: string,
  procedureStepId: string,
  endpointId: string,
  title: string,
  procedure: readonly string[],
  requiredConditions: readonly PhysicalRequiredCondition[],
  captureRequirements: readonly PhysicalCaptureRequirement[]
): PhysicalAcceptancePolicyCase => ({
  caseId,
  procedureStepId,
  endpointId,
  title,
  procedure,
  requiredConditions,
  minimumDurationMs: null,
  captureRequirements
});

const observedTrue = (
  id: string,
  caseId: string,
  category: PhysicalAcceptanceTest["category"],
  quantity: string,
  instrumentCapability: PhysicalAcceptanceTest["instrumentCapability"],
  expected: boolean | string | null = true
): PhysicalAcceptancePolicyTest => ({
  id,
  caseId,
  category,
  quantity,
  instrumentCapability,
  kind: "expected_value",
  expected
});

const numeric = (
  id: string,
  caseId: string,
  category: PhysicalAcceptanceTest["category"],
  quantity: string,
  instrumentCapability: PhysicalAcceptanceTest["instrumentCapability"],
  unit: Extract<PhysicalAcceptanceTest, { readonly kind: "numeric_range" }>["unit"],
  minimum: number | null,
  maximum: number | null
): PhysicalAcceptancePolicyTest => ({
  id,
  caseId,
  category,
  quantity,
  instrumentCapability,
  kind: "numeric_range",
  unit,
  minimum,
  maximum
});

const referenceCases: readonly PhysicalAcceptancePolicyCase[] = [
  caseEntry("assembly-inspection", "BU-01", "unpowered", "Assembly inspection", ["Inspect the exact assembled revision against BOM, CAM, polarity, orientation, solder, and connector requirements."], [exact("power-state", "unpowered")], [capture("assembly-images", "visual_inspection", "Annotated assembly inspection images", "camera", ["image/png", "image/jpeg"])]),
  caseEntry("unpowered-rail-resistance", "BU-01", "unpowered", "Unpowered rail resistance", ["Measure each required power rail to ground before energizing the board."], [exact("power-state", "unpowered")], [capture("rail-resistance-log", "scalar_measurement", "Raw per-rail resistance readings", "resistance", ["application/json", "text/csv"])]),
  caseEntry("minimum-input-rails", "BU-02", "input-minimum", "Minimum-input first power", ["Apply the approved current-limited minimum input and measure all regulated rails and safe outputs."], [range("input-voltage", "V", 7, 7), exact("motors-connected", false), exact("sensors-connected", false)], [capture("minimum-input-rail-log", "time_series", "Supply and regulated-rail measurements at minimum input", "dc_voltage", ["application/json", "text/csv"]), capture("minimum-input-current-log", "time_series", "Input-current startup and steady-state measurements", "dc_current", ["application/json", "text/csv"]), capture("minimum-input-startup", "waveform", "Startup and safe-output waveforms", "oscilloscope", ["application/json", "text/csv", "image/png"])]),
  caseEntry("swd-programming-recovery", "BU-03", "input-minimum", "SWD programming and recovery", ["Program the exact target binary, recover under reset, and record device and board identity."], [range("input-voltage", "V", 7, 7), exact("expected-board-revision", REFERENCE_CONTROLLER_V0_LIMITS.boardRevision), exact("guarded-loads", true)], [capture("swd-programmer-log", "programmer_log", "Complete programmer and recovery transcript", "programmer", ["application/json", "text/plain"])]),
  caseEntry("reset-safe-state", "BU-03", "input-minimum", "Reset safe-state behavior", ["Repeat reset and debugger-halt transitions while monitoring every hardware-biased safe output."], [range("input-voltage", "V", 7, 7), exact("guarded-loads", true)], [capture("reset-safe-waveforms", "waveform", "Reset, enable, sleep, standby, and output waveforms", "oscilloscope", ["application/json", "text/csv", "image/png"])]),
  ...(["usb", "uart", "can", "i2c", "spi"] as const).map((interfaceId) =>
    caseEntry(`communications-${interfaceId}`, "BU-04", "input-minimum", `${interfaceId.toUpperCase()} communications`, [`Exercise the approved ${interfaceId.toUpperCase()} fixture, configuration, traffic, error, and reset behavior.`], [range("input-voltage", "V", 7, 7), exact("motor-bridges-enabled", false)], [capture(`${interfaceId}-protocol-trace`, "protocol_trace", `${interfaceId.toUpperCase()} analyzer trace and settings`, "protocol_analyzer", ["application/json", "text/csv", "text/plain"])])
  ),
  caseEntry("sensor-power-normal", "BU-05", "input-minimum", "Protected sensor power", ["Enable the protected sensor rail into approved loads and record voltage, current, and fault behavior."], [range("input-voltage", "V", 7, 7), exact("guarded-sensor-fixture", true)], [capture("sensor-voltage-log", "time_series", "Sensor-rail voltage time series", "dc_voltage", ["application/json", "text/csv"]), capture("sensor-current-log", "time_series", "Sensor-rail load and current-limit time series", "dc_current", ["application/json", "text/csv"]), capture("sensor-fault-waveform", "waveform", "Sensor enable and fault response waveform", "oscilloscope", ["application/json", "text/csv", "image/png"])]),
  ...(["a", "b"] as const).map((channel) =>
    caseEntry(`encoder-${channel}`, "BU-05", "input-minimum", `Encoder ${channel.toUpperCase()} path`, [`Drive encoder ${channel.toUpperCase()} through the approved rate, direction, count, and overflow matrix.`], [range("input-voltage", "V", 7, 7), exact("quadrature-fixture", true)], [capture(`encoder-${channel}-trace`, "protocol_trace", `Encoder ${channel.toUpperCase()} stimulus and count trace`, "logic_analyzer", ["application/json", "text/csv"])])
  ),
  ...(["a", "b"] as const).map((channel) =>
    caseEntry(`motor-${channel}-current-regulation`, "BU-06", "input-minimum", `Motor ${channel.toUpperCase()} current regulation`, [`Exercise only motor channel ${channel.toUpperCase()} with the approved guarded load and dynamic current criteria.`], [range("input-voltage", "V", 7, 7), range("commanded-chop-target", "A", 1, 1), exact("mechanical-motion-prevented", true), exact("other-motor-channel-enabled", false)], [capture(`motor-${channel}-current-waveform`, "waveform", `Motor ${channel.toUpperCase()} PWM, current, IPROPI, VREF, sleep, and fault waveforms`, "current_probe", ["application/json", "text/csv", "image/png"])])
  ),
  ...(["input-minimum", "input-maximum"] as const).map((endpointId) =>
    caseEntry(`dual-motor-thermal-${endpointId}`, "BU-07", endpointId, `Dual-motor thermal characterization at ${endpointId}`, ["Operate both channels under the approved RMS load, duty, ambient, airflow, temperature-location, steady-state, and abort criteria."], [range("motor-rms-current-per-channel", "A", 0.5, 0.5), exact("controlled-ambient-airflow", true)], [capture(`thermal-${endpointId}-series`, "time_series", `All approved temperatures, rails, loads, supply, ambient, and airflow`, "temperature", ["application/json", "text/csv"])])
  ),
  ...(["bridge-a-fault", "bridge-b-fault", "sensor-power-fault", "watchdog-reset", "brownout", "debugger-halt", "communications-loss", "rapid-reset"] as const).map((faultId) =>
    caseEntry(`fault-${faultId}`, "BU-08", "input-minimum", `${faultId} safe-state response`, [`Inject ${faultId} using the approved guarded method and record response, retained state, diagnostics, and explicit recovery.`], [range("input-voltage", "V", 7, 7), exact("independent-cutoff-armed", true)], [capture(`${faultId}-waveform`, "waveform", `${faultId} stimulus and safe-state waveform`, "oscilloscope", ["application/json", "text/csv", "image/png"]), capture(`${faultId}-event-log`, "event_log", `${faultId} firmware event and recovery log`, "logic_analyzer", ["application/json", "text/plain"])] )
  ),
  caseEntry("maximum-input-rails", "BU-09", "input-maximum", "Maximum-input rails and idle state", ["Repeat every approved maximum-input rail, input-current, startup, and safe-idle check."], [range("input-voltage", "V", 16.8, 16.8), exact("prior-cases-passed", true)], [capture("maximum-input-rail-log", "time_series", "Maximum-input supply and regulated-rail measurements", "dc_voltage", ["application/json", "text/csv"]), capture("maximum-input-current-log", "time_series", "Maximum-input current measurements", "dc_current", ["application/json", "text/csv"]), capture("maximum-input-safe-waveform", "waveform", "Maximum-input safe-idle waveforms", "oscilloscope", ["application/json", "text/csv", "image/png"])]),
  ...(["usb", "uart", "can", "i2c", "spi"] as const).map((interfaceId) =>
    caseEntry(`maximum-input-communications-${interfaceId}`, "BU-09", "input-maximum", `${interfaceId.toUpperCase()} communications at maximum input`, [`Repeat the approved ${interfaceId.toUpperCase()} traffic, error, and reset matrix at maximum input.`], [range("input-voltage", "V", 16.8, 16.8), exact("prior-communications-case-passed", true)], [capture(`maximum-input-${interfaceId}-trace`, "protocol_trace", `${interfaceId.toUpperCase()} analyzer trace and settings at maximum input`, "protocol_analyzer", ["application/json", "text/csv", "text/plain"])])
  ),
  caseEntry("maximum-input-sensor-power", "BU-09", "input-maximum", "Protected sensor power at maximum input", ["Repeat the approved protected sensor-power load and fault matrix at maximum input."], [range("input-voltage", "V", 16.8, 16.8), exact("prior-sensor-case-passed", true)], [capture("maximum-input-sensor-voltage", "time_series", "Maximum-input sensor-rail voltage", "dc_voltage", ["application/json", "text/csv"]), capture("maximum-input-sensor-current", "time_series", "Maximum-input sensor-rail current", "dc_current", ["application/json", "text/csv"]), capture("maximum-input-sensor-fault", "waveform", "Maximum-input sensor fault response", "oscilloscope", ["application/json", "text/csv", "image/png"])]),
  ...(["a", "b"] as const).map((channel) =>
    caseEntry(`maximum-input-motor-${channel}`, "BU-09", "input-maximum", `Motor ${channel.toUpperCase()} at maximum input`, [`Repeat the approved guarded motor ${channel.toUpperCase()} dynamic-current and fault checks at maximum input.`], [range("input-voltage", "V", 16.8, 16.8), range("commanded-chop-target", "A", 1, 1), exact("prior-motor-case-passed", true), exact("mechanical-motion-prevented", true)], [capture(`maximum-input-motor-${channel}-waveform`, "waveform", `Motor ${channel.toUpperCase()} current and control waveforms at maximum input`, "current_probe", ["application/json", "text/csv", "image/png"])])
  )
];

const referenceTests: readonly PhysicalAcceptancePolicyTest[] = [
  observedTrue("assembly-exact-match", "assembly-inspection", "rails", "Exact assembly matches BOM, CAM, polarity, orientation, and workmanship requirements", "camera"),
  ...(["vbat-protected", "5v0", "3v3", "5v-sensor"] as const).map((railId) =>
    numeric(`unpowered-${railId}-resistance`, "unpowered-rail-resistance", "rails", `${railId} unpowered rail-to-ground resistance`, "resistance", "ohm", null, null)
  ),
  numeric("rail-5v0-minimum-input", "minimum-input-rails", "rails", "5V0 regulated rail at minimum input", "dc_voltage", "V", 4.75, 5.25),
  numeric("rail-3v3-minimum-input", "minimum-input-rails", "rails", "3V3 regulated rail at minimum input", "dc_voltage", "V", 3.201, 3.399),
  numeric("minimum-input-current", "minimum-input-rails", "rails", "Minimum-input startup and safe-idle current", "dc_current", "A", null, null),
  observedTrue("minimum-input-sensor-off", "minimum-input-rails", "sensors", "5V_SENSOR remains off before explicit enable", "oscilloscope"),
  observedTrue("minimum-input-motors-safe", "minimum-input-rails", "actuators", "Both motor bridges and outputs remain de-energized", "oscilloscope"),
  observedTrue("programming-swd-recovery", "swd-programming-recovery", "programming", "Exact target programming, SWD recovery, and board identity", "programmer"),
  observedTrue("programming-board-revision-encoding", "swd-programming-recovery", "programming", "Reviewed raw board-revision strap encoding resolves to the exact board revision", "programmer", null),
  observedTrue("reset-safe-state", "reset-safe-state", "fault_reset", "All reset and halt transitions retain hardware-biased safe state", "oscilloscope"),
  ...(["usb", "uart", "can", "i2c", "spi"] as const).map((interfaceId) => observedTrue(`communications-${interfaceId}`, `communications-${interfaceId}`, "communications", `${interfaceId.toUpperCase()} approved traffic and reset matrix`, "protocol_analyzer", interfaceId === "can" || interfaceId === "spi" ? null : true)),
  numeric("sensor-rail-enabled", "sensor-power-normal", "sensors", "5V_SENSOR enabled voltage", "dc_voltage", "V", 4.5, 5.25),
  numeric("sensor-current-limit", "sensor-power-normal", "sensors", "5V_SENSOR reviewed current-limit behavior", "dc_current", "A", null, null),
  observedTrue("sensor-fault-response", "sensor-power-normal", "sensors", "5V_SENSOR fault asserts, de-energizes, latches, and recovers as approved", "oscilloscope", null),
  ...(["a", "b"] as const).map((channel) => observedTrue(`encoder-${channel}-matrix`, `encoder-${channel}`, "sensors", `Encoder ${channel.toUpperCase()} approved stimulus and count matrix`, "logic_analyzer", null)),
  ...(["a", "b"] as const).map((channel) => numeric(`motor-${channel}-current-chop`, `motor-${channel}-current-regulation`, "actuators", `Motor ${channel.toUpperCase()} dynamic current-chop behavior`, "current_probe", "A", null, null)),
  ...(["a", "b"] as const).map((channel) => observedTrue(`motor-${channel}-disable-fault`, `motor-${channel}-current-regulation`, "actuators", `Motor ${channel.toUpperCase()} disable and fault paths de-energize both outputs`, "current_probe", null)),
  ...(["input-minimum", "input-maximum"] as const).flatMap((endpointId) =>
    (["motor-driver-a", "motor-driver-b", "buck-5v", "ldo-3v3", "sensor-switch", "power-connector", "motor-connector-a", "motor-connector-b", "power-copper", "ambient"] as const).map((locationId) =>
      numeric(`thermal-${endpointId}-${locationId}`, `dual-motor-thermal-${endpointId}`, "thermal", `${locationId} temperature at ${endpointId}`, "temperature", "degC", null, null)
    )
  ),
  ...(["bridge-a-fault", "bridge-b-fault", "sensor-power-fault", "watchdog-reset", "brownout", "debugger-halt", "communications-loss", "rapid-reset"] as const).map((faultId) => observedTrue(`fault-${faultId}-safe-state`, `fault-${faultId}`, "fault_reset", `${faultId} reaches, retains, and explicitly recovers from safe state`, "oscilloscope", null)),
  numeric("rail-5v0-maximum-input", "maximum-input-rails", "rails", "5V0 regulated rail at maximum input", "dc_voltage", "V", 4.75, 5.25),
  numeric("rail-3v3-maximum-input", "maximum-input-rails", "rails", "3V3 regulated rail at maximum input", "dc_voltage", "V", 3.201, 3.399),
  numeric("maximum-input-current", "maximum-input-rails", "rails", "Maximum-input startup and safe-idle current", "dc_current", "A", null, null),
  observedTrue("maximum-input-safe-idle", "maximum-input-rails", "fault_reset", "Maximum-input endpoint retains the approved safe idle state", "oscilloscope", null),
  ...(["usb", "uart", "can", "i2c", "spi"] as const).map((interfaceId) =>
    observedTrue(`maximum-input-communications-${interfaceId}`, `maximum-input-communications-${interfaceId}`, "communications", `${interfaceId.toUpperCase()} approved traffic and reset matrix at maximum input`, "protocol_analyzer", null)
  ),
  numeric("maximum-input-sensor-voltage", "maximum-input-sensor-power", "sensors", "5V_SENSOR enabled voltage at maximum input", "dc_voltage", "V", 4.5, 5.25),
  numeric("maximum-input-sensor-current", "maximum-input-sensor-power", "sensors", "5V_SENSOR current-limit behavior at maximum input", "dc_current", "A", null, null),
  observedTrue("maximum-input-sensor-fault", "maximum-input-sensor-power", "sensors", "5V_SENSOR fault behavior at maximum input", "oscilloscope", null),
  ...(["a", "b"] as const).map((channel) =>
    numeric(`maximum-input-motor-${channel}-current`, `maximum-input-motor-${channel}`, "actuators", `Motor ${channel.toUpperCase()} dynamic current at maximum input`, "current_probe", "A", null, null)
  )
];

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

export const REFERENCE_PHYSICAL_ACCEPTANCE_POLICY: PhysicalAcceptancePolicy = deepFreeze({
  schemaVersion: PHYSICAL_ACCEPTANCE_POLICY_SCHEMA,
  profileId: REFERENCE_CONTROLLER_V0_LIMITS.profileId,
  boardRevision: REFERENCE_CONTROLLER_V0_LIMITS.boardRevision,
  procedureId: "robotics-controller-v0-bringup",
  approvalStatus: "incomplete",
  unresolvedItems: [
    "unpowered-rail-resistance-limits",
    "first-power-current-limit-and-transient-limits",
    "can-and-spi-test-configurations",
    "encoder-rate-count-error-and-duration-criteria",
    "sensor-current-limit-fault-and-timing-criteria",
    "motor-dynamic-chop-load-and-overshoot-limits",
    "thermal-locations-limits-ambient-airflow-steady-state-and-duration",
    "fault-response-retention-recovery-and-repetition-criteria",
    "minimum-duration-for-every-required-case",
    "reviewed-board-revision-strap-encoding-and-dft-map"
  ],
  cases: referenceCases,
  tests: referenceTests
});

export const physicalAcceptancePolicyMatchesProfile = (
  policy: PhysicalAcceptancePolicy,
  profile: ReferenceControllerProfile
): boolean => policy.profileId === profile.profileId && policy.boardRevision === profile.boardRevision;
