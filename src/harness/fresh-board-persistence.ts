import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/client";

import { parseFreshPcbSource } from "./fresh-kicad-parser.js";
import { freshBoardComparisonText, freshBoardSerializationsEqual } from "./fresh-board-serialization.js";
import { assertFreshProjectDirectoryChain, isVerifiedFreshProject, type FreshFilesystemIdentity, type FreshProject } from "./fresh-project.js";

/** This is intentionally below the harness result cap and never reaches a provider. */
export const MAX_FRESH_LIVE_BOARD_BYTES = 500_000;

export interface FreshBoardContentIdentity {
  readonly sha256: string;
  readonly bytes: number;
}

export interface FreshBoardSaveAudit {
  readonly rawPcbSaveResult: string;
  readonly fallbackReason: string;
  readonly before: FreshBoardContentIdentity;
  readonly live: FreshBoardContentIdentity;
  readonly after: FreshBoardContentIdentity;
  /** Directory metadata flush outcome; this is not a power-loss guarantee. */
  readonly directorySync: "synced" | "unavailable";
}

export interface FreshBoardPersistenceSession {
  callTool(name: string, argumentsValue?: Readonly<Record<string, unknown>>): Promise<CallToolResult>;
  /** Private native document proof; configured project paths do not establish active identity. */
  assertActivePcb?(expectedPath: string): Promise<void>;
  /** Private unsanitized source captured between exact active-document checks. */
  readActivePcbSource?(expectedPath: string): Promise<string>;
}

/** Exact observations already admitted by a host's known-state recovery policy. */
export interface FreshBoardRollbackGuard {
  readonly expectedDiskSource: string;
  readonly expectedLiveSource: string;
}

/** Pinned native command completion, not merely nonempty non-error prose. */
export function hasQualifiedNativeBoardReply(result:CallToolResult,expected:string):boolean{
  if(result.isError===true)return false;
  const matches=(value:unknown):boolean=>typeof value==="string"?value.trim()===expected:value!==null&&typeof value==="object"&&!Array.isArray(value)
    &&Object.keys(value).length===1&&Object.hasOwn(value,"result")&&typeof (value as Record<string,unknown>).result==="string"&&((value as Record<string,string>).result!.trim()===expected);
  let proven=false;
  if(result.structuredContent!==undefined){if(!matches(result.structuredContent))return false;proven=true;}
  if(result.content.length>0){
    if(result.content.length!==1||result.content[0]!.type!=="text")return false;
    const text=result.content[0]!.text;
    // The pinned session replaces original content with this exact projection;
    // the command's qualified value remains in structuredContent. Arbitrary
    // conflicting raw text is still rejected below.
    if(proven&&text==='{"schemaVersion":"evleda.kicad-mcp-result.v1","category":"validated_structured_evidence"}')return true;
    let valid=matches(text);
    if(!valid){try{valid=matches(JSON.parse(text));}catch{return false;}}
    if(!valid)return false;proven=true;
  }
  return proven;
}

const identity = (value: Buffer): FreshBoardContentIdentity => Object.freeze({
  sha256: createHash("sha256").update(value).digest("hex"), bytes: value.byteLength,
});

interface ExistingBoard {
  readonly bytes: Buffer;
  readonly content: FreshBoardContentIdentity;
  readonly physical: FreshFilesystemIdentity;
}

const physicalIdentity = (canonicalPath: string, metadata: { readonly dev: bigint; readonly ino: bigint }): FreshFilesystemIdentity => {
  const dev = metadata.dev > 0n ? metadata.dev.toString(10) : null;
  const ino = metadata.ino > 0n ? metadata.ino.toString(10) : null;
  return Object.freeze({ canonicalPath, dev: dev === null || ino === null ? null : dev, ino: dev === null || ino === null ? null : ino });
};

