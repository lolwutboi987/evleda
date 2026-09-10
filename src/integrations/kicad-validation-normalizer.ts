import { DomainError } from "../domain/errors.js";
import { isProxy } from "node:util/types";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  canonicalPortableJson,
  assertCapturedPortablePdfSignature,
  capturePortableRawBytes,
  decodeCapturedPortableUtf8,
  derivePortableFindingsV2,
  hardenPortableValue,
  parseCapturedPortableJsonBytes,
  portableCanonicalIdentity,
  portablePdfNotRunV2,
  validateCanonicalIdentity,
  validateContentIdentity,
  validatePortableSourceBindingV1,
  validatePublicPortableSemanticsV2,
  validatePortableSemanticsPayloadV2,
  validatePortablePdfNotRunV2,
  validatePrivateRawCaptureReceiptV2,
  validateRawBoundPortableReceiptV2,
  validateToolContentIdentityV1,
  validateTypedCommandPlanV1,
  withRawBoundReceiptV2Identity,
  withSemanticIdentity,
  type FieldDispositionLedgerEntryV2,
  type PortableFindingV2,
  type PortablePdfNotRunV2,
  type PortableReportKind,
  type PortableRawByteSnapshot,
  type PortableSExpressionListV1,
  type PortableSExpressionV1,
  type PortableSemanticsPayloadV2,
  type PortableSourceBindingV1,
  type PrivateRawCaptureReceiptV2,
  type PublicPortableSemanticsV2,
  type RawBoundPortableReceiptV2,
  type ToolContentIdentityV1,
  type TypedCommandPlanV1
} from "../core/portable-artifact.js";

export interface NativeCommandOutcomeV1 {
  readonly schemaVersion: "evleda.native-command-outcome.v1";
  readonly invocationIdentity: CanonicalIdentity;
  readonly outcome: "succeeded";
  readonly exitCode: 0 | 5;
  readonly accepted: true;
  readonly complete: true;
}

export interface PortableNormalizationBindingsV2 {
  readonly schemaVersion: "evleda.portable-normalization-bindings.v2";
  readonly sourceBinding: PortableSourceBindingV1;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly normalizer: ToolContentIdentityV1;
  readonly commandPlan: TypedCommandPlanV1;
  readonly nativeOutcome: NativeCommandOutcomeV1;
}

export interface CaptureCommandEnvelopeV1 {
  readonly schemaVersion: "evleda.portable-capture-command-envelope.v1";
  readonly authority: "consistency-only";
  readonly reportKind: PortableReportKind;
  readonly sourceBinding: PortableSourceBindingV1;
  readonly rawContentIdentity: ContentIdentity;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly normalizer: ToolContentIdentityV1;
  readonly commandPlan: TypedCommandPlanV1;
  readonly nativeOutcome: NativeCommandOutcomeV1;
  readonly releaseAuthorized: false;
  readonly captureIdentity: CanonicalIdentity;
}

export interface PortableNormalizationResultV2 {
  readonly schemaVersion: "evleda.portable-normalization-result.v2";
  readonly authority: "consistency-only";
  readonly semantics: PublicPortableSemanticsV2;
  readonly rawBoundReceipt: RawBoundPortableReceiptV2;
  readonly captureEnvelope: CaptureCommandEnvelopeV1;
  readonly releaseAuthorized: false;
}

export interface PortableCompoundVerificationV2 {
  readonly schemaVersion: "evleda.portable-compound-verification.v2";
  readonly authority: "consistency-only";
  readonly hostAuthenticated: false;
  readonly reportKind: PortableReportKind;
  readonly result: PortableNormalizationResultV2;
  readonly privateReceipt: PrivateRawCaptureReceiptV2;
  readonly consistent: true;
  readonly releaseAuthorized: false;
  readonly verificationIdentity: CanonicalIdentity;
}

export interface PortablePdfNativeOutcomeV1 {
  readonly schemaVersion: "evleda.pdf-native-command-outcome.v1";
  readonly invocationIdentity: CanonicalIdentity;
  readonly outcome: "succeeded" | "failed" | "timed_out" | "not_run";
  readonly exitCode: number | null;
  readonly accepted: boolean;
  readonly complete: boolean;
}

export interface PortablePdfCompoundVerificationV2 {
  readonly schemaVersion: "evleda.portable-pdf-compound-verification.v2";
  readonly authority: "consistency-only";
  readonly hostAuthenticated: false;
  readonly marker: PortablePdfNotRunV2;
  readonly privateReceipt: PrivateRawCaptureReceiptV2;
  readonly nativeOutcome: PortablePdfNativeOutcomeV1;
  readonly consistent: true;
  readonly releaseAuthorized: false;
  readonly verificationIdentity: CanonicalIdentity;
}

const fail = (message: string, details: Readonly<Record<string, unknown>> = {}): never => {
  throw new DomainError("INVALID_ARGUMENT", message, details);
};

const decodeUtf8 = (snapshot: PortableRawByteSnapshot, kind: string): string =>
  decodeCapturedPortableUtf8(snapshot, kind);

const record = (value: unknown, path: string): Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail(`Expected object at ${path}`);
  return value as Readonly<Record<string, unknown>>;
};

