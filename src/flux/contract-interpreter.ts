import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import {
  capturePcbDesignInterpretationInput,
  interpretAndCompilePcbDesignIntent,
  parsePcbProviderProfileBinding,
  PCB_DESIGN_INTERPRETER_SCHEMA_VERSION,
  type PcbDesignInterpreterDependencies,
  type PcbDesignInterpreterOptions,
  type PcbProviderProfileBinding
} from "../harness/pcb-design-interpreter.js";
import {
  fluxDigest,
  FluxError,
  freeze,
  type FluxCompilationInterpretationResult,
  type FluxCompilationInterpreterPort,
  type FluxContractInterpretationInput,
  type FluxContractInterpretationPort,
  type FluxContractStateDto,
  type FluxInterpreterReceiptV2Dto
} from "./contracts.js";

const MAX_PROJECTION_BYTES = 512 * 1024;
const PATH_LIKE = /^(?:[A-Za-z]:[\\/]|\\\\|file:)/u;
const RECEIPT_SCHEMA_VERSION = "evleda.flux-interpreter-receipt.v2" as const;

const assertPathFree = (value: unknown, depth = 0, key = ""): void => {
  if (depth > 48) throw new FluxError("INVALID_ARGUMENT", "Compiled contract projection exceeds its depth bound");
  if (typeof value === "string") { const text = value.trim(); if (PATH_LIKE.test(text) || (text.startsWith("/") && !["id", "path", "clarificationId", "contractPath"].includes(key))) throw new FluxError("PATH_POLICY", "Compiled contract projection contains a filesystem location"); return; }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value)) { for (const entry of value) assertPathFree(entry, depth + 1, key); return; }
  if (typeof value === "object") { for (const [childKey, entry] of Object.entries(value as Record<string, unknown>)) { if (childKey === "projectPaths") throw new FluxError("PATH_POLICY", "Compiled contract projection contains a private path field"); assertPathFree(entry, depth + 1, childKey); } return; }
  throw new FluxError("INVALID_ARGUMENT", "Compiled contract projection is not plain JSON");
};

const sameCanonical = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

const checkedProviderProfile = (
  dependencies: PcbDesignInterpreterDependencies,
  value: PcbProviderProfileBinding
): PcbProviderProfileBinding => {
  let profile: PcbProviderProfileBinding;
  try {
    profile = parsePcbProviderProfileBinding(value);
  } catch {
    throw new FluxError("INVALID_ARGUMENT", "Flux provider profile binding is invalid");
  }
  if (profile.provider !== dependencies.provider.provider) {
    throw new FluxError("INVALID_ARGUMENT", "Flux provider profile does not match the configured interpreter adapter");
  }
  return profile;
};

const v2Receipt = (
  input: FluxContractInterpretationInput,
  providerProfile: PcbProviderProfileBinding,
  result: Awaited<ReturnType<typeof interpretAndCompilePcbDesignIntent>>,
  compiledAt: string
): FluxInterpreterReceiptV2Dto => {
  const bundle = result.bundle;
  const payload = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    interpreterSchemaVersion: PCB_DESIGN_INTERPRETER_SCHEMA_VERSION,
    provider: providerProfile.provider,
    providerProfile: structuredClone(providerProfile),
    providerProfileIdentity: { ...providerProfile.identity },
    promptDigest: fluxDigest(input.prompt),
    clarificationDigest: fluxDigest(input.clarificationAnswers),
    compilerProfileIdentity: bundle === null ? null : { ...bundle.compilerProfile.identity },
    practiceProfileBindingIdentity: bundle === null ? null : { ...bundle.practiceProfileBinding.identity },
    bundleIdentity: bundle === null ? null : { ...bundle.identity },
    compiledAt
  };
  return freeze({
    ...payload,
    identity: canonicalIdentity(payload, RECEIPT_SCHEMA_VERSION)
  });
};

