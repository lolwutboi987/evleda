import type { FluxApprovalSubjectDto, FluxCanonicalIdentityDto, FluxCompilationBundleRefDto, FluxContentIdentityDto, FluxProviderProfileBindingDto, FluxRunDto, FluxRuntimeReadinessDto, FluxTerminalDisposition } from "./model";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { parseFluxDeepRuleSummary } from "./deep-rule-summary";
import { parseFluxDesignContract } from "./design-contract-projection";
import { safeDisplay, safeDisplayDigest, safeDisplayLabel } from "./safe-display";

const terminal = new Set<FluxRunDto["phase"]>(["completed", "needs_review", "failed", "blocked"]);
const identitySchema = /^[a-z0-9][a-z0-9._-]{0,191}$/u;
const digest = /^[0-9a-f]{64}$/u;
const exactKeys = (value: object, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const plain = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ? value as Record<string, unknown> : undefined;
const closed = (value: unknown, keys: readonly string[]): Record<string, unknown> | undefined => { const item = plain(value); return item !== undefined && exactKeys(item, keys) ? item : undefined; };
const closedArray = (value: unknown, check: (entry: unknown) => boolean): boolean => Array.isArray(value) && value.every(check);
const validIdentity = (value: unknown): value is FluxCanonicalIdentityDto => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FluxCanonicalIdentityDto>;
  return exactKeys(value, ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"]) && item.algorithm === "sha256" && typeof item.digest === "string" && digest.test(item.digest) && typeof item.schemaVersion === "string" && identitySchema.test(item.schemaVersion) && item.canonicalizationVersion === "evleda-c14n-json-v1";
};
const validContentIdentity = (value: unknown): value is FluxContentIdentityDto => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FluxContentIdentityDto>;
  return exactKeys(value, ["algorithm", "digest", "size"]) && item.algorithm === "sha256" && typeof item.digest === "string" && digest.test(item.digest) && Number.isSafeInteger(item.size) && (item.size ?? -1) >= 0;
};
const validProviderProfile = (value: unknown): value is FluxProviderProfileBindingDto => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FluxProviderProfileBindingDto>;
  return exactKeys(value, ["schemaVersion", "provider", "model", "tier", "adapterSchemaVersion", "identity"]) && typeof item.schemaVersion === "string" && identitySchema.test(item.schemaVersion) && typeof item.provider === "string" && ["openai", "anthropic", "codex", "claude-cli"].includes(item.provider) && typeof item.model === "string" && item.model.length > 0 && item.model.length <= 256 && typeof item.tier === "string" && ["provider-default", "standard", "priority"].includes(item.tier) && typeof item.adapterSchemaVersion === "string" && identitySchema.test(item.adapterSchemaVersion) && validIdentity(item.identity) && item.identity.schemaVersion === item.schemaVersion;
};
const validBundleReference = (value: unknown): value is FluxCompilationBundleRefDto => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<FluxCompilationBundleRefDto>;
  return exactKeys(value, ["schemaVersion", "bundleIdentity", "contentIdentity", "identity"]) && typeof item.schemaVersion === "string" && identitySchema.test(item.schemaVersion) && validIdentity(item.bundleIdentity) && validContentIdentity(item.contentIdentity) && validIdentity(item.identity) && item.identity.schemaVersion === item.schemaVersion;
};
const validClosedContractShape = (value: unknown): boolean => {
  const contract = closed(value, ["schemaVersion", "kind", "scope", "components", "nets", "netClasses", "placementConstraints", "routingConstraints", "identity"]); if (contract === undefined) return false;
  const scope = closed(contract.scope, ["sheetCount", "componentUnitPolicy", "board"]); const board = closed(scope?.board, ["shape", "widthMm", "heightMm", "layerCount", "copperLayers"]); if (scope === undefined || board === undefined || !Array.isArray(board.copperLayers)) return false;
  const assignment = (value: unknown): boolean => { const item = plain(value); return item?.kind === "net" ? closed(item, ["kind", "net"]) !== undefined : item?.kind === "no_connect" && closed(item, ["kind"]) !== undefined; };
  const component = (value: unknown): boolean => { const item = closed(value, ["reference", "symbolLibId", "value", "footprintLibId", "unit", "pins"]); return item !== undefined && closedArray(item.pins, (pin) => { const record = closed(pin, ["pin", "assignment"]); return record !== undefined && assignment(record.assignment); }); };
  const endpoint = (value: unknown): boolean => closed(value, ["reference", "pin"]) !== undefined;
  const electrical = (value: unknown): boolean => { const item = closed(value, ["voltage", "current", "speed"]); return item !== undefined && closed(item.voltage, ["minimumV", "nominalV", "maximumV"]) !== undefined && closed(item.current, ["nominalA", "maximumContinuousA", "peakA", "peakDurationMs"]) !== undefined && closed(item.speed, ["kind", "maximumFrequencyMHz", "minimumEdgeTimeNs"]) !== undefined; };
  const net = (value: unknown): boolean => { const item = closed(value, ["name", "role", "endpoints", "electrical", "netClassId"]); return item !== undefined && closedArray(item.endpoints, endpoint) && electrical(item.electrical); };
  const netClass = (value: unknown): boolean => { const item = closed(value, ["id", "traceWidthMm", "clearanceMm", "copperToEdgeMm", "allowedLayers"]); return item !== undefined && Array.isArray(item.allowedLayers); };
  const placement = (value: unknown): boolean => { const item = closed(value, ["reference", "side", "regionMm", "allowedRotationsDeg", "minimumEdgeClearanceMm", "minimumCourtyardClearanceMm", "edgePreference"]); return item !== undefined && closed(item.regionMm, ["minXmm", "maxXmm", "minYmm", "maxYmm"]) !== undefined && Array.isArray(item.allowedRotationsDeg); };
  const routing = closed(contract.routingConstraints, ["cornerStyle", "maximumTurnAngleDeg", "minimumStraightBeforeTurnMm", "allowRightAngleCorners", "allowAcuteInteriorCorners", "allowBacktracking", "allowSelfIntersections", "viaPolicy", "nets"]); if (routing === undefined) return false;
  const via = plain(routing.viaPolicy); const validVia = via?.mode === "forbidden" ? closed(via, ["mode", "maxTotal"]) !== undefined : via?.mode === "bounded" && closed(via, ["mode", "maxTotal", "diameterMm", "drillMm", "minimumAnnularRingMm"]) !== undefined;
  const route = (value: unknown): boolean => { const item = closed(value, ["net", "topology", "preferredLayer", "maxVias", "routeLength"]); if (item === undefined) return false; const length = plain(item.routeLength); return length?.mode === "unbounded" ? closed(length, ["mode"]) !== undefined : length?.mode === "bounded" && closed(length, ["mode", "maximumMm"]) !== undefined; };
  return closedArray(contract.components, component) && closedArray(contract.nets, net) && closedArray(contract.netClasses, netClass) && closedArray(contract.placementConstraints, placement) && validVia && closedArray(routing.nets, route);
};
const validContractRecord = (value: unknown): value is Readonly<Record<string, unknown>> & Readonly<{ readonly identity: FluxCanonicalIdentityDto }> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return validClosedContractShape(value) && parseFluxDesignContract(value) !== undefined && item.schemaVersion === "evleda.pcb-design-contract.v1" && item.kind === "pcb_design_contract" && validIdentity(item.identity) && item.identity.schemaVersion === item.schemaVersion;
};
const sameIdentity = (left: unknown, right: unknown): boolean => validIdentity(left) && validIdentity(right) && left.algorithm === right.algorithm && left.digest === right.digest && left.schemaVersion === right.schemaVersion && left.canonicalizationVersion === right.canonicalizationVersion;

