const MAX_TEXT_LENGTH = 512;
const MAX_DEPTH = 5;
const MAX_ITEMS = 32;
const MAX_NODES = 256;

const CONTROL_TEXT = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/u;
const WINDOWS_OR_UNC_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/\/)[^\s<>"']*/u;
const FILE_URI = /file:\/\/[^\s<>"']*/iu;
const POSIX_PATH = /(?:^|[\s('"=:\[])\s*(?:~\/|\/(?!\/))(?:[A-Za-z0-9._~+-]+\/)*[A-Za-z0-9._~+-]*(?:\.[A-Za-z0-9._~-]+)?(?:$|[\s\]),.;:'"])/u;
const RELATIVE_PATH = /(?:^|[\s('"=:\[])(?:(?:\.\.?|[A-Za-z0-9._~-]+)[\\/])+(?:[A-Za-z0-9._~+-]+(?:\.[A-Za-z0-9._~-]+)?)(?:$|[\s\]),.;:'"])/u;
const CREDENTIAL_ASSIGNMENT = /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session(?:[_ -]?(?:id|key|token))?|cookie|set-cookie|client[_ -]?secret|token|secret|password|passphrase|credential|authorization|proxy-authorization|bearer|basic)\b\s*(?:[:=]|\bis\b)\s*\S+/iu;
const CREDENTIAL_TOKEN = /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}\b|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b|\bgh[pousr]_[A-Za-z0-9]{12,}\b|\bxox[a-z]-[A-Za-z0-9-]{12,}\b|\bAKIA[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b)/iu;
const PRIVATE_KEY_MATERIAL = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|PuTTY-User-Key-File-/iu;
const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|session|token|secret|password|passphrase|credential|authorization|cookie|private.?key|bearer|client.?secret|csrf|(?:^|[_-])(?:path|root)(?:$|[_-])|librarypath|sourceroot|relativepath|rawprovidertext|html)/iu;

const redactedString = (value: string): string | undefined => {
  if (value.length > MAX_TEXT_LENGTH) return "[redacted overlong text]";
  if (CONTROL_TEXT.test(value)) return "[redacted control text]";
  if (WINDOWS_OR_UNC_PATH.test(value) || FILE_URI.test(value) || POSIX_PATH.test(value) || RELATIVE_PATH.test(value)) return "[redacted path]";
  if (CREDENTIAL_ASSIGNMENT.test(value) || CREDENTIAL_TOKEN.test(value) || PRIVATE_KEY_MATERIAL.test(value)) return "[redacted credential]";
  return undefined;
};

const safeKey = (value: string): Readonly<{ readonly label: string; readonly sensitive: boolean }> => {
  if (SENSITIVE_KEY.test(value)) return { label: "[redacted field]", sensitive: true };
  const redacted = redactedString(value);
  return redacted === undefined && value.trim().length > 0 ? { label: value, sensitive: false } : { label: "[redacted field]", sensitive: false };
};

interface ProjectionContext {
  readonly seen: WeakSet<object>;
  nodes: number;
}

const project = (value: unknown, depth: number, context: ProjectionContext): string => {
  if (context.nodes >= MAX_NODES) return "[truncated]";
  context.nodes += 1;
  if (typeof value === "string") {
    const redacted = redactedString(value);
    return redacted ?? (value.trim().length === 0 ? "—" : value);
  }
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "[unsupported value]";
  if (typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (typeof value !== "object") return "[unsupported value]";
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (context.seen.has(value)) return "[circular]";
  context.seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((entry) => project(entry, depth + 1, context));
      if (value.length > MAX_ITEMS) items.push("[truncated]");
      return items.length === 0 ? "[]" : items.join(", ");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return "[unsupported object]";
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ITEMS);
    const displayed = entries.map(([key, entry]) => {
      const projectedKey = safeKey(key);
      return `${projectedKey.label}: ${projectedKey.sensitive ? "[redacted]" : project(entry, depth + 1, context)}`;
    });
    if (Object.keys(value as Record<string, unknown>).length > MAX_ITEMS) displayed.push("[truncated]");
    return displayed.length === 0 ? "{}" : displayed.join("; ");
  } catch {
    return "[unsupported object]";
  } finally {
    context.seen.delete(value);
  }
};

/**
 * The only renderer for server-projected text and unknown inspection values.
 * It returns bounded inert text and never stringifies arbitrary objects.
 */
export const safeDisplay = (value: unknown, fallback = "Unavailable"): string => {
  const displayed = project(value, 0, { seen: new WeakSet<object>(), nodes: 0 });
  return displayed === "—" ? fallback : displayed;
};

export const safeDisplayDate = (value: unknown): string => {
  const text = safeDisplay(value, "Unavailable");
  if (text.startsWith("[redacted") || text === "Unavailable") return text;
  const date = new Date(text);
  return Number.isNaN(date.valueOf()) ? "Invalid timestamp" : date.toLocaleString();
};

export const safeDisplayDigest = (value: unknown, abbreviated = true): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) return "[invalid digest]";
  const displayed = safeDisplay(value);
  return abbreviated ? `${displayed.slice(0, 8)}…${displayed.slice(-6)}` : displayed;
};

export const safeDisplayLabel = (value: unknown): string => safeDisplay(value).replaceAll("_", " ");
