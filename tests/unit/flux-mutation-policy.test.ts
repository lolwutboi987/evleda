import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PCB_AGENT_HARNESS_RULE_IDENTITY, PCB_AGENT_MUTATION_ALLOWLIST } from "../../src/cli/pcb-agent.js";
import { canonicalIdentity } from "../../src/core/canonical.js";
import { createFluxRuntime } from "../../src/flux/runtime.js";
import { createFakeFluxKicadMcpRuntime } from "../helpers/flux-kicad-mcp-runtime.js";
import { createFakeFluxKicadToolchain } from "../helpers/flux-kicad-toolchain.js";

const temporaryRoot = path.resolve(tmpdir());
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => {
    expect(path.dirname(path.resolve(root))).toBe(temporaryRoot);
    expect(path.basename(root)).toMatch(/^evleda-flux-mutation-policy-/u);
    await rm(root, { recursive: true, force: true });
  }));
});
const policyRuntime = async (allowlist: () => readonly string[]) => {
  const root = await mkdtemp(path.join(temporaryRoot, "evleda-flux-mutation-policy-")); roots.push(root);
  const sources = path.join(root, "sources"); await mkdir(sources);
  const kicad = await createFakeFluxKicadToolchain(root);
  return createFluxRuntime({ EVLEDA_FLUX_SOURCE_ROOT: sources, EVLEDA_FLUX_WORKSPACE_ROOT: path.join(root, "workspace") }, {
    kicadToolchain: kicad.toolchain, kicadMcpRuntime: createFakeFluxKicadMcpRuntime().runtime,
    runKicadCliIdentityProbe: kicad.runner,
    currentHarnessPolicy: () => ({ harnessRuleIdentity: PCB_AGENT_HARNESS_RULE_IDENTITY, mutationAllowlist: allowlist() }),
  });
};

describe("Flux canonical mutation policy", () => {
  it("accepts the current complete executable set with stable canonical identity across input order", async () => {
    const input = [...PCB_AGENT_MUTATION_ALLOWLIST].reverse();
    const before = [...input];
    const runtime = await policyRuntime(() => input);
    const reversed = runtime.routes.policy!();
    expect(reversed.mutationAllowlist).toEqual([...PCB_AGENT_MUTATION_ALLOWLIST].sort());
    expect(reversed.mutationAllowlist).toHaveLength(PCB_AGENT_MUTATION_ALLOWLIST.length);
    expect(reversed.harnessRuleIdentity).toBe(PCB_AGENT_HARNESS_RULE_IDENTITY);
    expect(Object.isFrozen(reversed.mutationAllowlist)).toBe(true);
    expect(input).toEqual(before);
    input.reverse();
    const original = runtime.routes.policy!();
    expect(canonicalIdentity(original, "evleda.flux-mutation-policy-test.v1"))
      .toEqual(canonicalIdentity(reversed, "evleda.flux-mutation-policy-test.v1"));
  });

  it.each([
    ["missing", PCB_AGENT_MUTATION_ALLOWLIST.slice(1)],
    ["extra", [...PCB_AGENT_MUTATION_ALLOWLIST, "unknown_mutation"]],
    ["duplicate at canonical cardinality", [...PCB_AGENT_MUTATION_ALLOWLIST.slice(0, -1), PCB_AGENT_MUTATION_ALLOWLIST[0]]],
    ["unknown at canonical cardinality", [...PCB_AGENT_MUTATION_ALLOWLIST.slice(0, -1), "unknown_mutation"]],
    ["invalid syntax at canonical cardinality", [...PCB_AGENT_MUTATION_ALLOWLIST.slice(0, -1), "../unsafe"]],
    ["empty", []],
  ] as const)("rejects a %s mutation-tool set", async (_name, input) => {
    const runtime = await policyRuntime(() => input);
    expect(() => runtime.routes.policy!()).toThrow("Flux harness mutation policy must be the exact unique executable mutation-tool set.");
  });
});