const samePhysicalIdentity = (left: FreshFilesystemIdentity, right: FreshFilesystemIdentity): boolean =>
  left.canonicalPath === right.canonicalPath
  && (left.dev === null || left.ino === null || (left.dev === right.dev && left.ino === right.ino));

async function readExistingRegularBoard(boardPath: string, projectRoot: FreshFilesystemIdentity): Promise<ExistingBoard> {
  const expected = path.join(projectRoot.canonicalPath, path.basename(boardPath));
  if (path.resolve(boardPath) !== expected) throw new Error("Fresh durable board basename does not bind directly to the marker root.");
  const metadata = await lstat(expected, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) throw new Error("Fresh durable board target is not an existing unlinked physical regular file.");
  const canonicalPath = await realpath(expected);
  if (canonicalPath !== expected) throw new Error("Fresh durable board target resolves through a link or wrong path.");
  const physical = physicalIdentity(canonicalPath, metadata);
  const bytes = await readFile(expected);
  return { bytes, content: identity(bytes), physical };
}

const scalarSafe = (value: string): boolean => !/[\u0000\uD800-\uDFFF]/u.test(value);

function assertSupportedBoardSource(source: string): Buffer {
  if (source.length === 0 || source.length > MAX_FRESH_LIVE_BOARD_BYTES || Buffer.byteLength(source, "utf8") > MAX_FRESH_LIVE_BOARD_BYTES) {
    throw new Error(`Live KiCad board exceeds the ${MAX_FRESH_LIVE_BOARD_BYTES}-byte/character durable-save limit.`);
  }
  if (!scalarSafe(source)) throw new Error("Live KiCad board contains NUL or non-scalar text.");
  freshBoardComparisonText(source);
  if (/\btruncat(?:ed|ion|e)\b|\[\s*\.\.\.\s*\]|\[\s*truncated\s*\]/iu.test(source)) {
    throw new Error("Live KiCad board carries a truncation marker.");
  }
  let parsed;
  try { parsed = parseFreshPcbSource(source); }
  catch (error) { throw new Error("Live KiCad board is not a balanced, supported KiCad PCB S-expression.", { cause: error }); }
  if (parsed.version === null || !/\(general(?:\s|\))/u.test(source) || !/\(layers[\s\S]*?"F\.Cu"[\s\S]*?"B\.Cu"/u.test(source)) {
    throw new Error("Live KiCad board is missing the required version, general, or two-layer board structure.");
  }
  return Buffer.from(source, "utf8");
}

async function syncDirectory(directory: string): Promise<"synced" | "unavailable"> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    return "synced";
  } catch (error) {
    // Windows commonly rejects directory handles with EPERM. This is a
    // best-effort metadata flush only; exact same-session file readback below
    // is the persistence acceptance condition, not crash/power-loss durability.
    const code = (error as NodeJS.ErrnoException).code;
    if (["EPERM", "EISDIR", "EINVAL", "ENOTSUP", "EBADF"].includes(code ?? "")) return "unavailable";
    throw error;
  }
}

async function assertPhysicalTemporary(temporary: string): Promise<void> {
  const metadata = await lstat(temporary, { bigint: true });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || await realpath(temporary) !== temporary) {
    throw new Error("Fresh durable-save temporary target is not a physical regular sibling file.");
  }
}

async function assertActiveBoard(session: FreshBoardPersistenceSession, canonicalBoard: string): Promise<void> {
  if (typeof session.assertActivePcb !== "function" || typeof session.readActivePcbSource !== "function") {
    throw new Error("Fresh board persistence requires private active-PCB identity and raw-source ports before mutation.");
  }
  await session.assertActivePcb(canonicalBoard);
}

const boardText = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

async function readActiveBoard(session: FreshBoardPersistenceSession, canonicalBoard: string): Promise<Buffer> {
  if (typeof session.readActivePcbSource !== "function") throw new Error("Fresh board persistence has no private active-PCB raw-source port.");
  return assertSupportedBoardSource(await session.readActivePcbSource(canonicalBoard));
}

