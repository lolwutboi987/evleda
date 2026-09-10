/** Authored assignment model for the closed generic contract net-name grammar. */
export const FRESH_NETCLASS_ASSIGNMENT_MODEL = Object.freeze({
  netClassPatterns: "host-generated-escaped-anchored-exact-contract-names" as const,
  derivedLabelAssignments: "empty-only" as const,
  contractNetAssignments: "exclusive" as const,
});

const CONTRACT_NET_NAME = /^[A-Za-z0-9+-][A-Za-z0-9_.+-]{0,63}$/u;
const RESERVED_NET_NAMES = new Set(["__proto__", "constructor", "prototype", "~no-connect", "~unnamed"]);
const MANAGED_CLASS_NAME = /^EVLEDA_[a-f0-9]{12}_C(?:0[1-9]|[1-9]\d*)$/u;

export interface FreshAuthoredNetClassPattern {
  readonly pattern: string;
  readonly netclass: string;
}

/**
 * KiCad 10.0.3 CTX_NETCLASS uses wxRE_ADVANCED without wxRE_ICASE, plus
 * an anchored wildcard matcher (common/eda_pattern_match.cpp). Only . and +
 * are regex operators admitted by this contract grammar; - is literal outside
 * a character class. Explicit ^/$ make the wildcard branch match only names
 * containing literal anchors, which the contract grammar forbids. Exact PCB
 * inventory validation remains required: this is not a general net matcher.
 */
export function exactContractNetClassPattern(netName: string): string {
  if (!CONTRACT_NET_NAME.test(netName) || !/[A-Za-z0-9]/u.test(netName)
      || RESERVED_NET_NAMES.has(netName.toLowerCase())) {
    throw new Error("Authored netclass patterns require a valid closed-contract net name.");
  }
  return `^${netName.replace(/[.+]/gu, "\\$&")}$`;
}

export function createExactContractNetClassPatterns(
  assignments: readonly { readonly netName: string; readonly kicadNetClassName: string }[],
): readonly FreshAuthoredNetClassPattern[] {
  if (assignments.length === 0 || assignments.length > 128) {
    throw new Error("Authored netclass pattern inventory is outside the contract bound.");
  }
  const names = new Set<string>();
  return [...assignments].sort((left, right) => left.netName.localeCompare(right.netName, "en-US"))
    .map(({ netName, kicadNetClassName }) => {
      if (names.has(netName) || !MANAGED_CLASS_NAME.test(kicadNetClassName)) {
        throw new Error("Authored netclass patterns require unique nets and bundle-managed classes.");
      }
      names.add(netName);
      return Object.freeze({ pattern: exactContractNetClassPattern(netName), netclass: kicadNetClassName });
    });
}

/** Validate exact records, not user-supplied regular expression equivalence. */
export function assertExactContractNetClassPatterns(
  value: unknown,
  expected: readonly FreshAuthoredNetClassPattern[],
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("Authored netclass patterns must contain exactly one expected pattern per contract net.");
  }
  const remaining = new Map(expected.map((entry) => [entry.pattern, entry.netclass]));
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || Object.keys(entry).sort().join("\0") !== "netclass\0pattern"
        || typeof entry.pattern !== "string" || typeof entry.netclass !== "string"
        || remaining.get(entry.pattern) !== entry.netclass) {
      throw new Error("Authored netclass patterns are missing, extra, altered, duplicate, or not exact contract mappings.");
    }
    remaining.delete(entry.pattern);
  }
}

/** KiCad serializes its empty schematic-derived label-assignment cache as null. */
export function assertEmptyDerivedNetClassAssignments(value: unknown): void {
  if (value !== null && (typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 0)) {
    throw new Error("Derived net-class label assignments must be empty for passive global labels without class fields.");
  }
}
