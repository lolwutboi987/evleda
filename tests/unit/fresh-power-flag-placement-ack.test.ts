import type { CallToolResult } from "@modelcontextprotocol/client";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { createFreshConnectivityContract, type FreshConnectivityContract } from "../../src/harness/fresh-connectivity-contract.js";
import { freshPowerFlagDefinitionSemanticIdentity, parseFreshSymbolLibraryTerminalGeometrySource } from "../../src/harness/fresh-kicad-parser.js";
import { PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION } from "../../src/harness/pcb-external-power.js";
import { prepareFreshProject } from "../../src/harness/fresh-project.js";
import { FreshSchematicRollback } from "../../src/harness/fresh-schematic-rollback.js";
import { verifyFreshExternalPowerSource } from "../../src/harness/fresh-external-power.js";
import { qualifyFreshPowerFlagMutationReply, assertFreshPowerFlagMutationSource, verifyFreshPowerFlagMutationReplyAndSource,
  executeFreshPowerFlagMutation, serializeFreshContractConnectivityResult, type FreshPowerFlagPlacementAdvisoryEvidence } from "../../src/harness/kicad-tools.js";
import { createGenericDividerBundleFixture } from "../helpers/generic-divider-bundle.js";
import { createSchematicFailureSession } from "../helpers/schematic-failure-session.js";

// Synthetic source/protocol fixture. The warning text/poses reproduce the
// retained native session18 failure; these tests do not run or qualify KiCad.
const rootUuid = "00000000-0000-4000-8000-000000000001";
const flag = { reference: "#FLG001", x: 57.15, y: 88.9, rotation: 0 as const };
const physical = '(symbol "Test:R" (symbol "R_1_1" (pin passive line (at 0 0 0) (length 0) (name "P") (number "1"))))';
const power = '(symbol "PWR_FLAG" (power global) (in_bom yes) (on_board yes) (property "Reference" "#FLG") (property "Value" "PWR_FLAG") (property "Footprint" "") (symbol "PWR_FLAG_0_1" (pin power_out line (at 0 0 90) (length 0) (name "pwr") (number "1"))))';
const stock = `(kicad_symbol_lib ${power})`;
const instance = '(symbol (lib_id "Test:R") (at 66.04 91.44 0) (unit 1) (property "Reference" "R3") (property "Value" "5k1") (property "Footprint" "Test:R"))';
const before = `(kicad_sch (version 20250114) (uuid "${rootUuid}") (lib_symbols ${physical} ${power.replace('(symbol "PWR_FLAG"', '(symbol "power:PWR_FLAG"')}) ${instance})`;
const added = `(symbol (lib_id "power:PWR_FLAG") (at 57.15 88.9 0) (unit 1) (in_bom yes) (on_board yes) (dnp no)
 (uuid "00000000-0000-4000-8000-000000000002")
 (property "Reference" "#FLG001" (at 57.15 85.09 0) (effects (font (size 1.27 1.27)) (hide yes)))
 (property "Value" "PWR_FLAG" (at 57.15 83.82 0) (effects (font (size 1.27 1.27))))
 (property "Footprint" "" (effects (font (size 1.27 1.27)) (hide yes)))
 (instances (project "synthetic" (path "/${rootUuid}" (reference "#FLG001") (unit 1)))))`;
const after = before.slice(0, -1) + added + ")";
const base = createFreshConnectivityContract(createGenericDividerBundleFixture().bundle.contract);
const bindingPayload = { schemaVersion: PCB_EXTERNAL_POWER_BINDING_SCHEMA_VERSION, contractIdentity: base.sourceContractIdentity,
  flags: [{ reference: "#FLG001", symbolLibId: "power:PWR_FLAG" as const, net: "N", anchorEndpoint: { reference: "R3", pin: "1" } }],
  source: { symbolLibId: "power:PWR_FLAG" as const, sourceIdentity: contentIdentity(stock),
    definitionIdentity: parseFreshSymbolLibraryTerminalGeometrySource(stock, contentIdentity(stock), "power:PWR_FLAG").definitionIdentity,
    definitionSemanticIdentity: freshPowerFlagDefinitionSemanticIdentity(stock, contentIdentity(stock), false),
    inspectionIdentity: canonicalIdentity({ purpose: "synthetic ack fixture" }, "evleda.synthetic-flag-inspection.v1"),
    policyIdentity: canonicalIdentity({ purpose: "synthetic ack fixture" }, "evleda.synthetic-flag-policy.v1") } };
