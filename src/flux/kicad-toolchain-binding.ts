import path from "node:path";

import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";

export const FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION =
  "evleda.flux-kicad-toolchain-binding.v1" as const;
export const FLUX_KICAD_CLI_BINDING_SCHEMA_VERSION =
  "evleda.flux-kicad-cli-binding.v1" as const;
export const FLUX_PCBNEW_BINDING_SCHEMA_VERSION =
  "evleda.flux-pcbnew-binding.v1" as const;
export const FLUX_KICAD_OPERATIONAL_TRANSCRIPT_POLICY = "exact-crlf-v1" as const;

export interface FluxKicadCliBinding {
  readonly path: string;
  readonly contentIdentity: ContentIdentity;
  readonly operationalVersion: string;
  readonly operationalCommit: string;
  readonly peFileVersion: string;
  readonly peProductVersion: string;
  readonly identity: CanonicalIdentity;
}

export interface FluxPcbnewBinding {
  readonly path: string;
  readonly contentIdentity: ContentIdentity;
  readonly peFileVersion: string;
  readonly peProductVersion: string;
  readonly identity: CanonicalIdentity;
}

export interface FluxKicadToolchainBinding {
  readonly schemaVersion: typeof FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION;
  readonly binRoot: string;
  readonly kicadCli: FluxKicadCliBinding;
  readonly pcbnew: FluxPcbnewBinding;
  readonly identity: CanonicalIdentity;
}

