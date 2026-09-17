import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION, createFreshSchematicFieldDiagnostic, publishFreshSchematicFieldDiagnostic,
  schematicFieldDiagnosticFilename, type FreshSchematicFieldDiagnostic, type FreshSchematicFieldCloseOutcome,
  type FreshSchematicFieldArtifactReference } from "../harness/fresh-schematic-field-diagnostics.js";

const VERSION = FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION;
const MAX_BYTES = 16 * 1024 * 1024;

/** Complete host-private first-failure evidence; the output directory is never model-selected. */
export async function writeToolboxSchematicFieldDiagnostic(outputRoot: string, diagnostic: FreshSchematicFieldDiagnostic) {
  const captured = hardenPortableValue(diagnostic, { maxBytes: MAX_BYTES, maxStringBytes: 1024 * 1024,
    maxDepth: 32, maxNodes: 100_000, maxArrayLength: 8192, maxOwnKeys: 512, maxKeyBytes: 256 }) as FreshSchematicFieldDiagnostic;
  const { identity, ...body } = captured;
  if (captured.schemaVersion !== VERSION || !["primary-failure", "recovery-finished", "close-finished"].includes(captured.phase)
      || canonicalJson(identity) !== canonicalJson(canonicalIdentity(body, VERSION))) {
    throw new Error("Schematic field diagnostic identity or phase differs from its complete payload.");
  }
  const bytes = Buffer.from(`${canonicalJson(captured)}\n`, "utf8");
  if (bytes.byteLength > MAX_BYTES) throw new Error("Schematic field diagnostic exceeds its private artifact limit.");
  const root = path.resolve(outputRoot);
  if (!path.isAbsolute(outputRoot) || root !== outputRoot || await realpath(root) !== root) {
    throw new Error("Schematic field diagnostic output must be the exact host-owned directory.");
  }
  const rootBefore = await lstat(root, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw new Error("Schematic field diagnostic output is not an ordinary directory.");
  const assertRoot = async () => {
    const current = await lstat(root, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== rootBefore.dev || current.ino !== rootBefore.ino
        || await realpath(root) !== root) throw new Error("Schematic field diagnostic output changed during publication.");
  };
  const filename = schematicFieldDiagnosticFilename(captured);
  const target = path.join(root, filename);
  const handle = await open(target, "wx+", 0o600);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== 0n) throw new Error("Schematic field diagnostic reservation is not exclusive.");
    await assertRoot();
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    const physical = await lstat(target, { bigint: true });
    if (written.dev !== opened.dev || written.ino !== opened.ino || written.nlink !== 1n || written.size !== BigInt(bytes.length)
        || physical.dev !== written.dev || physical.ino !== written.ino || !physical.isFile() || physical.isSymbolicLink()
        || physical.nlink !== 1n || physical.size !== written.size || await realpath(target) !== target) {
      throw new Error("Schematic field diagnostic artifact identity changed.");
    }
    const readback = Buffer.alloc(bytes.length + 1);
    let count = 0;
    while (count < readback.length) {
      const part = await handle.read(readback, count, readback.length - count, count);
      if (part.bytesRead === 0) break;
      count += part.bytesRead;
    }
    const settled = await lstat(target, { bigint: true });
    if (!readback.subarray(0, count).equals(bytes) || settled.dev !== written.dev || settled.ino !== written.ino
        || !settled.isFile() || settled.isSymbolicLink() || settled.size !== written.size || settled.nlink !== 1n || settled.mtimeNs !== physical.mtimeNs
        || settled.ctimeNs !== physical.ctimeNs) throw new Error("Schematic field diagnostic readback differs from the full failure record.");
    await assertRoot();
    return Object.freeze({ filename, identity: contentIdentity(bytes) });
  } finally {
    // Retain incomplete reservations as failure evidence; never overwrite them.
    await handle.close();
  }
}

/** One field failure, with separate immutable rollback and actual owned-close records. */
export function createToolboxSchematicFieldDiagnostics(outputRoot: string,
  write: typeof writeToolboxSchematicFieldDiagnostic = writeToolboxSchematicFieldDiagnostic) {
  let latest: FreshSchematicFieldDiagnostic | undefined;
  let primaryArtifact: FreshSchematicFieldArtifactReference | null = null;
  let recoveryArtifact: FreshSchematicFieldArtifactReference | null = null;
  let finalized = false;
  const observe = async (diagnostic: FreshSchematicFieldDiagnostic): Promise<FreshSchematicFieldArtifactReference> => {
    if (finalized || diagnostic.phase === "close-finished" || latest?.phase === diagnostic.phase
        || latest === undefined && diagnostic.phase !== "primary-failure"
        || latest !== undefined && diagnostic.phase !== "recovery-finished") throw new Error("Field diagnostic phase is duplicated or out of order.");
    if (latest !== undefined && latest.failureId !== diagnostic.failureId) throw new Error("Field diagnostics retain the first failure for this editing session.");
    if (latest !== undefined && ["toolCallId", "firstOperation", "beforeSchematicContentIdentity", "primary", "sessionResponse"]
      .some(key => canonicalJson(latest![key as keyof FreshSchematicFieldDiagnostic]) !== canonicalJson(diagnostic[key as keyof FreshSchematicFieldDiagnostic]))) {
      throw new Error("Field recovery diagnostic differs from its immutable first failure.");
    }
    latest = diagnostic;
    const reference = await write(outputRoot, diagnostic);
    if (diagnostic.phase === "primary-failure") primaryArtifact = reference;
    if (diagnostic.phase === "recovery-finished") recoveryArtifact = reference;
    return reference;
  };
  const finalize = async (outcome: FreshSchematicFieldCloseOutcome): Promise<void> => {
    if (latest === undefined || finalized) return;
    finalized = true;
    const { schemaVersion: _version, identity: _identity, ...body } = latest;
    const diagnostic = createFreshSchematicFieldDiagnostic({ ...body, phase: "close-finished", nativeClose: outcome,
      primaryArtifact, recoveryArtifact });
    await publishFreshSchematicFieldDiagnostic(async value => write(outputRoot, value), diagnostic);
  };
  return Object.freeze({ observe, finalize });
}