const contract: FreshConnectivityContract = { ...base, components: [{ reference: "R3", symbolLibId: "Test:R", value: "5k1", footprintLibId: "Test:R" }],
  nets: [{ name: "N", endpoints: [{ reference: "R3", pin: "1" }] }], noConnects: [],
  externalPowerBinding: { ...bindingPayload, identity: canonicalIdentity(bindingPayload, bindingPayload.schemaVersion) } };
const args = { library: "power", symbol_name: "PWR_FLAG", reference: flag.reference, value: "PWR_FLAG", footprint: "", x_mm: flag.x, y_mm: flag.y, rotation: 0, unit: 1, snap_to_grid: false };
const schematicPath = path.resolve("D:/private/source-bound/project.kicad_sch");
const warning = "WARNING: coordinate (57.15, 88.90) is 9.2 mm from 'R3' at (66.04, 91.44) — symbols may overlap. Use sch_find_free_placement to get a safe coordinate.";
const text = `The schematic was updated. Reload it manually in KiCad if needed.\nTarget schematic (root): [redacted path]\n${warning}`;
const reply = (value = text): CallToolResult => ({ content: [{ type: "text", text: value }], structuredContent: { result: value }, isError: false });
const context = { contract, flag, beforeSource: before, schematicPath };

describe("exact authenticated power-flag center-proximity acknowledgement", () => {
  it("recognizes the actual positive update plus R3 advisory and preserves its exact text/source/reply identities", () => {
    const evidence = qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", args, context)!;
    expect(evidence).toMatchObject({ code: "NATIVE_SYMBOL_CENTER_PROXIMITY", warning, reference: "#FLG001", at: { x: 57.15, y: 88.9 }, nearReference: "R3", nearAt: { x: 66.04, y: 91.44 } });
    expect(evidence.beforeSchematicContentIdentity).toEqual(contentIdentity(before));
    expect(evidence.nativeReplyContentIdentity).toEqual(contentIdentity(JSON.stringify(reply())));
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(() => assertFreshPowerFlagMutationSource(before, after, contract, flag)).not.toThrow();
  });
  it("accepts the actual KicadMcpSession sanitized flag envelope, not the marker by itself", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evleda-flag-envelope-"));
    let connected: Awaited<ReturnType<typeof createSchematicFailureSession>> | undefined;
    try {
      const f = createGenericDividerBundleFixture();
      const project = await prepareFreshProject({ outputDir: directory, name: "flag-envelope", resume: false, workflowKind: "generic", compilationBundle: f.bundle, compilationBundleRef: f.reference });
      connected = await createSchematicFailureSession({ workspace: directory, project: project.projectPath, boardFile: project.pcbPath, replyToolName: "sch_add_symbol", reply: reply() });
      const sanitized = await connected.session.callTool("sch_add_symbol", args);
      expect(sanitized.content).toEqual([{ type: "text", text: '{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}' }]);
      expect(sanitized.structuredContent).toEqual({ result: text });
      expect(qualifyFreshPowerFlagMutationReply(sanitized, "sch_add_symbol", args, context)!.warning).toBe(warning);
      expect(() => qualifyFreshPowerFlagMutationReply({ content: sanitized.content }, "sch_add_symbol", args, context)).toThrow();
      expect(() => qualifyFreshPowerFlagMutationReply({ ...sanitized, structuredContent: { result: text + "\nERROR: failed" } }, "sch_add_symbol", args, context)).toThrow();
      expect(() => qualifyFreshPowerFlagMutationReply({ ...sanitized, content: [{ type: "text", text: '{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"other"}' }] }, "sch_add_symbol", args, context)).toThrow();
    } finally { await connected?.session.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it.each([
    ["categorical error", (r: CallToolResult) => ({ ...r, isError: true })],
    ["contradictory content", (r: CallToolResult) => ({ ...r, content: [{ type: "text", text: "ERROR: write refused" }] })],
    ["contradictory structured field", (r: CallToolResult) => ({ ...r, structuredContent: { result: text, error: "write failed" } })],
    ["missing structured acknowledgement", (r: CallToolResult) => ({ content: r.content })],
  ] as const)("rejects %s", (_name, edit) => {
    expect(() => qualifyFreshPowerFlagMutationReply(edit(reply()) as CallToolResult, "sch_add_symbol", args, context)).toThrow();
  });
  it.each([
    text + "\nWARNING: obstacle_bypass_failed", text + "\nERROR: native write failed", text + "\nSnapped coordinate to another point.",
    text.replace("Target schematic (root)", "Target schematic (child)"), text.replace("[redacted path]", "D:/other.kicad_sch"),
    text.replace("was updated", "was not updated"), text.replace("'R3'", "'R4'"), text.replace("57.15, 88.90", "57.16, 88.90"),
    text.replace("66.04, 91.44", "66.05, 91.44"), text.replace("9.2 mm", "9.3 mm"), text.replace("symbols may overlap", "symbols overlap"),
    text.replace(`\n${warning}`, ""), text + "\n", "ok", `WARNING: ${warning}`, text.replace(warning, "WARNING: actual body overlap"),
  ])("rejects wrong, missing, mixed or malformed native acknowledgement %j", value => {
    expect(() => qualifyFreshPowerFlagMutationReply(reply(value), "sch_add_symbol", args, context)).toThrow();
  });
  it.each(["sch_add_wire", "sch_move_symbol", "sch_add_labels"])("cannot qualify a general %s warning", operation => {
    expect(() => qualifyFreshPowerFlagMutationReply(reply(), operation, args, context)).toThrow();
  });
  it.each([{ reference: "#FLG002" }, { library: "Device" }, { symbol_name: "R" }, { value: "OTHER" }, { footprint: "Test:Pad" },
    { x_mm: 58.42 }, { rotation: 90 }, { unit: 2 }, { snap_to_grid: true }, { sheet: "child" }])("rejects nonexact flag arguments %j", change => {
    expect(() => qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", { ...args, ...change }, context)).toThrow();
  });
  it("rejects changed current source and an unbound flag, without nearest-neighbor substitution", () => {
    expect(() => qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", args, { ...context, beforeSource: before.replace("66.04 91.44", "67.31 91.44") })).toThrow();
    const { externalPowerBinding: _binding, ...unbound } = contract;
    expect(() => qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", args, { ...context, contract: unbound })).toThrow();
    const first = instance.replaceAll("R3", "R2").replace("66.04 91.44", "66.04 90.17");
    const source = before.replace(instance, first + instance), expanded = { ...contract, components: [{ ...contract.components[0]!, reference: "R2" }, ...contract.components] };
    expect(() => qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", args, { ...context, contract: expanded, beforeSource: source })).toThrow();
  });
  it("matches the producer's library-based physical-then-power ordering, including a non-# power reference", () => {
    const definition = physical.replace('"Test:R"', '"power:Aux"').replace('"R_1_1"', '"Aux_1_1"');
    const extra = instance.replace('"Test:R"', '"power:Aux"').replaceAll('"R3"', '"A1"').replace("66.04 91.44", "60.96 87.63");
    const source = before.replace(physical, physical + definition).replace(instance, extra + instance);
    const expanded = { ...contract, components: [{ ...contract.components[0]!, reference: "A1", symbolLibId: "power:Aux" }, ...contract.components] };
    expect(qualifyFreshPowerFlagMutationReply(reply(), "sch_add_symbol", args, { ...context, contract: expanded, beforeSource: source })!.nearReference).toBe("R3");
  });
  it.each([
    after.replace("(at 57.15 88.9 0)", "(at 66.04 91.44 0)"), // actual overlap/incorrect placement
    after.replace("(at 57.15 88.9 0)", "(at 57.15 88.9 90)"),
    after.replace('(property "Value" "5k1")', '(property "Value" "10k")'),
    after.replace('(symbol "R_1_1"', '(symbol "R_1_1" (rectangle (start -30 -30) (end 30 30) (stroke (width 1) (type default)) (fill (type none)))'),
    after.replace("(length 0) (name \"pwr\")", "(length 1.27) (name \"pwr\")"),
    after.replace("(lib_id \"power:PWR_FLAG\")", "(lib_id \"Test:R\")"), before,
  ])("does not waive actual source/definition/pose drift after a positive advisory", source => {
    expect(() => assertFreshPowerFlagMutationSource(before, source, contract, flag)).toThrow();
  });
  it("keeps complete downstream native flag/net membership checks after a qualified reply", async () => {
    const receipts: FreshPowerFlagPlacementAdvisoryEvidence[] = [];
    const source = await verifyFreshPowerFlagMutationReplyAndSource(reply(), "sch_add_symbol", args, context, async () => after, value => receipts.push(value));
    expect(verifyFreshExternalPowerSource(contract, source, { groups: [{ name: "N", endpoints: ["R3:1", "#FLG001:1"] }], placements: [flag] }).references).toEqual(["#FLG001"]);
    for (const groups of [[{ name: "WRONG", endpoints: ["R3:1", "#FLG001:1"] }], [{ name: "N", endpoints: ["R3:1"] }], [{ name: "N", endpoints: ["R3:1", "#FLG001:1", "FOREIGN:1"] }]]) {
      expect(() => verifyFreshExternalPowerSource(contract, source, { groups, placements: [flag] })).toThrow();
      expect(receipts[0]!.advisory.warning).toBe(warning);
    }
  });
  it("retains the raw reply privately before an awaited read failure, while public provenance contains no path", async () => {
    const raw = reply(text.replace("[redacted path]", schematicPath)), receipts: FreshPowerFlagPlacementAdvisoryEvidence[] = [];
    const primary = new Error("native source read failed");
    await expect(verifyFreshPowerFlagMutationReplyAndSource(raw, "sch_add_symbol", args, context, async () => {
      expect(receipts).toHaveLength(1); throw primary;
    }, value => receipts.push(value))).rejects.toBe(primary);
    expect(JSON.stringify(receipts[0]!.nativeReply)).toContain(schematicPath.replaceAll("\\", "\\\\"));
    const publicResult = serializeFreshContractConnectivityResult(contract, { applied: true, mutated: true, idempotent: false, issues: [], powerFlagPlacementAdvisories: receipts.map(value => value.advisory) });
    expect(JSON.parse(publicResult).powerFlagPlacementAdvisories.items[0].warning).toBe(warning);
    expect(publicResult).not.toContain("private/source-bound"); expect(publicResult).not.toContain("private\\\\source-bound");
  });
  it("records the production port observation before its post-reply source guard fails", async () => {
    const receipts: FreshPowerFlagPlacementAdvisoryEvidence[] = [], events: string[] = [];
    const primary = new Error("approved library changed after native reply");
    await expect(executeFreshPowerFlagMutation(async observe => {
      observe(reply()); events.push("post-reply-source-guard"); throw primary;
    }, "sch_add_symbol", args, context, async () => { events.push("source-read"); return after; }, value => {
      receipts.push(value); events.push("advisory-retained");
    })).rejects.toBe(primary);
    expect(events).toEqual(["advisory-retained", "post-reply-source-guard"]);
    expect(receipts[0]!.advisory.warning).toBe(warning);
    expect(JSON.stringify(receipts[0]!.nativeReply)).toContain("9.2 mm from 'R3'");
  });
  it("rejects native reply drift across the retained post-reply guard without replacing its first receipt", async () => {
    const receipts: FreshPowerFlagPlacementAdvisoryEvidence[] = [];
    await expect(executeFreshPowerFlagMutation(async observe => { observe(reply()); return reply(text + "\nERROR: changed reply"); },
      "sch_add_symbol", args, context, async () => { throw new Error("must not read source"); }, value => receipts.push(value))).rejects.toThrow(/changed across/u);
    expect(receipts[0]!.advisory.warning).toBe(warning);
  });
  it("retains advisory provenance after actual guarded rollback of a later source fault", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "evleda-flag-ack-"));
    try {
      const f = createGenericDividerBundleFixture();
      const project = await prepareFreshProject({ outputDir: directory, name: "flag-ack", resume: false, workflowKind: "generic", compilationBundle: f.bundle, compilationBundleRef: f.reference });
      await writeFile(project.schematicPath, before); const owner = new FreshSchematicRollback(project), checkpoint = await owner.capture(before);
      const receipts: FreshPowerFlagPlacementAdvisoryEvidence[] = [];
      await writeFile(project.schematicPath, after.replace('(property "Value" "5k1")', '(property "Value" "10k")'));
      await expect(verifyFreshPowerFlagMutationReplyAndSource(reply(), "sch_add_symbol", args, context, () => readFile(project.schematicPath, "utf8"), value => receipts.push(value))).rejects.toThrow(/unrelated/u);
      await owner.restore(checkpoint);
      expect(await readFile(project.schematicPath, "utf8")).toBe(before);
      expect(receipts[0]!.advisory.warning).toBe(warning);
      expect(Object.isFrozen(receipts[0])).toBe(true);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
