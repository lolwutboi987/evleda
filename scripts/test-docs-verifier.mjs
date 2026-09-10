#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(repositoryRoot, "scripts", "verify-docs.mjs");
const scratchRoot = await mkdtemp(path.join(os.tmpdir(), "evleda-docs-verifier-"));
const baselineRoot = path.join(scratchRoot, "baseline");

const fixtureFiles = [
  "README.md",
  "HANDOFF.md",
  "docs/product-contract.md",
  "docs/architecture.md",
  "docs/api.md",
  "docs/security-model.md",
  "docs/acceptance-matrix.md",
  "docs/pcb-engineering-practices.md",
  "docs/agent-pcb-design-instructions.md",
  "src/contracts/operations.ts",
  "src/api/server.ts",
  ".github/workflows/ci.yml"
];

const runVerifier = (root) => spawnSync(process.execPath, [verifier], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: { ...process.env, EVLEDA_DOCS_VERIFY_ROOT: root }
});

const replaceOnce = (source, before, after, label) => {
  assert.ok(source.includes(before), `${label}: mutation preimage is absent`);
  return source.replace(before, after);
};

const replacePattern = (source, pattern, replacement, label) => {
  assert.match(source, pattern, `${label}: mutation preimage is absent`);
  return source.replace(pattern, replacement);
};

const replaceEvery = (source, before, after, label) => {
  assert.ok(source.includes(before), `${label}: mutation preimage is absent`);
  return source.replaceAll(before, after);
};

