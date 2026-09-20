import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { captureFreshSchematicFieldError, type FreshSchematicFieldErrorCapture } from "./fresh-schematic-field-diagnostics.js";

export const FRESH_PLANE_FAILURE_DIAGNOSTIC_VERSION = "evleda.fresh-plane-failure-diagnostic.v1";
export interface FreshPlaneFailureDiagnostic {
  readonly schemaVersion: typeof FRESH_PLANE_FAILURE_DIAGNOSTIC_VERSION;
  readonly failureId: string;
  readonly phase: "primary-failure";
  readonly toolCallId: string;
  readonly stage: string;
  readonly beforePcbContentIdentity: ContentIdentity;
  readonly acceptedStagedPcbContentIdentity: ContentIdentity | null;
  readonly primary: FreshSchematicFieldErrorCapture;
  readonly recoveryRequired: true;
  readonly identity: CanonicalIdentity;
}
export interface FreshPlaneFailureArtifact { readonly filename: string; readonly identity: ContentIdentity }
export type FreshPlaneFailureObserver = (diagnostic: FreshPlaneFailureDiagnostic) => Promise<FreshPlaneFailureArtifact>;
export function createFreshPlaneFailureDiagnostic(input: Omit<FreshPlaneFailureDiagnostic, "schemaVersion" | "identity">): FreshPlaneFailureDiagnostic {
  const body: Omit<FreshPlaneFailureDiagnostic, "identity"> = { schemaVersion: FRESH_PLANE_FAILURE_DIAGNOSTIC_VERSION, ...input };
  return Object.freeze({ ...body, identity: canonicalIdentity(body, FRESH_PLANE_FAILURE_DIAGNOSTIC_VERSION) });
}
export const planeFailureDiagnosticFilename = (diagnostic: FreshPlaneFailureDiagnostic) => `plane-apply-failure-${diagnostic.failureId}.json`;

/** Publication can fail or time out without replacing the original failure. */
export async function publishFreshPlaneFailureDiagnostic(observer: FreshPlaneFailureObserver | undefined,
  diagnostic: FreshPlaneFailureDiagnostic): Promise<FreshPlaneFailureArtifact | null> {
  if (observer === undefined) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const candidate = await Promise.race([Promise.resolve().then(() => observer(diagnostic)), new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), 5_000);
    })]);
    const capture = captureFreshSchematicFieldError(candidate);
    if (capture.status !== "captured" || capture.value === null || typeof capture.value !== "object") return null;
    const value = capture.value as FreshPlaneFailureArtifact;
    const expected = contentIdentity(Buffer.from(`${canonicalJson(diagnostic)}\n`, "utf8"));
    if (value.filename !== planeFailureDiagnosticFilename(diagnostic) || canonicalJson(value.identity) !== canonicalJson(expected)) return null;
    return Object.freeze({ filename: value.filename, identity: Object.freeze({ ...value.identity }) });
  } catch { return null; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
