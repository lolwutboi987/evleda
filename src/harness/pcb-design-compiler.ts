import type { PcbExternalPowerFlagInspection } from "./pcb-external-power.js";
import type { KiCadStockSymbolInspection } from "./kicad-library-resolver.js";
import type { KiCadApprovedSymbolInspection } from "./kicad-approved-package.js";
import type { FreshSymbolTerminalGeometry } from "./fresh-kicad-parser.js";
import { canonicalIdentity } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import {
  capturePcbLibrarySourceSelection, assertPcbLibrarySourceSelectionStable, isPcbLibraryRecordAuthorized,
  type PcbLibrarySourceSelection, type PcbLibrarySourceSelectionRequest,
} from "./pcb-library-source-binding.js";
import type { DeepRuleCatalog } from "./deep-rule-catalog.js";
import {
  selectDeepRulesForDesign,
  type BoundedDeepRuleSelection,
  type DeepRuleDesignFeatures,
  type DeepRuleSelectionOptions
} from "./deep-rule-selector.js";
import {
  PCB_DESIGN_CONTRACT_LIMITS,
  PcbDesignContractError,
  PcbDesignJsonSnapshotError,
  closePcbDesignIntentDraft,
  encodePcbDesignPathToken,
  normalizePcbDesignUnresolvedPath,
  parsePcbDesignIntentDraft,
  snapshotPcbDesignJson,
  type PcbDesignContract,
  type PcbDesignIntentDraft
} from "./pcb-design-contract.js";
import { z } from "zod";

export const PCB_DESIGN_COMPILATION_SCHEMA_VERSION = "evleda.pcb-design-compilation.v1" as const;
export const PCB_LIBRARY_BINDING_SCHEMA_VERSION = "evleda.pcb-library-binding.v1" as const;
export const PCB_DEEP_RULE_BINDING_SCHEMA_VERSION = "evleda.pcb-deep-rule-binding.v1" as const;
export const PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION = "evleda.pcb-acceptance-plan.v1" as const;
export const PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION = "evleda.pcb-acceptance-plan.v2" as const;

/** Pre-schema limits keep hostile JSON-shaped values bounded before inspection. */
export const PCB_DESIGN_COMPILER_INPUT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 100_000,
  maxArrayLength: 1_024,
  maxObjectKeys: 1_024
});

export const PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS = Object.freeze({
  maxPinsOrPads: PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent,
  maxUnits: 128,
  maxPinFunctionChars: 192,
  maxRecordBytes: 48 * 1_024,
  maxRecordDepth: 4,
  maxRecordNodes: PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent * 4 + 16,
  maxRecordArrayLength: PCB_DESIGN_CONTRACT_LIMITS.maxPinsPerComponent,
  maxRecordObjectKeys: 6,
  maxBindingProjectionBytes: 64 * 1_024
});

/**
 * Hard bounds for every compiler disposition, including large but valid
 * batched-clarification results. The byte bound is authoritative when many
 * individually bounded questions/issues are present together.
 */
export const PCB_DESIGN_COMPILATION_LIMITS = Object.freeze({
  maxQuestions: 16_384,
  maxIssues: 32_768,
  maxPayloadBytes: 4 * 1024 * 1024
});

export type PcbDesignCompilationDisposition = "ready" | "needs_clarification" | "unsupported";

export type PcbUnsupportedV1Capability =
  | "differential_pairs"
  | "controlled_impedance"
  | "bga"
  | "multilayer"
  | "custom_libraries"
  | "multi_unit_symbols"
  | "back_side_placement"
  | "non_rectangular_board"
  | "multiple_schematic_sheets";

/**
 * Structured extraction output only. These flags are deliberately separate
 * from the raw prompt so capability decisions never depend on keyword scans.
 */
export interface PcbRequestedCapabilities {
  readonly differentialPairs?: boolean;
  readonly controlledImpedance?: boolean;
  readonly bga?: boolean;
  readonly multilayer?: boolean;
  readonly customLibraries?: boolean;
  readonly multiUnitSymbols?: boolean;
  readonly backSidePlacement?: boolean;
  readonly nonRectangularBoard?: boolean;
  readonly multipleSchematicSheets?: boolean;
}

export interface PcbClarification {
  /** Stable, semantic field path. It is also the clarification key. */
  readonly id: string;
  readonly path: string;
  readonly question: string;
}

export type PcbContractIssueCode =
  | "INVALID_DRAFT"
  | "UNRESOLVED_FIELD"
  | "UNKNOWN_LIBRARY_ID"
  | "INVALID_LIBRARY_RECORD"
  | "LIBRARY_PIN_PAD_MISMATCH"
  | "POLARITY_NOT_EXPLICIT"
  | "CONNECTOR_ORIENTATION_NOT_EXPLICIT"
  | "UNSUPPORTED_V1_FEATURE";

export interface PcbContractIssue {
  readonly code: PcbContractIssueCode;
  readonly severity: "error";
  readonly path: string;
  readonly message: string;
  readonly clarificationId: string | null;
}

export type PcbLibrarySource = "kicad-stock" | "project-custom";
export type PcbLibraryComponentKind = "generic" | "connector" | "gpio" | "bga";
export type PcbLibraryPackageKind = "generic" | "bga";

export interface PcbResolvedSymbolPin {
  readonly number: string;
  /** Library-defined electrical/function name; null means unavailable. */
  readonly function: string | null;
}

export interface PcbResolvedSymbol {
  readonly libraryId: string;
  readonly source: PcbLibrarySource;
  readonly unitCount: number;
  readonly componentKind: PcbLibraryComponentKind;
  readonly polarized: boolean;
  readonly pins: readonly PcbResolvedSymbolPin[];
}

export interface PcbResolvedFootprint {
  readonly libraryId: string;
  readonly source: PcbLibrarySource;
  readonly packageKind: PcbLibraryPackageKind;
  readonly pads: readonly string[];
}

/**
 * Read-only dependency boundary. Implementations may inspect configured local
 * KiCad libraries, but the compiler supplies no mutation or filesystem path.
 */
export interface PcbReadOnlyLibraryResolver {
  readonly resolveSymbol: (exactLibraryId: string) => PcbResolvedSymbol | null;
  readonly resolveFootprint: (exactLibraryId: string) => PcbResolvedFootprint | null;
  /** Optional host catalog capability; legacy exact-ID resolvers omit it. */
  /** Strict source-bound schematic power annotation capability; absent in legacy dependency objects. */
  readonly inspectExternalPowerFlag?: () => PcbExternalPowerFlagInspection | null;
  /** Full host-owned source inspection; reduced resolver pin metadata cannot authorize a driver. */
  readonly inspectSymbol?: (exactLibraryId: string) => KiCadStockSymbolInspection | KiCadApprovedSymbolInspection | null;
  readonly inspectSymbolTerminalGeometry?: (exactLibraryId: string) => FreshSymbolTerminalGeometry | null;
  readonly captureSourceSelection?: (selected: PcbLibrarySourceSelectionRequest) => PcbLibrarySourceSelection;
}

export interface PcbLibrarySymbolBinding {
  readonly reference: string;
  readonly libraryId: string;
  readonly source: PcbLibrarySource;
  readonly unitCount: 1;
  readonly componentKind: Exclude<PcbLibraryComponentKind, "bga">;
  readonly polarized: boolean;
  readonly pins: readonly PcbResolvedSymbolPin[];
}

export interface PcbLibraryFootprintBinding {
  readonly reference: string;
  readonly libraryId: string;
  readonly source: PcbLibrarySource;
  readonly packageKind: "generic";
  readonly pads: readonly string[];
}

export interface PcbLibraryBinding {
  readonly schemaVersion: typeof PCB_LIBRARY_BINDING_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly symbols: readonly PcbLibrarySymbolBinding[];
  readonly footprints: readonly PcbLibraryFootprintBinding[];
  readonly sourceSelection?: PcbLibrarySourceSelection;
  readonly identity: CanonicalIdentity;
}

export interface PcbDeepRuleBinding {
  readonly schemaVersion: typeof PCB_DEEP_RULE_BINDING_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly catalogIdentity: CanonicalIdentity;
  readonly features: DeepRuleDesignFeatures;
  readonly selection: BoundedDeepRuleSelection;
  readonly identity: CanonicalIdentity;
}

export type PcbAcceptanceRowKind =
  | "contract_integrity"
  | "library_symbol"
  | "library_footprint"
  | "schematic_component"
  | "pin_disposition"
  | "schematic_net"
  | "pcb_component"
  | "board_outline"
  | "placement"
  | "routed_net"
  | "netclass_width"
  | "netclass_clearance"
  | "route_turns"
  | "route_vias"
  | "erc"
  | "drc"
  | "visual_practice"
  | "schematic_render_clearance";

