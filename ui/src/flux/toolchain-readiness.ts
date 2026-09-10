import type { FluxCanonicalIdentityDto, FluxReadinessToolchainDto } from "./model";

const exactKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const record = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
};
const identity = (value: unknown, schemaVersion: string): FluxCanonicalIdentityDto | undefined => {
  const item = record(value);
  return item !== undefined && exactKeys(item, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) && item.algorithm === "sha256" && typeof item.digest === "string" && /^[0-9a-f]{64}$/u.test(item.digest) && item.schemaVersion === schemaVersion && item.canonicalizationVersion === "evleda-c14n-json-v1"
    ? item as unknown as FluxCanonicalIdentityDto : undefined;
};
const version = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && /^[0-9]+(?:\.[0-9]+){2,3}(?:[-+][A-Za-z0-9.-]+)?$/u.test(value);

/** Strictly projects the safe, path-free subset of the server's private toolchain binding. */
export const parseFluxReadinessToolchain = (value: unknown): FluxReadinessToolchainDto | undefined => {
  try {
    const item = record(value);
    if (item === undefined || !exactKeys(item, ["identity", "kicadCli", "pcbnew"])) return undefined;
    const toolchainIdentity = identity(item.identity, "evleda.flux-kicad-toolchain-binding.v1");
    const cli = record(item.kicadCli); const editor = record(item.pcbnew);
    if (toolchainIdentity === undefined || cli === undefined || editor === undefined || !exactKeys(cli, ["identity", "operationalVersion", "operationalCommit", "peFileVersion", "peProductVersion"]) || !exactKeys(editor, ["identity", "peFileVersion", "peProductVersion"])) return undefined;
    const cliIdentity = identity(cli.identity, "evleda.flux-kicad-cli-binding.v1");
    const editorIdentity = identity(editor.identity, "evleda.flux-pcbnew-binding.v1");
    if (cliIdentity === undefined || editorIdentity === undefined || !version(cli.operationalVersion) || typeof cli.operationalCommit !== "string" || !/^[0-9a-f]{40}$/u.test(cli.operationalCommit) || !version(cli.peFileVersion) || !version(cli.peProductVersion) || !version(editor.peFileVersion) || !version(editor.peProductVersion)) return undefined;
    return {
      identity: toolchainIdentity,
      kicadCli: { identity: cliIdentity, operationalVersion: cli.operationalVersion, operationalCommit: cli.operationalCommit, peFileVersion: cli.peFileVersion, peProductVersion: cli.peProductVersion },
      pcbnew: { identity: editorIdentity, peFileVersion: editor.peFileVersion, peProductVersion: editor.peProductVersion },
    };
  } catch { return undefined; }
};
