import path from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { contentIdentity } from "../../src/core/canonical.js";
import {
  FLUX_KICAD_CLI_BINDING_SCHEMA_VERSION,
  FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION,
  FLUX_PCBNEW_BINDING_SCHEMA_VERSION,
  createFluxKicadToolchainBinding,
  parseFluxKicadToolchainBinding,
} from "../../src/flux/kicad-toolchain-binding.js";

const binding = () => {
  const binRoot = path.join(path.resolve(tmpdir()), "evleda-kicad-toolchain", "bin");
  return createFluxKicadToolchainBinding({
    binRoot,
    kicadCli: {
      path: path.join(binRoot, "kicad-cli.exe"),
      contentIdentity: contentIdentity(Buffer.from("kicad-cli")),
      operationalVersion: "10.0.3",
      operationalCommit: "146a4f2a7585c65bc580427a19b6fe2ec4a3f622",
      peFileVersion: "10.0.3.49839",
      peProductVersion: "10.0.3",
    },
    pcbnew: {
      path: path.join(binRoot, "pcbnew.exe"),
      contentIdentity: contentIdentity(Buffer.from("pcbnew")),
      peFileVersion: "10.0.3.49839",
      peProductVersion: "10.0.3",
    },
  });
};

describe("Flux KiCad toolchain binding", () => {
  it("creates one immutable same-root identity and rejects nested identity or authority drift", () => {
    const value = binding();
    expect(value).toMatchObject({
      schemaVersion: FLUX_KICAD_TOOLCHAIN_BINDING_SCHEMA_VERSION,
      kicadCli: { identity: { schemaVersion: FLUX_KICAD_CLI_BINDING_SCHEMA_VERSION } },
      pcbnew: { identity: { schemaVersion: FLUX_PCBNEW_BINDING_SCHEMA_VERSION } },
    });
    expect(parseFluxKicadToolchainBinding(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.kicadCli)).toBe(true);
    expect(Object.isFrozen(value.pcbnew.contentIdentity)).toBe(true);

    expect(() => parseFluxKicadToolchainBinding({
      ...value,
      identity: { ...value.identity, digest: "0".repeat(64) },
    })).toThrow(/identity/u);
    expect(() => parseFluxKicadToolchainBinding({
      ...value,
      kicadCli: {
        ...value.kicadCli,
        identity: { ...value.kicadCli.identity, schemaVersion: FLUX_PCBNEW_BINDING_SCHEMA_VERSION },
      },
    })).toThrow(/identity/u);
    expect(() => parseFluxKicadToolchainBinding({
      ...value,
      pcbnew: { ...value.pcbnew, path: path.join(path.dirname(value.binRoot), "other", "pcbnew.exe") },
    })).toThrow();
    expect(() => parseFluxKicadToolchainBinding({ ...value, privatePath: "C:\\private" })).toThrow();
  });

  it("snapshots creator input without invoking getters or accepting malformed executable roles", () => {
    const value = binding();
    let reads = 0;
    const malicious = { binRoot: value.binRoot, kicadCli: value.kicadCli, pcbnew: value.pcbnew } as Record<string, unknown>;
    Object.defineProperty(malicious, "binRoot", {
      enumerable: true,
      get: () => { reads += 1; return value.binRoot; },
    });
    expect(() => createFluxKicadToolchainBinding(malicious as never)).toThrow();
    expect(reads).toBe(0);
    const { identity: _cliIdentity, ...kicadCli } = value.kicadCli;
    const { identity: _pcbnewIdentity, ...pcbnew } = value.pcbnew;
    expect(() => createFluxKicadToolchainBinding({
      binRoot: value.binRoot,
      kicadCli,
      pcbnew: { ...pcbnew, path: path.join(path.dirname(value.binRoot), "other", "pcbnew.exe") },
    })).toThrow(/bin root/u);
    expect(() => createFluxKicadToolchainBinding({
      binRoot: value.binRoot,
      kicadCli: { ...kicadCli, path: path.join(value.binRoot, "not-kicad.exe") },
      pcbnew,
    })).toThrow(/bin root/u);
  });
});
