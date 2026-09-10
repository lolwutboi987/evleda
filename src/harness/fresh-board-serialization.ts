export type FreshBoardSerializationErrorCode =
  | "INVALID_TEXT"
  | "SOURCE_TOO_LARGE"
  | "TOKEN_TOO_LARGE"
  | "TOO_MANY_TOKENS"
  | "EXCESSIVE_DEPTH"
  | "MALFORMED_SOURCE"
  | "INVALID_FOOTPRINT_HEADER"
  | "BARE_CARRIAGE_RETURN"
  | "PHYSICAL_NEWLINE_IN_STRING"
  | "UNTERMINATED_STRING";

export const FRESH_BOARD_SERIALIZATION_LIMITS = Object.freeze({
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumTokenCharacters: 1024 * 1024,
  maximumTokens: 1_000_000,
  maximumDepth: 256,
});

export class FreshBoardSerializationError extends Error {
  public constructor(
    public readonly code: FreshBoardSerializationErrorCode,
    public readonly offset: number,
  ) {
    super(`Unsupported fresh board serialization: ${code} at character ${offset}.`);
    this.name = "FreshBoardSerializationError";
  }
}

/**
 * Physical line-ending representation only; never use this text for persistence, source
 * identities, rollback preimages, or concurrent-write checks.
 *
 * KiCad 10.0.3's API formatter emits physical LF delimiters; Windows file output
 * in text mode may emit CRLF. OUTPUTFORMATTER::Quotes escapes field CR/LF as
 * literal \\r/\\n, so physical line breaks inside quotes are unsupported here.
 * The only permitted change is removal of CR immediately preceding a physical
 * LF outside quotes. All other characters, including final newlines, remain
 * exact. This is the first validation stage, not the complete cross-channel
 * comparison: freshBoardSerializationsEqual also handles the pinned serializer's
 * layout whitespace and footprint headers. Callers validate PCB domain rules.
 */
export function freshBoardComparisonText(source: string): string {
  if (typeof source !== "string" || !source.isWellFormed()) {
    throw new FreshBoardSerializationError("INVALID_TEXT", 0);
  }
  if (source.length > FRESH_BOARD_SERIALIZATION_LIMITS.maximumSourceBytes
      || Buffer.byteLength(source, "utf8") > FRESH_BOARD_SERIALIZATION_LIMITS.maximumSourceBytes) {
    throw new FreshBoardSerializationError("SOURCE_TOO_LARGE", 0);
  }
  let quoted = false;
  let escaped = false;
  let hasCrLf = false;
  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset];
    if (character === "\0" || (!quoted && (character === "\uFEFF"
        || (/\s/u.test(character!) && !/[ \t\r\n]/u.test(character!))))) {
      throw new FreshBoardSerializationError("INVALID_TEXT", offset);
    }
    if (quoted) {
      if (character === "\r" || character === "\n") {
        throw new FreshBoardSerializationError("PHYSICAL_NEWLINE_IN_STRING", offset);
      }
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === "\r") {
      if (source[offset + 1] !== "\n") {
        throw new FreshBoardSerializationError("BARE_CARRIAGE_RETURN", offset);
      }
      hasCrLf = true;
      offset += 1;
    } else if (character === '"') {
      quoted = true;
    }
  }
  if (quoted) throw new FreshBoardSerializationError("UNTERMINATED_STRING", source.length);
  return hasCrLf ? source.replaceAll("\r\n", "\n") : source;
}

// Independently pinned to KiCad 10.0.3's format(FOOTPRINT*), not derived from
// incoming root metadata. The emitter uses SEXPR_BOARD_FILE_VERSION (20260206),
// literal pcbnew, and GetMajorMinorVersion(). CTL_FOR_BOARD omits this entire
// prefix; CTL_FOR_CLIPBOARD emits it immediately after the quoted footprint name.
// Source: pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr.cpp:1177-1207 and .h:202-222
// (physical raw-source lines, recorded with source hashes in the captured fixture).
const NATIVE_FOOTPRINT_HEADER = Object.freeze([
  ["version", "20260206"],
  ["generator", '"pcbnew"'],
  ["generator_version", '"10.0"'],
] as const);
const FOOTPRINT_HEADER_NAMES = new Set<string>(NATIVE_FOOTPRINT_HEADER.map(([name]) => name));
const isLayoutWhitespace = (character: string): boolean =>
  character === " " || character === "\t" || character === "\n";

interface Frame {
  readonly start: number;
  readonly offset: number;
  name: string | null;
  atomCount: number;
  firstAtom: string | null;
  childCount: number;
  headerCount: number;
  directFootprint: boolean;
}

interface BoardComparison {
  readonly tokens: readonly string[];
  /** Keep the original deliberate EOF whitespace policy after physical EOL conversion. */
  readonly eofWhitespace: string;
}

