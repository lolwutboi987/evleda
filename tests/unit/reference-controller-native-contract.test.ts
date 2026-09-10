import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import {
  REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA,
  REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CANONICAL_JSON,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_DIGEST,
  ReferenceControllerNativeContractError,
  evaluateReferenceControllerRevAReferenceSetAgreement,
  parseReferenceControllerNativeContractJson,
  reverifyReferenceControllerRevANativeAuthority,
  referenceControllerNativeContractIdentityPreimage,
  referenceControllerRevASourceBinding,
  referenceSetsAgree,
  snapshotReferenceControllerRevANativeAuthority,
  validateReferenceControllerNativeContract
} from "../../src/knowledge/reference-controller-native-contract.js";

const contractPath = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH;
const testRequire = createRequire(import.meta.url);

const errorCode = (action: () => unknown): string | null => {
  try {
    action();
    return null;
  } catch (error) {
    return error instanceof ReferenceControllerNativeContractError ? error.code : "unexpected";
  }
};

const unescapeKicadString = (value: string): string => value.replace(/\\([\\"])/gu, "$1");

const sExpressionForms = (source: string, name: string): readonly string[] => {
  const forms: string[] = [];
  const marker = `(${name}`;
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf(marker, cursor);
    if (start < 0) break;
    const boundary = source[start + marker.length];
    if (boundary !== undefined && !/[\s)]/u.test(boundary)) {
      cursor = start + marker.length;
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end < 0) throw new Error(`unterminated ${name}`);
    forms.push(source.slice(start, end));
    cursor = end;
  }
  return forms;
};

const stringField = (form: string, field: string): string | null => {
  const match = new RegExp(`\\(${field}\\s+"((?:\\\\.|[^"\\\\])*)"\\)`, "u").exec(form);
  return match?.[1] === undefined ? null : unescapeKicadString(match[1]);
};

const firstCsvColumn = (source: string): readonly string[] => source
  .split(/\r?\n/u)
  .slice(1)
  .filter((line) => line.length > 0)
  .map((line) => {
    const quoted = /^"([^"]+)"/u.exec(line)?.[1];
    return quoted ?? line.split(",", 1)[0]!;
  });

const pinnedText = (role: Parameters<typeof referenceControllerRevASourceBinding>[0]): string =>
  readFileSync(referenceControllerRevASourceBinding(role).path, "utf8");

const nativeObservation = () => {
  const netlist = pinnedText("schematic_netlist");
  const pcb = pinnedText("native_pcb");
  const schematicComponentReferences = sExpressionForms(netlist, "comp")
    .map((form) => stringField(form, "ref"))
    .filter((reference): reference is string => reference !== null);
  const schematicNodeReferences = [
    ...new Set(sExpressionForms(netlist, "node")
      .map((form) => stringField(form, "ref"))
      .filter((reference): reference is string => reference !== null))
  ];
  const positionCandidates = sExpressionForms(pcb, "footprint").map((form) => {
    const reference = /\(property\s+"Reference"\s+"((?:\\.|[^"\\])+)"/u.exec(form)?.[1];
    const side = /\(layer\s+"B\.Cu"\)/u.test(form) ? "bottom" as const : "top" as const;
    const attributes = sExpressionForms(form, "attr").join(" ");
    if (reference === undefined) throw new Error("PCB footprint lacks a reference");
    return {
      reference: unescapeKicadString(reference),
      side,
      dnp: /\bdnp\b/u.test(attributes),
      excludeFromPositionFiles: /\bexclude_from_pos_files\b/u.test(attributes)
    };
  });
  return {
    schematicComponentReferences,
    schematicNodeReferences,
    exportedBomReferences: firstCsvColumn(pinnedText("exported_bom")),
    nativePcbReferences: positionCandidates.map((entry) => entry.reference),
    positionCandidates,
    positionReferences: firstCsvColumn(pinnedText("positions"))
  };
};