export interface FluxAuthorityIssue { readonly title: string; readonly message: string }
export type FluxAuthorityIntegrity = "not_applicable" | "pending" | "valid" | "invalid";

export const fluxAuthorityIssue = (run: FluxRunDto | undefined, readiness: FluxRuntimeReadinessDto | undefined): FluxAuthorityIssue | undefined => {
  if (run === undefined) return undefined;
  if (run.blockedReason !== undefined) {
    return { title: run.phase === "failed" ? "Run failed" : "Run blocked", message: "The server recorded a terminal failure. Only the closed diagnostic record below is used to classify it." };
  }
  const receipt = run.contractState?.interpreterReceipt;
  if (run.workflowKind === "generic" && run.contractState?.disposition === "ready") {
    if (run.contractState.questions.length !== 0 || run.contractState.issues.length !== 0 || !validContractRecord(run.contractState.contract)) return { title: "Compilation authority incomplete", message: "A ready contract must contain one closed contract, no questions or issues, and an exact canonical record shape." };
    if (![run.contractState.contractIdentity, run.contractState.libraryBindingIdentity, run.contractState.deepRuleBindingIdentity, run.contractState.acceptancePlanIdentity].every(validIdentity)) return { title: "Compilation authority incomplete", message: "The ready contract is missing a valid compiled identity closure." };
    if (parseFluxDeepRuleSummary(run.contractState.deepRuleSummary, run.contractState.deepRuleBindingIdentity) === undefined) return { title: "Deep-rule summary drift", message: "The public selected-rule summary is missing, malformed, or not bound to this contract state." };
    if (!sameIdentity(run.contractState.contractIdentity, run.contractState.contract.identity)) return { title: "Contract-identity drift", message: "The displayed contract identity does not match the ready contract record." };
    if (receipt?.schemaVersion !== "evleda.flux-interpreter-receipt.v2") return { title: "Compilation-bundle drift", message: "This generic ready contract has no v2 compilation receipt and cannot continue." };
    if (!exactKeys(receipt, ["schemaVersion", "interpreterSchemaVersion", "provider", "providerProfile", "providerProfileIdentity", "promptDigest", "clarificationDigest", "compilerProfileIdentity", "practiceProfileBindingIdentity", "bundleIdentity", "compiledAt", "identity"]) || !validIdentity(receipt.identity) || receipt.identity.schemaVersion !== receipt.schemaVersion) return { title: "Interpreter-receipt drift", message: "The v2 interpreter receipt is not an exact closed canonical record." };
    if (!validIdentity(receipt.compilerProfileIdentity) || !validIdentity(receipt.practiceProfileBindingIdentity)) return { title: "Compilation authority incomplete", message: "The v2 receipt is missing a valid compiler or engineering-practice profile identity." };
    if (!validBundleReference(run.compilationBundleRef) || !sameIdentity(receipt.bundleIdentity, run.compilationBundleRef.bundleIdentity)) return { title: "Compilation-bundle drift", message: "The public bundle reference and its content identities do not match the interpreter receipt." };
    if (!validIdentity(receipt.providerProfileIdentity) || !validProviderProfile(receipt.providerProfile) || !sameIdentity(receipt.providerProfileIdentity, receipt.providerProfile.identity) || receipt.provider !== receipt.providerProfile.provider || receipt.providerProfile.provider !== run.providerModel.provider || receipt.providerProfile.model !== run.providerModel.model || receipt.providerProfile.tier !== run.providerModel.tier) return { title: "Provider-profile drift", message: "The run projection does not match its bound provider profile." };
    if (readiness?.configured !== true || readiness.provider === null || readiness.compiler === null) return { title: "Runtime authority unavailable", message: "The current provider and compiler identities are unavailable; continuing is locked." };
    if (!validIdentity(readiness.provider.providerProfileIdentity) || !sameIdentity(receipt.providerProfileIdentity, readiness.provider.providerProfileIdentity) || readiness.provider.provider !== run.providerModel.provider || readiness.provider.model !== run.providerModel.model || readiness.provider.canonicalTier !== run.providerModel.tier) return { title: "Provider-profile drift", message: terminal.has(run.phase) ? "This historical run is bound to a different provider profile than the current runtime." : "The current runtime provider profile changed after this run was compiled; continuing is locked." };
    if (!validIdentity(readiness.compiler.profileIdentity) || !validIdentity(readiness.compiler.catalogIdentity)) return { title: "Runtime authority unavailable", message: "The current compiler readiness identities are missing or malformed; continuing is locked." };
    // Production-composition and bundle compiler identities use distinct schemas. Equality is meaningful only when both declare the same identity domain.
    if (receipt.compilerProfileIdentity.schemaVersion === readiness.compiler.profileIdentity.schemaVersion && !sameIdentity(receipt.compilerProfileIdentity, readiness.compiler.profileIdentity)) return { title: "Compiler-profile drift", message: terminal.has(run.phase) ? "This historical run is bound to a different compiler profile than the current runtime." : "The current compiler profile changed after this run was compiled; continuing is locked." };
  }
  return undefined;
};

