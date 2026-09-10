import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { assessSavedMicrostrip, savedMicrostripRequestSchema, type SavedMicrostripAssessment } from "../harness/saved-microstrip-assessment.js";
import { createKicadSavedSourceReader, type KicadSavedSourceObservation } from "../integrations/kicad-saved-source.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";

export { savedMicrostripRequestSchema as toolboxSavedMicrostripQuerySchema };

const REQUEST_LIMITS = { maxBytes: 256 * 1024, maxDepth: 32, maxNodes: 100_000,
  maxArrayLength: 1024, maxOwnKeys: 1024, maxKeyBytes: 512, maxStringBytes: 64 * 1024 } as const;
const publicErrors = new WeakMap<object, string>();
function safeError(message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  publicErrors.set(error, message); return error;
}
/** Foreign filesystem, session and helper errors can contain private paths or source. */
export function toolboxSavedMicrostripErrorMessage(error: unknown): string {
  const message = error !== null && (typeof error === "object" || typeof error === "function") ? publicErrors.get(error) : undefined;
  return message ?? "Saved microstrip inspection could not verify the current project or calculation; no assessment was published.";
}

/** Detach every caller-owned field before queueing, filesystem reads or calculations. */
export function snapshotToolboxSavedMicrostripRequest(argument: unknown) {
  try { return savedMicrostripRequestSchema.parse(hardenPortableValue(argument, REQUEST_LIMITS)); }
  catch (cause) { throw safeError("Microstrip route request is invalid; use the advertised schema.", cause); }
}

/** One host-selected saved PCB; requests cannot supply paths, bytes or a runtime. */
export async function createToolboxSavedMicrostrip(input: { readonly pcbPath: string }) {
  const observe = await createKicadSavedSourceReader({ pcbPath: input.pcbPath });
  return async (argument: unknown, calculator?: KicadTransmissionLineCalculator): Promise<SavedMicrostripAssessment> => {
    const request = snapshotToolboxSavedMicrostripRequest(argument);
    let before: KicadSavedSourceObservation<Buffer>;
    try {
      // The existing reader fatal-decodes UTF-8 with ignoreBOM:true. Encoding it
      // back retains BOM, CRLF and every valid byte; verify the raw identity too.
      before = await observe(text => Buffer.from(text, "utf8"));
    } catch (cause) { throw safeError("The current saved PCB could not be read under its host binding.", cause); }
    if (canonicalJson(contentIdentity(before.value)) !== canonicalJson(before.sourceIdentity)) {
      throw safeError("Saved PCB bytes did not retain their exact source identity.");
    }
    if (canonicalJson(request.expectedSourceIdentity) !== canonicalJson(before.sourceIdentity)) {
      throw safeError("Saved PCB differs from the requested source identity; inspect it again.");
    }
    let result: SavedMicrostripAssessment;
    try {
      result = await assessSavedMicrostrip({ savedPcbBytes: before.value, request,
        ...(calculator === undefined ? {} : { calculator }) });
    } catch (cause) { throw safeError("Saved-route microstrip assessment could not verify its source or host calculator.", cause); }
    let after: KicadSavedSourceObservation<null>;
    try { after = await observe(() => null); }
    catch (cause) { throw safeError("Saved PCB changed or became unavailable during microstrip assessment; discard the result.", cause); }
    if (canonicalJson(before.sourceIdentity) !== canonicalJson(after.sourceIdentity)
        || canonicalJson(result.sourceIdentity) !== canonicalJson(before.sourceIdentity)) {
      throw safeError("Saved PCB changed during microstrip assessment; discard the result.");
    }
    return result;
  };
}
export type ToolboxSavedMicrostrip = Awaited<ReturnType<typeof createToolboxSavedMicrostrip>>;
