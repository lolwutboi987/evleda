import path from "node:path";
import { describe, expect, it } from "vitest";
import { materializeNativeSchematicStyleContext } from "../../src/cli/pcb-agent.js";

const template = '{\r\n  "api": { "interpreter_path": "", "enable_api": false },\r\n  "system": { "working_dir": "" },\r\n  "unrelated": [1, 2, "keep exact spacing"]\r\n}\r\n';
const executable = path.resolve("owned fixture", "KiCad", "bin", "kicad-cli.exe");
const project = path.resolve("owned fixture", "project");

describe("known portable native style context materialization", () => {
  it("changes only the two reviewed empty-string tokens, preserving unrelated bytes and CRLF", () => {
    const actual = materializeNativeSchematicStyleContext(template, executable, project);
    const expected = template.replace('"interpreter_path": ""', `"interpreter_path": ${JSON.stringify(path.join(path.dirname(executable), "pythonw.exe"))}`)
      .replace('"working_dir": ""', `"working_dir": ${JSON.stringify(project)}`);
    expect(actual).toBe(expected);
    expect(actual.endsWith("\r\n")).toBe(true);
    expect(JSON.parse(actual)).toMatchObject({ api: { enable_api: false }, unrelated: [1, 2, "keep exact spacing"] });
  });
  it("uses JSON string escaping for owned paths, not replacement-string interpolation", () => {
    const unusual = path.resolve("owned fixture", "$value", "quoted\"folder");
    const actual = materializeNativeSchematicStyleContext(template, executable, unusual);
    expect(JSON.parse(actual).system.working_dir).toBe(unusual);
  });
  it.each(["existing-interpreter", "existing-cwd", "missing-api", "duplicate-known-key", "duplicate-json-key", "invalid-json"] as const)("rejects an unrecognized/already-materialized template: %s", (kind) => {
    const source = kind === "existing-interpreter" ? template.replace('"interpreter_path": ""', '"interpreter_path": "old.exe"')
      : kind === "existing-cwd" ? template.replace('"working_dir": ""', '"working_dir": "old-project"')
        : kind === "missing-api" ? '{"system":{"working_dir":""}}'
          : kind === "duplicate-known-key" ? template.replace('"unrelated": [1, 2, "keep exact spacing"]', '"other": {"interpreter_path":""}')
            : kind === "duplicate-json-key" ? template.replace('"enable_api": false', '"interpreter_path":"", "enable_api":false') : "{not JSON}";
    expect(() => materializeNativeSchematicStyleContext(source, executable, project)).toThrow();
  });
  it("rejects relative paths and malformed UTF-8 text instead of inventing a context", () => {
    expect(() => materializeNativeSchematicStyleContext(template, "kicad-cli.exe", project)).toThrow();
    expect(() => materializeNativeSchematicStyleContext(template, executable, "project")).toThrow();
    expect(() => materializeNativeSchematicStyleContext(`${template}\ud800`, executable, project)).toThrow();
  });
});