const createIsolatedAuthorityFixture = (): string => {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), "native-contract-authority-fixture-"));
  const copyFixtureFile = (relativePath: string): void => {
    const target = resolve(fixtureRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(resolve(relativePath), target);
  };
  for (const relativePath of [
    "src/knowledge/reference-controller-native-contract.ts",
    "src/knowledge/reference-controller-native-contract.v1.json",
    "src/core/canonical.ts",
    "src/domain/errors.ts",
    "src/domain/types.ts"
  ]) {
    copyFixtureFile(relativePath);
  }
  writeFileSync(resolve(fixtureRoot, "package.json"), "{\"type\":\"module\"}\n", "utf8");
  cpSync(
    dirname(testRequire.resolve("zod/package.json")),
    resolve(fixtureRoot, "node_modules/zod"),
    { recursive: true, dereference: true }
  );
  return fixtureRoot;
};

const runIsolatedAuthorityMutationProbe = (): Readonly<Record<string, string>> => {
  const fixtureRoot = createIsolatedAuthorityFixture();
  const probePath = resolve(fixtureRoot, "authority-mutation-probe.ts");
  writeFileSync(probePath, `
import { readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  reverifyReferenceControllerRevANativeAuthority,
  snapshotReferenceControllerRevANativeAuthority
} from "./src/knowledge/reference-controller-native-contract.js";

const sourcePath = fileURLToPath(new URL(
  "./src/knowledge/reference-controller-native-contract.v1.json",
  import.meta.url
));
const originalBytes = await readFile(sourcePath);
const results = {};
const rejectionCode = async (action) => {
  try {
    await action();
    return "accepted";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unexpected";
  }
};

let current = await snapshotReferenceControllerRevANativeAuthority();

const replaceAndRestore = async (label, replacementBytes) => {
  const backupPath = sourcePath + "." + label + ".backup";
  const replacementPath = sourcePath + "." + label + ".replacement";
  await writeFile(replacementPath, replacementBytes);
  await rename(sourcePath, backupPath);
  await rename(replacementPath, sourcePath);
  try {
    results[label] = await rejectionCode(() =>
      reverifyReferenceControllerRevANativeAuthority(current)
    );
  } finally {
    await rm(sourcePath, { force: true });
    await rename(backupPath, sourcePath);
  }
  current = await snapshotReferenceControllerRevANativeAuthority();
  await reverifyReferenceControllerRevANativeAuthority(current);
};

await replaceAndRestore("identicalReplacement", originalBytes);
const changedBytes = Buffer.from(originalBytes);
changedBytes[0] = changedBytes[0] ^ 1;
await replaceAndRestore("changedReplacement", changedBytes);

const deletionBackup = sourcePath + ".deletion.backup";
await rename(sourcePath, deletionBackup);
try {
  results.deletion = await rejectionCode(() =>
    reverifyReferenceControllerRevANativeAuthority(current)
  );
} finally {
  await rename(deletionBackup, sourcePath);
}
current = await snapshotReferenceControllerRevANativeAuthority();
await reverifyReferenceControllerRevANativeAuthority(current);
results.restored = "pass";
results.forgedSnapshot = await rejectionCode(() =>
  reverifyReferenceControllerRevANativeAuthority(structuredClone(current))
);

const symlinkBackup = sourcePath + ".symlink.backup";
await rename(sourcePath, symlinkBackup);
try {
  try {
    await symlink(symlinkBackup, sourcePath, "file");
    results.symlink = await rejectionCode(() =>
      snapshotReferenceControllerRevANativeAuthority()
    );
    await rm(sourcePath, { force: true });
  } catch (error) {
    results.symlink = typeof error === "object" && error !== null && "code" in error
      ? "unsupported:" + String(error.code)
      : "unsupported";
  }
} finally {
  await rm(sourcePath, { force: true });
  await rename(symlinkBackup, sourcePath);
}
const finalSnapshot = await snapshotReferenceControllerRevANativeAuthority();
await reverifyReferenceControllerRevANativeAuthority(finalSnapshot);
results.finalRestore = "pass";
process.stdout.write(JSON.stringify(results));
`, "utf8");

  try {
    const execution = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(testRequire.resolve("tsx")).href, probePath],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 20_000
      }
    );
    if (execution.status !== 0) {
      throw new Error(`Authority mutation probe failed: ${execution.stderr}`);
    }
    return JSON.parse(execution.stdout) as Readonly<Record<string, string>>;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};

