import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const runtimeRoot = path.resolve(process.env.EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT
  ?? path.join("..", "working-runtime", "inspection-runtime-3.33.3-doc5"));
const python = path.join(runtimeRoot, "environment", "Scripts", "python.exe");
const modulePath = process.env.EVLEDA_TEST_SCHEMATIC_MODULE ?? path.join(runtimeRoot, "environment", "Lib", "site-packages", "kicad_mcp", "tools", "schematic.py");
const kicadCli = process.env.EVLEDA_KICAD_CLI
  ?? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "KiCad", "10.0", "bin", "kicad-cli.exe");
const symbolLibrary = path.resolve(path.dirname(kicadCli), "..", "share", "kicad", "symbols");
const temporaryRoot = path.resolve(tmpdir());
const capturedPath = path.resolve("tests", "fixtures", "kicad-mcp-connectivity", "attempt11-vout-junction.kicad_sch");
const owned: string[] = [];

interface Group {
  names: string[];
  points: [number, number][];
  pins: { reference: string; pin: string }[];
  no_connect: boolean;
}

afterEach(async () => {
  for (const root of owned.splice(0)) {
    const relative = path.relative(temporaryRoot, root);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Connectivity test cleanup escaped its temporary root.");
    await rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
  }
});

const invokeReader = String.raw`
import importlib.util, json, sys
from pathlib import Path
module_path, schematic_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location("kicad_mcp.tools.schematic", module_path)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
print(json.dumps(module._build_connectivity_groups(Path(schematic_path))))
`;

