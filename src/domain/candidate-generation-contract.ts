import type { DesignRevision, ToolIdentity, UnresolvedAssumption } from "./types.js";

export const CANDIDATE_APPLICATION_TOOL: ToolIdentity = Object.freeze({
  name: "evleda-application",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile: "candidate-only"
});

export const GENERATED_BRINGUP_PLAN_WARNING: UnresolvedAssumption = Object.freeze({
  id: "assumption_generate_bringup_plan_requires_review",
  statement:
    "The generated bring-up plan requires qualified human execution and physical measurements.",
  severity: "warning",
  sourceRequirementIds: Object.freeze([])
});

export const GENERATED_BRINGUP_PLAN_CONTRACT = Object.freeze({
  stage: "bringup_package",
  logicalName: "bringup-plan.md",
  mediaType: "text/markdown; charset=utf-8",
  validationStatus: "not_run",
  lifecycle: "candidate",
  tool: CANDIDATE_APPLICATION_TOOL,
  warning: GENERATED_BRINGUP_PLAN_WARNING
} as const);

export const generatedBringupPlan = (
  revision: DesignRevision,
  requirementsDigest: string
): string =>
  `# Candidate bring-up plan\n\n` +
  `> HUMAN-EXECUTED PROTOTYPE PROCEDURE — NOT A SAFETY OR PRODUCTION RELEASE\n\n` +
  `Project: ${revision.projectId}\nRun: ${revision.runId}\nRevision: ${revision.id}\n` +
  `Revision manifest: ${revision.manifest.digest}\nRequirements: ${requirementsDigest}\n\n` +
  `## Preconditions\n\n` +
  `- Verify board, BOM substitutions, assembly lot, firmware hash, and procedure revision against this manifest.\n` +
  `- Use a current-limited isolated bench supply, calibrated instruments, eye protection, and a reachable power disconnect.\n` +
  `- Keep actuator outputs unloaded and disabled until all logic rails, reset states, and fault paths pass.\n\n` +
  `## Ordered checks\n\n` +
  `1. Inspect orientation, polarity, shorts, contamination, and unpopulated options without power.\n` +
  `2. Measure resistance from every supply rail to ground and record raw values. Stop on an unexplained low resistance.\n` +
  `3. Apply minimum input voltage with a conservative current limit. Record input current, rail voltages, ripple, and thermal observations.\n` +
  `4. Repeat at nominal and maximum declared input voltage only after the preceding point passes.\n` +
  `5. Verify reset/default states keep motor bridges and switched sensor power disabled.\n` +
  `6. Verify SWD recovery, board-revision identification, clocks, watchdog, and fault logging.\n` +
  `7. Exercise USB, CAN, UART, I2C, SPI, and encoder inputs independently with bounded fixtures.\n` +
  `8. Exercise each actuator channel first into a protected dummy load; record current regulation, fault shutdown, and temperature.\n` +
  `9. Remove communications and inject declared faults; verify outputs return to the documented safe-disabled state.\n\n` +
  `## Evidence record\n\n` +
  `Record operator, board serial, assembly substitutions, instrument IDs/calibration, environment, raw measurements, limits, pass/fail verdicts, photos, and anomalies. Bind every record to revision manifest ${revision.manifest.digest}.\n`;