type ColdImportMutation = "empty" | "oversized" | "sparse" | "case_variant" | "symlink";

const runIsolatedColdImportProbe = (mutation: ColdImportMutation): string => {
  const fixtureRoot = createIsolatedAuthorityFixture();
  let modulePath = resolve(
    fixtureRoot,
    "src/knowledge/reference-controller-native-contract.ts"
  );
  let sourcePath = resolve(
    fixtureRoot,
    REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH
  );
  try {
    if (mutation === "empty") {
      writeFileSync(sourcePath, Buffer.alloc(0));
    } else if (mutation === "oversized") {
      writeFileSync(
        sourcePath,
        Buffer.alloc(REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES + 1, 0x20)
      );
    } else if (mutation === "sparse") {
      truncateSync(sourcePath, REFERENCE_CONTROLLER_NATIVE_CONTRACT_MAX_BYTES * 16);
    } else if (mutation === "case_variant") {
      const originalSourceRoot = resolve(fixtureRoot, "src");
      const intermediateSourceRoot = resolve(fixtureRoot, "source-case-intermediate");
      const caseVariantSourceRoot = resolve(fixtureRoot, "SRC");
      renameSync(originalSourceRoot, intermediateSourceRoot);
      renameSync(intermediateSourceRoot, caseVariantSourceRoot);
      modulePath = resolve(
        caseVariantSourceRoot,
        "knowledge/reference-controller-native-contract.ts"
      );
      sourcePath = resolve(
        caseVariantSourceRoot,
        "knowledge/reference-controller-native-contract.v1.json"
      );
    } else {
      const backupPath = `${sourcePath}.symlink-target`;
      renameSync(sourcePath, backupPath);
      try {
        symlinkSync(backupPath, sourcePath, "file");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "unknown";
        return `unsupported:${code}`;
      }
    }

    const probePath = resolve(fixtureRoot, "cold-import-probe.ts");
    writeFileSync(probePath, `
try {
  await import(${JSON.stringify(pathToFileURL(modulePath).href)});
  process.stdout.write("accepted");
} catch (error) {
  process.stdout.write(
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "unexpected"
  );
}
`, "utf8");
    const execution = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(testRequire.resolve("tsx")).href, probePath],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 20_000
      }
    );
    if (execution.status !== 0) {
      throw new Error(`Cold authority import probe failed: ${execution.stderr}`);
    }
    return execution.stdout;
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
};

