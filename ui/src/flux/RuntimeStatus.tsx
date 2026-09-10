import type { FluxReadinessKicadMcpRuntimeDto, FluxRuntimePolicyDto, FluxRuntimeReadinessDto } from "./model";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { fluxProviderLabel, fluxReadinessMessage } from "./model";
import { safeDisplay, safeDisplayDigest } from "./safe-display";
import { parseFluxIterationCapPolicy } from "./iteration-policy";
import { parseFluxReadinessToolchain } from "./toolchain-readiness";

export type FluxBootstrapState = "loading" | "ready" | "setup_required" | "readiness_invalid" | "policy_mismatch" | "policy_invalid" | "error";

const validKicadMcpRuntime = (value: FluxReadinessKicadMcpRuntimeDto | null | undefined): value is FluxReadinessKicadMcpRuntimeDto => {
  const validIdentity = (identity: FluxReadinessKicadMcpRuntimeDto["identity"], schemaVersion: string) =>
    Object.keys(identity).sort().join(",") === "algorithm,canonicalizationVersion,digest,schemaVersion"
    && identity.algorithm === "sha256"
    && /^[0-9a-f]{64}$/u.test(identity.digest)
    && identity.schemaVersion === schemaVersion
    && identity.canonicalizationVersion === "evleda-c14n-json-v1";
  if (value === null || value === undefined
    || Object.keys(value).sort().join(",") !== "connectionPolicy,executionBridgeIdentity,identity,inspectionBridgeIdentity"
    || !validIdentity(value.identity, "evleda.kicad-mcp-runtime.v1")
    || !validIdentity(value.inspectionBridgeIdentity, "evleda.kicad-mcp-inspection-bridge.v2")
    || !validIdentity(value.executionBridgeIdentity, "evleda.kicad-mcp-execution-bridge.v1")) return false;
  const policy = value.connectionPolicy;
  return Object.keys(policy).sort().join(",") === "cleanup,concurrency,maxConnections,restart,reuse,unconfirmed"
    && policy.maxConnections === 8
    && policy.concurrency === 1
    && policy.reuse === "same-live-run-bounded"
    && policy.restart === "fail-closed-reallocate-reapprove"
    && policy.cleanup === "after-confirmed-session-and-editor-stop"
    && policy.unconfirmed === "retain-poison-no-retry";
};

export const policyMatchesReadiness = (readiness: FluxRuntimeReadinessDto, policy: FluxRuntimePolicyDto): boolean => {
  const provider = readiness.provider;
  return readiness.configured && readiness.status === "ready" && provider !== null &&
    parseFluxReadinessToolchain(readiness.toolchain) !== undefined &&
    validKicadMcpRuntime(readiness.kicadMcpRuntime) &&
    readiness.diagnostic === null &&
    provider.provider === policy.providerModel.provider &&
    provider.model === policy.providerModel.model &&
    provider.canonicalTier === policy.providerModel.tier &&
    provider.localReadCapability === (provider.provider === "codex" ? "read_only_host_files" : "none") &&
    (provider.provider === "codex" ? provider.configurationPreflight?.status === "passed" && provider.configurationPreflight.imageInspectionPolicy === "disabled_by_pinned_feature" : provider.configurationPreflight === null) &&
    parseFluxIterationCapPolicy(policy.iterationCap) !== undefined;
};

const tierLabel = (readiness: FluxRuntimeReadinessDto): string => {
  const provider = readiness.provider;
  if (provider === null) return "Unavailable";
  if (provider.requestedTier === "fast") return provider.canonicalTier === "priority" ? "Fast (canonical priority)" : "Unsupported tier binding";
  if (provider.requestedTier === "provider-default") return "Provider default";
  return provider.requestedTier === "standard" ? "Standard" : "Unsupported tier binding";
};