const exactRootKeys = (value: Readonly<Record<string, unknown>>, required: readonly string[], kind: string): void => {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Unknown ${kind} root field`, { key });
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`Missing ${kind} root field`, { key });
  }
};

const boundedString = (value: unknown, kind: string, maxBytes = 4_096): string => {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) fail(`Invalid ${kind} string`);
  return value as string;
};

const boundedInteger = (value: unknown, kind: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(`Invalid ${kind} integer`);
  return value as number;
};

const projectNativeFindingItem = (value: unknown): Readonly<Record<string, unknown>> => {
  const item = record(value, "$raw/finding/item");
  exactRootKeys(item, ["description", "pos", "uuid"], "native finding item");
  const position = record(item.pos, "$raw/finding/item/pos");
  exactRootKeys(position, ["x", "y"], "native finding position");
  if (typeof position.x !== "number" || typeof position.y !== "number" || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    fail("Invalid native finding position");
  }
  return Object.freeze({
    description: boundedString(item.description, "native finding item description"),
    pos: Object.freeze({ x: position.x, y: position.y }),
    uuid: boundedString(item.uuid, "native finding UUID", 128)
  });
};

const projectNativeFinding = (value: unknown): Readonly<Record<string, unknown>> => {
  const item = record(value, "$raw/finding");
  const required = ["description", "severity", "type"] as const;
  const optional = Object.hasOwn(item, "items") ? ["items"] : [];
  exactRootKeys(item, [...required, ...optional], "native finding");
  const severity = boundedString(item.severity, "native finding severity", 32);
  if (!["error", "warning", "exclusion", "info"].includes(severity)) fail("Unsupported native finding severity");
  const type = boundedString(item.type, "native finding type", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(type)) fail("Invalid native finding type");
  let items: readonly Readonly<Record<string, unknown>>[] = Object.freeze([]);
  if (Object.hasOwn(item, "items")) {
    const rawItems = item.items;
    if (!Array.isArray(rawItems) || rawItems.length > 100_000) fail("Invalid native finding items");
    items = Object.freeze((rawItems as unknown[]).map((entry: unknown) => projectNativeFindingItem(entry)));
  }
  return Object.freeze({
    type,
    severity,
    description: boundedString(item.description, "native finding description"),
    items
  });
};

const projectIgnoredChecks = (value: unknown): readonly Readonly<Record<string, string>>[] => {
  if (!Array.isArray(value) || value.length > 4_096) fail("Invalid ignored-check list");
  const checks = (value as unknown[]).map((entry: unknown) => {
    const item = record(entry, "$raw/ignored-check");
    exactRootKeys(item, ["description", "key"], "ignored check");
    const key = boundedString(item.key, "ignored-check key", 256);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(key)) fail("Invalid ignored-check key");
    return Object.freeze({ key, description: boundedString(item.description, "ignored-check description") });
  });
  checks.sort((left: Readonly<Record<"key" | "description", string>>, right: Readonly<Record<"key" | "description", string>>) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (checks.some((entry: Readonly<Record<"key" | "description", string>>, index: number) => index > 0 && entry.key === checks[index - 1]!.key)) fail("Duplicate ignored-check key");
  return Object.freeze(checks);
};

const projectIncludedSeverities = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length > 16) fail("Invalid included-severity list");
  const severities = (value as unknown[]).map((entry: unknown) => boundedString(entry, "included severity", 32));
  if (new Set(severities).size !== severities.length || severities.some((entry) => !["error", "warning", "exclusion"].includes(entry))) {
    fail("Invalid or duplicate included severity");
  }
  return Object.freeze(severities);
};

const projectCountObject = (
  value: unknown,
  keys: readonly string[],
  kind: string
): Readonly<Record<string, number>> => {
  const item = record(value, `$raw/${kind}`);
  exactRootKeys(item, keys, kind);
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, boundedInteger(item[key], `${kind} count`)])));
};

const projectStatsDocument = (parsed: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const metadata = record(parsed.metadata, "$raw/metadata");
  exactRootKeys(metadata, ["date", "generator", "project", "board_name"], "statistics metadata");
  const board = record(parsed.board, "$raw/board");
  const boardKeys = [
    "has_outline", "width", "height", "area", "front_component_density", "back_component_density",
    "front_copper_area", "back_copper_area", "min_track_clearance", "min_track_width", "min_drill_diameter",
    "board_thickness", "front_footprint_area", "back_footprint_area", "front_footprint_density", "back_footprint_density"
  ] as const;
  exactRootKeys(board, boardKeys, "statistics board");
  if (typeof board.has_outline !== "boolean") fail("Invalid statistics outline flag");
  const projectedBoard: Record<string, unknown> = { has_outline: board.has_outline };
  for (const key of boardKeys.slice(1)) projectedBoard[key] = boundedString(board[key], "statistics board measurement", 64);
  if (!Array.isArray(parsed.drill_holes) || parsed.drill_holes.length > 4_096) fail("Invalid drill-hole statistics");
  const rawDrillHoles = parsed.drill_holes;
  const drillHoles = (rawDrillHoles as unknown[]).map((entry: unknown) => {
    const item = record(entry, "$raw/drill-hole");
    exactRootKeys(item, ["count", "shape", "x_size", "y_size", "plated", "source", "start_layer", "stop_layer"], "drill-hole statistics");
    if (typeof item.plated !== "boolean") fail("Invalid drill-hole plated flag");
    return Object.freeze({
      count: boundedInteger(item.count, "drill-hole count"),
      shape: boundedString(item.shape, "drill-hole shape", 32),
      x_size: boundedString(item.x_size, "drill-hole x-size", 64),
      y_size: boundedString(item.y_size, "drill-hole y-size", 64),
      plated: item.plated,
      source: boundedString(item.source, "drill-hole source", 32),
      start_layer: boundedString(item.start_layer, "drill-hole start layer", 32),
      stop_layer: boundedString(item.stop_layer, "drill-hole stop layer", 32)
    });
  });
  const components = record(parsed.components, "$raw/components");
  exactRootKeys(components, ["tht", "smd", "unspecified", "total"], "component statistics");
  return hardenPortableValue({
    metadata: {
      date: "<portable-date>",
      generator: boundedString(metadata.generator, "statistics generator", 128),
      project: boundedString(metadata.project, "statistics project", 256),
      board_name: boundedString(metadata.board_name, "statistics board name", 256)
    },
    board: projectedBoard,
    pads: projectCountObject(parsed.pads, ["through_hole", "smd", "connector", "npth", "castellated", "press_fit"], "pad statistics"),
    vias: projectCountObject(parsed.vias, ["through", "blind", "buried", "micro"], "via statistics"),
    components: Object.fromEntries(["tht", "smd", "unspecified", "total"].map((key) => [
      key,
      projectCountObject(components[key], ["front", "back", "total"], `${key} component statistics`)
    ])),
    drill_holes: drillHoles
  }) as Readonly<Record<string, unknown>>;
};

const identityEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm && left.digest === right.digest && left.size === right.size;

const validateNativeOutcome = (value: unknown, reportKind: PortableReportKind): NativeCommandOutcomeV1 => {
  const safe = record(value, "$bindings/nativeOutcome");
  exactRootKeys(safe, ["schemaVersion", "invocationIdentity", "outcome", "exitCode", "accepted", "complete"], "native outcome");
  if (
    safe.schemaVersion !== "evleda.native-command-outcome.v1" ||
    safe.outcome !== "succeeded" || safe.accepted !== true || safe.complete !== true ||
    !Number.isSafeInteger(safe.exitCode) || ![0, 5].includes(safe.exitCode as number)
  ) fail("Native command outcome is incomplete or unsuccessful");
  if (!["kicad_erc", "kicad_drc"].includes(reportKind) && safe.exitCode !== 0) {
    fail("This report kind requires native exit code zero");
  }
  const invocationIdentity = validateCanonicalIdentity(safe.invocationIdentity, "$bindings/nativeOutcome/invocationIdentity");
  if (invocationIdentity.schemaVersion !== "evleda.tool-invocation.v1") fail("Native invocation identity schema mismatch");
  return Object.freeze({
    schemaVersion: "evleda.native-command-outcome.v1",
    invocationIdentity,
    outcome: "succeeded",
    exitCode: safe.exitCode as 0 | 5,
    accepted: true,
    complete: true
  });
};

const COMMAND_MATRIX: Readonly<Record<PortableReportKind, readonly string[]>> = Object.freeze({
  kicad_erc: Object.freeze(["sch", "erc", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output", "<output>", "<source>"]),
  kicad_drc: Object.freeze(["pcb", "drc", "--schematic-parity", "--refill-zones", "--save-board", "--format", "json", "--units", "mm", "--severity-all", "--exit-code-violations", "--output", "<output>", "<source>"]),
  kicad_netlist: Object.freeze(["sch", "export", "netlist", "--output", "<output>", "<source>"]),
  kicad_stats: Object.freeze(["pcb", "export", "stats", "--format", "json", "--output", "<output>", "<source>"]),
  kicad_d356: Object.freeze(["pcb", "export", "ipcd356", "--output", "<output>", "<source>"])
});

const validateCommandMatrix = (
  commandPlan: TypedCommandPlanV1,
  sourceBinding: PortableSourceBindingV1,
  reportKind: PortableReportKind
): void => {
  if (commandPlan.tool.role !== "native_validator" || commandPlan.tool.kind !== "native_executable" || commandPlan.tool.name !== "kicad-cli") {
    fail("Portable normalization requires the exact native kicad-cli role/name/kind");
  }
  if (commandPlan.logicalCwd.root !== "run_input") fail("Portable native command cwd must use run_input");
  const signature = commandPlan.argv.map((entry, index) =>
    entry.kind === "literal" ? entry.value : index === commandPlan.argv.length - 2 ? "<output>" : "<source>"
  );
  if (canonicalPortableJson(signature) !== canonicalPortableJson(COMMAND_MATRIX[reportKind])) fail("Native command does not match the report-kind matrix");
  const outputArgument = commandPlan.argv.at(-2);
  const sourceArgument = commandPlan.argv.at(-1);
  const outputPath = outputArgument?.kind === "path" ? outputArgument.value : fail("Native command output path is missing");
  const sourcePath = sourceArgument?.kind === "path" ? sourceArgument.value : fail("Native command source path is missing");
  if (commandPlan.expectedOutputs.length !== 1) fail("Native command expected-output matrix is incomplete");
  if (
    outputPath.root !== "run_private" ||
    canonicalPortableJson(outputPath) !== canonicalPortableJson(commandPlan.expectedOutputs[0]) ||
    sourcePath.root !== "run_input"
  ) fail("Native command path roots or expected-output binding mismatch");
  const sourceSuffix = reportKind === "kicad_erc" || reportKind === "kicad_netlist" ? ".kicad_sch" : ".kicad_pcb";
  const outputSuffix = ({
    kicad_erc: ".erc.json", kicad_drc: ".drc.json", kicad_netlist: ".kicad_net", kicad_stats: ".stats.json", kicad_d356: ".d356"
  } as const)[reportKind];
  if (
    !sourcePath.relativePath.endsWith(sourceSuffix) ||
    !sourceBinding.sourcePath.relativePath.endsWith(sourceSuffix) ||
    canonicalPortableJson(sourcePath) !== canonicalPortableJson(sourceBinding.sourcePath) ||
    !outputPath.relativePath.endsWith(outputSuffix)
  ) fail("Native command source/output extension or source identity matrix mismatch");
};

const validateBindings = (value: PortableNormalizationBindingsV2, reportKind: PortableReportKind): PortableNormalizationBindingsV2 => {
  const safe = record(hardenPortableValue(value), "$bindings");
  exactRootKeys(
    safe,
    [
      "schemaVersion",
      "sourceBinding",
      "nativeContractIdentity",
      "normalizerContractIdentity",
      "normalizer",
      "commandPlan",
      "nativeOutcome"
    ],
    "normalization binding"
  );
  if (safe.schemaVersion !== "evleda.portable-normalization-bindings.v2") fail("Unsupported normalization bindings schema");
  const normalizer = validateToolContentIdentityV1(safe.normalizer, "$bindings/normalizer");
  if (normalizer.role !== "portable_normalizer" || normalizer.kind !== "portable_implementation") {
    fail("Normalizer binding must name a portable normalizer implementation");
  }
  const nativeContractIdentity = validateCanonicalIdentity(safe.nativeContractIdentity, "$bindings/nativeContractIdentity");
  const normalizerContractIdentity = validateCanonicalIdentity(safe.normalizerContractIdentity, "$bindings/normalizerContractIdentity");
  const sourceBinding = validatePortableSourceBindingV1(safe.sourceBinding, "$bindings/sourceBinding");
  const commandPlan = validateTypedCommandPlanV1(safe.commandPlan, "$bindings/commandPlan");
  const nativeOutcome = validateNativeOutcome(safe.nativeOutcome, reportKind);
  if (
    nativeContractIdentity.schemaVersion !== "evleda.native-validation-contract.v1" ||
    normalizerContractIdentity.schemaVersion !== "evleda.portable-normalizer-contract.v1"
  ) fail("Normalization binding identity schema-domain mismatch");
  validateCommandMatrix(commandPlan, sourceBinding, reportKind);
  return Object.freeze({
    schemaVersion: "evleda.portable-normalization-bindings.v2",
    sourceBinding,
    nativeContractIdentity,
    normalizerContractIdentity,
    normalizer,
    commandPlan,
    nativeOutcome
  });
};

const PATH_OR_URI = /(?:^[A-Za-z]:[\\/]|^\\\\|^\\[?.]\\|^file:|^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^\/(?:home|Users|tmp|var|etc|mnt|opt|workspace)(?:\/|$)|(?:^|[\\/])\.\.(?:[\\/]|$)|%2f|%5c)/iu;

const assertPortableStrings = (value: unknown, pointer = "", allowedUriPointers: ReadonlySet<string> = new Set()): void => {
  if (typeof value === "string") {
    Buffer.from(value, "utf8");
    if (PATH_OR_URI.test(value) && !allowedUriPointers.has(pointer)) fail("Path, URI, UNC, or traversal leak in normalized semantics", { pointer });
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertPortableStrings(value[index], `${pointer}/${index}`, allowedUriPointers);
    return;
  }
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    for (const key of keys) {
      assertPortableStrings((value as Readonly<Record<string, unknown>>)[key], `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, allowedUriPointers);
    }
  }
};