/**
 * Host-only same-session disk-persistence recovery for a fresh marker-bound project when IPC reports success
 * but leaves the board on disk untouched.  It owns neither provider output nor
 * copied projects: construction requires the private fresh-project capability.
 */
export class FreshBoardPersistence {
  readonly #freshProject: FreshProject;
  #before: ExistingBoard | undefined;

  constructor(freshProject: FreshProject) {
    if (!isVerifiedFreshProject(freshProject)) throw new Error("Durable board fallback requires a marker-bound fresh project.");
    this.#freshProject = freshProject;
  }

  async capturePreMutation(session: FreshBoardPersistenceSession): Promise<void> {
    await assertActiveBoard(session, path.resolve(this.#freshProject.pcbPath));
    if (this.#before !== undefined) return;
    const root = await assertFreshProjectDirectoryChain(this.#freshProject);
    this.#before = await readExistingRegularBoard(this.#freshProject.pcbPath, root);
  }

  async diskChangedSinceCapture(): Promise<boolean> {
    if (this.#before === undefined) return false;
    const root = await assertFreshProjectDirectoryChain(this.#freshProject);
    const current = await readExistingRegularBoard(this.#freshProject.pcbPath, root);
    return !freshBoardSerializationsEqual(boardText(current.bytes), boardText(this.#before.bytes));
  }

  hasPendingBoardMutation(): boolean {
    return this.#before !== undefined;
  }

  markNormalSaveComplete(): void {
    this.#before = undefined;
  }

  /**
   * Restore the exact captured disk bytes and make the active KiCad board
   * reload them. This is a terminal recovery primitive for host compound
   * mutations; success does not authorize retry in the same provider turn.
   */
  async rollbackToPreMutation(session: FreshBoardPersistenceSession, guard?: FreshBoardRollbackGuard): Promise<void> {
    const before = this.#before;
    if (before === undefined) throw new Error("Fresh board rollback has no captured pre-mutation state.");
    const root = await assertFreshProjectDirectoryChain(this.#freshProject);
    const expected = path.resolve(this.#freshProject.pcbPath);
    await assertActiveBoard(session, expected);
    const current = await readExistingRegularBoard(expected, root);
    const guardedDisk = guard === undefined ? undefined : assertSupportedBoardSource(guard.expectedDiskSource);
    const guardedLive = guard === undefined ? undefined : assertSupportedBoardSource(guard.expectedLiveSource);
    const assertGuard = async (expectedDisk: Buffer): Promise<void> => {
      if (guardedLive === undefined) return;
      await assertActiveBoard(session, expected);
      const disk = await readExistingRegularBoard(expected, await assertFreshProjectDirectoryChain(this.#freshProject));
      const live = await readActiveBoard(session, expected);
      const settled = await readExistingRegularBoard(expected, await assertFreshProjectDirectoryChain(this.#freshProject));
      if (!disk.bytes.equals(expectedDisk) || !settled.bytes.equals(expectedDisk)
          || !samePhysicalIdentity(disk.physical, settled.physical) || !live.equals(guardedLive)) {
        throw new Error("Guarded PCB rollback observed external disk/live drift; current state was preserved.");
      }
    };
    if (guardedDisk !== undefined) {
      if (!current.bytes.equals(guardedDisk)) throw new Error("Guarded PCB rollback disk differs from its exact admitted observation; current state was preserved.");
      await assertGuard(guardedDisk);
    }
    if (current.content.sha256 !== before.content.sha256 || !current.bytes.equals(before.bytes)) {
      const temporary = path.join(root.canonicalPath, `.${path.basename(expected)}.${process.pid}.${randomUUID()}.evleda-rollback.tmp`);
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(before.bytes);
          await handle.sync();
        } finally { await handle.close(); }
        await assertPhysicalTemporary(temporary);
        const staged = await readExistingRegularBoard(temporary, root);
        if (!staged.bytes.equals(before.bytes) || staged.content.sha256 !== before.content.sha256) {
          throw new Error("Fresh board rollback staging bytes differ from the exact preimage.");
        }
        if (guardedDisk !== undefined) await assertGuard(guardedDisk);
        await rename(temporary, expected);
        await syncDirectory(root.canonicalPath);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    }
    await assertActiveBoard(session, expected);
    if (guardedDisk !== undefined) await assertGuard(before.bytes);
    const reverted = await session.callTool("pcb_revert", {});
    if (reverted.isError === true) throw new Error("KiCad rejected live-board rollback to the restored disk preimage.");
    if(guard!==undefined&&!hasQualifiedNativeBoardReply(reverted,"Board reverted to last saved state. All unsaved changes have been discarded."))throw new Error("Guarded PCB rollback lacks the qualified positive native revert acknowledgement; editor recovery remains required.");
    const semantic = JSON.stringify(reverted.structuredContent ?? reverted.content).replace(/\s+/gu, " ");
    if (/\b(?:failed|failure|error|unable|refus(?:e|ed|ing))\b|\bcould not\b/iu.test(semantic)) {
      throw new Error(`KiCad live-board rollback reported a semantic failure: ${semantic.slice(0, 500)}`);
    }
    const liveBytes = await readActiveBoard(session, expected);
    const restored = await readExistingRegularBoard(expected, await assertFreshProjectDirectoryChain(this.#freshProject));
    if (!freshBoardSerializationsEqual(boardText(liveBytes), boardText(before.bytes)) || !restored.bytes.equals(before.bytes)
        || restored.content.sha256 !== before.content.sha256) {
      throw new Error("Fresh board rollback did not reproduce the exact disk preimage and equivalent native live serialization.");
    }
    this.#before = undefined;
  }

  async recoverFromLiveBoard(
    session: FreshBoardPersistenceSession,
    rawPcbSaveResult: string,
    fallbackReason: string,
    retainPreimage = false,
    expectedLiveSource?: string,
  ): Promise<FreshBoardSaveAudit> {
    const before = this.#before;
    if (before === undefined) throw new Error("Fresh durable board fallback has no pre-mutation board checkpoint.");
    if (rawPcbSaveResult.length > 8_000) throw new Error("Raw pcb_save result is too large to record safely.");

    const expected = path.resolve(this.#freshProject.pcbPath);
    const expectedDirectory = path.dirname(expected);
    const initialRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    const initialBoard = await readExistingRegularBoard(expected, initialRoot);
    if (!samePhysicalIdentity(initialBoard.physical, before.physical) || initialBoard.content.sha256 !== before.content.sha256) {
      throw new Error("Fresh board changed identity or bytes after its captured pre-mutation checkpoint; refusing concurrent overwrite.");
    }
    const canonicalBoard = initialBoard.physical.canonicalPath;
    const canonicalDirectory = initialRoot.canonicalPath;
    await assertActiveBoard(session, canonicalBoard);

    const liveBytes = await readActiveBoard(session, canonicalBoard);
    const expectedLiveBytes = expectedLiveSource === undefined ? undefined : assertSupportedBoardSource(expectedLiveSource);
    if (expectedLiveBytes !== undefined && !liveBytes.equals(expectedLiveBytes)) throw new Error("Guarded PCB persistence live source changed from the accepted staged observation; preserving current state.");
    const live = identity(liveBytes);
    if (freshBoardSerializationsEqual(boardText(liveBytes), boardText(before.bytes))) throw new Error("Live KiCad board did not differ from the pre-mutation board checkpoint.");
    await assertActiveBoard(session, canonicalBoard);

    // Recheck immediately before opening the sibling temp file.  Node has no
    // handle-relative renameat on Windows, so every path checkpoint fails closed.
    const beforeTempRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    const beforeTempBoard = await readExistingRegularBoard(expected, beforeTempRoot);
    if (!samePhysicalIdentity(beforeTempRoot, initialRoot) || !samePhysicalIdentity(beforeTempBoard.physical, before.physical) || beforeTempBoard.content.sha256 !== before.content.sha256) {
      throw new Error("Fresh board directory, file identity, or bytes changed before temporary-save creation.");
    }
    const temporary = path.join(canonicalDirectory, `.${path.basename(expected)}.${process.pid}.${randomUUID()}.evleda-save.tmp`);
    let temporaryHandleIdentity: FreshFilesystemIdentity | undefined;
    let directorySync: "synced" | "unavailable" | undefined;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await assertPhysicalTemporary(temporary);
        temporaryHandleIdentity = physicalIdentity(temporary, await handle.stat({ bigint: true }));
        await handle.writeFile(liveBytes);
        await handle.sync();
      } finally { await handle.close(); }
      const beforeRenameRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
      const beforeRenameBoard = await readExistingRegularBoard(expected, beforeRenameRoot);
      if (!samePhysicalIdentity(beforeRenameRoot, initialRoot) || !samePhysicalIdentity(beforeRenameBoard.physical, before.physical) || beforeRenameBoard.content.sha256 !== before.content.sha256) {
        throw new Error("Fresh board directory, file identity, or bytes changed before atomic replacement.");
      }
      await assertActiveBoard(session, canonicalBoard);
      await assertPhysicalTemporary(temporary);
      const temporaryBeforeRename = await readExistingRegularBoard(temporary, beforeRenameRoot);
      if (temporaryHandleIdentity === undefined || !samePhysicalIdentity(temporaryBeforeRename.physical, temporaryHandleIdentity) || !temporaryBeforeRename.bytes.equals(liveBytes) || temporaryBeforeRename.content.sha256 !== live.sha256) {
        throw new Error("Fresh durable-save temporary path changed identity or bytes before atomic replacement.");
      }
      if (expectedLiveBytes !== undefined) {
        if (!(await readActiveBoard(session, canonicalBoard)).equals(expectedLiveBytes)) throw new Error("Guarded PCB persistence live source changed before atomic replacement; preserving current state.");
        // The native read above awaits IPC; recheck disk/root AFTER it so an
        // external disk edit during that wait cannot be overwritten.
        const guardedRoot=await assertFreshProjectDirectoryChain(this.#freshProject);
        const guardedBoard=await readExistingRegularBoard(expected,guardedRoot);
        if(!samePhysicalIdentity(guardedRoot,initialRoot)||!samePhysicalIdentity(guardedBoard.physical,before.physical)||!guardedBoard.bytes.equals(before.bytes))throw new Error("Guarded PCB persistence disk or root changed during final native read; preserving current state.");
      }
      await rename(temporary, canonicalBoard);
      directorySync = await syncDirectory(canonicalDirectory);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    const afterRoot = await assertFreshProjectDirectoryChain(this.#freshProject);
    if (!samePhysicalIdentity(afterRoot, initialRoot)) throw new Error("Fresh project root identity changed during atomic board replacement.");
    const afterBoard = await readExistingRegularBoard(expected, afterRoot);
    const afterBytes = afterBoard.bytes;
    const after = afterBoard.content;
    if (!afterBytes.equals(liveBytes) || after.sha256 !== live.sha256) throw new Error("Fresh durable board save readback does not exactly match the verified live board.");
    try { parseFreshPcbSource(new TextDecoder("utf-8", { fatal: true }).decode(afterBytes)); }
    catch (error) { throw new Error("Fresh durable board save readback is not a supported KiCad PCB S-expression.", { cause: error }); }
    if (!retainPreimage) this.#before = undefined;
    if (directorySync === undefined) throw new Error("Fresh board replacement completed without a directory-sync outcome.");
    return Object.freeze({ rawPcbSaveResult, fallbackReason, before: before.content, live, after, directorySync });
  }
}
