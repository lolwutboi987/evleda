import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareCopiedKicadProject } from "../../src/cli/pcb-agent.js";
import { parseNativeToolboxArgs } from "../../src/mcp/toolbox-native-main.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const args = ["--profile", "profile.json", "--profile-sha256", "a".repeat(64), "--profile-bytes", "123",
  "--project-dir", "source", "--output-dir", "output", "--board", "board.kicad_pcb"];

it("requires explicit host edit access and complete profile pins", () => {
  expect(parseNativeToolboxArgs(args)).toMatchObject({ edit: false, resume: false, board: "board.kicad_pcb" });
  expect(parseNativeToolboxArgs([...args, "--edit", "--resume"])).toMatchObject({ edit: true, resume: true });
  expect(parseNativeToolboxArgs(["--help"])).toBeUndefined();
  expect(() => parseNativeToolboxArgs([])).toThrow("Missing --profile");
});

it.each(["../board.kicad_pcb", "..\\board.kicad_pcb", "board.txt"])("rejects a non-root board selector: %s", board => {
  expect(() => parseNativeToolboxArgs([...args.slice(0, -1), board])).toThrow("one PCB filename");
});

it("accepts explicit fresh inputs without allowing copied/resume options to mix", () => {
  const fresh = [...args.slice(0, -2), "--new-project", "divider", "--intent", "source/draft.json", "--prompt", "Build the reviewed divider."];
  expect(parseNativeToolboxArgs(fresh)).toMatchObject({ board: "divider.kicad_pcb", fresh: { name: "divider", originalPrompt: "Build the reviewed divider." } });
  expect(() => parseNativeToolboxArgs([...fresh, "--resume"])).toThrow("omit --intent and --prompt");
  expect(() => parseNativeToolboxArgs([...fresh, "--board", "board.kicad_pcb"])).toThrow("cannot also select --board");
  expect(parseNativeToolboxArgs([...args.slice(0, -2), "--new-project", "divider", "--resume"]))
    .toMatchObject({ resume: true, fresh: { name: "divider" } });
  expect(() => parseNativeToolboxArgs([...args, "--intent", "draft.json"])).toThrow("require --new-project");
});

it("copies and resumes a real project without model/provider parameters", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-native-prepare-")); roots.push(root);
  const projectDir = path.join(root, "source"); const outputDir = path.join(root, "output");
  await mkdir(projectDir); await mkdir(path.join(projectDir, ".git"));
  await writeFile(path.join(projectDir, "board.kicad_pcb"), "original");
  const prepared = await prepareCopiedKicadProject({ projectDir, outputDir });
  expect(await readFile(path.join(prepared.isolatedProjectPath, "board.kicad_pcb"), "utf8")).toBe("original");
  expect(await readdir(prepared.isolatedProjectPath)).not.toContain(".git");
  await writeFile(path.join(prepared.isolatedProjectPath, "board.kicad_pcb"), "copy edit");
  expect(await readFile(path.join(projectDir, "board.kicad_pcb"), "utf8")).toBe("original");
  expect(await prepareCopiedKicadProject({ projectDir, outputDir, mode: "resume" })).toEqual(prepared);
  await expect(prepareCopiedKicadProject({ projectDir, outputDir })).rejects.toThrow("must be empty");
  await expect(prepareCopiedKicadProject({ projectDir, outputDir: path.join(projectDir, "nested") })).rejects.toThrow("must be distinct");
});
