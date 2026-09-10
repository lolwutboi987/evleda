import type { FluxCanonicalIdentityDto, FluxContractStateDto, FluxInspectorSnapshot } from "./model";
import { parseFluxDesignContract, type FluxDesignContractProjection } from "./design-contract-projection";
import { parseFluxDeepRuleSummary } from "./deep-rule-summary";
import { safeDisplay, safeDisplayDigest, safeDisplayLabel } from "./safe-display";

const identity = (label: string, item: FluxCanonicalIdentityDto | null) => item
  ? <li key={label}><strong>{label}</strong><code title={safeDisplayDigest(item.digest, false)}>{safeDisplayDigest(item.digest, false)}</code><small>{safeDisplay(item.schemaVersion)}</small></li>
  : <li key={label}><strong>{label}</strong><span>Not compiled</span></li>;

const number = (value: number): string => safeDisplay(value.toLocaleString("en-US", { maximumFractionDigits: 6 }));
const millimetres = (value: number): string => `${number(value)} mm`;
const degrees = (value: number): string => `${number(value)}°`;
const allowed = (value: false): string => value ? "Allowed" : "Forbidden";
const titleLabel = (value: string): string => safeDisplayLabel(value).replace(/^./u, (character) => character.toUpperCase());

function ContractSection({ id, title, children }: { readonly id: string; readonly title: string; readonly children: React.ReactNode }) {
  return <section className="flux-contract-section" aria-labelledby={id}><h4 id={id}>{title}</h4>{children}</section>;
}

function BoardDetails({ design }: { readonly design: FluxDesignContractProjection }) {
  const board = design.scope.board;
  return <ContractSection id="flux-contract-board" title="Board and sheet">
    <dl className="flux-contract-details" aria-label="Board dimensions and layers">
      <div><dt>Outline</dt><dd>{titleLabel(board.shape)}, {millimetres(board.widthMm)} × {millimetres(board.heightMm)}</dd></div>
      <div><dt>Copper stack</dt><dd>{number(board.layerCount)} layers · {board.copperLayers.map((layer) => safeDisplay(layer)).join(", ")}</dd></div>
      <div><dt>Schematic</dt><dd>{number(design.scope.sheetCount)} sheet · {safeDisplayLabel(design.scope.componentUnitPolicy)}</dd></div>
    </dl>
  </ContractSection>;
}

function Components({ design }: { readonly design: FluxDesignContractProjection }) {
  return <>
    <ContractSection id="flux-contract-components" title="Components, values, symbols, footprints">
      <ul aria-label="Contract components">{design.components.map((component) => <li key={component.reference}>
        <strong>{safeDisplay(component.reference)} · {safeDisplay(component.value)}</strong>
        <span>Symbol {safeDisplay(component.symbolLibId)} · Footprint {safeDisplay(component.footprintLibId)} · Unit {number(component.unit)}</span>
      </li>)}</ul>
    </ContractSection>
    <ContractSection id="flux-contract-pins" title="Pin dispositions">
      <ul aria-label="Contract pin dispositions">{design.components.flatMap((component) => component.pins.map((pin) => <li key={`${component.reference}-${pin.pin}`}>
        <strong>{safeDisplay(component.reference)}.{safeDisplay(pin.pin)}</strong>
        <span>{pin.assignment.kind === "net" ? <>Net {safeDisplay(pin.assignment.net)}</> : "No connect"}</span>
      </li>))}</ul>
    </ContractSection>
  </>;
}

function Nets({ design }: { readonly design: FluxDesignContractProjection }) {
  return <ContractSection id="flux-contract-nets" title="Nets and electrical assumptions">
    <ul aria-label="Contract nets">{design.nets.map((net) => <li key={net.name}>
      <strong>{safeDisplay(net.name)} · {safeDisplayLabel(net.role)} · Class {safeDisplay(net.netClassId)}</strong>
      <span>Endpoints {net.endpoints.map((endpoint) => `${safeDisplay(endpoint.reference)}.${safeDisplay(endpoint.pin)}`).join(", ")}</span>
      <span>Voltage {number(net.electrical.voltage.minimumV)}–{number(net.electrical.voltage.maximumV)} V (nominal {number(net.electrical.voltage.nominalV)} V)</span>
      <span>Current {number(net.electrical.current.nominalA)} A nominal · {number(net.electrical.current.maximumContinuousA)} A continuous max · {number(net.electrical.current.peakA)} A peak for {number(net.electrical.current.peakDurationMs)} ms</span>
      <span>{net.electrical.speed.kind === "dc" ? "DC" : <>Signal · {number(net.electrical.speed.maximumFrequencyMHz)} MHz max · {number(net.electrical.speed.minimumEdgeTimeNs)} ns minimum edge</>}</span>
    </li>)}</ul>
  </ContractSection>;
}