describe("Rev-A native contract authority", () => {
  it("loads exact canonical bytes under independent semantic and content trust anchors", () => {
    const source = readFileSync(contractPath, "utf8");

    expect(source).toBe(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CANONICAL_JSON);
    expect(parseReferenceControllerNativeContractJson(source)).toStrictEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT
    );
    expect(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY.digest).toBe(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_DIGEST
    );
    expect(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY).toStrictEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY
    );
    expect(contentIdentity(source)).toStrictEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_CONTENT_IDENTITY
    );
    expect(
      canonicalIdentity(
        referenceControllerNativeContractIdentityPreimage(
          REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT
        ),
        REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA
      )
    ).toStrictEqual(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY);
    expect(Object.isFrozen(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT)).toBe(true);
    expect(Object.isFrozen(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators.mcu)).toBe(true);
  });

  it("verifies every repository-relative raw source binding without duplicated test digests", () => {
    for (const binding of REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.sourceBindings) {
      const bytes = readFileSync(binding.path);
      expect(contentIdentity(bytes), binding.role).toStrictEqual(binding.identity);
    }
  });

  it("issues a deeply frozen ordinary-file authority snapshot and idempotently reverifies it", async () => {
    const snapshot = await snapshotReferenceControllerRevANativeAuthority();

    expect(snapshot.sourcePath).toBe(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH);
    expect(snapshot.fileBinding).toStrictEqual({
      path: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
      sizeBytes: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.size,
      sha256: REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY.digest
    });
    expect(snapshot.contract).toStrictEqual(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT);
    expect(snapshot.semanticIdentity).toStrictEqual(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_IDENTITY);
    expect(snapshot.contentIdentity).toStrictEqual(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY);
    expect(snapshot.canonicalJson).toBe(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CANONICAL_JSON);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.fileInstance)).toBe(true);
    expect(Object.isFrozen(snapshot.contract)).toBe(true);
    await reverifyReferenceControllerRevANativeAuthority(snapshot);
    await reverifyReferenceControllerRevANativeAuthority(snapshot);

    await expect(reverifyReferenceControllerRevANativeAuthority(
      structuredClone(snapshot) as typeof snapshot
    )).rejects.toMatchObject({
      code: "REFERENCE_NATIVE_CONTRACT_INVALID_AUTHORITY_SNAPSHOT"
    });
  });

  it("detects same-process replacement and deletion and accepts only a restored authority", () => {
    const results = runIsolatedAuthorityMutationProbe();

    expect(results.identicalReplacement).toBe("REFERENCE_NATIVE_CONTRACT_SOURCE_CHANGED");
    expect(results.changedReplacement).toBe(
      "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH"
    );
    expect(results.deletion).toBe("REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE");
    expect(results.restored).toBe("pass");
    expect(results.forgedSnapshot).toBe(
      "REFERENCE_NATIVE_CONTRACT_INVALID_AUTHORITY_SNAPSHOT"
    );
    expect(results.symlink === "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY" ||
      results.symlink?.startsWith("unsupported:")).toBe(true);
    expect(results.finalRestore).toBe("pass");
  });

  it.each(["empty", "oversized", "sparse"] as const)(
    "rejects a %s authority during bounded cold import before exporting semantics",
    (mutation) => {
      expect(runIsolatedColdImportProbe(mutation)).toBe(
        "REFERENCE_NATIVE_CONTRACT_TOO_LARGE"
      );
    }
  );

  it("rejects a cold-import source reached through a case-variant path", () => {
    const result = runIsolatedColdImportProbe("case_variant");
    expect(result).not.toBe("accepted");
    expect([
      "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY",
      "REFERENCE_NATIVE_CONTRACT_SOURCE_UNAVAILABLE"
    ]).toContain(result);
  });

  it("rejects a cold-import source that is a symbolic-link/reparse alias when supported", () => {
    const result = runIsolatedColdImportProbe("symlink");
    expect(
      result === "REFERENCE_NATIVE_CONTRACT_SOURCE_NOT_ORDINARY" ||
      result.startsWith("unsupported:")
    ).toBe(true);
  });

  it("rejects a semantic edit even when an attacker coherently rehashes the embedded identity", () => {
    const tampered = structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT) as unknown as Record<string, unknown>;
    const interfaces = tampered.interfaceEndpointFingerprints as Array<{
      signals: Array<{ endpoints: Array<{ pin: string }> }>;
    }>;
    interfaces[0]!.signals[0]!.endpoints[0]!.pin = "9";
    const { identity: _identity, ...preimage } = tampered;
    tampered.identity = canonicalIdentity(preimage, REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA);

    expect(errorCode(() => validateReferenceControllerNativeContract(tampered))).toBe(
      "REFERENCE_NATIVE_CONTRACT_IDENTITY_MISMATCH"
    );
  });

  it("rejects unknown fields before accepting a signed contract", () => {
    const tampered = structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT) as unknown as Record<string, unknown>;
    tampered.unreviewedAuthority = true;

    expect(errorCode(() => validateReferenceControllerNativeContract(tampered))).toBe(
      "REFERENCE_NATIVE_CONTRACT_INVALID_STRUCTURE"
    );
  });

  it("canonicalizes object key order but rejects noncanonical raw key order", () => {
    const reordered = Object.fromEntries(
      Object.entries(structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT)).reverse()
    );
    expect(validateReferenceControllerNativeContract(reordered)).toStrictEqual(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT
    );
    expect(canonicalJson(reordered)).toBe(
      canonicalJson(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT)
    );

    const reorderedRaw = `${JSON.stringify(reordered)}\n`;
    expect(errorCode(() => parseReferenceControllerNativeContractJson(reorderedRaw))).toBe(
      "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH"
    );
  });

  it("rejects duplicate JSON keys through the exact raw-byte trust anchor", () => {
    const source = readFileSync(contractPath, "utf8");
    const duplicate = source.replace(
      "{\"architectureNetAliases\":",
      "{\"schemaVersion\":\"evleda.reference-controller-native-contract.v1\",\"schemaVersion\":\"evleda.reference-controller-native-contract.v1\",\"architectureNetAliases\":"
    );
    expect(duplicate).not.toBe(source);
    expect(errorCode(() => parseReferenceControllerNativeContractJson(duplicate))).toBe(
      "REFERENCE_NATIVE_CONTRACT_CONTENT_IDENTITY_MISMATCH"
    );
  });

  it("rejects placeholder, malformed, and ordinary identity substitutions", () => {
    for (const digest of ["0".repeat(64), "f".repeat(64), "not-a-digest"]) {
      const tampered = structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT);
      (tampered.identity as { digest: string }).digest = digest;
      expect(errorCode(() => validateReferenceControllerNativeContract(tampered)), digest)
        .not.toBeNull();
    }
  });

  it("rejects duplicate semantic entries and unreviewed alias targets", () => {
    const duplicate = structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT) as unknown as {
      requiredNativeNets: string[];
    };
    duplicate.requiredNativeNets[1] = duplicate.requiredNativeNets[0]!;
    expect(errorCode(() => validateReferenceControllerNativeContract(duplicate))).toBe(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT"
    );

    const unreviewed = structuredClone(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT) as unknown as {
      signalAliases: Record<string, string>;
      identity: ReturnType<typeof canonicalIdentity>;
      [key: string]: unknown;
    };
    unreviewed.signalAliases.CAN_RX = "UNREVIEWED_NET";
    const { identity: _identity, ...preimage } = unreviewed;
    unreviewed.identity = canonicalIdentity(preimage, REFERENCE_CONTROLLER_NATIVE_CONTRACT_SCHEMA);
    expect(errorCode(() => validateReferenceControllerNativeContract(unreviewed))).toBe(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT"
    );
  });

  it("keeps the JSON Schema root and semantic identity anchor aligned with the authority", () => {
    const schema = JSON.parse(readFileSync(
      "src/knowledge/reference-controller-native-contract.schema.json",
      "utf8"
    )) as {
      required: string[];
      $defs: { canonicalIdentity: { properties: { digest: { const: string } } } };
    };
    expect([...schema.required].sort()).toStrictEqual(
      Object.keys(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT).sort()
    );
    expect(schema.$defs.canonicalIdentity.properties.digest.const).toBe(
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_TRUSTED_DIGEST
    );
  });

  it("binds all required nets and every interface fingerprint to exact netlist endpoints", () => {
    const netlist = pinnedText("schematic_netlist");
    const nodesByNet = new Map<string, string[]>();
    for (const netForm of sExpressionForms(netlist, "net")) {
      const nativeNet = stringField(netForm, "name");
      if (nativeNet === null) throw new Error("net lacks a name");
      nodesByNet.set(nativeNet, sExpressionForms(netForm, "node")
        .map((node) => {
          const reference = stringField(node, "ref");
          const pin = stringField(node, "pin");
          if (reference === null || pin === null) throw new Error("node lacks an endpoint");
          return `${reference}.${pin}`;
        })
        .sort());
    }

    for (const nativeNet of REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.requiredNativeNets) {
      expect(nodesByNet.has(nativeNet), nativeNet).toBe(true);
    }
    for (const fingerprint of REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.interfaceEndpointFingerprints) {
      for (const signal of fingerprint.signals) {
        const expected = signal.endpoints
          .map((endpoint) => `${endpoint.reference}.${endpoint.pin}`)
          .sort();
        expect(nodesByNet.get(signal.nativeNet), `${fingerprint.interface}:${signal.nativeNet}`)
          .toStrictEqual(expected);
      }
    }
  });

  it("derives exact physical, node, and eligible position reference-set agreement", () => {
    const report = evaluateReferenceControllerRevAReferenceSetAgreement(nativeObservation());

    expect(report.passed).toBe(true);
    expect(referenceSetsAgree(report)).toBe(true);
    expect(report.differences.every((entry) =>
      entry.missing.length === 0 && entry.unexpected.length === 0
    )).toBe(true);
    for (const exclusion of report.classifiedExclusions.schematicNodes) {
      expect(report.canonicalPhysicalReferences).toContain(exclusion.reference);
      expect(report.expectedSchematicNodeReferences).not.toContain(exclusion.reference);
    }
    for (const exclusion of report.classifiedExclusions.schematicSourceOnly) {
      expect(report.canonicalPhysicalReferences).not.toContain(exclusion.reference);
    }
  });

  it("allows source-derived DNP and KiCad position exclusions without weakening other ref sets", () => {
    const observation = nativeObservation();
    const first = observation.positionCandidates[0]!;
    const second = observation.positionCandidates[1]!;
    observation.positionCandidates[0] = { ...first, dnp: true };
    observation.positionCandidates[1] = { ...second, excludeFromPositionFiles: true };
    observation.positionReferences = observation.positionReferences.filter(
      (reference) => reference !== first.reference && reference !== second.reference
    );

    const report = evaluateReferenceControllerRevAReferenceSetAgreement(observation);
    expect(report.passed).toBe(true);
    expect(referenceSetsAgree(report)).toBe(true);
  });

  it("reports a missing eligible position and rejects duplicate observed references", () => {
    const missing = nativeObservation();
    missing.positionReferences = missing.positionReferences.slice(1);
    const report = evaluateReferenceControllerRevAReferenceSetAgreement(missing);
    expect(report.passed).toBe(false);
    expect(referenceSetsAgree(report)).toBe(false);
    expect(report.differences.find((entry) => entry.source === "positions")?.missing).toHaveLength(1);

    const duplicate = nativeObservation();
    duplicate.exportedBomReferences = [
      ...duplicate.exportedBomReferences,
      duplicate.exportedBomReferences[0]!
    ];
    expect(errorCode(() => evaluateReferenceControllerRevAReferenceSetAgreement(duplicate))).toBe(
      "REFERENCE_NATIVE_CONTRACT_INCONSISTENT"
    );
  });

  it("requires explicit architecture aliases for every schematic-intent semantic net", () => {
    expect(REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.schematicIntentRequiredSemanticNets)
      .toHaveLength(14);
    for (const semanticNet of REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT
      .schematicIntentRequiredSemanticNets) {
      const aliases = REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT
        .architectureNetAliases[semanticNet];
      expect(aliases, semanticNet).toBeDefined();
      expect(aliases!.length, semanticNet).toBeGreaterThan(0);
    }
  });
});
