import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  canonicalPortableJson,
  portableCanonicalIdentity,
  portableContentIdentity,
  withPrivateRawCaptureReceiptV2Identities,
  type PortableSourceBindingV1,
  type ToolContentIdentityV1
} from "../../src/core/portable-artifact.js";
import type { ContentStorePort } from "../../src/application/ports.js";
import { FileContentStore } from "../../src/persistence/content-store.js";
import {
  DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY,
  MEMORY_PRIVATE_KICAD_CAPTURE_AUTHORITY,
  PRIVATE_KICAD_CAPTURE_FILE_ROLES,
  PRIVATE_KICAD_CAPTURE_STORE_PORT,
  type DevelopmentMemoryPrivateKicadCaptureStorePort,
  type DurablePrivateKicadCaptureStorePort,
  type PrivateKicadCaptureAppend,
  type PrivateKicadCaptureRecordId,
  type PrivateKicadFullResultDraftV1,
  type PrivateKicadFullResultV1
} from "../../src/persistence/private-kicad-capture-port.js";
import {
  DurablePrivateKicadCaptureStore,
  withPrivateKicadFullResultIdentity,
  type DurablePrivateKicadCaptureStoreOptions
} from "../../src/persistence/private-kicad-capture-store.js";

const temporaryRoots: string[] = [];

interface StoreFixture {
  readonly base: string;
  readonly privateRoot: string;
  readonly publicRoot: string;
  readonly store: DurablePrivateKicadCaptureStore;
}

const makeStore = async (
  overrides: Partial<DurablePrivateKicadCaptureStoreOptions> = {}
): Promise<StoreFixture> => {
  const base = await mkdtemp(path.join(tmpdir(), "evleda-private-capture-"));
  temporaryRoots.push(base);
  const privateRoot = path.join(base, "private-cas");
  const publicRoot = path.join(base, "public-cas");
  await mkdir(publicRoot);
  const store = new DurablePrivateKicadCaptureStore({
    privateRoot,
    disjointFrom: [{ label: "public-content-store", path: publicRoot }],
    ...overrides
  });
  return { base, privateRoot, publicRoot, store };
};

const toolIdentity = (): ToolContentIdentityV1 => ({
  schemaVersion: "evleda.tool-content-identity.v1",
  role: "native_validator",
  kind: "native_executable",
  name: "kicad-cli",
  version: "10.0.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  contentIdentity: portableContentIdentity("kicad-cli executable"),
  capabilitiesIdentity: portableContentIdentity("kicad-cli capabilities"),
  helpIdentity: portableContentIdentity("kicad-cli help")
});

