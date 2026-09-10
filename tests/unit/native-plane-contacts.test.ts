import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const python = String.raw`C:\Program Files\KiCad\10.0\bin\python.exe`;
const helper = path.resolve("scripts/kicad-plane-contacts.py");
const roots: string[] = [];
const id = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

// Saved native fixture, intentionally unsuitable for fabrication: the purpose is
// to qualify SWIG direct-neighbor semantics without running a filler or a GUI.
function fixture(options: { secondPolygon?: boolean; noFill?: boolean; overrides?: boolean; footprintZone?: boolean } = {}) {
  const pad = (number: number, x: number, y: number, net: string) => `(pad "${number}" thru_hole circle
    (at ${x} ${y}) (size 1 1) (drill 0.4) (layers "*.Cu" "*.Mask") (net "${net}")
    ${options.overrides && number === 1 ? "(zone_connect 0) (thermal_gap 0.3) (thermal_bridge_width 0.4)" : ""}
    (uuid "${id(10 + number)}"))`;
  return `(kicad_pcb (version 20260206) (generator "pcbnew") (generator_version "10.0")
    (general (thickness 1.6)) (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (1 "F.Mask" user) (3 "B.Mask" user) (25 "Edge.Cuts" user))
    (footprint "QualificationFixture" (layer "F.Cu") (uuid "${id(1)}") (at 0 0)
      (property "Reference" "J1" (at 0 -1) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
      ${options.overrides ? "(zone_connect 2)" : ""}
      ${pad(1, 2, 2, "GND")} ${pad(2, 8, 2, "GND")} ${pad(3, 2, 3, "OTHER")}
      ${options.secondPolygon ? pad(4, 11, 2, "GND") : ""}
      ${options.footprintZone ? `(zone (net "") (layer "B.Cu") (uuid "${id(33)}") (hatch edge 0.5)
        (connect_pads (clearance 0)) (min_thickness 0.25)
        (keepout (tracks allowed) (vias allowed) (pads allowed) (copperpour not_allowed) (footprints allowed))
        (polygon (pts (xy 30 0) (xy 34 0) (xy 34 4) (xy 30 4))))` : ""})
    (segment (start 2 2) (end 5 2) (width 0.3) (layer "B.Cu") (net "GND") (uuid "${id(21)}"))
    (segment (start 5 2) (end 8 2) (width 0.3) (layer "B.Cu") (net "GND") (uuid "${id(22)}"))
    (via (at 3 3) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${id(23)}"))
    (via (at 8 3) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net "GND") (uuid "${id(24)}"))
    (zone (net "GND") (layer "B.Cu") (uuid "${id(31)}") (hatch edge 0.5)
      (connect_pads (clearance 0.25)) (min_thickness 0.2) (fill yes (thermal_gap 0.25) (thermal_bridge_width 0.3))
      (polygon (pts (xy 0 0) (xy 12 0) (xy 12 5) (xy 0 5)))
      ${options.noFill ? "" : "(filled_polygon (layer \"B.Cu\") (pts (xy 0 0) (xy 4 0) (xy 4 4) (xy 0 4)))"}
      ${options.secondPolygon ? "(filled_polygon (layer \"B.Cu\") (pts (xy 10 1) (xy 12 1) (xy 12 3) (xy 10 3)))" : ""})
    (zone (net "GND") (layer "B.Cu") (uuid "${id(32)}") (hatch edge 0.5)
      (connect_pads (clearance 0.25)) (min_thickness 0.2)
      (polygon (pts (xy 20 0) (xy 24 0) (xy 24 4) (xy 20 4)))))`;
}

async function saved(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "evleda-native-plane-contacts-"));
  roots.push(root);
  const board = path.join(root, "saved.kicad_pcb");
  await writeFile(board, source);
  return { root, board, source };
}