export interface PcbAcceptancePlanRow {
  readonly id: string;
  readonly kind: PcbAcceptanceRowKind;
  readonly mandatory: true;
  readonly contractPath: string;
  readonly description: string;
}

export interface PcbAcceptancePlan {
  readonly schemaVersion: typeof PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION | typeof PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION;
  readonly contractIdentity: CanonicalIdentity;
  readonly libraryBindingIdentity: CanonicalIdentity;
  readonly deepRuleBindingIdentity: CanonicalIdentity;
  readonly rows: readonly PcbAcceptancePlanRow[];
  readonly identity: CanonicalIdentity;
}

export interface PcbDesignCompilation {
  readonly schemaVersion: typeof PCB_DESIGN_COMPILATION_SCHEMA_VERSION;
  readonly disposition: PcbDesignCompilationDisposition;
  readonly questions: readonly PcbClarification[];
  readonly issues: readonly PcbContractIssue[];
  readonly contract: PcbDesignContract | null;
  readonly contractIdentity: CanonicalIdentity | null;
  readonly libraryBinding: PcbLibraryBinding | null;
  readonly deepRuleBinding: PcbDeepRuleBinding | null;
  readonly acceptancePlan: PcbAcceptancePlan | null;
}

export interface PcbDesignCompilerOptions {
  readonly libraryResolver: PcbReadOnlyLibraryResolver;
  readonly deepRuleCatalog: DeepRuleCatalog;
  readonly requestedCapabilities?: PcbRequestedCapabilities;
  readonly deepRuleSelectionOptions?: DeepRuleSelectionOptions;
}

interface MutableFindingSet {
  readonly questions: Map<string, Set<string>>;
  readonly issues: Map<string, PcbContractIssue>;
}

interface ResolvedLibraries {
  readonly symbols: PcbLibrarySymbolBinding[];
  readonly footprints: PcbLibraryFootprintBinding[];
  readonly sourceSelection?: PcbLibrarySourceSelection;
  readonly componentKinds: ReadonlyMap<string, Exclude<PcbLibraryComponentKind, "bga">>;
  readonly unsupported: Map<PcbUnsupportedV1Capability, Set<string>>;
}

const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const encodePathToken = encodePcbDesignPathToken;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (value: unknown, key: string): unknown =>
  isRecord(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;

const asArray = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];
const ownText = (value: unknown, key: string): string | null => {
  const candidate = own(value, key);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
};

type DeepReadonly<Value> = Value extends (...arguments_: never[]) => unknown
  ? Value
  : Value extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : Value extends object
      ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
      : Value;

const deepFreeze = <Value>(value: Value): DeepReadonly<Value> => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<Value>;
};

const clonePlain = <Value>(value: Value): Value => structuredClone(value);

type CompilerInputSnapshot =
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly message: string };

/** Unsupported-feature inspection is permitted only on this detached view. */
const snapshotUntrustedCompilerInput = (value: unknown): CompilerInputSnapshot => {
  try {
    const snapshot = snapshotPcbDesignJson(value, {
      maxBytes: PCB_DESIGN_CONTRACT_LIMITS.maxPayloadBytes,
      maxDepth: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxDepth,
      maxNodes: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxNodes,
      maxArrayLength: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxArrayLength,
      maxObjectKeys: PCB_DESIGN_COMPILER_INPUT_LIMITS.maxObjectKeys,
      rejectAliases: true
    });
    if (!isRecord(snapshot.value)) return { success: false, message: "PCB design input must be a plain JSON object" };
    return { success: true, value: snapshot.value };
  } catch (error) {
    if (error instanceof PcbDesignJsonSnapshotError) {
      if (error.failure === "bytes") {
        return {
          success: false,
          message: `PCB design payload exceeds its byte limit; limit is ${PCB_DESIGN_CONTRACT_LIMITS.maxPayloadBytes}`
        };
      }
      if (error.failure === "depth") {
        return { success: false, message: `PCB design input exceeds maximum depth ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxDepth}` };
      }
      if (error.failure === "array_length") {
        return { success: false, message: `PCB design input array exceeds ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxArrayLength} entries` };
      }
      if (error.failure === "nodes") {
        return { success: false, message: `PCB design input exceeds ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxNodes} JSON nodes` };
      }
      if (error.failure === "object_keys") {
        return { success: false, message: `PCB design input object exceeds ${PCB_DESIGN_COMPILER_INPUT_LIMITS.maxObjectKeys} keys` };
      }
    }
    return { success: false, message: "PCB design input could not be safely inspected as bounded JSON" };
  }
};

const createFindingSet = (): MutableFindingSet => ({ questions: new Map(), issues: new Map() });

const addQuestion = (findings: MutableFindingSet, path: string, question: string): void => {
  const questions = findings.questions.get(path) ?? new Set<string>();
  questions.add(question);
  findings.questions.set(path, questions);
};

const addIssue = (
  findings: MutableFindingSet,
  code: PcbContractIssueCode,
  path: string,
  message: string,
  clarification = false
): void => {
  const clarificationId = clarification ? path : null;
  const issue: PcbContractIssue = { code, severity: "error", path, message, clarificationId };
  const key = code === "UNRESOLVED_FIELD"
    ? `${path}\u0000${code}`
    : `${path}\u0000${code}\u0000${message}`;
  const previous = findings.issues.get(key);
  if (previous === undefined) {
    findings.issues.set(key, issue);
  } else if (previous.message !== message) {
    findings.issues.set(key, {
      ...previous,
      message: [...new Set([previous.message, message])].sort(compareText).join("\n")
    });
  }
};

const addClarification = (
  findings: MutableFindingSet,
  code: Exclude<PcbContractIssueCode, "UNSUPPORTED_V1_FEATURE">,
  path: string,
  question: string,
  message = question
): void => {
  addQuestion(findings, path, question);
  addIssue(findings, code, path, message, true);
};

const finalizedQuestions = (findings: MutableFindingSet): readonly PcbClarification[] =>
  [...findings.questions.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([path, questions]) => ({
      id: path,
      path,
      question: [...questions].sort(compareText).join("\n")
    }));

const finalizedIssues = (findings: MutableFindingSet): readonly PcbContractIssue[] =>
  [...findings.issues.values()].sort((left, right) =>
    compareText(left.path, right.path) || compareText(left.code, right.code) || compareText(left.message, right.message)
  );

const finish = (
  disposition: PcbDesignCompilationDisposition,
  findings: MutableFindingSet,
  ready?: {
    readonly contract: PcbDesignContract;
    readonly libraryBinding: PcbLibraryBinding;
    readonly deepRuleBinding: PcbDeepRuleBinding;
    readonly acceptancePlan: PcbAcceptancePlan;
  }
): PcbDesignCompilation => {
  const result: PcbDesignCompilation = {
    schemaVersion: PCB_DESIGN_COMPILATION_SCHEMA_VERSION,
    disposition,
    questions: finalizedQuestions(findings),
    issues: finalizedIssues(findings),
    contract: ready?.contract ?? null,
    contractIdentity: ready?.contract.identity ?? null,
    libraryBinding: ready?.libraryBinding ?? null,
    deepRuleBinding: ready?.deepRuleBinding ?? null,
    acceptancePlan: ready?.acceptancePlan ?? null
  };
  if (result.questions.length > PCB_DESIGN_COMPILATION_LIMITS.maxQuestions ||
      result.issues.length > PCB_DESIGN_COMPILATION_LIMITS.maxIssues ||
      Buffer.byteLength(JSON.stringify(result), "utf8") > PCB_DESIGN_COMPILATION_LIMITS.maxPayloadBytes) {
    const path = "$";
    const question = "Submit a bounded PCB design-intent draft whose validation diagnostics fit the compilation limits.";
    const fallback: PcbDesignCompilation = {
      schemaVersion: PCB_DESIGN_COMPILATION_SCHEMA_VERSION,
      disposition: "needs_clarification",
      questions: [{ id: path, path, question }],
      issues: [{
        code: "INVALID_DRAFT",
        severity: "error",
        path,
        message: "PCB design validation diagnostics exceeded their deterministic result limits.",
        clarificationId: path
      }],
      contract: null,
      contractIdentity: null,
      libraryBinding: null,
      deepRuleBinding: null,
      acceptancePlan: null
    };
    return deepFreeze(fallback) as PcbDesignCompilation;
  }
  return deepFreeze(result) as PcbDesignCompilation;
};

const semanticArrayEntry = (raw: unknown, collection: string, index: number): unknown => {
  if (collection === "components") return asArray(own(raw, "components"))[index];
  if (collection === "nets") return asArray(own(raw, "nets"))[index];
  if (collection === "netClasses") return asArray(own(raw, "netClasses"))[index];
  if (collection === "placementConstraints") return asArray(own(raw, "placementConstraints"))[index];
  if (collection === "routingNets") {
    return asArray(own(own(raw, "routingConstraints"), "nets"))[index];
  }
  return undefined;
};