async function groupsFor(content: string): Promise<Group[]> {
  const root = await mkdtemp(path.join(temporaryRoot, "evleda-connectivity-reader-"));
  owned.push(root);
  const home = path.join(root, "home");
  await mkdir(home);
  const schematic = path.join(root, "candidate.kicad_sch");
  await writeFile(schematic, content, "utf8");
  const result = spawnSync(python, ["-I", "-s", "-E", "-B", "-c", invokeReader, modulePath, schematic], {
    cwd: root,
    env: {
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: "",
      HOME: home, USERPROFILE: home, TEMP: root, TMP: root,
      LOCALAPPDATA: path.join(home, "AppData", "Local"), APPDATA: path.join(home, "AppData", "Roaming"),
      KICAD_MCP_WORKSPACE_ROOT: root, KICAD_MCP_PROJECT_DIR: root,
      KICAD_MCP_KICAD_CLI: kicadCli,
      KICAD_MCP_SYMBOL_LIBRARY_DIR: symbolLibrary,
      KICAD_MCP_OPERATING_MODE: "readonly", KICAD_MCP_TELEMETRY_ENABLED: "false",
      PYTHONNOUSERSITE: "1", PYTHONSAFEPATH: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHON_DOTENV_DISABLED: "1",
    },
    encoding: "utf8", timeout: 20_000, maxBuffer: 512 * 1024, windowsHide: true, shell: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(await readFile(schematic, "utf8")).toBe(content);
  return JSON.parse(result.stdout) as Group[];
}

const endpoints = (group: Group): string[] => group.pins.map((pin) => `${pin.reference}:${pin.pin}`).sort();
const uuid = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const minimalSchematic = (wires: [number, number, number, number][], labels: [string, number, number][], junctions: [number, number][] = [], noConnects: [number, number][] = []): string => `(kicad_sch
  (version 20250114) (generator "evleda-reader-regression") (uuid "${uuid(1)}") (paper "A4") (lib_symbols)
  ${wires.map(([x1, y1, x2, y2], index) => `(wire (pts (xy ${x1} ${y1}) (xy ${x2} ${y2})) (stroke (width 0) (type default)) (uuid "${uuid(index + 10)}"))`).join("\n  ")}
  ${labels.map(([name, x, y], index) => `(label "${name}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uuid(index + 100)}"))`).join("\n  ")}
  ${junctions.map(([x, y], index) => `(junction (at ${x} ${y}) (diameter 0) (color 0 0 0 0) (uuid "${uuid(index + 200)}"))`).join("\n  ")}
  ${noConnects.map(([x, y], index) => `(no_connect (at ${x} ${y}) (uuid "${uuid(index + 300)}"))`).join("\n  ")}
)
`;

describe.runIf(process.platform === "win32")("pinned actual schematic connectivity reader", () => {
  it("binds the executed reader and recorded diff to the local patch provenance", async () => {
    const patchRoot = path.resolve("sidecars", "patches");
    const record = JSON.parse(await readFile(path.join(patchRoot, "runtime-patches.json"), "utf8")).patches
      .find((patch: { id: string }) => patch.id === "0001-explicit-junction-connectivity");
    expect(record.runtimePath).toBe("environment/Lib/site-packages/kicad_mcp/tools/schematic.py");
    expect(createHash("sha256").update(await readFile(path.join(patchRoot, record.diff))).digest("hex")).toBe(record.diffSha256);
    const layout = JSON.parse(await readFile(path.join(patchRoot, "0002-schematic-field-layout-revision3.provenance.json"), "utf8"));
    expect(layout.patchId).toBe("0002-schematic-field-layout-revision3");
    const layoutDiff = await readFile(path.join(patchRoot, "0002-schematic-field-layout-revision3.patch"));
    expect(layoutDiff.length).toBe(layout.patch.sizeBytes);
    expect(createHash("sha256").update(layoutDiff).digest("hex")).toBe(layout.patch.sha256);
    const readerDeltas = layout.runtimeDelta.filter((entry: { path: string }) => entry.path === record.runtimePath);
    expect(readerDeltas).toHaveLength(1);
    const readerDelta = readerDeltas[0];
    expect(readerDelta.before).toMatchObject(record.patched);
    const executedReader = await readFile(modulePath);
    expect(executedReader.length).toBe(readerDelta.after.sizeBytes);
    expect(createHash("sha256").update(executedReader).digest("hex")).toBe(readerDelta.after.sha256);
  });

  it("matches all three native-confirmed nets in the captured explicit VOUT T junction", async () => {
    const source = await readFile(capturedPath, "utf8");
    expect(createHash("sha256").update(source).digest("hex")).toBe("b5253e3df46a0e0e59ab24e0791da781c399470dbed760e87720482cdbe68d06");
    const groups = await groupsFor(source);
    expect(groups.map((group) => ({ names: group.names, endpoints: endpoints(group) }))).toEqual([
      { names: ["GND"], endpoints: ["J1:3", "R2:2"] },
      { names: ["VIN"], endpoints: ["J1:1", "R1:1"] },
      { names: ["VOUT"], endpoints: ["J1:2", "R1:2", "R2:1"] },
    ]);
  });

  it.each([true, false])("keeps crossing connectivity faithful to explicit dot=%s", async (dotted) => {
    const groups = await groupsFor(minimalSchematic([[0, 5, 10, 5], [5, 0, 5, 10]], [["H", 0, 5], ["V", 5, 0]], dotted ? [[5, 5]] : []));
    expect(groups.map((group) => group.names)).toEqual(dotted ? [["H", "V"]] : [["H"], ["V"]]);
  });

  it("joins an explicit T branch to the interior of its through-wire", async () => {
    const groups = await groupsFor(minimalSchematic([[0, 5, 10, 5], [5, 0, 5, 5]], [["H", 0, 5], ["B", 5, 0]], [[5, 5]]));
    expect(groups.map((group) => group.names)).toEqual([["B", "H"]]);
  });

  it("preserves ordinary interior pin and label attachments", async () => {
    const source = await readFile(capturedPath, "utf8");
    // Extend the existing VOUT through-wire just past R1:2 so that the pin
    // becomes an interior attachment, and add an ordinary interior label.
    expect(source).toContain("(xy 76.2 54.61)");
    const extended = source.replace("(xy 76.2 54.61)", "(xy 76.2 53.34)");
    const extraLabel = `(label "INTERIOR" (at 76.2 60.96 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid "${uuid(900)}"))`;
    const content = extended.replace(/\)\s*$/u, `${extraLabel}\n)\n`);
    const groups = await groupsFor(content);
    const vout = groups.find((group) => group.names.includes("VOUT"));
    expect(vout?.names).toEqual(["INTERIOR", "VOUT"]);
    expect(endpoints(vout!)).toEqual(["J1:2", "R1:2", "R2:1"]);
  });

  it("preserves shared endpoints, name collapse, and explicit no-connect markers", async () => {
    const groups = await groupsFor(minimalSchematic([[0, 0, 5, 0], [5, 0, 5, 5], [20, 0, 25, 0]], [["NET", 0, 0], ["NET", 20, 0]], [], [[30, 30]]));
    expect(groups.filter((group) => group.names.includes("NET"))).toHaveLength(1);
    expect(groups.find((group) => group.names.includes("NET"))?.points).toEqual([[0, 0], [5, 0], [5, 5], [20, 0], [25, 0]]);
    expect(groups.filter((group) => group.no_connect).map((group) => group.points)).toEqual([[[30, 30]]]);
  });
});
