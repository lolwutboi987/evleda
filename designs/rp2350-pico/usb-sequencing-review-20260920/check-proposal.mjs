import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = import.meta.dirname;
const inputBytes = fs.readFileSync(path.join(root, 'inputs.json'));
const input = JSON.parse(inputBytes);
const output = path.resolve(process.argv[2] ?? path.join(root, 'results.json'));
assert.ok(!fs.existsSync(output), 'Use a fresh result path; retain prior evidence.');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = [
  ['rp2350-pico-4layer.kicad_pcb', input.sourcePcbSha256],
  ['rp2350-pico-4layer.kicad_sch', input.sourceSchematicSha256],
].map(([filename, expected]) => {
  const file = path.resolve(root, '../native-r1-launches/native', filename);
  const bytes = fs.readFileSync(file);
  assert.equal(sha(bytes), expected, 'The board revision differs from the reviewed source.');
  return { file, bytes, expected };
});

// Range compatibility, not a transient or behavioral regulator model.
const supportsLoad = (minimumAvailable, required) => minimumAvailable >= required;
const guaranteesLow = (driverMaximumLow, receiverMaximumLow) => driverMaximumLow <= receiverMaximumLow;
const guaranteesOrderByThreshold = (earliestRelease, latestRequired) => earliestRelease >= latestRequired;

const sw = input.switch, regulator = input.regulator;
// Even crediting the minimum hysteresis as an addition to the PG sense
// threshold does not establish ordering against the latest limit release.
// The datasheet prose and table describe the PG reference differently; this
// comparison uses the table's ratios and does not resolve that ambiguity.
const earlyPgWithHysteresis = sw.powerGoodSenseFraction.minimum + sw.powerGoodHysteresisFraction.minimum;
const report = {
  schemaVersion: 'evleda.rp2350-usb-sequencing-screen.v1',
  inputsSha256: sha(inputBytes), sourcePcbSha256: input.sourcePcbSha256,
  sourceSchematicSha256: input.sourceSchematicSha256,
  proposal: input.proposal, scope: input.scope,
  settledLoadSupportDuringLowMode: {
    guaranteedByCurrentRange: supportsLoad(sw.rampCurrentLimitMa.minimum, input.existingPreconfigurationSettledInputScreenMa),
    minimumAvailableMa: sw.rampCurrentLimitMa.minimum,
    requiredScreenMa: input.existingPreconfigurationSettledInputScreenMa,
    shortfallMa: input.existingPreconfigurationSettledInputScreenMa - sw.rampCurrentLimitMa.minimum,
    implication: 'Do not leave the full assumed workload enabled during low-current startup. This comparison does not specify the actual startup workload.',
  },
  directPowerGoodToEnable: {
    lowStateGuaranteed: guaranteesLow(sw.powerGoodLowMaximumVAt1Ma, regulator.enableGuaranteedLowMaximumV),
    driverMaximumLowV: sw.powerGoodLowMaximumVAt1Ma,
    receiverGuaranteedLowMaximumV: regulator.enableGuaranteedLowMaximumV,
    electricalInterfaceMarginV: regulator.enableGuaranteedLowMaximumV - sw.powerGoodLowMaximumVAt1Ma,
    headerCompatibility: 'Existing 3V3_EN permits an external pull-down; a push-pull PG output is not an equivalent open-drain source.',
    externalVsysCompatibility: 'A VBUS-powered PG signal alone does not provide the existing external-VSYS-only enable behavior.',
  },
  handoverOrdering: {
    guaranteedByThresholdsAlone: guaranteesOrderByThreshold(earlyPgWithHysteresis, sw.releaseLowLimitFractionOfInput.maximum),
    earlyPowerGoodFractionCreditingHysteresis: earlyPgWithHysteresis,
    latestLowLimitReleaseFraction: sw.releaseLowLimitFractionOfInput.maximum,
    guaranteedMinimumDeglitchMs: sw.powerGoodRisingDeglitchMs.minimum,
    implication: 'Typical delayed PG waveforms are not a guaranteed minimum delay. Coordinated startup needs independent timing or rail-readiness evidence.',
  },
  outputCharging: {
    boundedByLowCurrentModeAfterHandover: false,
    highModeMaximumCurrentMa: sw.highModeMaximumCurrentMa,
    regulatorGuaranteedMinimumSoftStartMs: regulator.softStartMinimumMs,
    implication: 'Enabling the converter after handover still requires analysis of C21, distributed rail capacitance and startup load.',
  },
  decision: 'Do not adopt this direct-wiring proposal. Keep the board unchanged while designing an explicit complete startup sequence.',
  measuredFailure: false, actualWaveformKnown: false,
  completeStartupAssessed: false, nativeCircuitChanged: false,
};
for (const source of sources) assert.deepEqual(fs.readFileSync(source.file), source.bytes);
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({
  output, decision: report.decision,
  currentShortfallMa: report.settledLoadSupportDuringLowMode.shortfallMa,
  enableLowMarginV: report.directPowerGoodToEnable.electricalInterfaceMarginV,
  completeStartupAssessed: false,
}));