const collectionKey = (raw: unknown, collection: string, index: number): string => {
  const entry = semanticArrayEntry(raw, collection, index);
  const keyName = collection === "components" || collection === "placementConstraints"
    ? "reference"
    : collection === "nets" || collection === "routingNets"
      ? collection === "nets" ? "name" : "net"
      : "id";
  const key = ownText(entry, keyName);
  return key === null
    ? `%FFFF${canonicalIdentity(entry, "evleda.invalid-semantic-path-entry.v1").digest}`
    : encodePathToken(key);
};

const stableZodPath = (raw: unknown, path: readonly PropertyKey[]): string => {
  if (path.length === 0) return "$";
  const output: string[] = [];
  let index = 0;
  while (index < path.length) {
    const segment = String(path[index]);
    const next = path[index + 1];
    if (segment === "components" && typeof next === "number") {
      output.push("component", collectionKey(raw, "components", next));
      index += 2;
      if (path[index] === "pins" && typeof path[index + 1] === "number") {
        const component = semanticArrayEntry(raw, "components", next);
        const pin = asArray(own(component, "pins"))[path[index + 1] as number];
        output.push("pin", encodePathToken(ownText(pin, "pin") ?? `index-${String(path[index + 1])}`));
        index += 2;
      }
      continue;
    }
    if (segment === "nets" && typeof next === "number") {
      const net = semanticArrayEntry(raw, "nets", next);
      output.push("net", collectionKey(raw, "nets", next));
      index += 2;
      if (path[index] === "endpoints" && typeof path[index + 1] === "number") {
        const endpoint = asArray(own(net, "endpoints"))[path[index + 1] as number];
        const endpointFallback = `%FFFF${canonicalIdentity(endpoint, "evleda.invalid-endpoint-path-entry.v1").digest}`;
        output.push(
          "endpoint",
          encodePathToken(ownText(endpoint, "reference") ?? endpointFallback),
          encodePathToken(ownText(endpoint, "pin") ?? endpointFallback)
        );
        index += 2;
      }
      continue;
    }
    if (segment === "netClasses" && typeof next === "number") {
      output.push("netClass", collectionKey(raw, "netClasses", next));
      index += 2;
      continue;
    }
    if (segment === "placementConstraints" && typeof next === "number") {
      output.push("placement", collectionKey(raw, "placementConstraints", next));
      index += 2;
      continue;
    }
    if (segment === "routingConstraints") {
      if (path[index + 1] === "nets" && typeof path[index + 2] === "number") {
        output.push("route", collectionKey(raw, "routingNets", path[index + 2] as number));
        index += 3;
        continue;
      }
      output.push("routing");
      index += 1;
      continue;
    }
    output.push(encodePathToken(segment));
    index += 1;
  }
  return output.join(".");
};

const capabilityLabel: Readonly<Record<PcbUnsupportedV1Capability, string>> = Object.freeze({
  differential_pairs: "differential-pair routing",
  controlled_impedance: "controlled impedance",
  bga: "BGA components or footprints",
  multilayer: "more than two copper layers",
  custom_libraries: "custom symbol or footprint libraries",
  multi_unit_symbols: "multi-unit symbols",
  back_side_placement: "back-side component placement",
  non_rectangular_board: "non-rectangular board outlines",
  multiple_schematic_sheets: "multiple schematic sheets"
});

const requestedCapabilityFlags: readonly [keyof PcbRequestedCapabilities, PcbUnsupportedV1Capability][] = Object.freeze([
  ["differentialPairs", "differential_pairs"],
  ["controlledImpedance", "controlled_impedance"],
  ["bga", "bga"],
  ["multilayer", "multilayer"],
  ["customLibraries", "custom_libraries"],
  ["multiUnitSymbols", "multi_unit_symbols"],
  ["backSidePlacement", "back_side_placement"],
  ["nonRectangularBoard", "non_rectangular_board"],
  ["multipleSchematicSheets", "multiple_schematic_sheets"]
]);

const addUnsupported = (
  unsupported: Map<PcbUnsupportedV1Capability, Set<string>>,
  capability: PcbUnsupportedV1Capability,
  path: string
): void => {
  const paths = unsupported.get(capability) ?? new Set<string>();
  paths.add(path);
  unsupported.set(capability, paths);
};

const detectStructuredUnsupported = (
  raw: unknown,
  requested: PcbRequestedCapabilities | undefined
): Map<PcbUnsupportedV1Capability, Set<string>> => {
  const unsupported = new Map<PcbUnsupportedV1Capability, Set<string>>();
  for (const [flag, capability] of requestedCapabilityFlags) {
    if (requested?.[flag] === true) addUnsupported(unsupported, capability, `requestedCapabilities.${String(flag)}`);
  }

  const scope = own(raw, "scope");
  const board = own(scope, "board");
  // These are exact proposed-field checks, not prompt or free-text scans. They
  // let a newer extractor fail closed when it submits a capability that the
  // strict v1 draft schema cannot represent.
  if (own(raw, "differentialPairs") !== undefined) {
    addUnsupported(unsupported, "differential_pairs", "differentialPairs");
  }
  if (own(raw, "controlledImpedance") !== undefined || own(raw, "impedanceProfile") !== undefined) {
    addUnsupported(unsupported, "controlled_impedance", "controlledImpedance");
  }
  if (own(raw, "customLibraries") !== undefined) {
    addUnsupported(unsupported, "custom_libraries", "customLibraries");
  }
  const sheetCount = own(scope, "sheetCount");
  if (typeof sheetCount === "number" && sheetCount !== 1) {
    addUnsupported(unsupported, "multiple_schematic_sheets", "scope.sheetCount");
  }
  const shape = own(board, "shape");
  if (typeof shape === "string" && shape !== "rectangle") {
    addUnsupported(unsupported, "non_rectangular_board", "scope.board.shape");
  }
  const layerCount = own(board, "layerCount");
  if (typeof layerCount === "number" && layerCount !== 2) {
    addUnsupported(unsupported, "multilayer", "scope.board.layerCount");
  }
  asArray(own(raw, "components")).forEach((component, componentIndex) => {
    const unit = own(component, "unit");
    const reference = collectionKey(raw, "components", componentIndex);
    if (typeof unit === "number" && unit !== 1) {
      addUnsupported(unsupported, "multi_unit_symbols", `component.${reference}.unit`);
    }
    if (own(component, "packageKind") === "bga") {
      addUnsupported(unsupported, "bga", `component.${reference}.packageKind`);
    }
    if (own(component, "libraryPath") !== undefined || own(component, "librarySource") === "custom") {
      addUnsupported(unsupported, "custom_libraries", `component.${reference}.librarySource`);
    }
  });
  asArray(own(raw, "nets")).forEach((net, netIndex) => {
    const name = collectionKey(raw, "nets", netIndex);
    if (own(net, "differentialPair") !== undefined || own(net, "differentialPairId") !== undefined) {
      addUnsupported(unsupported, "differential_pairs", `net.${name}.differentialPair`);
    }
    if (own(net, "targetImpedanceOhms") !== undefined || own(net, "controlledImpedance") !== undefined) {
      addUnsupported(unsupported, "controlled_impedance", `net.${name}.targetImpedanceOhms`);
    }
  });
  return unsupported;
};

const detectParsedDraftUnsupported = (
  draft: PcbDesignIntentDraft
): Map<PcbUnsupportedV1Capability, Set<string>> => {
  const unsupported = new Map<PcbUnsupportedV1Capability, Set<string>>();
  for (const placement of draft.placementConstraints) {
    if (placement.side === "back") {
      addUnsupported(
        unsupported,
        "back_side_placement",
        `placement.${encodePathToken(placement.reference)}.side`
      );
    }
  }
  return unsupported;
};

const unsupportedFindings = (
  findings: MutableFindingSet,
  unsupported: ReadonlyMap<PcbUnsupportedV1Capability, ReadonlySet<string>>
): void => {
  for (const capability of Object.keys(capabilityLabel).sort(compareText) as PcbUnsupportedV1Capability[]) {
    const paths = unsupported.get(capability);
    if (paths === undefined) continue;
    for (const path of [...paths].sort(compareText)) {
      addIssue(
        findings,
        "UNSUPPORTED_V1_FEATURE",
        path,
        `PCB design contract v1 does not support ${capabilityLabel[capability]}; no substitute was inferred.`
      );
    }
  }
};

const invalidDraftFindings = (raw: unknown, error: unknown, findings: MutableFindingSet): void => {
  if (error instanceof PcbDesignContractError && error.cause instanceof z.ZodError) {
    for (const entry of error.cause.issues) {
      const path = stableZodPath(raw, entry.path);
      const question = `Provide a valid value for ${path}: ${entry.message}`;
      addClarification(findings, "INVALID_DRAFT", path, question, entry.message);
    }
    return;
  }
  const message = error instanceof PcbDesignContractError ? error.message : "PCB design intent could not be parsed safely";
  addClarification(findings, "INVALID_DRAFT", "$", "Submit a bounded, valid PCB design-intent draft.", message);
};

