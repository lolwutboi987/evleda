import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalIdentity, contentIdentity } from "../../src/core/canonical.js";
import { FileFluxCompilationBundleStore } from "../../src/flux/compilation-bundle-store.js";
import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import {
  PCB_DESIGN_COMPILATION_BUNDLE_LIMITS,
  PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
  createPcbDesignCompilationBundle,
  createPcbDesignCompilationBundleRef,
  serializePcbDesignCompilationBundle,
  type PcbDesignCompilationBundle,
  type PcbDesignCompilationBundleDependencies,
  type PcbDesignCompilationBundleRef,
} from "../../src/harness/pcb-design-compilation-bundle.js";
import {
  compilePcbDesignIntentDraft,
  type PcbReadOnlyLibraryResolver,
} from "../../src/harness/pcb-design-compiler.js";
import { PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION } from "../../src/harness/pcb-design-contract.js";

const catalog = loadDeepRuleCatalog();

const resolver: PcbReadOnlyLibraryResolver = {
  resolveSymbol: (libraryId) => libraryId === "Connector_Generic:Conn_01x02"
    ? {
        libraryId,
        source: "kicad-stock",
        unitCount: 1,
        componentKind: "connector",
        polarized: false,
        pins: [
          { number: "1", function: "Pin 1" },
          { number: "2", function: "Pin 2" },
        ],
      }
    : null,
  resolveFootprint: (libraryId) =>
    libraryId === "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical"
      ? { libraryId, source: "kicad-stock", packageKind: "generic", pads: ["1", "2"] }
      : null,
};

const dependencies: PcbDesignCompilationBundleDependencies = {
  libraryResolver: resolver,
  deepRuleCatalog: catalog,
};

const electrical = (voltage: number) => ({
  voltage: { minimumV: voltage, nominalV: voltage, maximumV: voltage },
  current: {
    nominalA: 0.1,
    maximumContinuousA: 0.1,
    peakA: 0.1,
    peakDurationMs: 1_000,
  },
  speed: { kind: "dc", maximumFrequencyMHz: 0, minimumEdgeTimeNs: null },
});

const placement = (
  reference: string,
  edgePreference: "left" | "right",
  rotation: 0 | 180,
) => ({
  reference,
  side: "front",
  regionMm: { minXmm: 1, maxXmm: 29, minYmm: 1, maxYmm: 19 },
  allowedRotationsDeg: [rotation],
  minimumEdgeClearanceMm: 1,
  minimumCourtyardClearanceMm: 0.25,
  edgePreference,
});

const makeBundle = (prompt = "Persist this exact candidate bundle. 🧪") => {
  const compilation = compilePcbDesignIntentDraft({
    schemaVersion: PCB_DESIGN_INTENT_DRAFT_SCHEMA_VERSION,
    kind: "pcb_design_intent_draft",
    scope: {
      sheetCount: 1,
      componentUnitPolicy: "single_unit",
      board: {
        shape: "rectangle",
        widthMm: 30,
        heightMm: 20,
        layerCount: 2,
        copperLayers: ["F.Cu", "B.Cu"],
      },
    },
    components: ["J1", "J2"].map((reference) => ({
      reference,
      symbolLibId: "Connector_Generic:Conn_01x02",
      value: reference === "J1" ? "POWER_IN" : "POWER_OUT",
      footprintLibId: "Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical",
      unit: 1,
      pins: [
        { pin: "1", assignment: { kind: "net", net: "VIN" } },
        { pin: "2", assignment: { kind: "net", net: "GND" } },
      ],
    })),
    nets: [
      {
        name: "VIN",
        role: "power_input",
        endpoints: [{ reference: "J1", pin: "1" }, { reference: "J2", pin: "1" }],
        electrical: electrical(5),
        netClassId: "POWER",
      },
      {
        name: "GND",
        role: "ground",
        endpoints: [{ reference: "J1", pin: "2" }, { reference: "J2", pin: "2" }],
        electrical: electrical(0),
        netClassId: "POWER",
      },
    ],
    netClasses: [{
      id: "POWER",
      traceWidthMm: 0.5,
      clearanceMm: 0.25,
      copperToEdgeMm: 0.3,
      allowedLayers: ["F.Cu"],
    }],
    placementConstraints: [placement("J1", "left", 0), placement("J2", "right", 180)],
    routingConstraints: {
      cornerStyle: "miter_45",
      maximumTurnAngleDeg: 45,
      minimumStraightBeforeTurnMm: 0.25,
      allowRightAngleCorners: false,
      allowAcuteInteriorCorners: false,
      allowBacktracking: false,
      allowSelfIntersections: false,
      viaPolicy: { mode: "forbidden", maxTotal: 0 },
      nets: ["VIN", "GND"].map((net) => ({
        net,
        topology: "point_to_point",
        preferredLayer: "F.Cu",
        maxVias: 0,
        routeLength: { mode: "unbounded" },
      })),
    },
    unresolved: [],
  }, dependencies);
  expect(compilation.disposition).toBe("ready");
  return createPcbDesignCompilationBundle({ originalPrompt: prompt, compilation }, dependencies);
};

const recursivelyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value)
    && Object.values(value).every((entry) => recursivelyFrozen(entry, seen));
};

const blobPath = (workspaceRoot: string, identity: { readonly digest: string }): string => join(
  workspaceRoot,
  "content",
  "compilation-bundles",
  "blobs",
  "sha256",
  identity.digest.slice(0, 2),
  identity.digest.slice(2),
);

const referenceFor = (
  bundle: PcbDesignCompilationBundle,
  bytes: Uint8Array,
): PcbDesignCompilationBundleRef => {
  const payload = {
    schemaVersion: PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
    bundleIdentity: bundle.identity,
    contentIdentity: contentIdentity(bytes),
  };
  return {
    ...payload,
    identity: canonicalIdentity(payload, PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION),
  };
};

const roots: string[] = [];

const temporaryWorkspace = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "evleda-flux-bundles-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("FileFluxCompilationBundleStore", () => {
  it("revalidates, stores canonical LF bytes, coalesces identical puts, and returns frozen data", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies);
    const bundle = makeBundle();

    const references = await Promise.all(Array.from(
      { length: 12 },
      () => store.put(structuredClone(bundle)),
    ));
    expect(references.every((entry) => entry === references[0])).toBe(true);
    expect(references.every((entry) => recursivelyFrozen(entry))).toBe(true);

    const reference = references[0]!;
    const exactBytes = serializePcbDesignCompilationBundle(bundle);
    expect(await readFile(blobPath(workspaceRoot, reference.contentIdentity))).toStrictEqual(exactBytes);
    const restored = await store.get(structuredClone(reference));
    expect(restored).toStrictEqual(bundle);
    expect(recursivelyFrozen(restored)).toBe(true);
  });

  it("does not read an outside file when the digest shard is swapped after validation", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    let attack = false;
    let swapped = false;
    let readBytes = 0;
    let shard = "";
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterReadPathValidation: async () => {
          if (!attack || swapped) return;
          swapped = true;
          await rename(shard, `${shard}.parked`);
          await symlink(outside, shard, process.platform === "win32" ? "junction" : "dir");
        },
        onReadChunk: (bytesRead) => {
          if (attack) readBytes += bytesRead;
        },
      },
    });
    const bundle = makeBundle();
    const reference = await store.put(bundle);
    shard = dirname(blobPath(workspaceRoot, reference.contentIdentity));
    const outsideTarget = join(outside, reference.contentIdentity.digest.slice(2));
    const outsideMarker = Buffer.from("outside bytes must never be consumed", "utf8");
    await writeFile(outsideTarget, outsideMarker);

    attack = true;
    await expect(store.get(reference)).rejects.toBeDefined();
    expect(swapped).toBe(true);
    expect(readBytes).toBe(0);
    expect(await readFile(outsideTarget)).toStrictEqual(outsideMarker);
  });

  it("does not consume a replacement file installed between path validation and open", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    let attack = false;
    let swapped = false;
    let readBytes = 0;
    let target = "";
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterReadPathValidation: async () => {
          if (!attack || swapped) return;
          swapped = true;
          await rename(target, `${target}.parked`);
          await link(join(outside, "replacement"), target);
        },
        onReadChunk: (bytesRead) => {
          if (attack) readBytes += bytesRead;
        },
      },
    });
    const bundle = makeBundle();
    const reference = await store.put(bundle);
    target = blobPath(workspaceRoot, reference.contentIdentity);
    const outsideBytes = serializePcbDesignCompilationBundle(bundle);
    await writeFile(join(outside, "replacement"), outsideBytes);

    attack = true;
    await expect(store.get(reference)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
    expect(swapped).toBe(true);
    expect(readBytes).toBe(0);
    expect(await readFile(join(outside, "replacement"))).toStrictEqual(outsideBytes);
  });

  it("caps a blob that grows after handle stat at exact expected bytes plus one", async () => {
    const workspaceRoot = await temporaryWorkspace();
    let attack = false;
    let enlarged = false;
    let largestObservedRead = 0;
    let target = "";
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterReadHandleValidation: async () => {
          if (!attack || enlarged) return;
          enlarged = true;
          await truncate(
            target,
            PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes + 1_024,
          );
        },
        onReadChunk: (_bytesRead, totalBytesRead) => {
          if (attack) largestObservedRead = Math.max(largestObservedRead, totalBytesRead);
        },
      },
    });
    const reference = await store.put(makeBundle());
    target = blobPath(workspaceRoot, reference.contentIdentity);

    attack = true;
    await expect(store.get(reference)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
    expect(enlarged).toBe(true);
    expect(largestObservedRead).toBe(reference.contentIdentity.size + 1);
    expect(largestObservedRead).toBeLessThanOrEqual(
      PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes + 1,
    );
  });

  it("rejects and scrubs an outside hard-link alias added during stage write/fsync", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    const bundle = makeBundle();
    const reference = createPcbDesignCompilationBundleRef(bundle);
    const target = blobPath(workspaceRoot, reference.contentIdentity);
    const stagingRoot = join(workspaceRoot, "content", "compilation-bundles", "staging");
    const outsideAlias = join(outside, "captured-stage-alias");
    let aliasCreated = false;
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterStageWriteBeforeSync: async () => {
          const stagingEntries = await readdir(stagingRoot);
          expect(stagingEntries).toHaveLength(1);
          await link(join(stagingRoot, stagingEntries[0]!), outsideAlias);
          aliasCreated = true;
        },
      },
    });

    await expect(store.put(bundle)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
    expect(aliasCreated).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(stagingRoot)).toStrictEqual([]);
    expect((await lstat(outsideAlias, { bigint: true })).nlink).toBe(1n);
    expect(await readFile(outsideAlias)).toStrictEqual(Buffer.alloc(0));
  });

  it("does not publish outside when the digest shard is swapped before atomic link", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    const bundle = makeBundle();
    const reference = createPcbDesignCompilationBundleRef(bundle);
    const shard = dirname(blobPath(workspaceRoot, reference.contentIdentity));
    let swapped = false;
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterPublishPathValidation: async () => {
          if (swapped) return;
          swapped = true;
          await rename(shard, `${shard}.parked`);
          await symlink(outside, shard, process.platform === "win32" ? "junction" : "dir");
        },
      },
    });

    await expect(store.put(bundle)).rejects.toMatchObject({ code: "PATH_POLICY" });
    expect(swapped).toBe(true);
    await expect(lstat(join(outside, reference.contentIdentity.digest.slice(2))))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(workspaceRoot, "content", "compilation-bundles", "staging")))
      .toStrictEqual([]);
  });

  it("rejects a publish target replaced before read-back without reading the replacement", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    const bundle = makeBundle();
    const reference = createPcbDesignCompilationBundleRef(bundle);
    const target = blobPath(workspaceRoot, reference.contentIdentity);
    const outsidePath = join(outside, "replacement");
    const outsideBytes = serializePcbDesignCompilationBundle(bundle);
    await writeFile(outsidePath, outsideBytes);
    let replaced = false;
    let readBytes = 0;
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies, {
      testHooks: {
        afterPublish: async () => {
          if (replaced) return;
          replaced = true;
          await rename(target, `${target}.parked`);
          await link(outsidePath, target);
        },
        onReadChunk: (bytesRead) => {
          readBytes += bytesRead;
        },
      },
    });

    await expect(store.put(bundle)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
    expect(replaced).toBe(true);
    expect(readBytes).toBe(0);
    expect(await readFile(outsidePath)).toStrictEqual(outsideBytes);
  });

  it.each([
    ["BOM", (canonical: Buffer) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]), "INVALID_INPUT"],
    ["CRLF", (canonical: Buffer) => Buffer.concat([canonical.subarray(0, -1), Buffer.from("\r\n")]), "NON_CANONICAL_BYTES"],
    ["pretty JSON", (canonical: Buffer) => Buffer.from(`${JSON.stringify(JSON.parse(canonical.toString("utf8")), null, 2)}\n`), "NON_CANONICAL_BYTES"],
    ["an extra LF", (canonical: Buffer) => Buffer.concat([canonical, Buffer.from("\n")]), "NON_CANONICAL_BYTES"],
  ])("rejects %s even when its exact content identity is reminted", async (_label, mutate, code) => {
    const workspaceRoot = await temporaryWorkspace();
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies);
    const bundle = makeBundle();
    const bytes = mutate(serializePcbDesignCompilationBundle(bundle));
    const reference = referenceFor(bundle, bytes);
    const target = blobPath(workspaceRoot, reference.contentIdentity);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);

    await expect(store.get(reference)).rejects.toMatchObject({ code });
  });

  it("fully revalidates an in-memory bundle before writing anything", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies);
    const tampered = structuredClone(makeBundle()) as unknown as {
      executionPrompt: { text: string };
    };
    tampered.executionPrompt.text += "\nUnbound provider instruction.";

    await expect(store.put(tampered)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
    await expect(lstat(join(
      workspaceRoot,
      "content",
      "compilation-bundles",
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for missing, corrupt, replaced, and nested-identity-mismatched blobs", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies);
    const first = makeBundle("First exact bundle");
    const missing = createPcbDesignCompilationBundleRef(first);
    await expect(store.get(missing)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const reference = await store.put(first);
    const target = blobPath(workspaceRoot, reference.contentIdentity);
    await writeFile(target, "corrupt replacement");
    await expect(store.get(reference)).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });

    await rm(target, { force: true });
    await mkdir(target);
    await expect(store.get(reference)).rejects.toMatchObject({ code: "PATH_POLICY" });

    await rm(target, { recursive: true, force: true });
    const firstBytes = serializePcbDesignCompilationBundle(first);
    await writeFile(target, firstBytes);
    const second = makeBundle("A different exact bundle identity");
    const mismatchedPayload = {
      schemaVersion: PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
      bundleIdentity: second.identity,
      contentIdentity: reference.contentIdentity,
    };
    const mismatched: PcbDesignCompilationBundleRef = {
      ...mismatchedPayload,
      identity: canonicalIdentity(
        mismatchedPayload,
        PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
      ),
    };
    await expect(store.get(mismatched)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
    });
  });

  it("accepts no caller path, bounds references, and rejects linked storage roots", async () => {
    const workspaceRoot = await temporaryWorkspace();
    const store = new FileFluxCompilationBundleStore(workspaceRoot, dependencies);
    await expect(store.get("../../outside.json")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(() => new FileFluxCompilationBundleStore("relative/workspace", dependencies)).toThrow(
      expect.objectContaining({ code: "PATH_POLICY" }),
    );

    const bundle = makeBundle();
    const oversizedPayload = {
      schemaVersion: PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
      bundleIdentity: bundle.identity,
      contentIdentity: {
        algorithm: "sha256" as const,
        digest: "a".repeat(64),
        size: PCB_DESIGN_COMPILATION_BUNDLE_LIMITS.maxBundleBytes + 1,
      },
    };
    await expect(store.get({
      ...oversizedPayload,
      identity: canonicalIdentity(
        oversizedPayload,
        PCB_DESIGN_COMPILATION_BUNDLE_REF_SCHEMA_VERSION,
      ),
    })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });

    const linkedWorkspace = await temporaryWorkspace();
    const outside = await temporaryWorkspace();
    await mkdir(join(linkedWorkspace, "content"));
    try {
      await symlink(outside, join(linkedWorkspace, "content", "compilation-bundles"), "junction");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    const linkedStore = new FileFluxCompilationBundleStore(linkedWorkspace, dependencies);
    await expect(linkedStore.get(createPcbDesignCompilationBundleRef(bundle))).rejects.toMatchObject({
      code: "PATH_POLICY",
    });
  });
});