function NetClasses({ design }: { readonly design: FluxDesignContractProjection }) {
  return <ContractSection id="flux-contract-netclasses" title="Net classes">
    <ul aria-label="Contract net classes">{design.netClasses.map((netClass) => <li key={netClass.id}>
      <strong>{safeDisplay(netClass.id)} · {netClass.allowedLayers.map((layer) => safeDisplay(layer)).join(", ")}</strong>
      <span>Trace {millimetres(netClass.traceWidthMm)} · Clearance {millimetres(netClass.clearanceMm)} · Copper to edge {millimetres(netClass.copperToEdgeMm)}</span>
    </li>)}</ul>
  </ContractSection>;
}

function Placements({ design }: { readonly design: FluxDesignContractProjection }) {
  return <ContractSection id="flux-contract-placements" title="Placement constraints">
    <ul aria-label="Contract placement constraints">{design.placementConstraints.map((placement) => <li key={placement.reference}>
      <strong>{safeDisplay(placement.reference)} · {safeDisplayLabel(placement.side)} side · {safeDisplayLabel(placement.edgePreference)} edge preference</strong>
      <span>Region X {millimetres(placement.regionMm.minXmm)}–{millimetres(placement.regionMm.maxXmm)} · Y {millimetres(placement.regionMm.minYmm)}–{millimetres(placement.regionMm.maxYmm)}</span>
      <span>Allowed rotations {placement.allowedRotationsDeg.map(degrees).join(", ")}</span>
      <span>Minimum edge clearance {millimetres(placement.minimumEdgeClearanceMm)} · Courtyard clearance {millimetres(placement.minimumCourtyardClearanceMm)}</span>
    </li>)}</ul>
  </ContractSection>;
}

function Routing({ design }: { readonly design: FluxDesignContractProjection }) {
  const routing = design.routingConstraints;
  const via = routing.viaPolicy;
  return <>
    <ContractSection id="flux-contract-routing-practice" title="Routing practice constraints">
      <dl className="flux-contract-details" aria-label="Contract routing practice constraints">
        <div><dt>Corner style</dt><dd>{safeDisplayLabel(routing.cornerStyle)} · Maximum turn {degrees(routing.maximumTurnAngleDeg)}</dd></div>
        <div><dt>Minimum straight before turn</dt><dd>{millimetres(routing.minimumStraightBeforeTurnMm)}</dd></div>
        <div><dt>90° corners</dt><dd>{allowed(routing.allowRightAngleCorners)}</dd></div>
        <div><dt>Acute interior corners</dt><dd>{allowed(routing.allowAcuteInteriorCorners)}</dd></div>
        <div><dt>Backtracking / hairpins</dt><dd>{allowed(routing.allowBacktracking)}</dd></div>
        <div><dt>Self-intersections</dt><dd>{allowed(routing.allowSelfIntersections)}</dd></div>
        <div><dt>Via policy</dt><dd>{via.mode === "forbidden" ? `Forbidden · Maximum total ${number(via.maxTotal)}` : <>Bounded · Maximum total {number(via.maxTotal)} · Diameter {millimetres(via.diameterMm)} · Drill {millimetres(via.drillMm)} · Minimum annular ring {millimetres(via.minimumAnnularRingMm)}</>}</dd></div>
      </dl>
    </ContractSection>
    <ContractSection id="flux-contract-routes" title="Per-net routing topology">
      <ul aria-label="Contract per-net routes">{routing.nets.map((route) => <li key={route.net}>
        <strong>{safeDisplay(route.net)} · {safeDisplayLabel(route.topology)} · {safeDisplayLabel(route.preferredLayer)}</strong>
        <span>Maximum vias {number(route.maxVias)} · Route length {route.routeLength.mode === "unbounded" ? "Unbounded" : `Maximum ${millimetres(route.routeLength.maximumMm)}`}</span>
      </li>)}</ul>
    </ContractSection>
  </>;
}

const FEATURE_LABELS = {
  powerCurrent: "Power and current",
  signalSpeedInterfaces: "Signal speed and interfaces",
  differentialPairs: "Differential pairs",
  stackupImpedance: "Stackup and impedance",
  thermal: "Thermal",
  emi: "EMI",
  placement: "Placement",
  dfm: "Design for manufacturing",
  assembly: "Assembly",
  bga: "BGA",
  gpio: "GPIO",
} as const;