const declaredStablePath = (draft: unknown, pointer: string): string | null => {
  try {
    const normalized = normalizePcbDesignUnresolvedPath(draft as PcbDesignIntentDraft, pointer);
    return normalized.success ? normalized.path : null;
  } catch {
    return null;
  }
};

const addElectricalClarifications = (
  findings: MutableFindingSet,
  netName: string,
  root: string
): void => {
  const electricalQuestions: readonly [string, string][] = [
    ["voltage.minimumV", `What is the minimum voltage on net ${netName}?`],
    ["voltage.nominalV", `What is the nominal voltage on net ${netName}?`],
    ["voltage.maximumV", `What is the maximum voltage on net ${netName}?`],
    ["current.nominalA", `What is the nominal current on net ${netName}?`],
    ["current.maximumContinuousA", `What is the maximum continuous current on net ${netName}?`],
    ["current.peakA", `What is the bounded peak current on net ${netName}, including zero when explicitly absent?`],
    ["current.peakDurationMs", `What duration applies to the bounded peak-current declaration on net ${netName}?`],
    ["speed", `Is net ${netName} explicitly DC, or what are its maximum frequency and minimum edge time?`]
  ];
  for (const [suffix, question] of electricalQuestions) {
    addClarification(findings, "UNRESOLVED_FIELD", `${root}.electrical.${suffix}`, question);
  }
};

const collectUnresolvedFacts = (draft: PcbDesignIntentDraft, findings: MutableFindingSet): void => {
  for (const unresolved of draft.unresolved) {
    const path = declaredStablePath(draft, unresolved.path);
    if (path !== null) addClarification(findings, "UNRESOLVED_FIELD", path, unresolved.question);
  }

  const board = draft.scope.board;
  if (board.widthMm === null) {
    addClarification(findings, "UNRESOLVED_FIELD", "scope.board.widthMm", "What is the required rectangular board width in millimetres?");
  }
  if (board.heightMm === null) {
    addClarification(findings, "UNRESOLVED_FIELD", "scope.board.heightMm", "What is the required rectangular board height in millimetres?");
  }

  for (const component of draft.components) {
    const root = `component.${encodePathToken(component.reference)}`;
    if (component.symbolLibId === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.symbolLibId`, `Which exact local KiCad symbol library ID should ${component.reference} use?`);
    }
    if (component.value === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.value`, `What exact value or part designation should ${component.reference} use?`);
    }
    if (component.footprintLibId === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.footprintLibId`, `Which exact local KiCad footprint library ID should ${component.reference} use?`);
    }
    for (const pin of component.pins) {
      if (pin.assignment.kind === "unresolved") {
        addClarification(findings, "UNRESOLVED_FIELD", `${root}.pin.${encodePathToken(pin.pin)}.assignment`, pin.assignment.question);
      }
    }
  }

  for (const net of draft.nets) {
    const root = `net.${encodePathToken(net.name)}`;
    if (net.role === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.role`, `What electrical role does net ${net.name} have?`);
    }
    if (net.endpoints.length < 2) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.endpoints`, `Which two or more exact component pins belong to net ${net.name}?`);
    }
    if (net.electrical === null) {
      addElectricalClarifications(findings, net.name, root);
    }
    if (net.netClassId === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.netClassId`, `Which declared net class applies to net ${net.name}?`);
    }
  }

  for (const netClass of draft.netClasses) {
    const root = `netClass.${encodePathToken(netClass.id)}`;
    if (netClass.traceWidthMm === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.traceWidthMm`, `What candidate trace width should class ${netClass.id} use in millimetres?`);
    }
    if (netClass.clearanceMm === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.clearanceMm`, `What copper clearance should class ${netClass.id} use in millimetres?`);
    }
    if (netClass.copperToEdgeMm === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.copperToEdgeMm`, `What copper-to-edge clearance should class ${netClass.id} use in millimetres?`);
    }
    if (netClass.allowedLayers === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.allowedLayers`, `Which of F.Cu and B.Cu may class ${netClass.id} use?`);
    }
  }

  const placements = new Map(draft.placementConstraints.map((entry) => [entry.reference, entry]));
  for (const component of draft.components) {
    const placement = placements.get(component.reference);
    const root = `placement.${encodePathToken(component.reference)}`;
    if (placement === undefined) {
      addClarification(findings, "UNRESOLVED_FIELD", root, `What placement region, side, orientation, and clearances apply to ${component.reference}?`);
      continue;
    }
    const fields: readonly [keyof typeof placement, string][] = [
      ["side", `Which PCB side should ${component.reference} occupy?`],
      ["regionMm", `What valid board region may contain ${component.reference}?`],
      ["allowedRotationsDeg", `Which explicit rotations are allowed for ${component.reference}?`],
      ["minimumEdgeClearanceMm", `What minimum board-edge clearance applies to ${component.reference}?`],
      ["minimumCourtyardClearanceMm", `What minimum courtyard clearance applies to ${component.reference}?`],
      ["edgePreference", `Does ${component.reference} require access from a specific board edge?`]
    ];
    for (const [field, question] of fields) {
      if (placement[field] === null) addClarification(findings, "UNRESOLVED_FIELD", `${root}.${field}`, question);
    }
  }

  const routing = draft.routingConstraints;
  const routingFields: readonly [keyof typeof routing, string][] = [
    ["cornerStyle", "Confirm mitered 45-degree routing as the required corner style."],
    ["maximumTurnAngleDeg", "What maximum direction change, no greater than 45 degrees, is allowed per routing segment?"],
    ["minimumStraightBeforeTurnMm", "What minimum straight length is required between route turns?"],
    ["allowRightAngleCorners", "Explicitly confirm that right-angle corners are forbidden."],
    ["allowAcuteInteriorCorners", "Explicitly confirm that acute interior copper corners are forbidden."],
    ["allowBacktracking", "Explicitly confirm that route backtracking is forbidden."],
    ["allowSelfIntersections", "Explicitly confirm that route self-intersections are forbidden."],
    ["viaPolicy", "Are vias forbidden, or what bounded via dimensions and total count apply?"]
  ];
  for (const [field, question] of routingFields) {
    if (routing[field] === null) addClarification(findings, "UNRESOLVED_FIELD", `routing.${field}`, question);
  }
  const routes = new Map(routing.nets.map((entry) => [entry.net, entry]));
  for (const net of draft.nets) {
    const route = routes.get(net.name);
    const root = `route.${encodePathToken(net.name)}`;
    if (route === undefined) {
      addClarification(findings, "UNRESOLVED_FIELD", root, `What topology, layer preference, via limit, and length policy apply to net ${net.name}?`);
      continue;
    }
    if (route.topology === "point_to_point" &&
        net.endpoints.length !== PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount) {
      addClarification(
        findings,
        "INVALID_DRAFT",
        `${root}.topology`,
        `Should ${net.name} use tree topology, or which exactly ${PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount} endpoints form its point-to-point route?`,
        `Point-to-point net ${net.name} must have exactly ${PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount} endpoints.`
      );
    }
    const fields: readonly [keyof typeof route, string][] = [
      ["topology", `Should net ${net.name} route point-to-point or as a tree?`],
      ["preferredLayer", `Which allowed copper layer is preferred for net ${net.name}?`],
      ["maxVias", `What is the maximum via count for net ${net.name}?`],
      ["routeLength", `Is net ${net.name} length unbounded, or what maximum length applies?`]
    ];
    for (const [field, question] of fields) {
      if (route[field] === null) addClarification(findings, "UNRESOLVED_FIELD", `${root}.${field}`, question);
    }
  }
};

/**
 * Preserve every recognizable unresolved fact when another strict-schema
 * error (for example an unknown root key) prevents the typed parse. Input is
 * already screened and snapshotted before this bounded walk.
 */
