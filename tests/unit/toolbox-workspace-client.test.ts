import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const client = fileURLToPath(new URL("../../scripts/toolbox-workspace-client.ts", import.meta.url));
// No profile is supplied: every validation case must stop before filesystem
// preparation or host launch, while exercising the actual operator CLI parser.
const invoke = (...args: string[]) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", client, ...args], {
    cwd: repository, encoding: "utf8", input: "", timeout: 10_000, windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
};

describe("operator workspace-client call timeout", () => {
  it("advertises the unchanged default, bounds and observation-only scope without launching a host", () => {
    const result = invoke("--help");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--call-timeout-ms <milliseconds>");
    expect(result.stdout).toContain("30000..1800000; default 600000");
    expect(result.stdout).toContain("startup stays 30000 ms and native deadlines are unchanged");
    expect(result.stdout).toContain("native outcome unknown; no automatic retries");
  });

  it.each([undefined, "30000", "600000", "1800000"])("accepts %s and then requires the ordinary host profile", value => {
    const result = invoke(...(value === undefined ? [] : ["--call-timeout-ms", value]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing --profile.");
    expect(result.stderr).not.toContain("--call-timeout-ms must");
    expect(result.stdout).toBe("");
  });

  it.each(["", "0", "-1", "29999", "1800001", "NaN", "Infinity", "30000.5", "3e4", " 30000", "030000", "9007199254740992"])(
    "rejects invalid timeout %j before host-profile admission", value => {
      const result = invoke(`--call-timeout-ms=${value}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--call-timeout-ms must be a positive integer from 30000 through 1800000.");
      expect(result.stderr).not.toContain("Missing --profile.");
      expect(result.stdout).toBe("");
    },
  );
});