/** Comparison-only tokens; never an authoritative source or persistence format. */
function boardComparison(sourceInput: string): BoardComparison {
  const source = freshBoardComparisonText(sourceInput);
  const tokens: string[] = [];
  const stack: Frame[] = [];
  let cursor = 0;
  let rawTokenCount = 0;
  let rootSeen = false;
  let rootClosed = false;
  let endOfRoot = 0;
  let previousWasValue = false;

  while (cursor < source.length) {
    const beforeWhitespace = cursor;
    while (cursor < source.length && isLayoutWhitespace(source[cursor]!)) cursor += 1;
    if (cursor === source.length) break;
    const start = cursor;
    const first = source[cursor]!;
    let token: string;
    if (first === "(" || first === ")") token = source[cursor++]!;
    else if (first === '"') {
      cursor += 1;
      let escaped = false;
      while (cursor < source.length) {
        const character = source[cursor++]!;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') break;
      }
      // Complete string/escape validation already ran in the physical stage.
      token = source.slice(start, cursor);
    } else {
      while (cursor < source.length && !isLayoutWhitespace(source[cursor]!)
          && source[cursor] !== "(" && source[cursor] !== ")") {
        const character = source[cursor]!;
        if (character === '"' || character.charCodeAt(0) < 0x20 || character === "\u007f") {
          throw new FreshBoardSerializationError("MALFORMED_SOURCE", cursor);
        }
        cursor += 1;
      }
      token = source.slice(start, cursor);
    }
    if (token.length > FRESH_BOARD_SERIALIZATION_LIMITS.maximumTokenCharacters) {
      throw new FreshBoardSerializationError("TOKEN_TOO_LARGE", start);
    }
    rawTokenCount += 1;
    if (rawTokenCount > FRESH_BOARD_SERIALIZATION_LIMITS.maximumTokens) {
      throw new FreshBoardSerializationError("TOO_MANY_TOKENS", start);
    }
    const isValue = token !== "(" && token !== ")";
    if (isValue && previousWasValue && beforeWhitespace === start) {
      throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);
    }
    previousWasValue = isValue;
    if (rootClosed) throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);

    if (token === "(") {
      const parent = stack.at(-1);
      if (parent !== undefined && parent.name === null) {
        throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);
      }
      if (stack.length >= FRESH_BOARD_SERIALIZATION_LIMITS.maximumDepth) {
        throw new FreshBoardSerializationError("EXCESSIVE_DEPTH", start);
      }
      stack.push({ start: tokens.length, offset: start, name: null, atomCount: 0,
        firstAtom: null, childCount: 0, headerCount: 0, directFootprint: false });
      rootSeen = true;
      tokens.push(token);
    } else if (token === ")") {
      const frame = stack.pop();
      if (frame === undefined || frame.name === null) {
        throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);
      }
      tokens.push(token);
      if (frame.directFootprint && frame.headerCount !== 0 && frame.headerCount !== 3) {
        throw new FreshBoardSerializationError("INVALID_FOOTPRINT_HEADER", frame.offset);
      }
      const parent = stack.at(-1);
      // Captured KiCad 10.0.3 reopen readback spells these footprint-child
      // angles as 270 where the saved board spells them -90. Limit the alias
      // to an exact three-atom at form under a direct property or pad. In
      // particular, the footprint's own rotation and all coordinates remain
      // exact. This changes comparison tokens only, never source bytes.
      if (frame.name === "at" && frame.atomCount === 3 && frame.childCount === 0
          && tokens.length - frame.start === 6
          && (parent?.name === "property" || parent?.name === "pad")
          && stack.at(-2)?.directFootprint === true
          && tokens[frame.start + 4] === "-90") {
        tokens[frame.start + 4] = "270";
      }
      if (parent === undefined) {
        if (frame.name !== "kicad_pcb" || frame.atomCount !== 0) {
          throw new FreshBoardSerializationError("MALFORMED_SOURCE", frame.offset);
        }
        rootClosed = true;
        endOfRoot = cursor;
      } else {
        if (parent.directFootprint && FOOTPRINT_HEADER_NAMES.has(frame.name)) {
          const expected = NATIVE_FOOTPRINT_HEADER[parent.childCount];
          if (expected === undefined || frame.name !== expected[0] || frame.firstAtom !== expected[1]
              || frame.atomCount !== 1 || frame.childCount !== 0 || tokens.length - frame.start !== 4
              || parent.atomCount !== 1 || !parent.firstAtom?.startsWith('"')) {
            throw new FreshBoardSerializationError("INVALID_FOOTPRINT_HEADER", frame.offset);
          }
          parent.headerCount += 1;
          // These four exact tokens are the current tail. No other source tokens
          // or fields are projected, decoded, reordered, or reconstructed.
          tokens.length = frame.start;
        } else if (parent.directFootprint && parent.headerCount > 0 && parent.headerCount < 3) {
          throw new FreshBoardSerializationError("INVALID_FOOTPRINT_HEADER", frame.offset);
        }
        parent.childCount += 1;
      }
    } else {
      const frame = stack.at(-1);
      if (frame === undefined || token.length === 0) {
        throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);
      }
      if (frame.name === null) {
        if (token.startsWith('"')) throw new FreshBoardSerializationError("MALFORMED_SOURCE", start);
        frame.name = token;
        frame.directFootprint = token === "footprint" && stack.length === 2 && stack[0]!.name === "kicad_pcb";
      } else {
        frame.atomCount += 1;
        if (frame.firstAtom === null) frame.firstAtom = token;
      }
      tokens.push(token);
    }
  }
  if (!rootSeen || !rootClosed || stack.length !== 0) {
    throw new FreshBoardSerializationError("MALFORMED_SOURCE", cursor);
  }
  return { tokens, eofWhitespace: source.slice(endOfRoot) };
}

/**
 * Whole-source equality across pinned KiCad 10.0.3 API/file serializers.
 * Ignores only ASCII layout whitespace between tokens and the exact direct
 * footprint header above, plus the exact -90/270 angle alias in direct
 * footprint property/at and pad/at forms. Every other raw token (including
 * root metadata, numeric spelling, quoted whitespace/escapes, unknown fields,
 * and order) and EOF whitespace must match. Raw source identities remain
 * separate authority.
 */
export function freshBoardSerializationsEqual(leftSource: string, rightSource: string): boolean {
  const left = boardComparison(leftSource);
  const right = boardComparison(rightSource);
  return left.eofWhitespace === right.eofWhitespace && left.tokens.length === right.tokens.length
    && left.tokens.every((token, index) => token === right.tokens[index]);
}