const collectKnownUnresolvedFactsFromScreenedRaw = (raw: unknown, findings: MutableFindingSet): void => {
  for (const unresolved of asArray(own(raw, "unresolved"))) {
    const path = ownText(unresolved, "path");
    const question = ownText(unresolved, "question");
    if (path !== null && question !== null) {
      const normalized = declaredStablePath(raw, path);
      if (normalized !== null) addClarification(findings, "UNRESOLVED_FIELD", normalized, question);
    }
  }

  const board = own(own(raw, "scope"), "board");
  if (own(board, "widthMm") === null) {
    addClarification(findings, "UNRESOLVED_FIELD", "scope.board.widthMm", "What is the required rectangular board width in millimetres?");
  }
  if (own(board, "heightMm") === null) {
    addClarification(findings, "UNRESOLVED_FIELD", "scope.board.heightMm", "What is the required rectangular board height in millimetres?");
  }

  const components = asArray(own(raw, "components"));
  for (const [componentIndex, component] of components.entries()) {
    const reference = ownText(component, "reference");
    if (reference === null) continue;
    const encodedReference = encodePathToken(reference);
    const root = `component.${encodedReference}`;
    if (own(component, "symbolLibId") === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.symbolLibId`, `Which exact local KiCad symbol library ID should ${reference} use?`);
    }
    if (own(component, "value") === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.value`, `What exact value or part designation should ${reference} use?`);
    }
    if (own(component, "footprintLibId") === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.footprintLibId`, `Which exact local KiCad footprint library ID should ${reference} use?`);
    }
    for (const [pinIndex, pin] of asArray(own(component, "pins")).entries()) {
      const number = ownText(pin, "pin") ?? `index-${pinIndex}`;
      const assignment = own(pin, "assignment");
      if (own(assignment, "kind") === "unresolved") {
        const question = ownText(assignment, "question") ?? `How should pin ${reference}.${number} be assigned?`;
        addClarification(findings, "UNRESOLVED_FIELD", `${root}.pin.${encodePathToken(number)}.assignment`, question);
      }
    }
    void componentIndex;
  }

  const nets = asArray(own(raw, "nets"));
  for (const net of nets) {
    const name = ownText(net, "name");
    if (name === null) continue;
    const root = `net.${encodePathToken(name)}`;
    if (own(net, "role") === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.role`, `What electrical role does net ${name} have?`);
    }
    const endpoints = own(net, "endpoints");
    if (Array.isArray(endpoints) && endpoints.length < 2) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.endpoints`, `Which two or more exact component pins belong to net ${name}?`);
    }
    if (own(net, "electrical") === null) addElectricalClarifications(findings, name, root);
    if (own(net, "netClassId") === null) {
      addClarification(findings, "UNRESOLVED_FIELD", `${root}.netClassId`, `Which declared net class applies to net ${name}?`);
    }
  }

  for (const netClass of asArray(own(raw, "netClasses"))) {
    const id = ownText(netClass, "id");
    if (id === null) continue;
    const root = `netClass.${encodePathToken(id)}`;
    const questions: readonly [string, string][] = [
      ["traceWidthMm", `What candidate trace width should class ${id} use in millimetres?`],
      ["clearanceMm", `What copper clearance should class ${id} use in millimetres?`],
      ["copperToEdgeMm", `What copper-to-edge clearance should class ${id} use in millimetres?`],
      ["allowedLayers", `Which of F.Cu and B.Cu may class ${id} use?`]
    ];
    for (const [field, question] of questions) {
      if (own(netClass, field) === null) addClarification(findings, "UNRESOLVED_FIELD", `${root}.${field}`, question);
    }
  }

  const placementsByReference = new Map<string, unknown[]>();
  for (const placement of asArray(own(raw, "placementConstraints"))) {
    const reference = ownText(placement, "reference");
    if (reference !== null) {
      const grouped = placementsByReference.get(reference) ?? [];
      grouped.push(placement);
      placementsByReference.set(reference, grouped);
    }
  }
  for (const component of components) {
    const reference = ownText(component, "reference");
    if (reference === null) continue;
    const root = `placement.${encodePathToken(reference)}`;
    const placements = placementsByReference.get(reference);
    if (placements === undefined) {
      addClarification(findings, "UNRESOLVED_FIELD", root, `What placement region, side, orientation, and clearances apply to ${reference}?`);
      continue;
    }
    const questions: readonly [string, string][] = [
      ["side", `Which PCB side should ${reference} occupy?`],
      ["regionMm", `What valid board region may contain ${reference}?`],
      ["allowedRotationsDeg", `Which explicit rotations are allowed for ${reference}?`],
      ["minimumEdgeClearanceMm", `What minimum board-edge clearance applies to ${reference}?`],
      ["minimumCourtyardClearanceMm", `What minimum courtyard clearance applies to ${reference}?`],
      ["edgePreference", `Does ${reference} require access from a specific board edge?`]
    ];
    for (const placement of placements) {
      for (const [field, question] of questions) {
        if (own(placement, field) === null) addClarification(findings, "UNRESOLVED_FIELD", `${root}.${field}`, question);
      }
    }
  }

  const routing = own(raw, "routingConstraints");
  const routingQuestions: readonly [string, string][] = [
    ["cornerStyle", "Confirm mitered 45-degree routing as the required corner style."],
    ["maximumTurnAngleDeg", "What maximum direction change, no greater than 45 degrees, is allowed per routing segment?"],
    ["minimumStraightBeforeTurnMm", "What minimum straight length is required between route turns?"],
    ["allowRightAngleCorners", "Explicitly confirm that right-angle corners are forbidden."],
    ["allowAcuteInteriorCorners", "Explicitly confirm that acute interior copper corners are forbidden."],
    ["allowBacktracking", "Explicitly confirm that route backtracking is forbidden."],
    ["allowSelfIntersections", "Explicitly confirm that route self-intersections are forbidden."],
    ["viaPolicy", "Are vias forbidden, or what bounded via dimensions and total count apply?"]
  ];
  for (const [field, question] of routingQuestions) {
    if (own(routing, field) === null) addClarification(findings, "UNRESOLVED_FIELD", `routing.${field}`, question);
  }
  const routesByNet = new Map<string, unknown[]>();
  for (const route of asArray(own(routing, "nets"))) {
    const name = ownText(route, "net");
    if (name !== null) {
      const grouped = routesByNet.get(name) ?? [];
      grouped.push(route);
      routesByNet.set(name, grouped);
    }
  }
  for (const net of nets) {
    const name = ownText(net, "name");
    if (name === null) continue;
    const root = `route.${encodePathToken(name)}`;
    const routes = routesByNet.get(name);
    if (routes === undefined) {
      addClarification(findings, "UNRESOLVED_FIELD", root, `What topology, layer preference, via limit, and length policy apply to net ${name}?`);
      continue;
    }
    const questions: readonly [string, string][] = [
      ["topology", `Should net ${name} route point-to-point or as a tree?`],
      ["preferredLayer", `Which allowed copper layer is preferred for net ${name}?`],
      ["maxVias", `What is the maximum via count for net ${name}?`],
      ["routeLength", `Is net ${name} length unbounded, or what maximum length applies?`]
    ];
    for (const route of routes) {
      if (own(route, "topology") === "point_to_point" && Array.isArray(own(net, "endpoints")) &&
          (own(net, "endpoints") as readonly unknown[]).length !== PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount) {
        addClarification(
          findings,
          "INVALID_DRAFT",
          `${root}.topology`,
          `Should ${name} use tree topology, or which exactly ${PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount} endpoints form its point-to-point route?`,
          `Point-to-point net ${name} must have exactly ${PCB_DESIGN_CONTRACT_LIMITS.pointToPointEndpointCount} endpoints.`
        );
      }
      for (const [field, question] of questions) {
        if (own(route, field) === null) addClarification(findings, "UNRESOLVED_FIELD", `${root}.${field}`, question);
      }
    }
  }
};

const validateText = (value: unknown, maximum = Number.POSITIVE_INFINITY): value is string =>
  typeof value === "string"
  && value.length > 0
  && value.length <= maximum
  && value.trim() === value
  && !/[\u0000-\u001f\u007f]/u.test(value);

const validateLibraryIdentifier = (value: unknown): value is string =>
  validateText(value, 192) && /^[^\s:]+:[^\s:]+$/u.test(value);

const validatePinOrPadIdentifier = (value: unknown): value is string =>
  validateText(value, 32) && /^[A-Za-z0-9][A-Za-z0-9.+/_-]{0,31}$/u.test(value);

const hasExactDataKeys = (value: unknown, expectedKeys: readonly string[]): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    return false;
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
};

const boundedCanonicalBytes = (value: unknown, maximum: number): boolean => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum;
  } catch {
    return false;
  }
};

type CapturedResolverRecord =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "value"; readonly value: unknown };

const captureResolverRecord = (value: unknown): CapturedResolverRecord => {
  if (value === null) return { kind: "missing" };
  try {
    return {
      kind: "value",
      value: snapshotPcbDesignJson(value, {
        maxBytes: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordBytes,
        maxDepth: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordDepth,
        maxNodes: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordNodes,
        maxArrayLength: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordArrayLength,
        maxObjectKeys: PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordObjectKeys,
        rejectAliases: true
      }).value
    };
  } catch {
    return { kind: "invalid" };
  }
};

const normalizeCapturedSymbol = (value: unknown, expectedId: string): PcbResolvedSymbol | null => {
  if (!hasExactDataKeys(value, ["libraryId", "source", "unitCount", "componentKind", "polarized", "pins"])) return null;
  if (!validateLibraryIdentifier(value.libraryId) || value.libraryId !== expectedId) return null;
  if (value.source !== "kicad-stock" && value.source !== "project-custom") return null;
  if (
    !Number.isInteger(value.unitCount)
    || (value.unitCount as number) < 1
    || (value.unitCount as number) > PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxUnits
  ) return null;
  if (!["generic", "connector", "gpio", "bga"].includes(String(value.componentKind))) return null;
  if (
    typeof value.polarized !== "boolean"
    || !Array.isArray(value.pins)
    || value.pins.length === 0
    || value.pins.length > PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads
  ) return null;
  const pins: PcbResolvedSymbolPin[] = [];
  for (const pin of value.pins) {
    if (!hasExactDataKeys(pin, ["number", "function"]) || !validatePinOrPadIdentifier(pin.number)) return null;
    if (pin.function !== null && !validateText(pin.function, PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinFunctionChars)) return null;
    pins.push({ number: pin.number, function: pin.function as string | null });
  }
  const normalized: PcbResolvedSymbol = {
    libraryId: value.libraryId,
    source: value.source,
    unitCount: value.unitCount as number,
    componentKind: value.componentKind as PcbLibraryComponentKind,
    polarized: value.polarized,
    pins: pins.sort((left, right) => compareText(left.number, right.number))
  };
  return boundedCanonicalBytes(normalized, PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordBytes) ? normalized : null;
};

const normalizeCapturedFootprint = (value: unknown, expectedId: string): PcbResolvedFootprint | null => {
  if (!hasExactDataKeys(value, ["libraryId", "source", "packageKind", "pads"])) return null;
  if (!validateLibraryIdentifier(value.libraryId) || value.libraryId !== expectedId) return null;
  if (value.source !== "kicad-stock" && value.source !== "project-custom") return null;
  if (value.packageKind !== "generic" && value.packageKind !== "bga") return null;
  if (
    !Array.isArray(value.pads)
    || value.pads.length === 0
    || value.pads.length > PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxPinsOrPads
    || !value.pads.every(validatePinOrPadIdentifier)
  ) return null;
  const normalized: PcbResolvedFootprint = {
    libraryId: value.libraryId,
    source: value.source,
    packageKind: value.packageKind,
    pads: [...value.pads].sort(compareText)
  };
  return boundedCanonicalBytes(normalized, PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxRecordBytes) ? normalized : null;
};

const normalizeSymbol = (value: unknown, expectedId: string): PcbResolvedSymbol | null => {
  const captured = captureResolverRecord(value);
  if (captured.kind !== "value") return null;
  try {
    return normalizeCapturedSymbol(captured.value, expectedId);
  } catch {
    return null;
  }
};

const normalizeFootprint = (value: unknown, expectedId: string): PcbResolvedFootprint | null => {
  const captured = captureResolverRecord(value);
  if (captured.kind !== "value") return null;
  try {
    return normalizeCapturedFootprint(captured.value, expectedId);
  } catch {
    return null;
  }
};

/** Reuse the compiler's exact resolver boundary when independently reproducing acceptance artifacts. */
export const normalizePcbResolvedSymbol = (
  value: PcbResolvedSymbol | null,
  expectedId: string,
): PcbResolvedSymbol | null => normalizeSymbol(value, expectedId);

/** Reuse the compiler's exact resolver boundary when independently reproducing acceptance artifacts. */
export const normalizePcbResolvedFootprint = (
  value: PcbResolvedFootprint | null,
  expectedId: string,
): PcbResolvedFootprint | null => normalizeFootprint(value, expectedId);

const equalUniqueSets = (left: readonly string[], right: readonly string[]): boolean =>
  new Set(left).size === left.length
  && new Set(right).size === right.length
  && left.length === right.length
  && [...left].sort(compareText).every((entry, index) => entry === [...right].sort(compareText)[index]);

const resolveLibraries = (
  draft: Pick<PcbDesignIntentDraft, "components" | "placementConstraints">,
  resolver: PcbReadOnlyLibraryResolver,
  findings: MutableFindingSet
): ResolvedLibraries => {
  const symbols: PcbLibrarySymbolBinding[] = [];
  const footprints: PcbLibraryFootprintBinding[] = [];
  const componentKinds = new Map<string, Exclude<PcbLibraryComponentKind, "bga">>();
  const unsupported = new Map<PcbUnsupportedV1Capability, Set<string>>();

  const selected = {
    symbolIds: [...new Set(draft.components.flatMap(component => component.symbolLibId === null ? [] : [component.symbolLibId]))],
    footprintIds: [...new Set(draft.components.flatMap(component => component.footprintLibId === null ? [] : [component.footprintLibId]))],
  };
  let sourceSelection: PcbLibrarySourceSelection | undefined;
  try { sourceSelection = capturePcbLibrarySourceSelection(resolver, selected); }
  catch {
    addClarification(findings, "INVALID_LIBRARY_RECORD", "libraryBinding", "The host catalog could not capture the exact selected library sources.");
    return { symbols, footprints, componentKinds, unsupported };
  }

  for (const component of draft.components) {
    if (component.symbolLibId === null || component.footprintLibId === null) continue;
    const encodedReference = encodePathToken(component.reference);
    const symbolPath = `component.${encodedReference}.symbolLibId`;
    const footprintPath = `component.${encodedReference}.footprintLibId`;
    let capturedSymbol: CapturedResolverRecord = { kind: "invalid" };
    let capturedFootprint: CapturedResolverRecord = { kind: "invalid" };
    let symbolResolverFailed = false;
    let footprintResolverFailed = false;
    try {
      capturedSymbol = captureResolverRecord(resolver.resolveSymbol(component.symbolLibId));
    } catch {
      symbolResolverFailed = true;
      addClarification(findings, "INVALID_LIBRARY_RECORD", symbolPath, `Recheck exact local symbol ID ${component.symbolLibId}; the read-only resolver could not inspect it.`);
    }
    let symbol: PcbResolvedSymbol | null = null;
    if (!symbolResolverFailed && capturedSymbol.kind === "value") {
      try {
        symbol = normalizeCapturedSymbol(capturedSymbol.value, component.symbolLibId);
      } catch {
        symbol = null;
      }
    }
    if (!symbolResolverFailed && capturedSymbol.kind === "missing") {
      addClarification(findings, "UNKNOWN_LIBRARY_ID", symbolPath, `Which exact existing local KiCad symbol ID should replace unavailable ${component.symbolLibId}?`);
    } else if (!symbolResolverFailed && (capturedSymbol.kind === "invalid" || symbol === null)) {
      addClarification(findings, "INVALID_LIBRARY_RECORD", symbolPath, `Recheck ${component.symbolLibId}; its resolved symbol record is invalid or does not reproduce the exact requested ID.`);
    }

    try {
      capturedFootprint = captureResolverRecord(resolver.resolveFootprint(component.footprintLibId));
    } catch {
      footprintResolverFailed = true;
      addClarification(findings, "INVALID_LIBRARY_RECORD", footprintPath, `Recheck exact local footprint ID ${component.footprintLibId}; the read-only resolver could not inspect it.`);
    }
    let footprint: PcbResolvedFootprint | null = null;
    if (!footprintResolverFailed && capturedFootprint.kind === "value") {
      try {
        footprint = normalizeCapturedFootprint(capturedFootprint.value, component.footprintLibId);
      } catch {
        footprint = null;
      }
    }
    if (!footprintResolverFailed && capturedFootprint.kind === "missing") {
      addClarification(findings, "UNKNOWN_LIBRARY_ID", footprintPath, `Which exact existing local KiCad footprint ID should replace unavailable ${component.footprintLibId}?`);
    } else if (!footprintResolverFailed && (capturedFootprint.kind === "invalid" || footprint === null)) {
      addClarification(findings, "INVALID_LIBRARY_RECORD", footprintPath, `Recheck ${component.footprintLibId}; its resolved footprint record is invalid or does not reproduce the exact requested ID.`);
    }
    if (symbol === null || footprint === null) continue;

    const symbolAuthorized = isPcbLibraryRecordAuthorized(resolver, "symbol", symbol, sourceSelection);
    const footprintAuthorized = isPcbLibraryRecordAuthorized(resolver, "footprint", footprint, sourceSelection);
    if (!symbolAuthorized) addUnsupported(unsupported, "custom_libraries", symbolPath);
    if (!footprintAuthorized) addUnsupported(unsupported, "custom_libraries", footprintPath);
    if (symbol.unitCount !== 1) addUnsupported(unsupported, "multi_unit_symbols", symbolPath);
    if (symbol.componentKind === "bga") addUnsupported(unsupported, "bga", symbolPath);
    if (footprint.packageKind === "bga") addUnsupported(unsupported, "bga", footprintPath);
    if (
      !symbolAuthorized
      || !footprintAuthorized
      || symbol.unitCount !== 1
      || symbol.componentKind === "bga"
      || footprint.packageKind === "bga"
    ) continue;

    const declaredPins = component.pins.map((pin) => pin.pin);
    const symbolPins = symbol.pins.map((pin) => pin.number);
    if (!equalUniqueSets(declaredPins, symbolPins)) {
      addClarification(
        findings,
        "LIBRARY_PIN_PAD_MISMATCH",
        `component.${encodedReference}.pins`,
        `Make ${component.reference}'s declared pins exactly match local symbol ${component.symbolLibId}.`
      );
    }
    if (!equalUniqueSets(symbolPins, footprint.pads)) {
      addClarification(
        findings,
        "LIBRARY_PIN_PAD_MISMATCH",
        `component.${encodedReference}.footprintLibId`,
        `Choose a footprint whose complete pad-number set exactly matches symbol ${component.symbolLibId}.`
      );
    }
    if (symbol.polarized && symbol.pins.some((pin) => pin.function === null)) {
      addClarification(
        findings,
        "POLARITY_NOT_EXPLICIT",
        `component.${encodedReference}.polarity`,
        `Select or verify a local symbol whose pins explicitly identify every polarized function for ${component.reference}.`
      );
    }

    if (symbol.componentKind === "connector") {
      const placement = draft.placementConstraints.find((entry) => entry.reference === component.reference);
      if (placement !== undefined && placement.edgePreference === "none") {
        addClarification(
          findings,
          "CONNECTOR_ORIENTATION_NOT_EXPLICIT",
          `placement.${encodedReference}.edgePreference`,
          `Which board edge must provide physical access to connector ${component.reference}?`
        );
      }
      if (placement?.allowedRotationsDeg !== null && placement?.allowedRotationsDeg !== undefined && placement.allowedRotationsDeg.length !== 1) {
        addClarification(
          findings,
          "CONNECTOR_ORIENTATION_NOT_EXPLICIT",
          `placement.${encodedReference}.allowedRotationsDeg`,
          `Choose one exact orientation for connector ${component.reference}; multiple allowed rotations are ambiguous.`
        );
      }
    }

    componentKinds.set(component.reference, symbol.componentKind);
    const symbolBinding: PcbLibrarySymbolBinding = {
      reference: component.reference,
      libraryId: symbol.libraryId,
      source: symbol.source,
      unitCount: 1,
      componentKind: symbol.componentKind,
      polarized: symbol.polarized,
      pins: symbol.pins.map((pin) => ({ ...pin }))
    };
    const footprintBinding: PcbLibraryFootprintBinding = {
      reference: component.reference,
      libraryId: footprint.libraryId,
      source: footprint.source,
      packageKind: "generic",
      pads: [...footprint.pads]
    };
    symbols.push(symbolBinding);
    footprints.push(footprintBinding);
  }

  symbols.sort((left, right) => compareText(left.reference, right.reference));
  footprints.sort((left, right) => compareText(left.reference, right.reference));
  const projectionBytes = Buffer.byteLength(JSON.stringify({ footprints, symbols }), "utf8");
  if (projectionBytes > PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxBindingProjectionBytes) {
    addClarification(
      findings,
      "INVALID_LIBRARY_RECORD",
      "libraryBinding",
      `Use a bounded exact local library projection no larger than ${PCB_LIBRARY_RESOLVER_OUTPUT_LIMITS.maxBindingProjectionBytes} bytes; received ${projectionBytes} bytes.`
    );
  }
  try { assertPcbLibrarySourceSelectionStable(sourceSelection, capturePcbLibrarySourceSelection(resolver, selected)); }
  catch {
    addClarification(findings, "INVALID_LIBRARY_RECORD", "libraryBinding", "The exact selected library sources or host catalog policy changed during library resolution.");
  }
  return { symbols, footprints, componentKinds, unsupported, ...(sourceSelection === undefined ? {} : { sourceSelection }) };
};