const publicProjection = (
  dependencies: PcbDesignInterpreterDependencies,
  input: FluxContractInterpretationInput,
  result: Awaited<ReturnType<typeof interpretAndCompilePcbDesignIntent>>,
  providerProfile: PcbProviderProfileBinding | undefined
): FluxContractStateDto => {
  const bundle = result.bundle;
  if ((result.disposition === "ready") !== (bundle !== null)) {
    throw new FluxError("INVALID_ARGUMENT", "Interpreter returned an inconsistent ready compilation-bundle state");
  }
  if (bundle !== null && (
    bundle.executionPrompt.originalPrompt !== input.prompt ||
    result.contractIdentity === null || result.libraryBinding === null ||
    result.deepRuleBinding === null || result.acceptancePlan === null ||
    !sameCanonical(bundle.contract.identity, result.contractIdentity) ||
    !sameCanonical(bundle.libraryBinding.identity, result.libraryBinding.identity) ||
    !sameCanonical(bundle.deepRuleBinding.identity, result.deepRuleBinding.identity) ||
    !sameCanonical(bundle.acceptancePlan.identity, result.acceptancePlan.identity)
  )) {
    throw new FluxError("INVALID_ARGUMENT", "Interpreter bundle does not bind the exact public compilation");
  }

  const contract = result.contract === null
    ? null
    : structuredClone(result.contract) as Readonly<Record<string, unknown>>;
  const compiledAt = new Date().toISOString();
  const interpreterReceipt = providerProfile === undefined
    ? {
        schemaVersion: "evleda.flux-interpreter-receipt.v1" as const,
        interpreterSchemaVersion: PCB_DESIGN_INTERPRETER_SCHEMA_VERSION,
        provider: dependencies.provider.provider,
        promptDigest: fluxDigest(input.prompt),
        clarificationDigest: fluxDigest(input.clarificationAnswers),
        compiledAt
      }
    : v2Receipt(input, providerProfile, result, compiledAt);
  const projection: FluxContractStateDto = {
    disposition: result.disposition,
    questions: result.questions.map((entry) => ({ id: entry.id, path: entry.path, question: entry.question })),
    issues: result.issues.map((entry) => ({ code: entry.code, severity: entry.severity, path: entry.path, message: entry.message, clarificationId: entry.clarificationId })),
    contract,
    contractIdentity: result.contractIdentity === null ? null : { ...result.contractIdentity },
    libraryBindingIdentity: result.libraryBinding === null ? null : { ...result.libraryBinding.identity },
    deepRuleBindingIdentity: result.deepRuleBinding === null ? null : { ...result.deepRuleBinding.identity },
    acceptancePlanIdentity: result.acceptancePlan === null ? null : { ...result.acceptancePlan.identity },
    interpreterReceipt
  };
  assertPathFree(projection);
  if (Buffer.byteLength(JSON.stringify(projection), "utf8") > MAX_PROJECTION_BYTES) {
    throw new FluxError("INVALID_ARGUMENT", "Compiled contract projection exceeds its byte bound");
  }
  return freeze(projection);
};

const compile = async (
  dependencies: PcbDesignInterpreterDependencies,
  inputValue: Readonly<FluxContractInterpretationInput>,
  providerProfile: PcbProviderProfileBinding | undefined,
  interpreterOptions: PcbDesignInterpreterOptions
): Promise<FluxCompilationInterpretationResult> => {
  const input = capturePcbDesignInterpretationInput(inputValue);
  const result = await interpretAndCompilePcbDesignIntent(input, dependencies, interpreterOptions);
  const publicState = publicProjection(dependencies, input, result, providerProfile);
  return freeze({ publicState, bundle: result.bundle });
};

export function createPcbDesignInterpreterPort(
  dependencies: PcbDesignInterpreterDependencies,
  providerProfile: PcbProviderProfileBinding,
  interpreterOptions?: PcbDesignInterpreterOptions
): FluxContractInterpretationPort & FluxCompilationInterpreterPort;
export function createPcbDesignInterpreterPort(
  dependencies: PcbDesignInterpreterDependencies
): FluxContractInterpretationPort;
export function createPcbDesignInterpreterPort(
  dependencies: PcbDesignInterpreterDependencies,
  providerProfileValue?: PcbProviderProfileBinding,
  interpreterOptions: PcbDesignInterpreterOptions = {}
): FluxContractInterpretationPort | (FluxContractInterpretationPort & FluxCompilationInterpreterPort) {
  const providerProfile = providerProfileValue === undefined
    ? undefined
    : checkedProviderProfile(dependencies, providerProfileValue);
  const interpret = async (input: Readonly<FluxContractInterpretationInput>): Promise<FluxContractStateDto> =>
    (await compile(dependencies, input, providerProfile, interpreterOptions)).publicState;
  if (providerProfile === undefined) return { interpret };
  return {
    interpret,
    interpretCompilation: async (input) => await compile(dependencies, input, providerProfile, interpreterOptions)
  };
}
