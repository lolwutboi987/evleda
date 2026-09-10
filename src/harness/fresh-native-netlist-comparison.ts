import { canonicalIdentity, contentIdentity, sha256 } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";

export const FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION = "evleda.fresh-native-netlist-comparison.v1" as const;
const DATE_PLACEHOLDER = '"<native-export-date>"';
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 300_000;
const MAX_DEPTH = 64;
const MAX_TOKEN_CHARACTERS = 262_144;
const whitespace = (character: string | undefined): boolean => character !== undefined && /[ \t\r\n]/u.test(character);

interface Token { readonly start: number; readonly end: number; readonly quoted: boolean }
interface Form { readonly name: string; readonly values: readonly Token[]; readonly children: readonly Form[] }

export class FreshNativeNetlistComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshNativeNetlistComparisonError";
  }
}

const fail = (message: string): never => { throw new FreshNativeNetlistComparisonError(message); };

/**
 * Bounded structural reader retaining original token spans. The existing fresh
 * fact parser intentionally drops fields and raw spans, so its projected output
 * cannot establish this stronger, otherwise byte-exact comparison.
 */
function exportDateToken(source: string): Token {
  if (source.length === 0 || source.length > MAX_SOURCE_BYTES || Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return fail("Native netlist comparison source size is unsupported.");
  }
  if (Buffer.from(source, "utf8").toString("utf8") !== source) return fail("Native netlist comparison requires exact UTF-8 text.");
  let cursor = 0;
  let nodes = 0;
  const skipWhitespace = (): void => { while (whitespace(source[cursor])) cursor += 1; };
  const token = (): Token => {
    const start = cursor;
    const quoted = source[cursor] === '"';
    if (quoted) {
      cursor += 1;
      while (cursor < source.length) {
        const character = source[cursor++]!;
        if (cursor - start > MAX_TOKEN_CHARACTERS) return fail("Native netlist token budget exceeded.");
        if (character === '"') return { start, end: cursor, quoted };
        if (character === "\\") {
          if (cursor >= source.length) return fail("Unterminated native netlist string escape.");
          cursor += 1;
        } else if (character.charCodeAt(0) < 32) return fail("Control character in native netlist string.");
      }
      return fail("Unterminated native netlist string.");
    }
    while (cursor < source.length && !whitespace(source[cursor]) && source[cursor] !== "(" && source[cursor] !== ")") {
      const character = source[cursor++]!;
      if (character === '"' || character === "\\" || character.charCodeAt(0) < 32) return fail("Invalid native netlist atom.");
      if (cursor - start > MAX_TOKEN_CHARACTERS) return fail("Native netlist token budget exceeded.");
    }
    if (cursor === start) return fail("Expected native netlist atom.");
    return { start, end: cursor, quoted };
  };
  const form = (depth: number): Form => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) return fail("Native netlist structural budget exceeded.");
    if (source[cursor++] !== "(") return fail("Expected native netlist form.");
    skipWhitespace();
    const head = token();
    if (head.quoted) return fail("Native netlist form head must be an atom.");
    const name = source.slice(head.start, head.end);
    const values: Token[] = [];
    const children: Form[] = [];
    while (true) {
      skipWhitespace();
      if (cursor >= source.length) return fail("Unterminated native netlist form.");
      if (source[cursor] === ")") { cursor += 1; return { name, values, children }; }
      if (source[cursor] === "(") children.push(form(depth + 1));
      else values.push(token());
    }
  };
  skipWhitespace();
  const root = form(1);
  skipWhitespace();
  if (cursor !== source.length || root.name !== "export" || root.values.length !== 0) {
    return fail("Expected exactly one native netlist export root.");
  }
  const designs = root.children.filter((entry) => entry.name === "design");
  if (designs.length !== 1 || designs[0]!.values.length !== 0) return fail("Expected exactly one direct export/design form.");
  const dates = designs[0]!.children.filter((entry) => entry.name === "date");
  if (dates.length !== 1 || dates[0]!.values.length !== 1 || dates[0]!.children.length !== 0 || !dates[0]!.values[0]!.quoted) {
    return fail("Expected exactly one direct export/design/date string.");
  }
  const result = dates[0]!.values[0]!;
  const date = source.slice(result.start + 1, result.end - 1);
  // KiCad 10.0.3's observed native export timestamp is an unescaped local ISO
  // date/time with seconds. Reject other shapes instead of erasing ambiguity.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/u.test(date)) return fail("Unsupported native export timestamp shape.");
  const parsedDate = new Date(`${date}Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 19) !== date) {
    return fail("Invalid native export timestamp.");
  }
  return result;
}

export interface FreshNativeNetlistComparisonEntry {
  /** Exact captured UTF-8 content identity; never replaced by the comparison identity. */
  readonly rawIdentity: ContentIdentity;
  readonly exportDate: string;
  /** Domain-separated identity of the timestamp-masked representation, not a file digest. */
  readonly comparisonIdentity: CanonicalIdentity;
}

export function freshNativeNetlistComparisonEntry(source: string): FreshNativeNetlistComparisonEntry {
  const date = exportDateToken(source);
  const masked = `${source.slice(0, date.start)}${DATE_PLACEHOLDER}${source.slice(date.end)}`;
  return Object.freeze({
    rawIdentity: Object.freeze(contentIdentity(source)),
    exportDate: source.slice(date.start + 1, date.end - 1),
    comparisonIdentity: Object.freeze(canonicalIdentity({
      normalization: "mask-only-direct-export-design-date-string.v1",
      preservedBytesSha256: sha256(masked),
    }, FRESH_NATIVE_NETLIST_COMPARISON_SCHEMA_VERSION)),
  });
}

/**
 * Compare otherwise exact native exports. Callers must separately bind unchanged
 * schematic source bytes and retain contract parity, tool/library authority,
 * live/disk readback, rollback, and save gates. This helper proves none of those.
 */
export function compareFreshNativeNetlists(beforeSource: string, afterSource: string): Readonly<{
  equal: boolean;
  before: FreshNativeNetlistComparisonEntry;
  after: FreshNativeNetlistComparisonEntry;
}> {
  const before = freshNativeNetlistComparisonEntry(beforeSource);
  const after = freshNativeNetlistComparisonEntry(afterSource);
  return Object.freeze({ equal: before.comparisonIdentity.digest === after.comparisonIdentity.digest, before, after });
}