/** Library validation shared with new contract families, without minting a V1 contract or plan. */
export const resolvePcbDesignCommonLibraries = (
  draft: Pick<PcbDesignIntentDraft, "components" | "placementConstraints">,
  resolver: PcbReadOnlyLibraryResolver,
): Readonly<{
  disposition: PcbDesignCompilationDisposition;
  questions: readonly PcbClarification[];
  issues: readonly PcbContractIssue[];
  symbols: readonly PcbLibrarySymbolBinding[];
  footprints: readonly PcbLibraryFootprintBinding[];
  sourceSelection?: PcbLibrarySourceSelection;
}> => {
  const findings = createFindingSet();
  const resolved = resolveLibraries(draft, resolver, findings);
  if (resolved.unsupported.size > 0) unsupportedFindings(findings, resolved.unsupported);
  const disposition = resolved.unsupported.size > 0 ? "unsupported"
    : findings.questions.size > 0 || findings.issues.size > 0 ? "needs_clarification" : "ready";
  const diagnostics = finish(disposition, findings);
  return deepFreeze({ disposition, questions: diagnostics.questions, issues: diagnostics.issues,
    symbols: resolved.symbols, footprints: resolved.footprints,
    ...(resolved.sourceSelection === undefined ? {} : { sourceSelection: resolved.sourceSelection }) });
};