const Identity = ({ label, identity }: { readonly label: string; readonly identity: FluxCanonicalIdentityDto | null | undefined }) => <div><dt>{label}</dt><dd>{validIdentity(identity) ? <><code title={safeDisplayDigest(identity.digest, false)}>{safeDisplayDigest(identity.digest)}</code><small>{safeDisplay(identity.schemaVersion)}</small></> : "Unavailable"}</dd></div>;

export function CompilationAuthority({ run, approval, readiness, integrity }: { readonly run: FluxRunDto | undefined; readonly approval: FluxApprovalSubjectDto | undefined; readonly readiness: FluxRuntimeReadinessDto | undefined; readonly integrity: FluxAuthorityIntegrity }) {
  if (run === undefined) return null;
  const receipt = run.contractState?.interpreterReceipt;
  const v2 = receipt?.schemaVersion === "evleda.flux-interpreter-receipt.v2" ? receipt : undefined;
  const reference = validBundleReference(run.compilationBundleRef) ? run.compilationBundleRef : undefined;
  const issue = fluxAuthorityIssue(run, readiness);
  const disposition = terminal.has(run.phase) ? run.phase as FluxTerminalDisposition : undefined;
  return <section className="flux-authority" aria-labelledby="flux-authority-title" aria-busy={integrity === "pending"}>
    <div className="flux-authority-heading"><h3 id="flux-authority-title">Bound candidate authority</h3><span className="flux-check flux-check-review">candidate only</span></div>
    {issue ? <div className="flux-authority-alert" role="alert"><strong>{safeDisplay(issue.title)}</strong><p>{safeDisplay(issue.message)}</p></div> : null}
    {run.phase === "failed" || run.phase === "blocked" ? <DiagnosticNotice diagnostic={run.diagnostic} legacy={run.diagnostic == null} /> : null}
    {!issue && integrity === "pending" ? <div className="flux-authority-pending" role="status"><strong>Verifying public identity closure…</strong></div> : null}
    {!issue && integrity === "invalid" ? <div className="flux-authority-alert" role="alert"><strong>Canonical identity drift</strong><p>The provider profile, compilation-bundle reference, or v2 interpreter receipt does not reproduce its declared identity.</p></div> : null}
    {disposition ? <div className={`flux-terminal flux-terminal-${disposition}`} role="status"><strong>Terminal disposition</strong><span>{safeDisplayLabel(disposition)}</span><p>{disposition === "completed" ? "The bounded candidate run completed. This is not manufacturing release or physical qualification." : "This terminal outcome is retained explicitly; the UI does not reinterpret it as completion."}</p></div> : null}
    {reference ? <dl className="flux-authority-grid">
      <Identity label="Bundle" identity={reference.bundleIdentity} />
      <div><dt>Bundle content</dt><dd><code title={safeDisplayDigest(reference.contentIdentity.digest, false)}>{safeDisplayDigest(reference.contentIdentity.digest)}</code><small>{safeDisplay(reference.contentIdentity.size.toLocaleString("en-US"))} bytes</small></dd></div>
      <Identity label="Bundle reference" identity={reference.identity} />
      <Identity label="Provider profile" identity={v2?.providerProfileIdentity} />
      <Identity label="Compiler profile" identity={v2?.compilerProfileIdentity} />
      <Identity label="Practice profile" identity={v2?.practiceProfileBindingIdentity} />
      <Identity label="Interpreter receipt" identity={v2?.identity} />
      <div><dt>Approval subject</dt><dd>{approval ? <code title={safeDisplayDigest(approval.digest, false)}>{safeDisplayDigest(approval.digest)}</code> : "Not available at this phase"}</dd></div>
    </dl> : <p className="flux-authority-empty">No compilation-bundle reference exists at this phase. Only a ready v2 contract may acquire one.</p>}
    <p className="flux-authority-copy">Only path-free identities and the content byte count are projected here. Bundle contents, generated execution text, credentials, and local paths remain private to the server.</p>
  </section>;
}