export interface FluxKicadToolchainBindingInput {
  readonly binRoot: string;
  readonly kicadCli: Omit<FluxKicadCliBinding, "identity">;
  readonly pcbnew: Omit<FluxPcbnewBinding, "identity">;
}

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const exactRecord = (value: unknown, keys: readonly string[], label: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  const record = value as Record<string, unknown>;
  const actual = Reflect.ownKeys(record);
  if (actual.length !== keys.length
    || actual.some((key) => typeof key !== "string" || !keys.includes(key))
    || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} is malformed`);
  }
  return record;
};

const comparablePath = (value: string): string => process.platform === "win32"
  ? value.toLocaleLowerCase("en-US")
  : value;

const exactPath = (value: unknown, label: string): string => {
  if (typeof value !== "string"
    || !value.isWellFormed()
    || value.length === 0
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)
    || Buffer.byteLength(value, "utf8") > 32 * 1024
    || !path.isAbsolute(value)
    || comparablePath(path.normalize(value)) !== comparablePath(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
};

const contentIdentity = (value: unknown, label: string): ContentIdentity => {
  const record = exactRecord(value, ["algorithm", "digest", "size"], label);
  if (record.algorithm !== "sha256"
    || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)
    || typeof record.size !== "number" || !Number.isSafeInteger(record.size)
    || record.size < 1 || record.size > 512 * 1024 * 1024) {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze({ algorithm: "sha256", digest: record.digest, size: record.size });
};

const version = (value: unknown, label: string): string => {
  if (typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > 128
    || !/^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
};

const commit = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error("KiCad CLI operational commit is malformed");
  }
  return value;
};

const canonicalIdentityValue = (
  value: unknown,
  expectedSchemaVersion: string,
  label: string,
): CanonicalIdentity => {
  const record = exactRecord(
    value,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    label,
  );
  if (record.algorithm !== "sha256"
    || typeof record.digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.digest)
    || record.schemaVersion !== expectedSchemaVersion
    || record.canonicalizationVersion !== "evleda-c14n-json-v1") {
    throw new Error(`${label} is malformed`);
  }
  return Object.freeze({
    algorithm: "sha256",
    digest: record.digest,
    schemaVersion: expectedSchemaVersion,
    canonicalizationVersion: "evleda-c14n-json-v1",
  });
};

const sameIdentity = (left: CanonicalIdentity, right: CanonicalIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const kicadCliPayload = (record: Record<string, unknown>) => ({
  path: exactPath(record.path, "KiCad CLI path"),
  contentIdentity: contentIdentity(record.contentIdentity, "KiCad CLI content identity"),
  operationalVersion: version(record.operationalVersion, "KiCad CLI operational version"),
  operationalCommit: commit(record.operationalCommit),
  peFileVersion: version(record.peFileVersion, "KiCad CLI PE file version"),
  peProductVersion: version(record.peProductVersion, "KiCad CLI PE product version"),
});

const kicadCliIdentity = (payload: ReturnType<typeof kicadCliPayload>): CanonicalIdentity =>
  canonicalIdentity({
    ...payload,
    operationalTranscriptPolicy: FLUX_KICAD_OPERATIONAL_TRANSCRIPT_POLICY,
  }, FLUX_KICAD_CLI_BINDING_SCHEMA_VERSION);

const kicadCliBinding = (value: unknown): FluxKicadCliBinding => {
  const record = exactRecord(value, [
    "path", "contentIdentity", "operationalVersion", "operationalCommit",
    "peFileVersion", "peProductVersion", "identity",
  ], "KiCad CLI binding");
  const payload = kicadCliPayload(record);
  const identity = kicadCliIdentity(payload);
  if (!sameIdentity(identity, canonicalIdentityValue(
    record.identity,
    FLUX_KICAD_CLI_BINDING_SCHEMA_VERSION,
    "KiCad CLI binding identity",
  ))) throw new Error("KiCad CLI binding identity does not match its preimage");
  return deepFreeze({ ...payload, identity });
};

const pcbnewPayload = (record: Record<string, unknown>) => ({
  path: exactPath(record.path, "PCB editor path"),
  contentIdentity: contentIdentity(record.contentIdentity, "PCB editor content identity"),
  peFileVersion: version(record.peFileVersion, "PCB editor PE file version"),
  peProductVersion: version(record.peProductVersion, "PCB editor PE product version"),
});

const pcbnewBinding = (value: unknown): FluxPcbnewBinding => {
  const record = exactRecord(value, [
    "path", "contentIdentity", "peFileVersion", "peProductVersion", "identity",
  ], "PCB editor binding");
  const payload = pcbnewPayload(record);
  const identity = canonicalIdentity(payload, FLUX_PCBNEW_BINDING_SCHEMA_VERSION);
  if (!sameIdentity(identity, canonicalIdentityValue(
    record.identity,
    FLUX_PCBNEW_BINDING_SCHEMA_VERSION,
    "PCB editor binding identity",
  ))) throw new Error("PCB editor binding identity does not match its preimage");
  return deepFreeze({ ...payload, identity });
};

const parseSnapshot = (value: unknown): FluxKicadToolchainBinding => {
  const record = exactRecord(value, ["schemaVersion", "binRoot", "kicadCli", "pcbnew", "identity"], "KiCad toolchain binding");
  if (record.schemaVersion !== FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION) {
    throw new Error("KiCad toolchain binding schema version is unsupported");
  }
  const binRoot = exactPath(record.binRoot, "KiCad toolchain bin root");
  const kicadCli = kicadCliBinding(record.kicadCli);
  const pcbnew = pcbnewBinding(record.pcbnew);
  if (comparablePath(path.dirname(kicadCli.path)) !== comparablePath(binRoot)
    || comparablePath(path.dirname(pcbnew.path)) !== comparablePath(binRoot)
    || path.basename(kicadCli.path).toLocaleLowerCase("en-US") !== "kicad-cli.exe"
    || path.basename(pcbnew.path).toLocaleLowerCase("en-US") !== "pcbnew.exe") {
    throw new Error("KiCad toolchain executables do not share the exact canonical bin root");
  }
  const payload = {
    schemaVersion: FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION,
    binRoot,
    kicadCli,
    pcbnew,
  };
  const identity = canonicalIdentity(payload, FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION);
  if (!sameIdentity(identity, canonicalIdentityValue(
    record.identity,
    FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION,
    "KiCad toolchain binding identity",
  ))) throw new Error("KiCad toolchain binding identity does not match its preimage");
  return deepFreeze({ ...payload, identity });
};

export const parseFluxKicadToolchainBinding = (value: unknown): FluxKicadToolchainBinding => {
  const snapshot = hardenPortableValue(value, {
    maxBytes: 128 * 1024,
    maxDepth: 8,
    maxNodes: 256,
    maxArrayLength: 8,
    maxOwnKeys: 16,
    maxKeyBytes: 64,
    maxStringBytes: 32 * 1024,
  });
  return parseSnapshot(snapshot);
};

export const createFluxKicadToolchainBinding = (
  input: FluxKicadToolchainBindingInput,
): FluxKicadToolchainBinding => {
  const snapshot = hardenPortableValue(input, {
    maxBytes: 128 * 1024,
    maxDepth: 8,
    maxNodes: 256,
    maxArrayLength: 8,
    maxOwnKeys: 16,
    maxKeyBytes: 64,
    maxStringBytes: 32 * 1024,
  });
  const record = exactRecord(snapshot, ["binRoot", "kicadCli", "pcbnew"], "KiCad toolchain binding input");
  const cliRecord = exactRecord(record.kicadCli, [
    "path", "contentIdentity", "operationalVersion", "operationalCommit",
    "peFileVersion", "peProductVersion",
  ], "KiCad CLI binding input");
  const pcbRecord = exactRecord(record.pcbnew, [
    "path", "contentIdentity", "peFileVersion", "peProductVersion",
  ], "PCB editor binding input");
  const cliPayload = kicadCliPayload(cliRecord);
  const editorPayload = pcbnewPayload(pcbRecord);
  const binRoot = exactPath(record.binRoot, "KiCad toolchain bin root");
  const kicadCli = {
    ...cliPayload,
    identity: kicadCliIdentity(cliPayload),
  };
  const pcbnew = {
    ...editorPayload,
    identity: canonicalIdentity(editorPayload, FLUX_PCBNEW_BINDING_SCHEMA_VERSION),
  };
  const payload = {
    schemaVersion: FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION,
    binRoot,
    kicadCli,
    pcbnew,
  };
  return parseFluxKicadToolchainBinding({
    ...payload,
    identity: canonicalIdentity(payload, FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION),
  });
};