const makeLibraryBinding = (
  contract: PcbDesignContract,
  resolved: ResolvedLibraries
): PcbLibraryBinding => {
  const payload = {
    schemaVersion: PCB_LIBRARY_BINDING_SCHEMA_VERSION,
    contractIdentity: clonePlain(contract.identity),
    symbols: clonePlain(resolved.symbols),
    footprints: clonePlain(resolved.footprints),
    ...(resolved.sourceSelection === undefined ? {} : { sourceSelection: clonePlain(resolved.sourceSelection) })
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, PCB_LIBRARY_BINDING_SCHEMA_VERSION)
  }) as PcbLibraryBinding;
};

/** Derive guidance features only from the closed contract and local bindings. */
export const deriveDeepRuleFeaturesFromContract = (
  contract: Pick<PcbDesignContract, "nets">,
  libraryBinding: PcbLibraryBinding
): DeepRuleDesignFeatures => {
  const features: DeepRuleDesignFeatures = {
    placement: true,
    dfm: true,
    assembly: true
  };
  if (contract.nets.some((net) =>
    net.role === "ground" || net.role === "power" || net.role === "power_input" || net.role === "power_output"
  )) {
    (features as { powerCurrent?: true }).powerCurrent = true;
  }
  if (contract.nets.some((net) => net.electrical.speed.kind === "signal")) {
    (features as { signalSpeedInterfaces?: true }).signalSpeedInterfaces = true;
  }
  if (libraryBinding.symbols.some((symbol) => symbol.componentKind === "gpio")) {
    (features as { gpio?: true }).gpio = true;
  }
  return deepFreeze(features) as DeepRuleDesignFeatures;
};

const makeDeepRuleBinding = (
  contract: PcbDesignContract,
  libraryBinding: PcbLibraryBinding,
  catalog: DeepRuleCatalog,
  selectionOptions: DeepRuleSelectionOptions | undefined
): PcbDeepRuleBinding => {
  const features = deriveDeepRuleFeaturesFromContract(contract, libraryBinding);
  const selection = selectDeepRulesForDesign(catalog, features, selectionOptions);
  if (selection.disposition !== "ready-for-prompt") {
    throw new Error("Deep-rule selection is incomplete and cannot be bound to a ready PCB design contract");
  }
  const catalogIdentity = canonicalIdentity(catalog, "evleda.deep-rule-catalog.v1");
  const payload = {
    schemaVersion: PCB_DEEP_RULE_BINDING_SCHEMA_VERSION,
    contractIdentity: clonePlain(contract.identity),
    catalogIdentity,
    features: clonePlain(features),
    selection: clonePlain(selection)
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, PCB_DEEP_RULE_BINDING_SCHEMA_VERSION)
  }) as PcbDeepRuleBinding;
};

const row = (
  id: string,
  kind: PcbAcceptanceRowKind,
  contractPath: string,
  description: string
): PcbAcceptancePlanRow => ({ id, kind, mandatory: true, contractPath, description });