const makeCapture = (
  store: DurablePrivateKicadCaptureStore,
  options: {
    readonly recordId?: PrivateKicadCaptureRecordId;
    readonly raw?: Buffer;
    readonly source?: Buffer;
    readonly stdout?: Buffer;
    readonly stderr?: Buffer;
    readonly fullResult?: Buffer;
    readonly capturedAt?: string;
  } = {}
): PrivateKicadCaptureAppend => {
  const recordId = options.recordId ?? store.mintRecordId();
  const raw = options.raw ?? Buffer.from("%PDF-1.7\nprivate validation report\n", "utf8");
  const source = options.source ?? Buffer.from("(kicad_sch (version 20250114))\n", "utf8");
  const stdout = options.stdout ?? Buffer.from("exported private report\n", "utf8");
  const stderr = options.stderr ?? Buffer.alloc(0);
  const sourceBinding: PortableSourceBindingV1 = {
    schemaVersion: "evleda.portable-source-binding.v1",
    sourceRevisionIdentity: portableCanonicalIdentity(
      { revision: "private-store-test" },
      "evleda.source-revision.v1"
    ),
    sourceArtifactIdentity: portableContentIdentity(source),
    sourcePath: {
      schemaVersion: "evleda.portable-path-ref.v1",
      root: "run_input",
      relativePath: "candidate/board.kicad_sch"
    },
    sourceContractIdentity: portableCanonicalIdentity(
      { contract: "native" },
      "evleda.source-contract.v1"
    )
  };
  const receipt = withPrivateRawCaptureReceiptV2Identities({
    schemaVersion: "evleda.private-raw-capture-receipt.v2",
    authority: "private-non-authoritative",
    reportKind: "kicad_pdf",
    sourceBinding,
    rawContentIdentity: portableContentIdentity(raw),
    privateRawPath: {
      schemaVersion: "evleda.portable-path-ref.v1",
      root: "run_private",
      relativePath: "captures/report.pdf"
    },
    nativeContractIdentity: portableCanonicalIdentity(
      { native: "contract" },
      "evleda.native-validation-contract.v1"
    ),
    normalizerContractIdentity: portableCanonicalIdentity(
      { normalizer: "contract" },
      "evleda.portable-normalizer-contract.v1"
    ),
    toolIdentity: toolIdentity(),
    commandPlanIdentity: portableCanonicalIdentity(
      { command: "sch export pdf" },
      "evleda.typed-command-plan.v1"
    ),
    invocationIdentity: portableCanonicalIdentity(
      { invocation: "private-store-test" },
      "evleda.tool-invocation.v1"
    ),
    stdoutIdentity: portableContentIdentity(stdout),
    stderrIdentity: portableContentIdentity(stderr),
    exitCode: 0,
    outcome: "succeeded",
    publicSemanticIdentity: null,
    capturedAt: options.capturedAt ?? "2026-09-05T12:00:00.000Z",
    timestampDisposition: "excluded-private"
  });
  const privateReceipt = Buffer.from(`${canonicalPortableJson(receipt)}\n`, "utf8");
  const fullResultRecord = withPrivateKicadFullResultIdentity({
    schemaVersion: "evleda.private-kicad-full-result.v1",
    authority: "private-storage-consistency-only",
    reportKind: receipt.reportKind,
    rawContentIdentity: receipt.rawContentIdentity,
    sourceContentIdentity: receipt.sourceBinding.sourceArtifactIdentity,
    stdoutIdentity: receipt.stdoutIdentity,
    stderrIdentity: receipt.stderrIdentity,
    commandPlanIdentity: receipt.commandPlanIdentity,
    invocationIdentity: receipt.invocationIdentity,
    captureIdentity: receipt.captureIdentity,
    privateReceiptContentIdentity: portableContentIdentity(privateReceipt),
    privateReceiptRecordIdentity: receipt.receiptIdentity,
    outcome: receipt.outcome,
    exitCode: receipt.exitCode,
    releaseAuthorized: false
  });
  const fullResult = options.fullResult ?? Buffer.from(
    `${canonicalPortableJson(fullResultRecord)}\n`,
    "utf8"
  );
  return {
    recordId,
    files: {
      raw,
      source,
      stdout,
      stderr,
      fullResult,
      privateReceipt
    }
  };
};

const blobPath = (
  privateRoot: string,
  identity: { readonly digest: string }
): string => path.join(
  privateRoot,
  "blobs",
  "sha256",
  identity.digest.slice(0, 2),
  identity.digest.slice(2)
);

