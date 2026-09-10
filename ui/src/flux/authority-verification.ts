import type { FluxCanonicalIdentityDto, FluxRunDto } from "./model";
import { verifyFluxDeepRuleSummary } from "./deep-rule-summary";
import { parseFluxDesignContract } from "./design-contract-projection";

const exactKeys = (value: object, expected: readonly string[]): boolean => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const identityRecord = (value: unknown): value is FluxCanonicalIdentityDto => typeof value === "object" && value !== null && !Array.isArray(value) && exactKeys(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]);
const privateField = /(?:path|root|secret|token|credential|password|authorization|cookie|privatekey|rawprovidertext|html)$/iu;
const hasNoPrivateFields = (value: unknown, seen = new WeakSet<object>(), depth = 0): boolean => {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.every((entry) => hasNoPrivateFields(entry, seen, depth + 1));
    return Object.entries(value as Record<string, unknown>).every(([key, entry]) => !privateField.test(key.replaceAll(/[_-]/gu, "")) && hasNoPrivateFields(entry, seen, depth + 1));
  } finally { seen.delete(value); }
};

const canonical = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite identity value");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("non-plain identity value");
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map((key) => {
      if (item[key] === undefined) throw new Error("undefined identity value");
      return `${JSON.stringify(key)}:${canonical(item[key])}`;
    }).join(",")}}`;
  }
  throw new Error("unsupported identity value");
};

const digest = async (value: unknown): Promise<string> => {
  if (globalThis.crypto?.subtle === undefined) throw new Error("Web Crypto is unavailable");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((entry) => entry.toString(16).padStart(2, "0")).join("");
};

const identityMatches = async (payload: Readonly<Record<string, unknown>>, identity: FluxCanonicalIdentityDto): Promise<boolean> => identityRecord(identity) && identity.algorithm === "sha256" && identity.canonicalizationVersion === "evleda-c14n-json-v1" && typeof payload.schemaVersion === "string" && identity.schemaVersion === payload.schemaVersion && identity.digest === await digest(payload);

const payloadWithoutIdentity = (value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "identity"));

/** Independently authenticates the three complete canonical records available to the browser. */
export const verifyFluxPublicAuthority = async (run: FluxRunDto): Promise<boolean> => {
  try {
    if (run.workflowKind !== "generic" || run.contractState?.disposition !== "ready" || run.contractState.interpreterReceipt.schemaVersion !== "evleda.flux-interpreter-receipt.v2" || run.compilationBundleRef === undefined) return false;
    const receipt = run.contractState.interpreterReceipt;
    const contract = run.contractState.contract as Readonly<Record<string, unknown>> | null;
    const providerProfile = receipt.providerProfile as unknown as Readonly<Record<string, unknown>>;
    const reference = run.compilationBundleRef as unknown as Readonly<Record<string, unknown>>;
    const receiptRecord = receipt as unknown as Readonly<Record<string, unknown>>;
    if (contract === null || parseFluxDesignContract(contract) === undefined || !exactKeys(contract, ["schemaVersion", "kind", "scope", "components", "nets", "netClasses", "placementConstraints", "routingConstraints", "identity"]) || !hasNoPrivateFields(contract) || !identityRecord(contract.identity) || !identityRecord(run.contractState.contractIdentity) || canonical(contract.identity) !== canonical(run.contractState.contractIdentity)) return false;
    if (!exactKeys(providerProfile, ["schemaVersion", "provider", "model", "tier", "adapterSchemaVersion", "identity"]) || !exactKeys(reference, ["schemaVersion", "bundleIdentity", "contentIdentity", "identity"]) || !exactKeys(receiptRecord, ["schemaVersion", "interpreterSchemaVersion", "provider", "providerProfile", "providerProfileIdentity", "promptDigest", "clarificationDigest", "compilerProfileIdentity", "practiceProfileBindingIdentity", "bundleIdentity", "compiledAt", "identity"])) return false;
    if (!identityRecord(reference.bundleIdentity) || typeof reference.contentIdentity !== "object" || reference.contentIdentity === null || Array.isArray(reference.contentIdentity) || !exactKeys(reference.contentIdentity, ["algorithm", "digest", "size"])) return false;
    return (await verifyFluxDeepRuleSummary(run.contractState.deepRuleSummary, run.contractState.deepRuleBindingIdentity)) &&
      (await identityMatches(payloadWithoutIdentity(contract), contract.identity)) &&
      (await identityMatches(payloadWithoutIdentity(providerProfile), receipt.providerProfile.identity)) &&
      (await identityMatches(payloadWithoutIdentity(reference), run.compilationBundleRef.identity)) &&
      (await identityMatches(payloadWithoutIdentity(receiptRecord), receipt.identity));
  } catch { return false; }
};