/** Host-only plan generation. No draft/model field is accepted as a row. */
export const createPcbAcceptancePlanV1 = (
  contract: PcbDesignContract,
  libraryBinding: PcbLibraryBinding,
  deepRuleBinding: PcbDeepRuleBinding
): PcbAcceptancePlan => {
  const rows: PcbAcceptancePlanRow[] = [
    row("contract:integrity", "contract_integrity", "$", "Reproduce and verify the exact closed contract identity.")
  ];
  for (const component of contract.components) {
    const encodedReference = encodePathToken(component.reference);
    rows.push(row(`library:${encodedReference}:symbol`, "library_symbol", `component.${encodedReference}.symbolLibId`, `Verify the bound local symbol for ${component.reference}.`));
    rows.push(row(`library:${encodedReference}:footprint`, "library_footprint", `component.${encodedReference}.footprintLibId`, `Verify the bound local footprint for ${component.reference}.`));
    rows.push(row(`component:${encodedReference}:schematic`, "schematic_component", `component.${encodedReference}`, `Verify ${component.reference} exists exactly once in the schematic.`));
    for (const pin of component.pins) {
      const encodedPin = encodePathToken(pin.pin);
      rows.push(row(`pin:${encodedReference}:${encodedPin}:disposition`, "pin_disposition", `component.${encodedReference}.pin.${encodedPin}.assignment`, `Verify the exact net or explicit no-connect disposition for ${component.reference}.${pin.pin}.`));
    }
  }
  for (const net of contract.nets) {
    const encodedName = encodePathToken(net.name);
    rows.push(row(`net:${encodedName}:schematic`, "schematic_net", `net.${encodedName}`, `Verify exact endpoint symmetry for schematic net ${net.name}.`));
  }
  for (const component of contract.components) {
    const encodedReference = encodePathToken(component.reference);
    rows.push(row(`component:${encodedReference}:pcb`, "pcb_component", `component.${encodedReference}.footprintLibId`, `Verify ${component.reference}'s exact footprint is present on the PCB.`));
  }
  rows.push(row("board:outline", "board_outline", "scope.board", "Verify one closed rectangular outline with the exact contract dimensions."));
  for (const placement of contract.placementConstraints) {
    const encodedReference = encodePathToken(placement.reference);
    rows.push(row(`placement:${encodedReference}`, "placement", `placement.${encodedReference}`, `Verify ${placement.reference} satisfies side, region, edge, rotation, and clearance constraints.`));
  }
  for (const net of contract.nets) {
    const encodedName = encodePathToken(net.name);
    rows.push(row(`net:${encodedName}:routed`, "routed_net", `net.${encodedName}`, `Verify every endpoint on ${net.name} is physically connected without unintended endpoints.`));
  }
  for (const netClass of contract.netClasses) {
    const encodedId = encodePathToken(netClass.id);
    rows.push(row(`netclass:${encodedId}:width`, "netclass_width", `netClass.${encodedId}.traceWidthMm`, `Verify class ${netClass.id} uses its recorded candidate trace width; this is not ampacity proof.`));
    rows.push(row(
      `netclass:${encodedId}:clearance`,
      "netclass_clearance",
      `netClass.${encodedId}.clearanceMm`,
      `Verify class ${netClass.id} has an effective configured clearance of at least ${netClass.clearanceMm} mm; a clean DRC result alone does not prove this contract value.`
    ));
  }
  for (const route of contract.routingConstraints.nets) {
    const encodedName = encodePathToken(route.net);
    rows.push(row(`route:${encodedName}:turns`, "route_turns", `route.${encodedName}`, `Verify mitered turns, no right angles, no acute interiors, no backtracking, no self-intersections, and no hairpins on ${route.net}.`));
    rows.push(row(`route:${encodedName}:vias`, "route_vias", `route.${encodedName}.maxVias`, `Verify ${route.net} stays within its per-net and global via bounds and allowed layers.`));
  }
  rows.push(row("erc", "erc", "$", "Run native KiCad ERC and require an independent passing result."));
  rows.push(row("drc", "drc", "$", "Run native KiCad DRC and require an independent passing result."));
  rows.push(row("visual-practice", "visual_practice", "$", "Inspect schematic and PCB renders for legibility, routing quality, orientation, and visible practice defects."));

  const rowIds = new Set<string>();
  for (const entry of rows) {
    if (rowIds.has(entry.id)) throw new Error(`Compiler generated duplicate acceptance row ${entry.id}`);
    rowIds.add(entry.id);
  }
  const payload = {
    schemaVersion: PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION,
    contractIdentity: clonePlain(contract.identity),
    libraryBindingIdentity: clonePlain(libraryBinding.identity),
    deepRuleBindingIdentity: clonePlain(deepRuleBinding.identity),
    rows
  };
  return deepFreeze({
    ...payload,
    identity: canonicalIdentity(payload, PCB_ACCEPTANCE_PLAN_LEGACY_SCHEMA_VERSION)
  }) as PcbAcceptancePlan;
};

/** Current host-only acceptance adds native visible-ink clearance without changing V1 history. */
export const createPcbAcceptancePlan = (
  contract: PcbDesignContract,
  libraryBinding: PcbLibraryBinding,
  deepRuleBinding: PcbDeepRuleBinding,
): PcbAcceptancePlan => {
  const { identity: _legacyIdentity, ...legacy } = createPcbAcceptancePlanV1(contract, libraryBinding, deepRuleBinding);
  const payload = { ...legacy, schemaVersion: PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION, rows: [...legacy.rows,
    row("schematic-render-clearance", "schematic_render_clearance", "$", "Verify source-bound native schematic visible-text ink clearance; this does not establish compactness or professional layout quality.") ] };
  return deepFreeze({ ...payload, identity: canonicalIdentity(payload, PCB_ACCEPTANCE_PLAN_SCHEMA_VERSION) }) as PcbAcceptancePlan;
};

/**
 * Compile an untrusted, unresolved draft into a deterministic host artifact.
 * This function has no KiCad mutation surface and performs no provider call.
 */
function compilePcbDesignIntentDraftForPlan(
  value: unknown,
  options: PcbDesignCompilerOptions,
  acceptancePlanFactory: typeof createPcbAcceptancePlan,
): PcbDesignCompilation {
  const findings = createFindingSet();
  const captured = snapshotUntrustedCompilerInput(value);
  if (!captured.success) {
    addClarification(
      findings,
      "INVALID_DRAFT",
      "$",
      "Submit a bounded, plain, acyclic JSON PCB design-intent draft.",
      captured.message
    );
    return finish("needs_clarification", findings);
  }
  const inputSnapshot = captured.value;
  const structuredUnsupported = detectStructuredUnsupported(inputSnapshot, options.requestedCapabilities);
  if (structuredUnsupported.size > 0) {
    unsupportedFindings(findings, structuredUnsupported);
    return finish("unsupported", findings);
  }

  let draft: PcbDesignIntentDraft;
  try {
    draft = parsePcbDesignIntentDraft(inputSnapshot);
  } catch (error) {
    collectKnownUnresolvedFactsFromScreenedRaw(inputSnapshot, findings);
    invalidDraftFindings(inputSnapshot, error, findings);
    return finish("needs_clarification", findings);
  }

  const parsedUnsupported = detectParsedDraftUnsupported(draft);
  if (parsedUnsupported.size > 0) {
    unsupportedFindings(findings, parsedUnsupported);
    return finish("unsupported", findings);
  }

  collectUnresolvedFacts(draft, findings);
  const resolved = resolveLibraries(draft, options.libraryResolver, findings);
  if (resolved.unsupported.size > 0) {
    unsupportedFindings(findings, resolved.unsupported);
    return finish("unsupported", findings);
  }
  if (findings.questions.size > 0 || findings.issues.size > 0) {
    return finish("needs_clarification", findings);
  }

  let contract: PcbDesignContract;
  try {
    contract = closePcbDesignIntentDraft(draft);
  } catch (error) {
    invalidDraftFindings(draft, error, findings);
    return finish("needs_clarification", findings);
  }
  if (resolved.symbols.length !== contract.components.length || resolved.footprints.length !== contract.components.length) {
    addClarification(findings, "INVALID_LIBRARY_RECORD", "libraryBinding", "Resolve every component to one exact local symbol and footprint before continuing.");
    return finish("needs_clarification", findings);
  }

  const libraryBinding = makeLibraryBinding(contract, resolved);
  const deepRuleBinding = makeDeepRuleBinding(
    contract,
    libraryBinding,
    options.deepRuleCatalog,
    options.deepRuleSelectionOptions
  );
  const acceptancePlan = acceptancePlanFactory(contract, libraryBinding, deepRuleBinding);
  return finish("ready", findings, { contract, libraryBinding, deepRuleBinding, acceptancePlan });
}

/** Concise alias for callers that already name their input as a draft. */
export const compilePcbDesignIntentDraft = (value: unknown, options: PcbDesignCompilerOptions): PcbDesignCompilation =>
  compilePcbDesignIntentDraftForPlan(value, options, createPcbAcceptancePlan);
/** Historical regeneration only. Current execution admission requires the current compiler profile. */
export const compilePcbDesignIntentDraftV1 = (value: unknown, options: PcbDesignCompilerOptions): PcbDesignCompilation =>
  compilePcbDesignIntentDraftForPlan(value, options, createPcbAcceptancePlanV1);
export const compilePcbDesignIntent = compilePcbDesignIntentDraft;