const ledgerEntry = (pointer: string, ruleId: string, occurrenceCount: number, marker: string): FieldDispositionLedgerEntryV2 => ({
  pointer,
  ruleId,
  occurrenceCount,
  disposition: "normalized",
  normalizedMarker: marker
});

const findingKey = (finding: PortableFindingV2): string =>
  `${finding.severity}\u0000${finding.ruleId}\u0000${finding.message}`;

const findingsFrom = (entries: readonly unknown[], defaultRule: string): readonly PortableFindingV2[] => {
  const grouped = new Map<string, PortableFindingV2>();
  for (const entry of entries) {
    const item = record(entry, "$finding");
    const rawRule = [item.type, item.rule, item.key, item.code].find((candidate) => typeof candidate === "string") ?? defaultRule;
    const rawMessage = [item.description, item.message].find((candidate) => typeof candidate === "string") ?? "KiCad reported a finding";
    const ruleId = String(rawRule).replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 256) || defaultRule;
    const message = String(rawMessage).slice(0, 4_096);
    const rawSeverity = typeof item.severity === "string" ? item.severity : "error";
    const severity: PortableFindingV2["severity"] =
      rawSeverity === "warning" || rawSeverity === "exclusion" || rawSeverity === "info" ? rawSeverity : "error";
    const candidate: PortableFindingV2 = { ruleId, severity, message, occurrenceCount: 1 };
    const key = findingKey(candidate);
    const prior = grouped.get(key);
    grouped.set(key, prior === undefined ? candidate : { ...prior, occurrenceCount: prior.occurrenceCount + 1 });
  }
  return Object.freeze(
    [...grouped.values()].sort((left, right) => {
      const leftKey = findingKey(left);
      const rightKey = findingKey(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
  );
};

const statusFor = (findings: readonly PortableFindingV2[]): PublicPortableSemanticsV2["status"] => {
  if (findings.some((finding) => finding.severity === "error")) return "FAIL";
  if (findings.length > 0) return "UNKNOWN";
  return "PASS";
};

const assemble = (
  reportKind: PortableReportKind,
  rawSnapshot: PortableRawByteSnapshot,
  bindingsValue: PortableNormalizationBindingsV2,
  payload: PortableSemanticsPayloadV2,
  ledger: readonly FieldDispositionLedgerEntryV2[]
): PortableNormalizationResultV2 => {
  const bindings = validateBindings(bindingsValue, reportKind);
  const validatedPayload = validatePortableSemanticsPayloadV2(payload, reportKind);
  const findings = derivePortableFindingsV2(validatedPayload);
  const captureDraft = Object.freeze({
    schemaVersion: "evleda.portable-capture-command-envelope.v1" as const,
    authority: "consistency-only" as const,
    reportKind,
    sourceBinding: bindings.sourceBinding,
    rawContentIdentity: rawSnapshot.identity,
    nativeContractIdentity: bindings.nativeContractIdentity,
    normalizerContractIdentity: bindings.normalizerContractIdentity,
    normalizer: bindings.normalizer,
    commandPlan: bindings.commandPlan,
    nativeOutcome: bindings.nativeOutcome,
    releaseAuthorized: false as const
  });
  const captureEnvelope: CaptureCommandEnvelopeV1 = Object.freeze({
    ...captureDraft,
    captureIdentity: portableCanonicalIdentity(captureDraft, "evleda.portable-capture-command-envelope.v1")
  });
  const semantics = validatePublicPortableSemanticsV2(
    withSemanticIdentity({
      schemaVersion: "evleda.public-portable-semantics.v2",
      authority: "integrity-only",
      rawNormalizationProvenance: "requires-private-replay",
      reportKind,
      sourceBinding: bindings.sourceBinding,
      nativeContractIdentity: bindings.nativeContractIdentity,
      normalizerContractIdentity: bindings.normalizerContractIdentity,
      normalizer: bindings.normalizer,
      tool: bindings.commandPlan.tool,
      commandPlanIdentity: bindings.commandPlan.commandPlanIdentity,
      payload: validatedPayload,
      fieldDispositionLedger: ledger,
      findings,
      status: statusFor(findings),
      normalizationOutcome: "succeeded",
      lifecycle: "candidate",
      releaseAuthorized: false
    })
  );
  const rawBoundReceipt = validateRawBoundPortableReceiptV2(
    withRawBoundReceiptV2Identity({
      schemaVersion: "evleda.raw-bound-portable-receipt.v2",
      reportKind,
      sourceBinding: bindings.sourceBinding,
      rawContentIdentity: rawSnapshot.identity,
      portableSemanticIdentity: semantics.semanticIdentity,
      portableDocumentIdentity: semantics.documentIdentity,
      normalizerContentIdentity: bindings.normalizer.contentIdentity,
      toolIdentity: bindings.commandPlan.tool,
      commandPlanIdentity: bindings.commandPlan.commandPlanIdentity,
      captureIdentity: captureEnvelope.captureIdentity,
      lifecycle: "candidate",
      releaseAuthorized: false
    })
  );
  return validatePortableNormalizationResultV2({
    schemaVersion: "evleda.portable-normalization-result.v2",
    authority: "consistency-only",
    semantics,
    rawBoundReceipt,
    captureEnvelope,
    releaseAuthorized: false
  });
};

const normalizeJsonReport = (
  reportKind: "kicad_erc" | "kicad_drc" | "kicad_stats",
  rawSnapshot: PortableRawByteSnapshot,
  bindings: PortableNormalizationBindingsV2
): PortableNormalizationResultV2 => {
  const maxBytes = reportKind === "kicad_stats" ? 2_097_152 : 8_388_608;
  const parsed = record(parseCapturedPortableJsonBytes(rawSnapshot, { maxBytes, maxDepth: 64, maxNodes: 200_000 }), "$raw");
  let document: Readonly<Record<string, unknown>>;
  let ledger: readonly FieldDispositionLedgerEntryV2[];
  let findingInputs: readonly unknown[] = [];
  if (reportKind === "kicad_erc") {
    exactRootKeys(parsed, ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "sheets", "source"], "ERC");
    if (
      parsed.$schema !== "https://schemas.kicad.org/erc.v1.json" ||
      !Array.isArray(parsed.sheets) ||
      typeof parsed.source !== "string" ||
      typeof parsed.date !== "string"
    ) return fail("Unsupported ERC document");
    const ignoredChecks = projectIgnoredChecks(parsed.ignored_checks);
    const includedSeverities = projectIncludedSeverities(parsed.included_severities);
    const sheets = parsed.sheets.map((rawSheet: unknown) => {
      const sheet = record(rawSheet, "$raw/sheet");
      exactRootKeys(sheet, ["path", "uuid_path", "violations"], "ERC sheet");
      const rawViolations = sheet.violations;
      if (!Array.isArray(rawViolations) || rawViolations.length > 100_000) fail("Invalid ERC sheet violations");
      return Object.freeze({
        path: boundedString(sheet.path, "ERC sheet path", 1_024),
        uuid_path: boundedString(sheet.uuid_path, "ERC sheet UUID path", 4_096),
        violations: Object.freeze((rawViolations as unknown[]).map((entry: unknown) => projectNativeFinding(entry)))
      });
    });
    const source = parsed.source;
    const date = parsed.date;
    document = hardenPortableValue({
      $schema: parsed.$schema,
      coordinate_units: boundedString(parsed.coordinate_units, "ERC coordinate units", 32),
      date: "<portable-date>",
      ignored_checks: ignoredChecks,
      included_severities: includedSeverities,
      kicad_version: boundedString(parsed.kicad_version, "ERC KiCad version", 64),
      sheets,
      source: "<portable-source>"
    }) as Readonly<Record<string, unknown>>;
    ledger = Object.freeze([
      ledgerEntry("/date", "evleda.portable.normalize-date.v1", 1, "<portable-date>"),
      ledgerEntry("/source", "evleda.portable.normalize-source.v1", 1, "<portable-source>")
    ]);
    findingInputs = sheets.flatMap((sheet: unknown) => {
      const sheetRecord = record(sheet, "$raw/sheets");
      return Array.isArray(sheetRecord.violations) ? sheetRecord.violations : fail("ERC sheet violations must be an array");
    });
  } else if (reportKind === "kicad_drc") {
    exactRootKeys(
      parsed,
      ["$schema", "coordinate_units", "date", "ignored_checks", "included_severities", "kicad_version", "schematic_parity", "source", "unconnected_items", "violations"],
      "DRC"
    );
    if (
      parsed.$schema !== "https://schemas.kicad.org/drc.v1.json" ||
      typeof parsed.source !== "string" ||
      typeof parsed.date !== "string" ||
      !Array.isArray(parsed.violations) ||
      !Array.isArray(parsed.unconnected_items) ||
      !Array.isArray(parsed.schematic_parity)
    ) {
      return fail("Unsupported DRC document");
    }
    const violations = parsed.violations.map(projectNativeFinding);
    const unconnectedItems = parsed.unconnected_items.map(projectNativeFinding);
    const schematicParity = parsed.schematic_parity.map(projectNativeFinding);
    const ignoredChecks = projectIgnoredChecks(parsed.ignored_checks);
    const includedSeverities = projectIncludedSeverities(parsed.included_severities);
    const source = parsed.source;
    const date = parsed.date;
    document = hardenPortableValue({
      $schema: parsed.$schema,
      coordinate_units: boundedString(parsed.coordinate_units, "DRC coordinate units", 32),
      date: "<portable-date>",
      ignored_checks: ignoredChecks,
      included_severities: includedSeverities,
      kicad_version: boundedString(parsed.kicad_version, "DRC KiCad version", 64),
      schematic_parity: schematicParity,
      source: "<portable-source>",
      unconnected_items: unconnectedItems,
      violations
    }) as Readonly<Record<string, unknown>>;
    ledger = Object.freeze([
      ledgerEntry("/date", "evleda.portable.normalize-date.v1", 1, "<portable-date>"),
      ledgerEntry("/source", "evleda.portable.normalize-source.v1", 1, "<portable-source>")
    ]);
    findingInputs = [...violations, ...unconnectedItems, ...schematicParity];
  } else {
    exactRootKeys(parsed, ["metadata", "board", "pads", "vias", "components", "drill_holes"], "statistics");
    const metadata = record(parsed.metadata, "$raw/metadata");
    if (typeof metadata.date !== "string") fail("Statistics metadata date string is required");
    const date = metadata.date;
    document = projectStatsDocument(parsed);
    ledger = Object.freeze([
      ledgerEntry("/metadata/date", "evleda.portable.normalize-date.v1", 1, "<portable-date>")
    ]);
  }
  assertPortableStrings(document, "", new Set(["/$schema", "/sheets/0/path", "/sheets/0/uuid_path"]));
  const findings = findingsFrom(findingInputs, `${reportKind}.finding`);
  const schemaVersion = {
    kicad_erc: "evleda.portable-kicad-erc.v2",
    kicad_drc: "evleda.portable-kicad-drc.v2",
    kicad_stats: "evleda.portable-kicad-stats.v2"
  }[reportKind] as "evleda.portable-kicad-erc.v2" | "evleda.portable-kicad-drc.v2" | "evleda.portable-kicad-stats.v2";
  const payload = { schemaVersion, reportKind, document } as PortableSemanticsPayloadV2;
  return assemble(reportKind, rawSnapshot, bindings, payload, ledger);
};

export const normalizeKiCadErc = (rawBytes: Uint8Array, bindings: PortableNormalizationBindingsV2): PortableNormalizationResultV2 =>
  normalizeJsonReport("kicad_erc", capturePortableRawBytes(rawBytes, 8_388_608, false), bindings);

export const normalizeKiCadDrc = (rawBytes: Uint8Array, bindings: PortableNormalizationBindingsV2): PortableNormalizationResultV2 =>
  normalizeJsonReport("kicad_drc", capturePortableRawBytes(rawBytes, 8_388_608, false), bindings);

export const normalizeKiCadStats = (rawBytes: Uint8Array, bindings: PortableNormalizationBindingsV2): PortableNormalizationResultV2 =>
  normalizeJsonReport("kicad_stats", capturePortableRawBytes(rawBytes, 2_097_152, false), bindings);

class KiCadSExpressionParser {
  readonly #text: string;
  #index = 0;
  #nodes = 0;

  public constructor(rawSnapshot: PortableRawByteSnapshot) {
    this.#text = decodeUtf8(rawSnapshot, "KiCad netlist");
  }

  public parse(): readonly PortableSExpressionV1[] {
    const expressions: PortableSExpressionV1[] = [];
    this.#skipSpace();
    while (this.#index < this.#text.length) {
      expressions.push(this.#expression(0));
      if (expressions.length > 32) fail("Too many top-level KiCad netlist expressions");
      this.#skipSpace();
    }
    if (expressions.length === 0) fail("Empty KiCad netlist");
    return Object.freeze(expressions);
  }

  #skipSpace(): void {
    while ([" ", "\t", "\r", "\n", "\0"].includes(this.#text[this.#index] ?? "")) this.#index += 1;
  }

  #bump(depth: number): void {
    this.#nodes += 1;
    if (depth > 64 || this.#nodes > 300_000) fail("KiCad netlist parse budget exceeded", { depth, nodes: this.#nodes });
  }

  #expression(depth: number): PortableSExpressionV1 {
    this.#bump(depth);
    const next = this.#text[this.#index];
    if (next === "(") return this.#list(depth);
    if (next === '"') return Object.freeze({ kind: "string", value: this.#quoted() });
    if (next === undefined || next === ")") return fail("Unexpected KiCad netlist token", { offset: this.#index });
    return Object.freeze({ kind: "atom", value: this.#atom() });
  }

  #list(depth: number): PortableSExpressionListV1 {
    this.#index += 1;
    const items: PortableSExpressionV1[] = [];
    this.#skipSpace();
    while (this.#text[this.#index] !== ")") {
      if (this.#index >= this.#text.length) return fail("Unterminated KiCad netlist list");
      items.push(this.#expression(depth + 1));
      if (items.length > 100_000) fail("KiCad netlist list budget exceeded");
      this.#skipSpace();
    }
    this.#index += 1;
    return Object.freeze({ kind: "list", items: Object.freeze(items) });
  }

  #atom(): string {
    const start = this.#index;
    while (
      this.#index < this.#text.length &&
      ![" ", "\t", "\r", "\n", "\0", "(", ")"].includes(this.#text[this.#index]!)
    ) {
      const code = this.#text.charCodeAt(this.#index);
      if (this.#text[this.#index] === '"' || code < 0x20 || code === 0x7f) {
        return fail("Invalid character in KiCad netlist atom", { offset: start });
      }
      this.#index += 1;
      if (this.#index - start > 4_096) return fail("KiCad netlist atom budget exceeded", { offset: start });
    }
    const value = this.#text.slice(start, this.#index);
    if (value.length === 0 || Buffer.byteLength(value, "utf8") > 4_096) {
      return fail("Invalid KiCad netlist atom", { offset: start });
    }
    return value;
  }

  #quoted(): string {
    const start = this.#index;
    this.#index += 1;
    const parts: string[] = [];
    let byteLength = 0;
    const append = (part: string): void => {
      byteLength += Buffer.byteLength(part, "utf8");
      if (byteLength > 262_144) fail("KiCad netlist string budget exceeded", { offset: start });
      parts.push(part);
    };
    while (this.#index < this.#text.length) {
      const codePoint = this.#text.codePointAt(this.#index)!;
      const char = String.fromCodePoint(codePoint);
      this.#index += char.length;
      if (char === '"') {
        const value = parts.join("");
        return value;
      }
      if (char === "\\") {
        const escaped = this.#text[this.#index];
        this.#index += 1;
        if (escaped === undefined) return fail("Unterminated KiCad netlist escape", { offset: start });
        if (escaped === "x") {
          let hex = "";
          while (hex.length < 2 && /^[0-9a-fA-F]$/u.test(this.#text[this.#index] ?? "")) {
            hex += this.#text[this.#index]!;
            this.#index += 1;
          }
          if (hex.length === 0) return fail("Invalid KiCad hex escape", { offset: this.#index });
          append(String.fromCodePoint(Number.parseInt(hex, 16)));
        } else if (/^[0-7]$/u.test(escaped)) {
          let octal = escaped;
          while (octal.length < 3 && /^[0-7]$/u.test(this.#text[this.#index] ?? "")) {
            octal += this.#text[this.#index]!;
            this.#index += 1;
          }
          append(String.fromCodePoint(Number.parseInt(octal, 8)));
        } else {
          const replacements: Readonly<Record<string, string>> = {
            '"': '"', "\\": "\\", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v"
          };
          const replacement = replacements[escaped];
          if (replacement === undefined) return fail("Invalid KiCad netlist escape", { offset: this.#index - 1 });
          append(replacement);
        }
      } else {
        if ((codePoint < 0x20 && char !== "\t") || codePoint === 0x7f) {
          return fail("Control character in KiCad netlist string", { offset: this.#index - char.length });
        }
        append(char);
      }
    }
    return fail("Unterminated KiCad netlist string", { offset: start });
  }
}

const listHead = (value: PortableSExpressionV1): string | undefined => {
  if (value.kind !== "list") return undefined;
  const first = value.items[0];
  return first?.kind === "atom" ? first.value : undefined;
};

const namedNetlistField = (value: PortableSExpressionListV1): string | undefined => {
  const name = value.items.find((entry) => listHead(entry) === "name");
  if (name?.kind !== "list") return undefined;
  const nameValue = name.items[1];
  return nameValue?.kind === "string" ? nameValue.value : undefined;
};

const PUBLIC_DOCUMENTATION_URI = /^https?:\/\/(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::[0-9]+)?\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u;

const assertPortableNetlistStrings = (
  expressions: readonly PortableSExpressionV1[]
): void => {
  const visit = (
    value: PortableSExpressionV1,
    currentList: PortableSExpressionListV1 | undefined,
    index: number,
    parentList: PortableSExpressionListV1 | undefined
  ): void => {
    if (value.kind === "list") {
      value.items.forEach((entry, childIndex) => visit(entry, value, childIndex, currentList));
      return;
    }
    if (!PATH_OR_URI.test(value.value)) return;
    const currentHead = currentList === undefined ? undefined : listHead(currentList);
    const parentHead = parentList === undefined ? undefined : listHead(parentList);
    const allowedDocumentationUri =
      PUBLIC_DOCUMENTATION_URI.test(value.value) &&
      ((currentHead === "docs" && index === 1) ||
        (currentList !== undefined && currentHead === "field" && index === 2 && ["Source", "Datasheet"].includes(namedNetlistField(currentList) ?? "")) ||
        (parentList !== undefined && currentHead === "value" && index === 1 && parentHead === "property" && ["Source", "Datasheet"].includes(namedNetlistField(parentList) ?? "")));
    if (!allowedDocumentationUri) fail("Path, URI, UNC, or traversal leak in normalized netlist");
  };
  expressions.forEach((entry, index) => visit(entry, undefined, index, undefined));
};

const normalizeNetlistExpressions = (
  expressions: readonly PortableSExpressionV1[]
): {
  readonly expressions: readonly PortableSExpressionV1[];
  readonly ledger: readonly FieldDispositionLedgerEntryV2[];
} => {
  const exports = expressions.filter((entry) => listHead(entry) === "export");
  if (exports.length !== 1) fail("KiCad netlist requires exactly one export form");
  const exportList = exports[0]! as PortableSExpressionListV1;
  const designs = exportList.items.filter((entry) => listHead(entry) === "design");
  if (designs.length !== 1) fail("KiCad netlist requires exactly one direct design form");
  const design = designs[0]! as PortableSExpressionListV1;
  const sources = design.items.filter((entry) => listHead(entry) === "source");
  const dates = design.items.filter((entry) => listHead(entry) === "date");
  if (sources.length !== 1 || dates.length !== 1) fail("KiCad netlist direct design source/date cardinality mismatch");
  const source = sources[0]! as PortableSExpressionListV1;
  const date = dates[0]! as PortableSExpressionListV1;
  const sourceValue = source.items[1];
  const dateValue = date.items[1];
  if (source.items.length !== 2 || date.items.length !== 2 || sourceValue?.kind !== "string" || dateValue?.kind !== "string") {
    fail("KiCad netlist direct design source/date must be single strings");
  }
  if (sourceValue?.kind !== "string" || dateValue?.kind !== "string") return fail("Invalid KiCad source/date value");
  const rawSource = sourceValue.value;
  const rawDate = dateValue.value;
  const normalizedSource: PortableSExpressionListV1 = Object.freeze({
    kind: "list",
    items: Object.freeze([source.items[0]!, Object.freeze({ kind: "string", value: "<portable-source>" })])
  });
  const normalizedDate: PortableSExpressionListV1 = Object.freeze({
    kind: "list",
    items: Object.freeze([date.items[0]!, Object.freeze({ kind: "string", value: "<portable-date>" })])
  });
  const normalizedDesign: PortableSExpressionListV1 = Object.freeze({
    kind: "list",
    items: Object.freeze(
      design.items.map((entry) => (entry === source ? normalizedSource : entry === date ? normalizedDate : entry))
    )
  });
  const normalizedExport: PortableSExpressionListV1 = Object.freeze({
    kind: "list",
    items: Object.freeze(exportList.items.map((entry) => (entry === design ? normalizedDesign : entry)))
  });
  const normalizedExpressions = Object.freeze(expressions.map((entry) => (entry === exportList ? normalizedExport : entry)));
  return Object.freeze({
    expressions: normalizedExpressions,
    ledger: Object.freeze([
      ledgerEntry("/design/date", "evleda.portable.normalize-date.v1", 1, "<portable-date>"),
      ledgerEntry("/design/source", "evleda.portable.normalize-source.v1", 1, "<portable-source>")
    ])
  });
};

const normalizeKiCadNetlistSnapshot = (
  rawSnapshot: PortableRawByteSnapshot,
  bindings: PortableNormalizationBindingsV2
): PortableNormalizationResultV2 => {
  const parsed = new KiCadSExpressionParser(rawSnapshot).parse();
  const normalized = normalizeNetlistExpressions(parsed);
  assertPortableNetlistStrings(normalized.expressions);
  return assemble(
    "kicad_netlist",
    rawSnapshot,
    bindings,
    {
      schemaVersion: "evleda.portable-kicad-netlist.v2",
      reportKind: "kicad_netlist",
      expressions: normalized.expressions
    },
    normalized.ledger
  );
};

export const normalizeKiCadNetlist = (
  rawBytes: Uint8Array,
  bindings: PortableNormalizationBindingsV2
): PortableNormalizationResultV2 =>
  normalizeKiCadNetlistSnapshot(capturePortableRawBytes(rawBytes, 16_777_216, false), bindings);

const normalizeKiCadD356Snapshot = (
  rawSnapshot: PortableRawByteSnapshot,
  bindings: PortableNormalizationBindingsV2
): PortableNormalizationResultV2 => {
  const text = decodeUtf8(rawSnapshot, "IPC-D-356");
  if (/\r(?!\n)/u.test(text)) fail("IPC-D-356 contains a lone carriage return");
  let lineFeeds = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 0x0a && ++lineFeeds > 657) {
      fail("IPC-D-356 line budget exceeded before allocation");
    }
  }
  const normalizedLineEndings = text.replaceAll("\r\n", "\n");
  const withoutFinalNewline = normalizedLineEndings.endsWith("\n")
    ? normalizedLineEndings.slice(0, -1)
    : normalizedLineEndings;
  const lines = withoutFinalNewline.split("\n");
  if (lines.length !== 657 || lines.some((line) => line.length === 0 || line !== line.trimEnd() || Buffer.byteLength(line, "utf8") > 2_048)) {
    fail("IPC-D-356 contains an empty, trailing-space, or oversized line");
  }
  const headers = lines.slice(0, 3);
  if (lines.at(-1) !== "999" || lines.slice(3, -1).some((line) => line === "999" || line.startsWith("P "))) {
    fail("D356 Rev-A profile requires ordered headers and one final terminator");
  }
  const rawRecords = lines.slice(3, -1);
  const recordTypes = new Map<string, number>();
  const viaTypes = new Map<string, number>();
  const viaDrills = new Map<string, number>();
  const viaTails = new Set<string>();
  const viaBodies = new Set<string>();
  const rawViaPattern = /^((?:307|317)[A-Z0-9_+()/.\- ]{17}VIA {8}(MD[0-9]{4})PA[0-9]{2}X[+-][0-9]{6}Y[+-][0-9]{6}X[0-9]{4}Y[0-9]{4}R[0-9]{3})S([+-]?[0-9]{1,10})$/u;
  const normalizedRecords = rawRecords.map((line) => {
    const recordType = line.slice(0, 3);
    recordTypes.set(recordType, (recordTypes.get(recordType) ?? 0) + 1);
    const via = rawViaPattern.exec(line);
    if (via === null) {
      if (line.slice(20, 23) === "VIA" || line.length !== 73) fail("IPC-D-356 record violates the fixed-column grammar");
      return line;
    }
    viaTypes.set(recordType, (viaTypes.get(recordType) ?? 0) + 1);
    viaDrills.set(via[2]!, (viaDrills.get(via[2]!) ?? 0) + 1);
    viaTails.add(via[3]!);
    if (viaBodies.has(via[1]!)) fail("IPC-D-356 VIA endpoint/body coverage is not unique");
    viaBodies.add(via[1]!);
    return `${via[1]!}S+000000000`;
  });
  const exactCounts = (actual: ReadonlyMap<string, number>, expected: Readonly<Record<string, number>>): boolean =>
    actual.size === Object.keys(expected).length && Object.entries(expected).every(([key, count]) => actual.get(key) === count);
  if (
    rawRecords.length !== 653 ||
    !exactCounts(recordTypes, { "307": 11, "317": 331, "327": 305, "367": 6 }) ||
    !exactCounts(viaTypes, { "307": 11, "317": 262 }) ||
    !exactCounts(viaDrills, { MD0039: 11, MD0079: 7, MD0118: 255 }) ||
    viaTails.size !== 1 ||
    viaBodies.size !== 273
  ) fail("IPC-D-356 Rev-A record, VIA, drill, or shared-tail coverage mismatch");
  const sortedRecords = normalizedRecords.sort();
  sortedRecords.push("999");
  return assemble(
    "kicad_d356",
    rawSnapshot,
    bindings,
    {
      schemaVersion: "evleda.portable-kicad-d356-rev-a.v2",
      reportKind: "kicad_d356",
      headers: Object.freeze(headers),
      records: Object.freeze(sortedRecords)
    },
    [ledgerEntry(
      "/records/via-random-s-tail",
      "evleda.portable.normalize-d356-via-random-s-tail.v1",
      273,
      "<portable-via-s-tail>"
    )]
  );
};

export const normalizeKiCadD356 = (
  rawBytes: Uint8Array,
  bindings: PortableNormalizationBindingsV2
): PortableNormalizationResultV2 =>
  normalizeKiCadD356Snapshot(capturePortableRawBytes(rawBytes, 16_777_216, false), bindings);

export const normalizeKiCadPdfV2 = (rawBytes: Uint8Array): PortablePdfNotRunV2 => portablePdfNotRunV2(rawBytes);

export const validatePortableNormalizationResultV2 = (value: unknown): PortableNormalizationResultV2 => {
  const safe = record(hardenPortableValue(value), "$normalizationResult");
  exactRootKeys(safe, ["schemaVersion", "authority", "semantics", "rawBoundReceipt", "captureEnvelope", "releaseAuthorized"], "normalization result");
  if (safe.schemaVersion !== "evleda.portable-normalization-result.v2" || safe.authority !== "consistency-only" || safe.releaseAuthorized !== false) {
    fail("Unsupported or authority-escalating normalization result schema");
  }
  const semantics = validatePublicPortableSemanticsV2(safe.semantics, "$normalizationResult/semantics");
  const rawBoundReceipt = validateRawBoundPortableReceiptV2(safe.rawBoundReceipt, "$normalizationResult/rawBoundReceipt");
  const envelope = record(safe.captureEnvelope, "$normalizationResult/captureEnvelope");
  exactRootKeys(envelope, ["schemaVersion", "authority", "reportKind", "sourceBinding", "rawContentIdentity", "nativeContractIdentity", "normalizerContractIdentity", "normalizer", "commandPlan", "nativeOutcome", "releaseAuthorized", "captureIdentity"], "capture command envelope");
  if (envelope.schemaVersion !== "evleda.portable-capture-command-envelope.v1" || envelope.authority !== "consistency-only" || envelope.releaseAuthorized !== false) {
    fail("Unsupported capture command envelope");
  }
  const envelopePreimage = Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== "captureIdentity"));
  const captureIdentity = validateCanonicalIdentity(envelope.captureIdentity, "$normalizationResult/captureEnvelope/captureIdentity");
  const expectedCaptureIdentity = portableCanonicalIdentity(envelopePreimage, "evleda.portable-capture-command-envelope.v1");
  if (canonicalPortableJson(captureIdentity) !== canonicalPortableJson(expectedCaptureIdentity)) fail("Capture command envelope identity mismatch");
  const envelopeSource = validatePortableSourceBindingV1(envelope.sourceBinding, "$normalizationResult/captureEnvelope/sourceBinding");
  const envelopeNormalizer = validateToolContentIdentityV1(envelope.normalizer, "$normalizationResult/captureEnvelope/normalizer");
  const envelopeCommand = validateTypedCommandPlanV1(envelope.commandPlan, "$normalizationResult/captureEnvelope/commandPlan");
  const envelopeOutcome = validateNativeOutcome(envelope.nativeOutcome, semantics.reportKind);
  const envelopeRawIdentity = validateContentIdentity(envelope.rawContentIdentity, "$normalizationResult/captureEnvelope/rawContentIdentity");
  validateCommandMatrix(envelopeCommand, envelopeSource, semantics.reportKind);
  if (
    rawBoundReceipt.reportKind !== semantics.reportKind ||
    canonicalPortableJson(rawBoundReceipt.portableSemanticIdentity) !== canonicalPortableJson(semantics.semanticIdentity) ||
    canonicalPortableJson(rawBoundReceipt.portableDocumentIdentity) !== canonicalPortableJson(semantics.documentIdentity) ||
    canonicalPortableJson(rawBoundReceipt.commandPlanIdentity) !== canonicalPortableJson(semantics.commandPlanIdentity) ||
    canonicalPortableJson(rawBoundReceipt.normalizerContentIdentity) !== canonicalPortableJson(semantics.normalizer.contentIdentity) ||
    canonicalPortableJson(rawBoundReceipt.sourceBinding) !== canonicalPortableJson(semantics.sourceBinding) ||
    canonicalPortableJson(rawBoundReceipt.toolIdentity) !== canonicalPortableJson(semantics.tool) ||
    envelope.reportKind !== semantics.reportKind ||
    canonicalPortableJson(envelopeSource) !== canonicalPortableJson(semantics.sourceBinding) ||
    canonicalPortableJson(envelopeRawIdentity) !== canonicalPortableJson(rawBoundReceipt.rawContentIdentity) ||
    canonicalPortableJson(envelope.nativeContractIdentity) !== canonicalPortableJson(semantics.nativeContractIdentity) ||
    canonicalPortableJson(envelope.normalizerContractIdentity) !== canonicalPortableJson(semantics.normalizerContractIdentity) ||
    canonicalPortableJson(envelopeNormalizer) !== canonicalPortableJson(semantics.normalizer) ||
    canonicalPortableJson(envelopeCommand.tool) !== canonicalPortableJson(semantics.tool) ||
    canonicalPortableJson(envelopeCommand.commandPlanIdentity) !== canonicalPortableJson(semantics.commandPlanIdentity) ||
    canonicalPortableJson(envelopeOutcome.invocationIdentity) !== canonicalPortableJson((envelope.nativeOutcome as Readonly<Record<string, unknown>>).invocationIdentity) ||
    canonicalPortableJson(captureIdentity) !== canonicalPortableJson(rawBoundReceipt.captureIdentity)
  ) {
    fail("Normalization result public/raw receipt coherence mismatch");
  }
  return Object.freeze({
    schemaVersion: "evleda.portable-normalization-result.v2",
    authority: "consistency-only",
    semantics,
    rawBoundReceipt,
    captureEnvelope: Object.freeze({ ...(envelope as unknown as CaptureCommandEnvelopeV1) }),
    releaseAuthorized: false
  });
};

export const verifyPortableNormalizationCompoundV2 = (input: {
  readonly reportKind: PortableReportKind;
  readonly rawBytes: Uint8Array;
  readonly sourceBytes: Uint8Array;
  readonly bindings: PortableNormalizationBindingsV2;
  readonly expectedResult: unknown;
  readonly privateReceipt: unknown;
}): PortableCompoundVerificationV2 => {
  if (input === null || typeof input !== "object" || isProxy(input)) fail("Compound-verification input must be a non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const required = ["reportKind", "rawBytes", "sourceBytes", "bindings", "expectedResult", "privateReceipt"] as const;
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !required.includes(key as typeof required[number])) ||
      required.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!) || !descriptors[key]!.enumerable)) {
    fail("Compound-verification input fields must be exact enumerable data properties");
  }
  const rawSnapshot = capturePortableRawBytes(descriptors.rawBytes!.value as Uint8Array, 16_777_216, false);
  const sourceSnapshot = capturePortableRawBytes(descriptors.sourceBytes!.value as Uint8Array, 16_777_216, false);
  const reportKind = descriptors.reportKind!.value as PortableReportKind;
  if (!(["kicad_netlist", "kicad_erc", "kicad_drc", "kicad_stats", "kicad_d356"] as const).includes(reportKind)) {
    return fail("Unsupported compound-verification report kind");
  }
  const bindings = validateBindings(descriptors.bindings!.value as PortableNormalizationBindingsV2, reportKind);
  if (!identityEqual(bindings.sourceBinding.sourceArtifactIdentity, sourceSnapshot.identity)) {
    fail("Compound verification source bytes do not match the bound source artifact");
  }
  const actual = reportKind === "kicad_erc"
    ? normalizeJsonReport(reportKind, rawSnapshot, bindings)
    : reportKind === "kicad_drc"
      ? normalizeJsonReport(reportKind, rawSnapshot, bindings)
      : reportKind === "kicad_stats"
        ? normalizeJsonReport(reportKind, rawSnapshot, bindings)
        : reportKind === "kicad_netlist"
          ? normalizeKiCadNetlistSnapshot(rawSnapshot, bindings)
          : normalizeKiCadD356Snapshot(rawSnapshot, bindings);
  const expected = validatePortableNormalizationResultV2(descriptors.expectedResult!.value);
  if (canonicalPortableJson(actual) !== canonicalPortableJson(expected)) {
    fail("Compound verification normalized result does not exactly match replay");
  }
  const privateReceipt = validatePrivateRawCaptureReceiptV2(descriptors.privateReceipt!.value, "$compound/privateReceipt");
  if (
    privateReceipt.reportKind !== reportKind ||
    privateReceipt.outcome !== "succeeded" || privateReceipt.exitCode !== bindings.nativeOutcome.exitCode ||
    privateReceipt.publicSemanticIdentity === null ||
    canonicalPortableJson(privateReceipt.sourceBinding) !== canonicalPortableJson(bindings.sourceBinding) ||
    !identityEqual(privateReceipt.rawContentIdentity, rawSnapshot.identity) ||
    canonicalPortableJson(privateReceipt.nativeContractIdentity) !== canonicalPortableJson(bindings.nativeContractIdentity) ||
    canonicalPortableJson(privateReceipt.normalizerContractIdentity) !== canonicalPortableJson(bindings.normalizerContractIdentity) ||
    canonicalPortableJson(privateReceipt.toolIdentity) !== canonicalPortableJson(bindings.commandPlan.tool) ||
    canonicalPortableJson(privateReceipt.commandPlanIdentity) !== canonicalPortableJson(bindings.commandPlan.commandPlanIdentity) ||
    canonicalPortableJson(privateReceipt.invocationIdentity) !== canonicalPortableJson(bindings.nativeOutcome.invocationIdentity) ||
    canonicalPortableJson(privateReceipt.publicSemanticIdentity) !== canonicalPortableJson(actual.semantics.semanticIdentity) ||
    canonicalPortableJson(privateReceipt.privateRawPath) !== canonicalPortableJson(bindings.commandPlan.expectedOutputs[0])
  ) fail("Compound verification private receipt is not coherent with raw replay and public result");
  const draft = Object.freeze({
    schemaVersion: "evleda.portable-compound-verification.v2" as const,
    authority: "consistency-only" as const,
    hostAuthenticated: false as const,
    reportKind,
    result: actual,
    privateReceipt,
    consistent: true as const,
    releaseAuthorized: false as const
  });
  return Object.freeze({
    ...draft,
    verificationIdentity: portableCanonicalIdentity(draft, "evleda.portable-compound-verification.v2")
  });
};

const validatePdfNativeOutcome = (value: unknown): PortablePdfNativeOutcomeV1 => {
  const safe = record(hardenPortableValue(value), "$pdf/nativeOutcome");
  exactRootKeys(safe, ["schemaVersion", "invocationIdentity", "outcome", "exitCode", "accepted", "complete"], "PDF native outcome");
  if (safe.schemaVersion !== "evleda.pdf-native-command-outcome.v1") fail("Unsupported PDF native outcome schema");
  const outcome = ["succeeded", "failed", "timed_out", "not_run"].includes(safe.outcome as string)
    ? safe.outcome as PortablePdfNativeOutcomeV1["outcome"]
    : fail("Unsupported PDF native outcome");
  const exitCode = safe.exitCode === null ? null : boundedInteger(safe.exitCode, "PDF exit code");
  if (
    typeof safe.accepted !== "boolean" || typeof safe.complete !== "boolean" ||
    (outcome === "succeeded" && (exitCode !== 0 || safe.accepted !== true || safe.complete !== true)) ||
    (outcome === "failed" && (exitCode === null || exitCode === 0 || safe.accepted !== false || safe.complete !== true)) ||
    ((outcome === "timed_out" || outcome === "not_run") && (exitCode !== null || safe.accepted !== false || safe.complete !== false))
  ) fail("PDF outcome/exit/accepted/complete matrix mismatch");
  const invocationIdentity = validateCanonicalIdentity(safe.invocationIdentity, "$pdf/nativeOutcome/invocationIdentity");
  if (invocationIdentity.schemaVersion !== "evleda.tool-invocation.v1") fail("PDF invocation identity schema mismatch");
  return Object.freeze({
    schemaVersion: "evleda.pdf-native-command-outcome.v1", invocationIdentity, outcome, exitCode,
    accepted: safe.accepted as boolean, complete: safe.complete as boolean
  });
};

const validatePdfCommandMatrix = (commandPlan: TypedCommandPlanV1, sourceBinding: PortableSourceBindingV1): void => {
  if (commandPlan.tool.role !== "native_validator" || commandPlan.tool.kind !== "native_executable" || commandPlan.tool.name !== "kicad-cli" || commandPlan.logicalCwd.root !== "run_input") {
    fail("PDF command tool/name/kind/cwd matrix mismatch");
  }
  const signature = commandPlan.argv.map((entry, index) =>
    entry.kind === "literal" ? entry.value : index === commandPlan.argv.length - 2 ? "<output>" : "<source>"
  );
  if (canonicalPortableJson(signature) !== canonicalPortableJson(["sch", "export", "pdf", "--output", "<output>", "<source>"])) {
    fail("PDF native command argv matrix mismatch");
  }
  const outputArgument = commandPlan.argv.at(-2);
  const sourceArgument = commandPlan.argv.at(-1);
  const outputPath = outputArgument?.kind === "path" ? outputArgument.value : fail("PDF output path missing");
  const sourcePath = sourceArgument?.kind === "path" ? sourceArgument.value : fail("PDF source path missing");
  if (
    commandPlan.expectedOutputs.length !== 1 || outputPath.root !== "run_private" || sourcePath.root !== "run_input" ||
    canonicalPortableJson(outputPath) !== canonicalPortableJson(commandPlan.expectedOutputs[0]) ||
    !outputPath.relativePath.endsWith(".pdf") || !sourcePath.relativePath.endsWith(".kicad_sch") ||
    !sourceBinding.sourcePath.relativePath.endsWith(".kicad_sch") ||
    canonicalPortableJson(sourcePath) !== canonicalPortableJson(sourceBinding.sourcePath)
  ) fail("PDF source/output path matrix mismatch");
};

export const verifyPortablePdfCompoundV2 = (input: {
  readonly rawBytes: Uint8Array;
  readonly sourceBytes: Uint8Array;
  readonly sourceBinding: PortableSourceBindingV1;
  readonly nativeContractIdentity: CanonicalIdentity;
  readonly normalizerContractIdentity: CanonicalIdentity;
  readonly commandPlan: TypedCommandPlanV1;
  readonly nativeOutcome: PortablePdfNativeOutcomeV1;
  readonly expectedMarker: unknown;
  readonly privateReceipt: unknown;
}): PortablePdfCompoundVerificationV2 => {
  if (input === null || typeof input !== "object" || isProxy(input)) fail("PDF compound input must be a non-proxy object");
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const required = ["rawBytes", "sourceBytes", "sourceBinding", "nativeContractIdentity", "normalizerContractIdentity", "commandPlan", "nativeOutcome", "expectedMarker", "privateReceipt"] as const;
  if (Reflect.ownKeys(input).some((key) => typeof key !== "string" || !required.includes(key as typeof required[number])) ||
      required.some((key) => descriptors[key] === undefined || !("value" in descriptors[key]!) || !descriptors[key]!.enumerable)) {
    fail("PDF compound input fields must be exact enumerable data properties");
  }
  const rawSnapshot = capturePortableRawBytes(descriptors.rawBytes!.value as Uint8Array, 16_777_216, true);
  const sourceSnapshot = capturePortableRawBytes(descriptors.sourceBytes!.value as Uint8Array, 16_777_216, false);
  const sourceBinding = validatePortableSourceBindingV1(descriptors.sourceBinding!.value, "$pdf/sourceBinding");
  if (!identityEqual(sourceBinding.sourceArtifactIdentity, sourceSnapshot.identity)) fail("PDF source bytes do not match source binding");
  const nativeContractIdentity = validateCanonicalIdentity(descriptors.nativeContractIdentity!.value, "$pdf/nativeContractIdentity");
  const normalizerContractIdentity = validateCanonicalIdentity(descriptors.normalizerContractIdentity!.value, "$pdf/normalizerContractIdentity");
  if (nativeContractIdentity.schemaVersion !== "evleda.native-validation-contract.v1" || normalizerContractIdentity.schemaVersion !== "evleda.portable-normalizer-contract.v1") {
    fail("PDF contract identity schema mismatch");
  }
  const commandPlan = validateTypedCommandPlanV1(descriptors.commandPlan!.value, "$pdf/commandPlan");
  validatePdfCommandMatrix(commandPlan, sourceBinding);
  const nativeOutcome = validatePdfNativeOutcome(descriptors.nativeOutcome!.value);
  if (nativeOutcome.outcome === "succeeded") assertCapturedPortablePdfSignature(rawSnapshot);
  const marker = validatePortablePdfNotRunV2(descriptors.expectedMarker!.value);
  const replayedMarker = portablePdfNotRunV2(new Uint8Array());
  if (canonicalPortableJson(marker) !== canonicalPortableJson(replayedMarker)) fail("PDF marker does not match deterministic NOT_RUN projection");
  const privateReceipt = validatePrivateRawCaptureReceiptV2(descriptors.privateReceipt!.value, "$pdf/privateReceipt");
  if (
    privateReceipt.reportKind !== "kicad_pdf" || privateReceipt.publicSemanticIdentity !== null ||
    privateReceipt.outcome !== nativeOutcome.outcome || privateReceipt.exitCode !== nativeOutcome.exitCode ||
    !identityEqual(privateReceipt.rawContentIdentity, rawSnapshot.identity) ||
    canonicalPortableJson(privateReceipt.sourceBinding) !== canonicalPortableJson(sourceBinding) ||
    canonicalPortableJson(privateReceipt.nativeContractIdentity) !== canonicalPortableJson(nativeContractIdentity) ||
    canonicalPortableJson(privateReceipt.normalizerContractIdentity) !== canonicalPortableJson(normalizerContractIdentity) ||
    canonicalPortableJson(privateReceipt.toolIdentity) !== canonicalPortableJson(commandPlan.tool) ||
    canonicalPortableJson(privateReceipt.commandPlanIdentity) !== canonicalPortableJson(commandPlan.commandPlanIdentity) ||
    canonicalPortableJson(privateReceipt.invocationIdentity) !== canonicalPortableJson(nativeOutcome.invocationIdentity) ||
    canonicalPortableJson(privateReceipt.privateRawPath) !== canonicalPortableJson(commandPlan.expectedOutputs[0])
  ) fail("PDF private receipt does not match the raw/source/command/outcome compound");
  const draft = Object.freeze({
    schemaVersion: "evleda.portable-pdf-compound-verification.v2" as const,
    authority: "consistency-only" as const, hostAuthenticated: false as const, marker, privateReceipt, nativeOutcome,
    consistent: true as const, releaseAuthorized: false as const
  });
  return Object.freeze({ ...draft, verificationIdentity: portableCanonicalIdentity(draft, "evleda.portable-pdf-compound-verification.v2") });
};