export function RuntimeStatus({ readiness, state, error, onRetry }: {
  readonly readiness: FluxRuntimeReadinessDto | undefined;
  readonly state: FluxBootstrapState;
  readonly error: string | undefined;
  readonly onRetry: () => void;
}) {
  const toolchain = parseFluxReadinessToolchain(readiness?.toolchain);
  const kicadMcpRuntime = readiness?.kicadMcpRuntime;
  const ready = state === "ready" && readiness?.configured === true && readiness.provider !== null && readiness.compiler !== null && toolchain !== undefined && validKicadMcpRuntime(kicadMcpRuntime);
  const stateClass = ready ? "flux-state-completed" : state === "loading" ? "flux-state-active" : "flux-state-blocked";
  return <section className={`flux-runtime flux-runtime-${ready ? "ready" : state}`} aria-labelledby="flux-runtime-title" aria-busy={state === "loading"}>
    <div className="flux-runtime-heading">
      <div><p className="overline">SERVER AUTHORITY</p><h2 id="flux-runtime-title">Interpretation runtime</h2></div>
      <span className={`flux-state ${stateClass}`}>{state.replaceAll("_", " ")}</span>
    </div>
    {ready ? <>
      <dl className="flux-runtime-grid">
        <div><dt>Provider</dt><dd>{fluxProviderLabel(readiness.provider.provider)}</dd></div>
        <div><dt>Model</dt><dd><code>{safeDisplay(readiness.provider.model)}</code></dd></div>
        <div><dt>Tier</dt><dd>{tierLabel(readiness)}</dd></div>
        <div><dt>Adapter</dt><dd><code>{safeDisplay(readiness.provider.adapterSchemaVersion)}</code></dd></div>
        <div><dt>Provider profile</dt><dd><code title={safeDisplayDigest(readiness.provider.providerProfileIdentity.digest, false)}>{safeDisplayDigest(readiness.provider.providerProfileIdentity.digest)}</code></dd></div>
        <div><dt>Compiler catalog</dt><dd><code title={safeDisplayDigest(readiness.compiler.catalogIdentity.digest, false)}>{safeDisplayDigest(readiness.compiler.catalogIdentity.digest)}</code></dd></div>
        <div><dt>Exact libraries</dt><dd>{safeDisplay(readiness.compiler.exactSymbolCount)} symbols · {safeDisplay(readiness.compiler.exactFootprintCount)} footprints</dd></div>
        <div><dt>Library nicknames</dt><dd>{safeDisplay(readiness.compiler.symbolNicknameCount)} symbol · {safeDisplay(readiness.compiler.footprintNicknameCount)} footprint</dd></div>
        <div><dt>KiCad toolchain</dt><dd><code title={safeDisplayDigest(toolchain.identity.digest, false)}>{safeDisplayDigest(toolchain.identity.digest)}</code></dd></div>
        <div><dt>KiCad CLI</dt><dd>{safeDisplay(toolchain.kicadCli.operationalVersion)} · PE file {safeDisplay(toolchain.kicadCli.peFileVersion)} · product {safeDisplay(toolchain.kicadCli.peProductVersion)}</dd></div>
        <div><dt>KiCad CLI binding</dt><dd><code title={safeDisplayDigest(toolchain.kicadCli.identity.digest, false)}>{safeDisplayDigest(toolchain.kicadCli.identity.digest)}</code></dd></div>
        <div><dt>KiCad CLI commit</dt><dd><code>{safeDisplay(toolchain.kicadCli.operationalCommit)}</code></dd></div>
        <div><dt>PCB editor</dt><dd>PE file {safeDisplay(toolchain.pcbnew.peFileVersion)} · product {safeDisplay(toolchain.pcbnew.peProductVersion)}</dd></div>
        <div><dt>PCB editor binding</dt><dd><code title={safeDisplayDigest(toolchain.pcbnew.identity.digest, false)}>{safeDisplayDigest(toolchain.pcbnew.identity.digest)}</code></dd></div>
        <div><dt>KiCad MCP runtime</dt><dd><code title={safeDisplayDigest(kicadMcpRuntime.identity.digest, false)}>{safeDisplayDigest(kicadMcpRuntime.identity.digest)}</code></dd></div>
        <div><dt>Inspection bridge</dt><dd><code title={safeDisplayDigest(kicadMcpRuntime.inspectionBridgeIdentity.digest, false)}>{safeDisplayDigest(kicadMcpRuntime.inspectionBridgeIdentity.digest)}</code></dd></div>
        <div><dt>Execution bridge</dt><dd><code title={safeDisplayDigest(kicadMcpRuntime.executionBridgeIdentity.digest, false)}>{safeDisplayDigest(kicadMcpRuntime.executionBridgeIdentity.digest)}</code></dd></div>
        <div><dt>MCP connections</dt><dd>{kicadMcpRuntime.connectionPolicy.maxConnections} total · {kicadMcpRuntime.connectionPolicy.concurrency} concurrent</dd></div>
      </dl>
      {readiness.provider.provider === "codex" && readiness.provider.localReadCapability === "read_only_host_files" ? <aside className="flux-runtime-read-warning" role="note" aria-label="Codex local read capability"><strong>Codex CLI retains local read capability</strong><p>The acknowledged read-only provider mode may inspect host files available to its process. This acknowledgement does not create a tool-free or no-read boundary.</p></aside> : null}
      <p className="flux-runtime-copy">This safe snapshot contains identities, versions, and counts only. Credentials, executable locations, library paths, and bundle contents stay server-side.</p>
    </> : <div className="flux-runtime-blocker" role={state === "loading" ? "status" : "alert"}>
      {state === "loading" ? <p>Checking the server-owned provider and compiler configuration…</p> : null}
      {state === "setup_required" ? <><h3>Setup required</h3><ul>{readiness?.reasonCodes.map((code) => <li key={code}>{fluxReadinessMessage(code)}</li>)}</ul><DiagnosticNotice diagnostic={readiness?.diagnostic} required={readiness?.reasonCodes.some((code) => code === "CODEX_CONFIG_INCOMPATIBLE" || code === "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED" || code === "KICAD_PROCESS_TERMINATION_UNCONFIRMED") === true} /></> : null}
      {state === "readiness_invalid" ? <><h3>Runtime authority malformed</h3><p>The ready snapshot did not contain exact path-free KiCad toolchain, MCP runtime, inspection, and execution identity projections. Lifecycle policy and mutations remain locked.</p></> : null}
      {state === "policy_mismatch" ? <><h3>Provider policy changed during bootstrap</h3><p>The readiness snapshot and lifecycle policy do not bind the same provider, model, and canonical tier. Mutating controls remain locked until a fresh consistent snapshot is loaded.</p></> : null}
      {state === "policy_invalid" ? <><h3>Iteration policy unavailable</h3><p>The server lifecycle policy did not provide one closed, bounded iteration-cap range. Create remains locked; the browser will not invent a limit.</p></> : null}
      {state === "error" ? <><h3>Runtime status unavailable</h3><p>{safeDisplay(error, "The safe Flux readiness snapshot could not be loaded.")}</p></> : null}
      {state !== "loading" ? <button className="button button-secondary" type="button" onClick={onRetry}>Retry setup check</button> : null}
    </div>}
  </section>;
}
