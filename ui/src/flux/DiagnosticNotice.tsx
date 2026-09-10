import type { FluxCanonicalIdentityDto, FluxDiagnosticCode, FluxDiagnosticDto } from "./model";
import { safeDisplay, safeDisplayDigest } from "./safe-display";

const CODES = new Set<FluxDiagnosticCode>(["CODEX_CONFIG_INCOMPATIBLE", "PROVIDER_AUTH_UNAVAILABLE", "PROVIDER_DEADLINE_EXCEEDED", "PROVIDER_CANCELLED", "PROVIDER_PROCESS_EXIT", "PROVIDER_REQUEST_FAILED", "PROVIDER_RESPONSE_INVALID", "SOURCE_DRIFT", "TOOLCHAIN_FAILURE"]);
const identityKeys = ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"] as const;
const diagnosticKeys = ["schemaVersion", "code", "evidenceIdentity"] as const;
const exactKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isIdentity = (value: unknown): value is FluxCanonicalIdentityDto => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !exactKeys(value, identityKeys)) return false;
  const item = value as Partial<FluxCanonicalIdentityDto>;
  return item.algorithm === "sha256" && typeof item.digest === "string" && /^[0-9a-f]{64}$/u.test(item.digest) && item.schemaVersion === "evleda.flux-diagnostic-evidence.v1" && item.canonicalizationVersion === "evleda-c14n-json-v1";
};

export type FluxDiagnosticState = Readonly<{ readonly state: "absent" }> | Readonly<{ readonly state: "malformed" }> | Readonly<{ readonly state: "valid"; readonly diagnostic: FluxDiagnosticDto }>;

export const parseFluxDiagnostic = (value: unknown): FluxDiagnosticState => {
  if (value === undefined || value === null) return { state: "absent" };
  if (typeof value !== "object" || Array.isArray(value) || !exactKeys(value, diagnosticKeys)) return { state: "malformed" };
  const item = value as Partial<FluxDiagnosticDto>;
  return item.schemaVersion === "evleda.flux-diagnostic.v1" && typeof item.code === "string" && CODES.has(item.code as FluxDiagnosticCode) && isIdentity(item.evidenceIdentity)
    ? { state: "valid", diagnostic: item as FluxDiagnosticDto }
    : { state: "malformed" };
};

const COPY: Readonly<Record<FluxDiagnosticCode, Readonly<{ readonly title: string; readonly remediation: string }>>> = Object.freeze({
  CODEX_CONFIG_INCOMPATIBLE: { title: "Codex configuration incompatible", remediation: "Update the pinned Codex isolation profile, then restart the local service and recheck readiness." },
  PROVIDER_AUTH_UNAVAILABLE: { title: "Provider authentication unavailable", remediation: "Restore the configured provider authentication, then recheck readiness or create a new run." },
  PROVIDER_DEADLINE_EXCEEDED: { title: "Provider deadline exceeded", remediation: "Review the bounded request and provider availability, then start a new run if another attempt is appropriate." },
  PROVIDER_CANCELLED: { title: "Provider operation cancelled", remediation: "Confirm no prior operation remains pending, then retry only through the preserved browser intent or create a new run." },
  PROVIDER_PROCESS_EXIT: { title: "Provider process exited unsuccessfully", remediation: "Verify the pinned local provider configuration and inspect the safe evidence identity before starting a new run." },
  PROVIDER_REQUEST_FAILED: { title: "Provider request failed", remediation: "Recheck the configured provider service and authentication, then create a new run when the service is healthy." },
  PROVIDER_RESPONSE_INVALID: { title: "Provider response was invalid", remediation: "Review the safe evidence identity and revise the prompt or provider profile before creating a new run." },
  SOURCE_DRIFT: { title: "Source project changed", remediation: "Restore the exact source revision or create and approve a new run from the current source state." },
  TOOLCHAIN_FAILURE: { title: "PCB toolchain failed", remediation: "Review the safe evidence identity and local toolchain readiness, then create a new candidate run after correction." },
});
if (Object.values(COPY).some((entry) => entry.title.length > 80 || entry.remediation.length > 240)) throw new Error("Closed Flux diagnostic copy exceeds its UI bound.");

export function DiagnosticNotice({ diagnostic, required = false, legacy = false, compact = false }: { readonly diagnostic: unknown; readonly required?: boolean; readonly legacy?: boolean; readonly compact?: boolean }) {
  const parsed = parseFluxDiagnostic(diagnostic);
  if (parsed.state === "absent" && !required && !legacy) return null;
  if (parsed.state !== "valid") return <aside className={`flux-diagnostic flux-diagnostic-fallback${compact ? " flux-diagnostic-compact" : ""}`} role="alert"><strong>{legacy && parsed.state === "absent" ? "Legacy diagnostic unavailable" : "Diagnostic unavailable"}</strong><p>{legacy && parsed.state === "absent" ? "This retained v2 record predates structured diagnostics. No failure category is inferred from its prose." : "The required diagnostic is absent, unknown, or malformed. No server prose is used to infer a category."}</p></aside>;
  const copy = COPY[parsed.diagnostic.code];
  return <aside className={`flux-diagnostic${compact ? " flux-diagnostic-compact" : ""}`} role="alert" aria-label={`Diagnostic ${parsed.diagnostic.code}`}>
    <div><strong>{copy.title}</strong><code>{parsed.diagnostic.code}</code></div>
    <p>{copy.remediation}</p>
    <p className="flux-diagnostic-evidence">Evidence <code title={safeDisplayDigest(parsed.diagnostic.evidenceIdentity.digest, false)}>{safeDisplayDigest(parsed.diagnostic.evidenceIdentity.digest)}</code> · {safeDisplay(parsed.diagnostic.evidenceIdentity.schemaVersion)}</p>
  </aside>;
}