const cases = [
  {
    name: "implementation operation inventory drift",
    file: "src/contracts/operations.ts",
    mutate: (source) => replacePattern(
      source,
      /  "inspect_engineering_practices",\r?\n/u,
      "",
      "implementation operation inventory drift"
    )
  },
  {
    name: "missing operation-14 API heading",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "### `inspect_engineering_practices`",
      "### `inspect_engineering_practices_removed`",
      "missing operation-14 API heading"
    )
  },
  {
    name: "missing operation-14 REST route",
    file: "docs/api.md",
    mutate: (source) => replaceEvery(
      source,
      "GET /api/v1/runs/{runId}/engineering-practices",
      "GET /api/v1/runs/{runId}/engineering-practice",
      "missing operation-14 REST route"
    )
  },
  {
    name: "stale thirteen-operation prose",
    file: "docs/api.md",
    mutate: (source) => replacePattern(
      source,
      /fourteen operation/iu,
      "thirteen operation",
      "stale thirteen-operation prose"
    )
  },
  {
    name: "current manifest relabeled v2",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "Fresh exports use `evleda.bundle-manifest.v3`",
      "Fresh exports use `evleda.bundle-manifest.v2`",
      "current manifest relabeled v2"
    )
  },
  {
    name: "README adds contradictory current manifest v2 claim",
    file: "README.md",
    mutate: (source) => replaceOnce(
      source,
      "Current exports use `evleda.bundle-manifest.v3`,",
      "Current exports use `evleda.bundle-manifest.v3`. Current exports use `evleda.bundle-manifest.v2`,",
      "README adds contradictory current manifest v2 claim"
    )
  },
  {
    name: "current replay-v2 wording removed",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "Current durable export receipts use `evleda.bundle-export-replay.v2`",
      "Current durable export receipts use an unspecified replay schema",
      "current replay-v2 wording removed"
    )
  },
  {
    name: "current deterministic-zip-v3 wording removed",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "`deterministic-zip-v3`",
      "`deterministic-zip-v2`",
      "current deterministic-zip-v3 wording removed"
    )
  },
  {
    name: "legacy replay-v1 pairing removed",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "`evleda.bundle-export-replay.v1` receipt",
      "`evleda.bundle-export-replay.v9` receipt",
      "legacy replay-v1 pairing removed"
    )
  },
  {
    name: "legacy deterministic-zip-v2 profile removed",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "`deterministic-zip-v2`",
      "an unspecified legacy bundler",
      "legacy deterministic-zip-v2 profile removed"
    )
  },
  {
    name: "legacy v2 relabeled instead of unlabeled",
    file: "docs/architecture.md",
    mutate: (source) => replacePattern(
      source,
      /original\r?\nunlabeled manifest-v2\/replay-v1 pair/u,
      "original\nlabeled manifest-v2/replay-v1 pair",
      "legacy v2 relabeled instead of unlabeled"
    )
  },
  {
    name: "legacy v2 policy inference claimed",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "no policy was inferred.",
      "a current policy was inferred.",
      "legacy v2 policy inference claimed"
    )
  },
  {
    name: "cross-version bundle acceptance claimed",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "Labeled v2, crossed receipt/manifest versions, and hybrids fail closed.",
      "Labeled v2, crossed receipt/manifest versions, and hybrids are accepted.",
      "cross-version bundle acceptance claimed"
    )
  },
  {
    name: "manifest-v1 assurance upgraded",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "`evleda.bundle-manifest.v1` requires `--allow-legacy-v1`, returns `byte_integrity_only`",
      "`evleda.bundle-manifest.v1` requires `--allow-legacy-v1`, returns `provenance_roots`",
      "manifest-v1 assurance upgraded"
    )
  },
  {
    name: "native DRC inverted into practice pass",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "Native DRC pass does not imply EvlEDA-practice pass.",
      "Native DRC pass implies EvlEDA-practice pass.",
      "native DRC inverted into practice pass"
    )
  },
  {
    name: "current external evidence uses legacy firmware binding",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      '"targetBuildReport":',
      '"firmwareBuild":',
      "current external evidence uses legacy firmware binding"
    )
  },
  {
    name: "current external evidence omits target binary",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      '"targetBinary":',
      '"legacyBinary":',
      "current external evidence omits target binary"
    )
  },
  {
    name: "current external evidence uses raw observation role",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "`required_capture`, optional",
      "`raw_observation`, optional",
      "current external evidence uses raw observation role"
    )
  },
  {
    name: "engineering inspection nullable revision removed",
    file: "docs/api.md",
    mutate: (source) => replaceOnce(
      source,
      "revision through required `revisionId: string | null` (`null` before any head)",
      "revision through required `revisionId: string`",
      "engineering inspection nullable revision removed"
    )
  },
  {
    name: "architecture IR falsely marked integrated",
    file: "docs/api.md",
    mutate: (source) => replacePattern(
      source,
      /system-architecture decision IR\/compiler is likewise\r?\nisolated Phase-A infrastructure/u,
      "system-architecture decision IR/compiler is likewise\nintegrated application infrastructure",
      "architecture IR falsely marked integrated"
    )
  },
  {
    name: "unsupported firmware languages claimed available",
    file: "docs/api.md",
    mutate: (source) => replacePattern(
      source,
      /current\r?\nimplementation supports only `c`; `cpp` or `rust` returns `GATE_FAILED`/u,
      "current\nimplementation supports `c`, `cpp`, and `rust`",
      "unsupported firmware languages claimed available"
    )
  },
  {
    name: "W-03 demoted after settled atomic verification",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replacePattern(
      source,
      /^(\| W-03 \|[^\n]*\| )SOFTWARE-COMPLETE( \|)$/mu,
      "$1UNVERIFIED$2",
      "W-03 demoted after settled atomic verification"
    )
  },
  {
    name: "invocation ledger falsely marked complete",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replacePattern(
      source,
      /^(\| W-08 \|[^\n]*\| )UNVERIFIED( \|)$/mu,
      "$1SOFTWARE-COMPLETE$2",
      "invocation ledger falsely marked complete"
    )
  },
  {
    name: "P-14 physical completion falsely promoted",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replacePattern(
      source,
      /^(\| P-14 \|[^\n]*\| )UNVERIFIED( \|)$/mu,
      "$1SOFTWARE-COMPLETE$2",
      "P-14 physical completion falsely promoted"
    )
  },
  {
    name: "P-15 broad-goal boundary removed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "broad agentic hardware-development goal from the narrower constrained current implementation",
      "single fixed implementation",
      "P-15 broad-goal boundary removed"
    )
  },
  {
    name: "C-20 Phase-A scope removed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "Phase-A agent scaffolding and system-architecture decision IR",
      "Integrated production agent execution",
      "C-20 Phase-A scope removed"
    )
  },
  {
    name: "C-21 production agent integration falsely promoted",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replacePattern(
      source,
      /^(\| C-21 \|[^\n]*\| )UNVERIFIED( \|)$/mu,
      "$1SOFTWARE-COMPLETE$2",
      "C-21 production agent integration falsely promoted"
    )
  },
  {
    name: "E-11 physical v3 boundary removed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "new qualification-eligible derived `human_physical` evidence uses strict v3",
      "new qualification evidence is unversioned",
      "E-11 physical v3 boundary removed"
    )
  },
  {
    name: "T-17 firmware candidate boundary removed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "deterministic candidate-only ELF, BIN and map from a bounded exact private toolchain closure",
      "production-ready ELF, BIN and map from a public compiler",
      "T-17 firmware candidate boundary removed"
    )
  },
  {
    name: "W-03 durable-lock platform boundary removed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "macOS, and FreeBSD. Other platforms, including AIX and Solaris, are outside the",
      "All host platforms are supported without qualification",
      "W-03 durable-lock platform boundary removed"
    )
  },
  {
    name: "W-08 production writer falsely claimed",
    file: "docs/acceptance-matrix.md",
    mutate: (source) => replaceOnce(
      source,
      "no production writer populates `state.invocations`",
      "a production writer populates `state.invocations`",
      "W-08 production writer falsely claimed"
    )
  },
  {
    name: "README falsely claims arbitrary topology generation",
    file: "README.md",
    mutate: (source) => replacePattern(
      source,
      /It does not yet\r?\ngenerate arbitrary hardware topology\./u,
      "It now\ngenerates arbitrary hardware topology.",
      "README falsely claims arbitrary topology generation"
    )
  },
  {
    name: "README falsely claims invocation writer",
    file: "README.md",
    mutate: (source) => replaceOnce(
      source,
      "no production application writer populates the",
      "a production application writer populates the",
      "README falsely claims invocation writer"
    )
  },
  {
    name: "README falsely claims Phase-A integration",
    file: "README.md",
    mutate: (source) => replaceOnce(
      source,
      "That subsystem is not wired into the",
      "That subsystem is fully wired into the",
      "README falsely claims Phase-A integration"
    )
  },
  {
    name: "API falsely claims real physical qualification",
    file: "docs/api.md",
    mutate: (source) => replacePattern(
      source,
      /No real current-board physical record, qualification, or manufacturing\r?\nrelease is claimed\./u,
      "A real current-board physical record, qualification, and manufacturing\nrelease exist.",
      "API falsely claims real physical qualification"
    )
  },
  {
    name: "security model falsely claims real physical release",
    file: "docs/security-model.md",
    mutate: (source) => replacePattern(
      source,
      /No\r?\nreal Rev-A physical record, qualification, or manufacturing release exists\./u,
      "A\nreal Rev-A physical record, qualification, and manufacturing release exist.",
      "security model falsely claims real physical release"
    )
  },
  {
    name: "reference fixture relabeled clean",
    file: "README.md",
    mutate: (source) => replaceOnce(
      source,
      "expected-negative BLOCKED_DIAGNOSTIC proof fixture",
      "zero routing findings proof fixture",
      "reference fixture relabeled clean"
    )
  },
  {
    name: "settled test count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "65/65 test files, 929 passed",
      "65/65 test files, 930 passed",
      "settled test count drift"
    )
  },
  {
    name: "settled test-file count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "65/65 test files",
      "64/65 test files",
      "settled test-file count drift"
    )
  },
  {
    name: "settled skip count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "929 passed, 1 skip",
      "929 passed, 2 skips",
      "settled skip count drift"
    )
  },
  {
    name: "settled todo count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "1 todo, and 0 failed",
      "0 todo, and 0 failed",
      "settled todo count drift"
    )
  },
  {
    name: "settled failure count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "1 todo, and 0 failed",
      "1 todo, and 1 failed",
      "settled failure count drift"
    )
  },
  {
    name: "settled UI count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "UI Vitest: 10/10 files and 33/33 tests",
      "UI Vitest: 10/10 files and 34/34 tests",
      "settled UI count drift"
    )
  },
  {
    name: "settled Playwright count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "Playwright acceptance: 5/5",
      "Playwright acceptance: 4/5",
      "settled Playwright count drift"
    )
  },
  {
    name: "settled KiCad count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "Real KiCad/reference suites: 4/4 files and 76/76 tests",
      "Real KiCad/reference suites: 4/4 files and 75/76 tests",
      "settled KiCad count drift"
    )
  },
  {
    name: "settled Arm count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "Firmware validation: 32 passed and 1 intentional host-compiler skip",
      "Firmware validation: 31 passed and 1 intentional host-compiler skip",
      "settled Arm count drift"
    )
  },
  {
    name: "settled sidecar count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "Audited `kicad-mcp`: 5/5",
      "Audited `kicad-mcp`: 4/5",
      "settled sidecar count drift"
    )
  },
  {
    name: "settled evidence count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "Evidence and bundle suites: 3/3 files and 43/43 tests",
      "Evidence and bundle suites: 3/3 files and 42/43 tests",
      "settled evidence count drift"
    )
  },
  {
    name: "settled bundle-adversarial count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "bundle adversarial verification: 35/35",
      "bundle adversarial verification: 34/35",
      "settled bundle-adversarial count drift"
    )
  },
  {
    name: "settled production-module count drift",
    file: "HANDOFF.md",
    mutate: (source) => replaceOnce(
      source,
      "production build passed with 92 modules",
      "production build passed with 91 modules",
      "settled production-module count drift"
    )
  },
  {
    name: "Phase-A proposal schema drift",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "`evleda.design-agent-proposal.v2`",
      "`evleda.design-agent-proposal.v1`",
      "Phase-A proposal schema drift"
    )
  },
  {
    name: "Phase-A stage role removed",
    file: "docs/architecture.md",
    mutate: (source) => replaceOnce(
      source,
      "`system_architect`",
      "`generic_agent`",
      "Phase-A stage role removed"
    )
  },
  {
    name: "as-built age limit drift",
    file: "docs/security-model.md",
    mutate: (source) => replaceOnce(
      source,
      "as-built-record age at 90 days",
      "as-built-record age at 900 days",
      "as-built age limit drift"
    )
  },
  {
    name: "PCB document reciprocal link removed",
    file: "docs/pcb-engineering-practices.md",
    mutate: (source) => replaceOnce(
      source,
      "agent-pcb-design-instructions.md",
      "missing-agent-pcb-instructions.md",
      "PCB document reciprocal link removed"
    )
  }
];

try {
  for (const relative of fixtureFiles) {
    const destination = path.join(baselineRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(repositoryRoot, relative), destination);
  }

  const baseline = runVerifier(baselineRoot);
  assert.equal(
    baseline.status,
    0,
    `Baseline documentation fixture failed:\n${baseline.stdout}${baseline.stderr}`
  );

  for (const [index, testCase] of cases.entries()) {
    const caseRoot = path.join(scratchRoot, `case-${String(index + 1).padStart(2, "0")}`);
    await cp(baselineRoot, caseRoot, { recursive: true });
    const target = path.join(caseRoot, testCase.file);
    const source = await readFile(target, "utf8");
    await writeFile(target, testCase.mutate(source), "utf8");
    const result = runVerifier(caseRoot);
    assert.equal(
      result.status,
      2,
      `${testCase.name}: expected exit 2, received ${result.status}\n${result.stdout}${result.stderr}`
    );
  }

  console.log(`Adversarial documentation verifier: ${cases.length}/${cases.length} cases rejected.`);
} finally {
  await rm(scratchRoot, { recursive: true, force: true });
}
