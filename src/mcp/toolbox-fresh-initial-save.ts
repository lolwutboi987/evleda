import { canonicalJson, contentIdentity } from "../core/canonical.js";
import { freshBoardSerializationsEqual } from "../harness/fresh-board-serialization.js";
import { hasQualifiedNativeBoardReply, type FreshBoardPersistenceSession } from "../harness/fresh-board-persistence.js";
import { captureFreshProjectOpenPreparedSourceAuthority, parseFreshProjectOpenPreparedSourceAuthority,
  type FreshProject, type FreshProjectOpenPreparedSourceAuthority } from "../harness/fresh-project.js";
import { captureKicadNativeSourceHashes } from "../integrations/kicad-cli.js";
import { createKicadSavedSourceReader } from "../integrations/kicad-saved-source.js";
import { lstat, realpath } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";

/** Host-owned numeric codes survive the existing safe startup diagnostics. */
export const INITIAL_FRESH_SAVE_ERROR_CODES = Object.freeze({
  PREPARED_AUTHORITY: 52001, PREPARED_SETTINGS: 52002, PCB_BYTES: 52003,
  SOURCE_INVENTORY: 52004, LIVE_PCB: 52005, ACKNOWLEDGEMENT: 52006,
  HISTORY_DESTINATION: 52007, HISTORY_SNAPSHOT: 52008,
});
function failure(code: number, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}
async function optionalMetadata(file: string): Promise<BigIntStats | null> {
  try { return await lstat(file, { bigint: true }); }
  catch (error) {
    if (error !== null && typeof error === "object" && Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT") return null;
    throw error;
  }
}

interface InitialFreshSaveInput {
  readonly project: FreshProject;
  readonly expectedPreparedSourceAuthority: FreshProjectOpenPreparedSourceAuthority;
  readonly session: Required<Pick<FreshBoardPersistenceSession, "assertActivePcb" | "readActivePcbSource" | "callTool">>;
}
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

/**
 * Called only while opening a newly prepared project, before tools are exposed.
 * This flushes native project defaults, never authorizes changed PCB bytes, and
 * leaves all .pro semantics to the existing per-family Open normalizer.
 */
export async function saveInitialFreshProjectSettings(input: InitialFreshSaveInput): Promise<void> {
  const { project, session } = input;
  const codes = INITIAL_FRESH_SAVE_ERROR_CODES;
  const expected = parseFreshProjectOpenPreparedSourceAuthority(input.expectedPreparedSourceAuthority);
  const assertPrepared = async (afterNativeSave = false) => {
    // The existing capture rejects changed immutable marker sources, including
    // the plane family's canonical .dru, and validates ordinary file ownership.
    let current: FreshProjectOpenPreparedSourceAuthority;
    try { current = await captureFreshProjectOpenPreparedSourceAuthority(project); }
    catch (cause) { throw failure(codes.PREPARED_AUTHORITY, "Initial native save refused changed prepared source authority.", cause); }
    for (const key of ["projectIdentity", "sch", "pcb", "sym", "fp", "marker"] as const) {
      if (!same(current[key], expected[key])) throw failure(codes.PREPARED_AUTHORITY, `Initial native save refused changed prepared ${key} authority.`);
    }
    // The observed blank Open leaves the prepared .pro on disk until Save.
    // Do not overwrite an unknown preexisting or concurrent settings change.
    if (!afterNativeSave && !same(current.pro, expected.pro)) {
      throw failure(codes.PREPARED_SETTINGS, "Initial native save refused changed prepared pro authority.");
    }
    return current;
  };
  const nativeSourcesExceptPrimaryProject = async () => {
    try {
      const sources = await captureKicadNativeSourceHashes(project.projectPath);
      return Object.fromEntries(Object.entries(sources).filter(([name]) => name !== `${project.name}.kicad_pro`));
    } catch (cause) { throw failure(codes.SOURCE_INVENTORY, "Initial native save could not verify the native source inventory.", cause); }
  };
  const historyDirectory = path.join(project.projectPath, ".history");
  const historyPath = path.join(historyDirectory, `${project.name}.kicad_pcb`);
  const historyKey = `.history/${project.name}.kicad_pcb`;
  const historyParent = async () => {
    try {
      const metadata = await optionalMetadata(historyDirectory);
      if (metadata !== null && (!metadata.isDirectory() || metadata.isSymbolicLink()
          || await realpath(historyDirectory) !== historyDirectory)) {
        throw new Error("History parent is not an ordinary canonical directory.");
      }
      return metadata;
    } catch (cause) { throw failure(codes.HISTORY_DESTINATION, "Initial native save refuses an unsafe history parent.", cause); }
  };
  const originalHistoryParent = await historyParent();
  const assertHistoryBeforeSave = async () => {
    const current = await historyParent();
    if ((current === null) !== (originalHistoryParent === null)
        || current !== null && originalHistoryParent !== null && (current.dev !== originalHistoryParent.dev
          || current.ino !== originalHistoryParent.ino || current.mode !== originalHistoryParent.mode
          || current.mtimeNs !== originalHistoryParent.mtimeNs || current.ctimeNs !== originalHistoryParent.ctimeNs)) {
      throw failure(codes.HISTORY_DESTINATION, "History parent changed before initial native save.");
    }
    try {
      if (await optionalMetadata(historyPath) !== null) throw new Error("The exact history target already exists.");
    } catch (cause) { throw failure(codes.HISTORY_DESTINATION, "Initial native save refuses a preexisting or unavailable history target.", cause); }
  };
  await assertHistoryBeforeSave();
  await session.assertActivePcb(project.pcbPath);
  await assertPrepared();
  const observe = await createKicadSavedSourceReader({ pcbPath: project.pcbPath });
  const before = await observe(text => Buffer.from(text, "utf8"));
  if (!same(contentIdentity(before.value), expected.pcb) || !same(before.sourceIdentity, expected.pcb)) {
    throw failure(codes.PCB_BYTES, "Initial native save requires the exact prepared PCB bytes.");
  }
  const sourceInventory = await nativeSourcesExceptPrimaryProject();
  await assertPrepared();
  if (!same(await nativeSourcesExceptPrimaryProject(), sourceInventory)) {
    throw failure(codes.SOURCE_INVENTORY, "Native source inventory changed before initial save.");
  }
  // The serializer comparison permits only its existing, independently pinned
  // channel forms. Recheck disk authority after that awaited native observation.
  const liveBefore = await session.readActivePcbSource(project.pcbPath);
  if (!freshBoardSerializationsEqual(before.value.toString("utf8"), liveBefore)) {
    throw failure(codes.LIVE_PCB, "Initial native save refuses unsaved live PCB changes.");
  }
  await assertPrepared();
  if (!same(await nativeSourcesExceptPrimaryProject(), sourceInventory)) {
    throw failure(codes.SOURCE_INVENTORY, "Native source inventory changed during the initial live read.");
  }
  const dispatch = await observe(text => Buffer.from(text, "utf8"));
  if (!dispatch.value.equals(before.value) || !same(dispatch.sourceIdentity, before.sourceIdentity)) {
    throw failure(codes.PCB_BYTES, "Prepared PCB bytes changed before initial native save dispatch.");
  }
  await assertPrepared();
  await assertHistoryBeforeSave();
  const reply = await session.callTool("pcb_save", {});
  let acknowledged = false;
  try { acknowledged = hasQualifiedNativeBoardReply(reply, "Board saved."); }
  catch { /* The original returned envelope is retained below as private cause. */ }
  if (!acknowledged) throw failure(codes.ACKNOWLEDGEMENT, "Initial native save lacks the qualified Board saved acknowledgement.", reply);

  await session.assertActivePcb(project.pcbPath);
  const liveAfter = await session.readActivePcbSource(project.pcbPath);
  if (!freshBoardSerializationsEqual(before.value.toString("utf8"), liveAfter)) {
    throw failure(codes.LIVE_PCB, "Live PCB changed during initial native save.");
  }
  await assertPrepared(true);
  const afterSources = await nativeSourcesExceptPrimaryProject();
  // KiCad LOCAL_HISTORY writes the current board during Save. For this
  // byte-preserving initialization it must equal the independently read live
  // board from before Save. No arbitrary history subtree is excluded.
  try {
    const parent = await historyParent();
    if (originalHistoryParent !== null && (parent === null || parent.dev !== originalHistoryParent.dev
        || parent.ino !== originalHistoryParent.ino || parent.mode !== originalHistoryParent.mode)) {
      throw new Error("History parent changed during Save.");
    }
    const history = await optionalMetadata(historyPath);
    if (history !== null) {
      if (parent === null || !history.isFile() || history.isSymbolicLink() || history.nlink !== 1n
          || Object.hasOwn(sourceInventory, historyKey) || !Object.hasOwn(afterSources, historyKey)) {
        throw new Error("History is not the single new ordinary native snapshot.");
      }
      const observeHistory = await createKicadSavedSourceReader({ pcbPath: historyPath });
      const snapshot = await observeHistory(text => Buffer.from(text, "utf8"));
      if (!snapshot.value.equals(Buffer.from(liveBefore, "utf8"))
          || !same(contentIdentity(snapshot.value), snapshot.sourceIdentity)
          || snapshot.sourceIdentity.digest !== afterSources[historyKey]) {
        throw new Error("History bytes differ from the observed unchanged live board.");
      }
      delete afterSources[historyKey];
    }
  } catch (cause) { throw failure(codes.HISTORY_SNAPSHOT, "Initial native save produced unsupported or changed history evidence.", cause); }
  if (!same(afterSources, sourceInventory)) {
    throw failure(codes.SOURCE_INVENTORY, "A non-project-settings native source changed during initial save.");
  }
  // Exact final bytes, not serializer equivalence, govern the marker baseline.
  // Capture them after the remaining source inventory checks.
  const after = await observe(text => Buffer.from(text, "utf8"));
  if (!after.value.equals(before.value) || !same(after.sourceIdentity, before.sourceIdentity)) {
    throw failure(codes.PCB_BYTES, "Initial native save changed the exact prepared PCB bytes.");
  }
  if (!freshBoardSerializationsEqual(after.value.toString("utf8"), liveAfter)) {
    throw failure(codes.LIVE_PCB, "Saved/live PCB source differs after initial native save.");
  }
}