function DeepRules({ contract, authorityIntegrity }: { readonly contract: FluxContractStateDto; readonly authorityIntegrity: "not_applicable" | "pending" | "valid" | "invalid" }) {
  const raw = contract.deepRuleSummary;
  const summary = parseFluxDeepRuleSummary(raw, contract.deepRuleBindingIdentity);
  return <ContractSection id="flux-contract-deep-rules" title="Selected deep-rule IDs and features">
    {raw === undefined ? <p>Public selection details are not available for this contract. The bound identity remains visible above.</p> : summary === undefined ? <div className="flux-contract-inline-alert" role={authorityIntegrity === "invalid" ? "status" : "alert"}>The public deep-rule summary is malformed or misbound. No selection details are displayed.</div> : authorityIntegrity === "pending" ? <p role="status">Verifying the selected-rule summary identity…</p> : authorityIntegrity !== "valid" ? <div className="flux-contract-inline-alert" role="status">The selected-rule summary did not pass the public identity closure. No selection details are displayed.</div> : <>
      <dl className="flux-contract-details" aria-label="Selected deep-rule summary">
        <div><dt>Selected count</dt><dd>{number(summary.selectedCount)}</dd></div>
        <div><dt>Catalog identity</dt><dd><code title={safeDisplayDigest(summary.catalogIdentity.digest, false)}>{safeDisplayDigest(summary.catalogIdentity.digest)}</code></dd></div>
      </dl>
      <h5>Selected rule IDs</h5>
      <ul className="flux-contract-token-list" aria-label="Selected deep-rule IDs">{summary.selectedRuleIds.map((ruleId) => <li key={ruleId}><code>{safeDisplay(ruleId)}</code></li>)}</ul>
      <h5>Covered features</h5>
      {summary.coveredFeatures.length === 0 ? <p>None selected.</p> : <ul className="flux-contract-token-list" aria-label="Covered deep-rule features">{summary.coveredFeatures.map((feature) => <li key={feature}>{safeDisplay(FEATURE_LABELS[feature])}</li>)}</ul>}
      <h5>Uncovered features</h5>
      {summary.uncoveredFeatures.length === 0 ? <p>None.</p> : <ul className="flux-contract-token-list" aria-label="Uncovered deep-rule features">{summary.uncoveredFeatures.map((feature) => <li key={feature}>{safeDisplay(FEATURE_LABELS[feature])}</li>)}</ul>}
    </>}
  </ContractSection>;
}

export function DesignInspector({ snapshot, contract, authorityIntegrity = "not_applicable", busy, onInspect }: { readonly snapshot: FluxInspectorSnapshot | undefined; readonly contract: FluxContractStateDto | undefined; readonly authorityIntegrity?: "not_applicable" | "pending" | "valid" | "invalid"; readonly busy: boolean; readonly onInspect: () => void }) {
  const ready = snapshot?.state === "ready" ? [snapshot.boardSummary, snapshot.rules, snapshot.footprints, snapshot.tracks, snapshot.vias, snapshot.zones] : [];
  const rawDesign = contract?.contract ?? null;
  const design = parseFluxDesignContract(rawDesign);
  const dispositionClass = contract !== undefined && ["ready", "needs_clarification", "unsupported"].includes(contract.disposition) ? contract.disposition : "pending";
  return <aside className="flux-inspector" aria-labelledby="flux-inspector-title">
    <div className="flux-panel-heading"><p className="overline">03 / INSPECTION</p><h2 id="flux-inspector-title">Design inspector</h2></div>
    <section className="flux-contract" aria-labelledby="flux-contract-title">
      <h3 id="flux-contract-title">Design Contract</h3>
      <p className={`flux-contract-disposition flux-contract-${dispositionClass}`}>{contract ? safeDisplayLabel(contract.disposition) : "Awaiting interpretation"}</p>
      {contract?.issues.length ? <ul className="flux-contract-issues">{contract.issues.map((issue) => <li key={`${issue.code}-${issue.path}`}><strong>{safeDisplay(issue.code)}</strong> {safeDisplay(issue.message)}{issue.clarificationId ? <small>Needs answer</small> : null}</li>)}</ul> : null}
      <div className="flux-contract-identities" aria-label="Compiled contract identities"><h4>Compiled identities</h4><ul>{identity("Contract", contract?.contractIdentity ?? null)}{identity("Library binding", contract?.libraryBindingIdentity ?? null)}{identity("Deep-rule binding", contract?.deepRuleBindingIdentity ?? null)}{identity("Acceptance plan", contract?.acceptancePlanIdentity ?? null)}</ul></div>
      {rawDesign !== null && design === undefined ? <div className="flux-contract-invalid" role={authorityIntegrity === "invalid" ? "status" : "alert"}><strong>Contract details unavailable</strong><p>The public contract is malformed, oversized, or contains an unknown value. No unverified fields are displayed.</p></div> : null}
      {design ? <div className="flux-contract-grid">
        <BoardDetails design={design} />
        <Components design={design} />
        <Nets design={design} />
        <NetClasses design={design} />
        <Placements design={design} />
        <Routing design={design} />
        <DeepRules contract={contract!} authorityIntegrity={authorityIntegrity} />
      </div> : null}
    </section>
    <button className="button button-secondary" type="button" disabled={busy} onClick={onInspect}>{busy ? "Inspecting…" : "Run read-only inspection"}</button>
    <section className={`flux-ipc flux-ipc-${snapshot?.state === "ready" ? "ready" : "waiting"}`}><h3>KiCad IPC readiness</h3><strong>{snapshot === undefined ? "Unavailable" : safeDisplay(snapshot.state)}</strong><p>{safeDisplay(snapshot?.completedTools ?? 0)} of {safeDisplay(snapshot?.totalTools ?? 6)} fixed read tools completed.</p></section>
    <div className="flux-inspector-list">{ready.map((entry) => <details key={entry.tool}><summary>{safeDisplay(entry.tool)}</summary><pre className="flux-inspection-json">{safeDisplay(entry.value)}</pre></details>)}</div>
  </aside>;
}