type RunOptions = { hash?: string; isolatedFlag?: boolean };
function runWithRuntime(executable: string, board: string, source: string, options: RunOptions = {}) {
  const result = spawnSync(executable, [options.isolatedFlag === false ? "-P" : "-I", "-s", "-E", "-B", "-S",
    helper, "--board", board, "--expected-source-sha256", options.hash ?? sha(source)], {
    encoding: "utf8", shell: false, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    cwd: path.dirname(executable), env: { ...process.env, PATH: String.raw`C:\Windows\System32` },
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  return { exit: result.status, report: JSON.parse(result.stdout), stdout: result.stdout };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

for (const [label, executable] of [
  ["installed", python],
  ["isolated", path.resolve("../working-helpers/plane-contacts/runtime-20260910/bin/python.exe")],
] as const) {
describe.skipIf(process.platform !== "win32" || !existsSync(executable))(`${label} native saved-board plane contacts`, () => {
  const run = (board: string, source: string, options: RunOptions = {}) => runWithRuntime(executable, board, source, options);
  it("reports native direct neighbors, classifies base track proxies as vias, and preserves source bytes", async () => {
    const input = await saved(fixture());
    const { exit, report } = run(input.board, input.source);
    expect(exit).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.runtime.buildVersion).toBe("10.0.3");
    expect(report.runtime.pythonExecutable.path.toLowerCase()).toBe(executable.toLowerCase());
    expect(report.runtime.commitHash).toBe("146a4f2a7585c65bc580427a19b6fe2ec4a3f622");
    expect(report.source.before).toEqual(report.source.after);
    expect(report.source.before.sha256).toBe(sha(input.source));
    expect(report.inventory).toEqual({ zoneCount: 2, padCount: 3, footprintCount: 1, trackCount: 4 });
    const zone = report.zones.find((value: { uuid: string }) => value.uuid === id(31));
    expect(zone.directPads.map((value: { uuid: string }) => value.uuid)).toEqual([id(11)]);
    // Native connectivity filters foreign-net overlaps; DRC remains necessary.
    expect(report.allPads.find((value: { uuid: string }) => value.uuid === id(13)).netName).toBe("OTHER");
    expect(zone.directTracks.map((value: { uuid: string }) => value.uuid)).toEqual([id(21)]);
    expect(zone.directVias).toEqual([expect.objectContaining({ uuid: id(23), nativeClass: "PCB_VIA", nativeType: 14, proxyType: "PCB_TRACK" })]);
    expect(zone.layers[0]).toMatchObject({ name: "B.Cu", filledSubpolygonCount: 1 });
    expect(zone.layers[0].subpolygons[0].outline).toEqual([[0, 0], [4000000, 0], [4000000, 4000000], [0, 4000000]]);
    expect(zone.layers[0].subpolygons[0].holes).toEqual([]);
    expect(report.zones[1]).toMatchObject({ directPads: [], directTracks: [], directVias: [] });
    expect(await readFile(input.board, "utf8")).toBe(input.source);
    expect(await readdir(input.root)).toEqual(["saved.kicad_pcb"]);
  });

  it("preserves multiple native subpolygons for fail-closed downstream scope checks", async () => {
    const input = await saved(fixture({ secondPolygon: true }));
    const { report } = run(input.board, input.source);
    expect(report.ok).toBe(true);
    expect(report.connectivity.zoneScope).toBe("aggregate-native-subpolygons");
    expect(report.zones[0].layers[0].filledSubpolygonCount).toBe(2);
    expect(new Set(report.zones[0].layers[0].subpolygons.map((p: { sha256: string }) => p.sha256)).size).toBe(2);
    // Pad 4 lies solely in polygon 2, proving that the native API aggregates
    // contacts across subpolygons rather than exposing one component's contacts.
    expect(report.zones[0].directPads.map((p: { uuid: string }) => p.uuid)).toEqual([id(11), id(14)]);
  });

  it("emits complete empty sets for unfilled zones", async () => {
    const input = await saved(fixture({ noFill: true }));
    const { report } = run(input.board, input.source);
    expect(report.ok).toBe(true);
    for (const zone of report.zones) {
      expect(zone).toMatchObject({ directPads: [], directTracks: [], directVias: [] });
      expect(zone.layers[0]).toMatchObject({ filledSubpolygonCount: 0, subpolygons: [] });
    }
  });

  it("includes footprint-owned rule areas in the complete zone inventory", async () => {
    const input = await saved(fixture({ footprintZone: true }));
    const { report } = run(input.board, input.source);
    expect(report.ok).toBe(true);
    expect(report.inventory.zoneCount).toBe(3);
    expect(report.zones.find((zone: { uuid: string }) => zone.uuid === id(33))).toMatchObject({
      isRuleArea: true, directPads: [], directTracks: [], directVias: [],
    });
  });

  it("observes pad and footprint overrides without claiming effective connections or spoke counts", async () => {
    const input = await saved(fixture({ overrides: true }));
    const { report } = run(input.board, input.source);
    expect(report.ok).toBe(true);
    expect(report.allFootprints[0]).toMatchObject({ localZoneConnection: 2, resolvedZoneConnectionOverride: 2 });
    expect(report.allPads[0]).toMatchObject({ localZoneConnection: 0, resolvedZoneConnectionOverride: 0,
      localThermalGapOverride: 300000, localThermalSpokeWidthOverride: 400000 });
    expect(report.capabilities).toEqual({ perLayerPadstackZoneConnectionAvailable: false,
      effectivePadZoneConnectionAvailable: false, physicalThermalSpokeCountAvailable: false });
  });

  it("rejects a stale source hash before native loading", async () => {
    const input = await saved(fixture());
    const { exit, report } = run(input.board, input.source, { hash: "0".repeat(64) });
    expect(exit).toBe(2);
    expect(report).toMatchObject({ ok: false, error: { code: "SOURCE_HASH_MISMATCH" } });
  });

  it("rejects native parse errors without echoing source text or the board path", async () => {
    const input = await saved('(kicad_pcb (version 20260206) SECRET_SOURCE_LABEL_MUST_NOT_ESCAPE');
    const { exit, report, stdout } = run(input.board, input.source);
    expect(exit).toBe(2);
    expect(report).toMatchObject({ ok: false, error: { code: "NATIVE_LOAD_FAILED" } });
    expect(stdout).not.toContain("SECRET_SOURCE_LABEL");
    expect(stdout).not.toContain(input.board);
    expect(await readFile(input.board, "utf8")).toBe(input.source);
  });

  it("refuses startup without the complete isolated flags", async () => {
    const input = await saved(fixture());
    // Keep -S and -P in this negative test so it never executes site customization.
    const { exit, report } = run(input.board, input.source, { isolatedFlag: false });
    expect(exit).toBe(2);
    expect(report).toMatchObject({ ok: false, error: { code: "ISOLATED_STARTUP_REQUIRED" } });
  });
});
}