const localhostAdminSharePath = (candidate: string): string => {
  const absolute = path.resolve(candidate);
  const drive = /^([A-Za-z]):\\$/u.exec(path.parse(absolute).root)?.[1];
  if (drive === undefined) throw new Error(`Expected a drive-letter path, received ${absolute}`);
  const remainder = absolute.slice(path.parse(absolute).root.length).split(path.sep).join("\\");
  return `\\\\localhost\\${drive.toLowerCase()}$\\${remainder}`;
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

describe("DurablePrivateKicadCaptureStore boundaries", () => {
  it("is a separately branded durable-private port with an opaque identity and overlap hook", async () => {
    const observations: string[] = [];
    const fixture = await makeStore({
      rootBoundaryHook: ({ phase, disjointRoot }) => {
        observations.push(`${phase}:${disjointRoot.label}`);
      }
    });
    const { store, privateRoot, publicRoot } = fixture;
    const publicStore = new FileContentStore(publicRoot);

    expectTypeOf<DurablePrivateKicadCaptureStore>()
      .toMatchTypeOf<DurablePrivateKicadCaptureStorePort>();
    expectTypeOf<FileContentStore>()
      .not.toMatchTypeOf<DurablePrivateKicadCaptureStorePort>();
    expectTypeOf<DurablePrivateKicadCaptureStorePort>()
      .not.toMatchTypeOf<ContentStorePort>();
    expectTypeOf<DevelopmentMemoryPrivateKicadCaptureStorePort["storageAuthority"]>()
      .toEqualTypeOf<typeof MEMORY_PRIVATE_KICAD_CAPTURE_AUTHORITY>();
    expect(store.storageAuthority).toBe(DURABLE_PRIVATE_KICAD_CAPTURE_AUTHORITY);
    expect(PRIVATE_KICAD_CAPTURE_STORE_PORT in store).toBe(true);
    expect(PRIVATE_KICAD_CAPTURE_STORE_PORT in publicStore).toBe(false);
    expect(Object.isFrozen(PRIVATE_KICAD_CAPTURE_FILE_ROLES)).toBe(true);
    expect(Object.isFrozen(store.limits)).toBe(true);
    expect(Object.isExtensible(store)).toBe(false);
    for (const key of [
      PRIVATE_KICAD_CAPTURE_STORE_PORT,
      "storageAuthority",
      "privateRoot",
      "limits"
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(store, key)).toMatchObject({
        writable: false,
        configurable: false
      });
    }
    expect(Reflect.set(store, "limits", { maxBytesPerFile: 0 })).toBe(false);
    expect(Reflect.set(store.limits, "maxBytesPerFile", 0)).toBe(false);
    expect(Reflect.set(PRIVATE_KICAD_CAPTURE_FILE_ROLES, "0", "attacker")).toBe(false);

    const first = store.mintRecordId();
    const second = store.mintRecordId();
    expect(first).toMatch(/^pkc_[0-9a-f]{32}$/u);
    expect(second).not.toBe(first);
    expect(first).not.toContain(portableContentIdentity("content").digest);

    await store.initialize();
    expect(path.resolve(store.privateRoot)).toBe(path.resolve(privateRoot));
    expect(path.resolve(store.privateRoot)).not.toBe(path.resolve(publicRoot));
    expect(observations).toContain("before-create:public-content-store");
    expect(observations).toContain("after-create:public-content-store");
    expect(observations).toContain("operation:public-content-store");
    expect(JSON.parse(await readFile(
      path.join(privateRoot, ".evleda-private-kicad-capture-store.json"),
      "utf8"
    ))).toEqual({
      schemaVersion: "evleda.private-kicad-capture-store.v1",
      storageAuthority: "durable-private-production"
    });
  });

  it("rejects lexical and canonical public/private root overlap before use", async () => {
    const fixture = await makeStore();
    expect(() => new DurablePrivateKicadCaptureStore({
      privateRoot: fixture.publicRoot,
      disjointFrom: [{ label: "public-content-store", path: fixture.publicRoot }]
    })).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));
    expect(() => new DurablePrivateKicadCaptureStore({
      privateRoot: path.join(fixture.publicRoot, "private"),
      disjointFrom: [{ label: "public-content-store", path: fixture.publicRoot }]
    })).toThrowError(expect.objectContaining({ code: "POLICY_DENIED" }));

    const shared = path.join(fixture.base, "shared-physical-root");
    const alias = path.join(fixture.base, "public-alias");
    await mkdir(shared);
    await symlink(shared, alias, process.platform === "win32" ? "junction" : "dir");
    const canonicalOverlap = new DurablePrivateKicadCaptureStore({
      privateRoot: path.join(shared, "private-child"),
      disjointFrom: [{ label: "public-content-store", path: alias }]
    });
    await expect(canonicalOverlap.initialize()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it.skipIf(process.platform !== "win32")(
    "uses filesystem ancestry identities across drive-letter and UNC aliases",
    async () => {
      const sameFixture = await makeStore();
      await mkdir(sameFixture.privateRoot);
      const sameObjectAlias = new DurablePrivateKicadCaptureStore({
        privateRoot: sameFixture.privateRoot,
        disjointFrom: [{
          label: "same-root-through-unc",
          path: localhostAdminSharePath(sameFixture.privateRoot)
        }]
      });
      await expect(sameObjectAlias.initialize()).rejects.toMatchObject({ code: "POLICY_DENIED" });

      const ancestorFixture = await makeStore();
      const physicalParent = path.join(ancestorFixture.base, "physical-parent");
      const rejectedPrivateChild = path.join(physicalParent, "private-child");
      await mkdir(physicalParent);
      const childThroughDrive = new DurablePrivateKicadCaptureStore({
        privateRoot: rejectedPrivateChild,
        disjointFrom: [{
          label: "parent-through-unc",
          path: localhostAdminSharePath(physicalParent)
        }]
      });
      await expect(childThroughDrive.initialize()).rejects.toMatchObject({ code: "POLICY_DENIED" });
      await expect(lstat(rejectedPrivateChild)).rejects.toMatchObject({ code: "ENOENT" });

      const siblingFixture = await makeStore();
      const siblingParent = path.join(siblingFixture.base, "physical-siblings");
      const privateSibling = path.join(siblingParent, "private");
      const publicSibling = path.join(siblingParent, "public");
      await mkdir(privateSibling, { recursive: true });
      await mkdir(publicSibling);
      const disjointSiblings = new DurablePrivateKicadCaptureStore({
        privateRoot: privateSibling,
        disjointFrom: [{
          label: "sibling-through-unc",
          path: localhostAdminSharePath(publicSibling)
        }]
      });
      await expect(disjointSiblings.initialize()).resolves.toBeUndefined();
    }
  );

  it("refuses a public content-store layout and link/reparse traversal", async () => {
    const fixture = await makeStore();
    const mixedRoot = path.join(fixture.base, "already-public");
    const publicStore = new FileContentStore(mixedRoot);
    await publicStore.initialize();
    const mixed = new DurablePrivateKicadCaptureStore({
      privateRoot: mixedRoot,
      disjointFrom: [{ label: "other-public-root", path: fixture.publicRoot }]
    });
    await expect(mixed.initialize()).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });

    const target = path.join(fixture.base, "junction-target");
    const alias = path.join(fixture.base, "junction-private-root");
    await mkdir(target);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    const linked = new DurablePrivateKicadCaptureStore({
      privateRoot: alias,
      disjointFrom: [{ label: "public-content-store", path: fixture.publicRoot }]
    });
    await expect(linked.initialize()).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE"
    });
  });

  it("fails closed when a protected root has no provable filesystem identity", async () => {
    const fixture = await makeStore();
    const privateRoot = path.join(fixture.base, "private-with-unproven-peer");
    const store = new DurablePrivateKicadCaptureStore({
      privateRoot,
      disjointFrom: [{
        label: "missing-public-content-store",
        path: path.join(fixture.base, "does-not-exist")
      }]
    });
    await expect(store.initialize()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(lstat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal-shaped record identities before filesystem lookup", async () => {
    const { store } = await makeStore();
    await expect(store.readCapture("../../escape" as PrivateKicadCaptureRecordId))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const capture = makeCapture(store);
    await expect(store.appendCapture({
      ...capture,
      recordId: "pkc_../escape" as PrivateKicadCaptureRecordId
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("DurablePrivateKicadCaptureStore records", () => {
  it("durably restarts, exactly deduplicates, and returns detached verified bytes", async () => {
    const { store, privateRoot, publicRoot } = await makeStore();
    const capture = makeCapture(store);
    const expectedRaw = Buffer.from(capture.files.raw);
    const expectedSource = Buffer.from(capture.files.source);
    const first = await store.appendCapture(capture);
    const duplicate = await store.appendCapture(capture);

    expect(duplicate).toEqual(first);
    expect(first.fileCount).toBe(PRIVATE_KICAD_CAPTURE_FILE_ROLES.length);
    expect(first.aggregateSize).toBe(
      PRIVATE_KICAD_CAPTURE_FILE_ROLES.reduce(
        (total, role) => total + capture.files[role].byteLength,
        0
      )
    );
    expect(Object.keys(first.files).sort()).toEqual([...PRIVATE_KICAD_CAPTURE_FILE_ROLES].sort());
    expect("hostAuthenticated" in first).toBe(false);
    expect(first.releaseAuthorized).toBe(false);

    capture.files.raw.fill(0x78);
    capture.files.source.fill(0x79);
    const restarted = new DurablePrivateKicadCaptureStore({
      privateRoot,
      disjointFrom: [{ label: "public-content-store", path: publicRoot }]
    });
    const read = await restarted.readCapture(first.recordId);
    expect(read.files.raw).toEqual(expectedRaw);
    expect(read.files.source).toEqual(expectedSource);
    expect(read.privateReceipt.authority).toBe("private-non-authoritative");
    expect(read.privateReceipt.receiptIdentity).toEqual(first.privateReceiptRecordIdentity);
    expect(read.fullResult.authority).toBe("private-storage-consistency-only");
    expect(read.fullResult.resultIdentity).toEqual(first.fullResultRecordIdentity);
    expect("hostAuthenticated" in read.fullResult).toBe(false);

    read.files.raw.fill(0);
    read.files.fullResult.fill(0);
    const detached = await restarted.readCapture(first.recordId);
    expect(detached.files.raw).toEqual(expectedRaw);
    expect(detached.files.fullResult).not.toEqual(read.files.fullResult);
    await expect(restarted.verifyCapture(first.recordId)).resolves.toEqual(first);

    const serialized = JSON.parse(await readFile(
      path.join(privateRoot, "records", `${first.recordId}.json`),
      "utf8"
    )) as Record<string, unknown>;
    expect(serialized).not.toHaveProperty("hostAuthenticated");
    expect(serialized).toMatchObject({
      storageAuthority: "durable-private-production",
      releaseAuthorized: false
    });
  });

  it("treats a same opaque identity with different exact content as corruption", async () => {
    const { store } = await makeStore();
    const firstCapture = makeCapture(store);
    const first = await store.appendCapture(firstCapture);
    const conflict = makeCapture(store, {
      recordId: first.recordId,
      raw: Buffer.from(firstCapture.files.raw),
      source: Buffer.from(firstCapture.files.source),
      stdout: Buffer.from(firstCapture.files.stdout),
      stderr: Buffer.from(firstCapture.files.stderr),
      capturedAt: "2026-09-05T12:00:01.000Z"
    });

    await expect(store.appendCapture(conflict)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR",
      message: expect.stringContaining("Conflicting duplicate")
    });
    expect((await store.readCapture(first.recordId)).files.fullResult)
      .toEqual(firstCapture.files.fullResult);
  });

  it("requires byte-canonical receipts/results and rejects arbitrary succeeded result bytes", async () => {
    const { store } = await makeStore();

    const arbitrary = makeCapture(store);
    await expect(store.appendCapture({
      ...arbitrary,
      files: { ...arbitrary.files, fullResult: Buffer.from("succeeded but not JSON", "utf8") }
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const noncanonicalReceipt = makeCapture(store);
    await expect(store.appendCapture({
      ...noncanonicalReceipt,
      files: {
        ...noncanonicalReceipt.files,
        privateReceipt: Buffer.concat([
          Buffer.from(noncanonicalReceipt.files.privateReceipt),
          Buffer.from(" ", "utf8")
        ])
      }
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("exact canonical")
    });

    const noncanonicalResult = makeCapture(store);
    await expect(store.appendCapture({
      ...noncanonicalResult,
      files: {
        ...noncanonicalResult.files,
        fullResult: Buffer.concat([
          Buffer.from(noncanonicalResult.files.fullResult),
          Buffer.from(" ", "utf8")
        ])
      }
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: expect.stringContaining("exact canonical")
    });
  });

  it("aligns full-result exit codes exactly to the receipt uint32 domain", async () => {
    const { store } = await makeStore();
    const capture = makeCapture(store);
    const parsed = JSON.parse(
      Buffer.from(capture.files.fullResult).toString("utf8")
    ) as PrivateKicadFullResultV1;
    const { resultIdentity: _resultIdentity, ...base } = parsed;

    expect(withPrivateKicadFullResultIdentity({
      ...base,
      outcome: "failed",
      exitCode: 4_294_967_295
    }).exitCode).toBe(4_294_967_295);
    for (const exitCode of [-1, 4_294_967_296, Number.MAX_SAFE_INTEGER]) {
      expect(() => withPrivateKicadFullResultIdentity({
        ...base,
        outcome: "failed",
        exitCode
      }), String(exitCode)).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    }
  });

  it("cross-checks every full-result byte, command, invocation, receipt, and outcome binding", async () => {
    const { store } = await makeStore();
    const capture = makeCapture(store);
    const parsed = JSON.parse(
      Buffer.from(capture.files.fullResult).toString("utf8")
    ) as PrivateKicadFullResultV1;
    const { resultIdentity: _resultIdentity, ...base } = parsed;
    const mutations: readonly [string, (draft: PrivateKicadFullResultDraftV1) => PrivateKicadFullResultDraftV1][] = [
      ["raw", (draft) => ({ ...draft, rawContentIdentity: portableContentIdentity("different raw") })],
      ["source", (draft) => ({ ...draft, sourceContentIdentity: portableContentIdentity("different source") })],
      ["stdout", (draft) => ({ ...draft, stdoutIdentity: portableContentIdentity("different stdout") })],
      ["stderr", (draft) => ({ ...draft, stderrIdentity: portableContentIdentity("different stderr") })],
      ["command", (draft) => ({
        ...draft,
        commandPlanIdentity: portableCanonicalIdentity(
          { command: "different" },
          "evleda.typed-command-plan.v1"
        )
      })],
      ["invocation", (draft) => ({
        ...draft,
        invocationIdentity: portableCanonicalIdentity(
          { invocation: "different" },
          "evleda.tool-invocation.v1"
        )
      })],
      ["capture", (draft) => ({
        ...draft,
        captureIdentity: portableCanonicalIdentity(
          { capture: "different" },
          "evleda.raw-capture-key.v2"
        )
      })],
      ["receipt-content", (draft) => ({
        ...draft,
        privateReceiptContentIdentity: portableContentIdentity("different receipt bytes")
      })],
      ["receipt-record", (draft) => ({
        ...draft,
        privateReceiptRecordIdentity: portableCanonicalIdentity(
          { receipt: "different" },
          "evleda.private-raw-capture-receipt.v2"
        )
      })],
      ["report-kind", (draft) => ({ ...draft, reportKind: "kicad_stats" })],
      ["outcome", (draft) => ({ ...draft, outcome: "failed", exitCode: 1 })]
    ];

    for (const [name, mutate] of mutations) {
      const fullResult = withPrivateKicadFullResultIdentity(
        mutate(base as PrivateKicadFullResultDraftV1)
      );
      await expect(store.appendCapture({
        ...capture,
        files: {
          ...capture.files,
          fullResult: Buffer.from(`${canonicalPortableJson(fullResult)}\n`, "utf8")
        }
      }), name).rejects.toMatchObject({ code: "DIGEST_MISMATCH" });
    }
  });

  it("serializes exact concurrent retries and preserves one immutable record", async () => {
    const { store, privateRoot, publicRoot } = await makeStore();
    const peer = new DurablePrivateKicadCaptureStore({
      privateRoot,
      disjointFrom: [{ label: "public-content-store", path: publicRoot }]
    });
    const capture = makeCapture(store);
    const [first, second] = await Promise.all([
      store.appendCapture(capture),
      peer.appendCapture(capture)
    ]);
    expect(second).toEqual(first);
    await expect(peer.verifyCapture(first.recordId)).resolves.toEqual(first);
  });

  it("fails closed on blob tampering and record truncation across restarts", async () => {
    const firstFixture = await makeStore();
    const firstCapture = makeCapture(firstFixture.store);
    const first = await firstFixture.store.appendCapture(firstCapture);
    await writeFile(blobPath(firstFixture.privateRoot, first.files.raw), "tampered", "utf8");
    const firstRestart = new DurablePrivateKicadCaptureStore({
      privateRoot: firstFixture.privateRoot,
      disjointFrom: [{ label: "public-content-store", path: firstFixture.publicRoot }]
    });
    await expect(firstRestart.readCapture(first.recordId)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });

    const secondFixture = await makeStore();
    const second = await secondFixture.store.appendCapture(makeCapture(secondFixture.store));
    const recordPath = path.join(
      secondFixture.privateRoot,
      "records",
      `${second.recordId}.json`
    );
    await truncate(recordPath, 17);
    const secondRestart = new DurablePrivateKicadCaptureStore({
      privateRoot: secondFixture.privateRoot,
      disjointFrom: [{ label: "public-content-store", path: secondFixture.publicRoot }]
    });
    await expect(secondRestart.readCapture(second.recordId)).rejects.toMatchObject({
      code: "ARTIFACT_INTEGRITY_ERROR"
    });
    await expect(secondRestart.appendCapture(makeCapture(secondRestart, {
      recordId: second.recordId
    }))).rejects.toMatchObject({ code: "ARTIFACT_INTEGRITY_ERROR" });
  });

  it("rejects a junction substituted beneath an initialized private root", async () => {
    const { base, store, privateRoot } = await makeStore();
    const capture = makeCapture(store);
    const record = await store.appendCapture(capture);
    const records = path.join(privateRoot, "records");
    const originalRecords = path.join(privateRoot, "records-original");
    const external = path.join(base, "external-records");
    await mkdir(external);
    await rename(records, originalRecords);
    await symlink(external, records, process.platform === "win32" ? "junction" : "dir");

    await expect(store.readCapture(record.recordId)).rejects.toMatchObject({
      code: "PATH_OUTSIDE_WORKSPACE"
    });
  });

  it("rejects receipt/byte identity mismatch before appending any record", async () => {
    const { store, privateRoot } = await makeStore();
    const capture = makeCapture(store);
    const mismatched = {
      ...capture,
      files: { ...capture.files, stdout: Buffer.from("changed stdout", "utf8") }
    };
    await expect(store.appendCapture(mismatched)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH"
    });
    await expect(readFile(path.join(privateRoot, "records", `${capture.recordId}.json`)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces file-count, per-file, and aggregate limits", async () => {
    const countFixture = await makeStore({
      limits: { maxFilesPerCapture: PRIVATE_KICAD_CAPTURE_FILE_ROLES.length - 1 }
    });
    await expect(countFixture.store.appendCapture(makeCapture(countFixture.store)))
      .rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { actual: 6, maximum: 5 }
      });

    const fileFixture = await makeStore({ limits: { maxBytesPerFile: 3_000 } });
    const oversized = makeCapture(fileFixture.store, { raw: Buffer.alloc(3_001, 0x41) });
    await expect(fileFixture.store.appendCapture(oversized)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { role: "raw", actual: 3_001, maximum: 3_000 }
    });

    const aggregateBase = await makeStore();
    const aggregateCapture = makeCapture(aggregateBase.store);
    const aggregateSize = PRIVATE_KICAD_CAPTURE_FILE_ROLES.reduce(
      (total, role) => total + aggregateCapture.files[role].byteLength,
      0
    );
    const aggregateFixture = await makeStore({
      limits: { maxBytesPerFile: 1_000_000, maxAggregateBytesPerCapture: aggregateSize - 1 }
    });
    const aggregateInput = makeCapture(aggregateFixture.store, {
      recordId: aggregateCapture.recordId,
      raw: Buffer.from(aggregateCapture.files.raw),
      source: Buffer.from(aggregateCapture.files.source),
      stdout: Buffer.from(aggregateCapture.files.stdout),
      stderr: Buffer.from(aggregateCapture.files.stderr),
      fullResult: Buffer.from(aggregateCapture.files.fullResult)
    });
    await expect(aggregateFixture.store.appendCapture(aggregateInput)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { maximum: aggregateSize - 1 }
    });
  });
});
