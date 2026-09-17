import { types } from "node:util";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";

export const FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION = "evleda.fresh-schematic-field-diagnostic.v1";
export const FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS = 5_000;
export interface FreshSchematicFieldArtifactReference { readonly filename: string; readonly identity: ContentIdentity }
export interface FreshSchematicFieldCloseOutcome {
  readonly nativeEditorTeardown: "confirmed" | "unconfirmed";
  readonly sidecarTeardown: "confirmed" | "unconfirmed";
  readonly ownedHostCleanup: "confirmed" | "unconfirmed";
  /** The owning server publishes checkpoints only after native close returns. */
  readonly checkpoint: "not-observed";
}
export type FreshSchematicFieldErrorCapture = Readonly<{ status: "captured"; value: unknown }>
  | Readonly<{ status: "unavailable"; reason: string }>;
export interface FreshSchematicFieldDiagnostic {
  readonly schemaVersion: typeof FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION;
  readonly failureId: string;
  readonly phase: "primary-failure" | "recovery-finished" | "close-finished";
  readonly toolCallId: string;
  readonly firstOperation: string;
  readonly beforeSchematicContentIdentity: ContentIdentity;
  readonly primary: FreshSchematicFieldErrorCapture;
  readonly sessionResponse: FreshSchematicFieldErrorCapture | null;
  readonly schematicRollback: "not-attempted" | "verified" | "failed";
  readonly rollbackFailure: FreshSchematicFieldErrorCapture | null;
  readonly nativeSchematicState: "unproven";
  readonly nativeClose: FreshSchematicFieldCloseOutcome | null;
  readonly primaryArtifact: FreshSchematicFieldArtifactReference | null;
  readonly recoveryArtifact: FreshSchematicFieldArtifactReference | null;
  readonly identity: CanonicalIdentity;
}
export type FreshSchematicFieldDiagnosticObserver = (diagnostic: FreshSchematicFieldDiagnostic) => Promise<FreshSchematicFieldArtifactReference>;

/** Capture private data without invoking foreign getters, toJSON, or inspectors. */
export function captureFreshSchematicFieldError(error: unknown): FreshSchematicFieldErrorCapture {
  try {
    const seen = new Set<object>(); let nodes = 0;
    const visit = (value: unknown, depth = 0): unknown => {
      if (++nodes > 32_768 || depth > 24) throw new Error("Capture bound.");
      if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        if (Buffer.byteLength(value, "utf8") > 1024 * 1024) throw new Error("String bound.");
        return value;
      }
      if (typeof value !== "object" || value === null || types.isProxy(value) || seen.has(value)) throw new Error("Unsupported object.");
      seen.add(value);
      try {
        const properties = Object.getOwnPropertyDescriptors(value);
        if (types.isNativeError(value)) {
          const result: Record<string, unknown> = { name: "Error" };
          for (const key of ["name", "message", "cause"]) {
            const descriptor = properties[key];
            if (descriptor === undefined) continue;
            if (!("value" in descriptor)) throw new Error("Accessor.");
            if (descriptor.value !== undefined) result[key] = visit(descriptor.value, depth + 1);
          }
          return result;
        }
        if (Array.isArray(value)) {
          if (value.length > 8192) throw new Error("Array bound.");
          return Array.from({ length: value.length }, (_, index) => {
            const descriptor = properties[String(index)];
            if (descriptor === undefined || !("value" in descriptor)) throw new Error("Sparse or accessor array.");
            return visit(descriptor.value, depth + 1);
          });
        }
        if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Foreign object.");
        if (Object.keys(properties).length > 512) throw new Error("Property bound.");
        return Object.fromEntries(Object.entries(properties).filter(([, descriptor]) => descriptor.enumerable).map(([key, descriptor]) => {
          if (!("value" in descriptor)) throw new Error("Accessor.");
          return [key, visit(descriptor.value, depth + 1)];
        }));
      } finally { seen.delete(value); }
    };
    return Object.freeze({ status: "captured", value: hardenPortableValue(visit(error), { maxBytes: 2 * 1024 * 1024,
      maxStringBytes: 1024 * 1024, maxDepth: 24, maxNodes: 32_768, maxOwnKeys: 512, maxArrayLength: 8192, maxKeyBytes: 256 }) });
  } catch {
    return Object.freeze({ status: "unavailable", reason: "Complete private cause exceeds capture bounds or contains unsupported objects; the original in-memory cause is retained." });
  }
}

export function createFreshSchematicFieldDiagnostic(body: Omit<FreshSchematicFieldDiagnostic, "schemaVersion" | "identity">): FreshSchematicFieldDiagnostic {
  const payload = hardenPortableValue({ schemaVersion: FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION, ...body }, {
    maxBytes: 16 * 1024 * 1024, maxStringBytes: 1024 * 1024, maxDepth: 32,
    maxNodes: 100_000, maxArrayLength: 8192, maxOwnKeys: 512, maxKeyBytes: 256,
  }) as Omit<FreshSchematicFieldDiagnostic, "identity">;
  return Object.freeze({ ...payload, identity: canonicalIdentity(payload, FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_VERSION) });
}

export function schematicFieldDiagnosticFilename(diagnostic: Pick<FreshSchematicFieldDiagnostic, "phase" | "failureId">): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(diagnostic.failureId)) throw new Error("Field diagnostic failure identity is invalid.");
  if (!["primary-failure", "recovery-finished", "close-finished"].includes(diagnostic.phase)) throw new Error("Field diagnostic phase is invalid.");
  return `schematic-field-diagnostic-${diagnostic.phase}-${diagnostic.failureId}.json`;
}

/** Diagnostic failure or timeout cannot replace the operation or block owned recovery. */
export async function publishFreshSchematicFieldDiagnostic(observer: FreshSchematicFieldDiagnosticObserver | undefined,
  diagnostic: FreshSchematicFieldDiagnostic): Promise<FreshSchematicFieldArtifactReference | null> {
  if (observer === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const artifact = await Promise.race([Promise.resolve().then(() => observer(diagnostic)), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), FRESH_SCHEMATIC_FIELD_DIAGNOSTIC_TIMEOUT_MS);
    })]);
    if (artifact === null || types.isProxy(artifact)) return null;
    const captured = captureFreshSchematicFieldError(artifact);
    if (captured.status !== "captured" || captured.value === null || typeof captured.value !== "object") return null;
    const value = captured.value as FreshSchematicFieldArtifactReference;
    const expectedIdentity = contentIdentity(Buffer.from(`${canonicalJson(diagnostic)}\n`, "utf8"));
    if (value.filename !== schematicFieldDiagnosticFilename(diagnostic) || canonicalJson(value.identity) !== canonicalJson(expectedIdentity)) return null;
    return Object.freeze({ filename: value.filename, identity: Object.freeze({ ...value.identity }) });
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function schematicFieldDiagnosticReferenceText(phase: "primary" | "recovery", reference: FreshSchematicFieldArtifactReference | null): string {
  return reference === null ? ` Private ${phase} diagnostic publication was not confirmed.`
    : ` Private ${phase} diagnostic: ${reference.filename} (sha256:${reference.identity.digest}).`;
}
