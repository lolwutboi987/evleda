import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useEffect, useRef } from "react";
import type {
  EngineeringCheckSummary,
  EngineeringExactIdentity,
  EngineeringFindingProjection,
  EngineeringPracticeInspectionResult,
  EngineeringSourceProjection
} from "../model";
import { stageLabel } from "../model";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface EngineeringPracticePanelProps {
  readonly hasRun: boolean;
  readonly inspection?: EngineeringPracticeInspectionResult | undefined;
  readonly findingPages?: readonly EngineeringPracticeInspectionResult[] | undefined;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly error?: string | undefined;
  readonly onRetry: () => Promise<void>;
  readonly onLoadMore: () => Promise<void>;
}

const EMPTY_LABEL = "None reported";

const joinValues = (values: readonly string[]): string =>
  values.length > 0 ? values.join(", ") : EMPTY_LABEL;

const identityLabel = (identity: EngineeringExactIdentity): string =>
  "size" in identity
    ? `${identity.algorithm}:${identity.digest} · ${identity.size.toLocaleString()} bytes`
    : `${identity.algorithm}:${identity.digest} · ${identity.schemaVersion} · ${identity.canonicalizationVersion}`;

function IdentityValue({ identity }: { readonly identity: EngineeringExactIdentity | null }) {
  return identity ? <code>{identityLabel(identity)}</code> : <span className="engineering-missing">Not bound</span>;
}

const machineStatusLabel = (status: string): string =>
  status === "NOT_APPLICABLE" ? "N/A" : status;

interface CheckCardProps {
  readonly id: string;
  readonly title: string;
  readonly check: EngineeringCheckSummary & {
    readonly evidenceClass: "kicad_native" | "evleda_check";
  };
  readonly practice?: {
    readonly analysisOutcome: "pass" | "review" | "fail" | null;
    readonly reviewRequired: boolean;
    readonly advisoryCount: number;
  };
}

function CheckCard({ id, title, check, practice }: CheckCardProps) {
  return (
    <section className="engineering-check-card" aria-labelledby={id}>
      <div className="engineering-check-head">
        <div>
          <span className="overline">{check.evidenceClass}</span>
          <h3 id={id}>{title}</h3>
        </div>
        <StatusTag status={check.machineStatus} label={machineStatusLabel(check.machineStatus)} />
      </div>
      <p>{check.message}</p>
      <dl className="engineering-check-data">
        <div>
          <dt>Reason</dt>
          <dd><code>{check.reasonCode}</code></dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>{check.current ? "Current exact report" : "Not current"}</dd>
        </div>
        <div>
          <dt>Artifact</dt>
          <dd><code>{check.artifactId ?? "Not bound"}</code></dd>
        </div>
        <div>
          <dt>Evidence</dt>
          <dd><code>{check.evidenceId ?? "Not bound"}</code></dd>
        </div>
        <div>
          <dt>Report identity</dt>
          <dd><IdentityValue identity={check.reportIdentity} /></dd>
        </div>
        <div>
          <dt>Evaluated</dt>
          <dd>{check.evaluatedAt ?? "Not run"}</dd>
        </div>
        <div>
          <dt>Tool</dt>
          <dd>
            {check.tool ? (
              <span>
                <code>{check.tool.name}</code> {check.tool.version} via {check.tool.adapter}
              </span>
            ) : "Not bound"}
          </dd>
        </div>
      </dl>
      {practice ? (
        <div className={`engineering-review-state${practice.reviewRequired ? " review-open" : ""}`}>
          <div>
            <strong>Practice analysis outcome</strong>
            <span>{practice.analysisOutcome ?? "not available"}</span>
          </div>
          <div>
            <strong>Review advisory</strong>
            <span>
              {practice.reviewRequired ? "Review required" : "No review flag"} · {practice.advisoryCount} advisories
            </span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function JsonValue({ label, value }: { readonly label: string; readonly value: Readonly<Record<string, unknown>> }) {
  return (
    <div className="engineering-json-block">
      <strong>{label}</strong>
      <pre><code>{JSON.stringify(value, null, 2)}</code></pre>
    </div>
  );
}

function SourceLinks({
  sourceIds,
  sources
}: {
  readonly sourceIds: readonly string[];
  readonly sources: ReadonlyMap<string, EngineeringSourceProjection>;
}) {
  if (sourceIds.length === 0) return <span>{EMPTY_LABEL}</span>;
  return (
    <ul className="engineering-inline-list">
      {sourceIds.map((sourceId) => {
        const source = sources.get(sourceId);
        return (
          <li key={sourceId}>
            {source?.url ? (
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title} ({source.sourceId})
              </a>
            ) : source ? (
              <span className="engineering-internal-source">
                {source.title} (<code>{source.sourceId}</code>) · embedded internal policy provenance
              </span>
            ) : <code>{sourceId}</code>}
          </li>
        );
      })}
    </ul>
  );
}

function FindingDetail({
  finding,
  sources
}: {
  readonly finding: EngineeringFindingProjection;
  readonly sources: ReadonlyMap<string, EngineeringSourceProjection>;
}) {
  return (
    <details className="engineering-finding">
      <summary data-engineering-finding-summary>
        <span>
          <code>{finding.findingId}</code>
          <strong>{finding.message}</strong>
        </span>
        <span className="inline-tags">
          <StatusTag status={finding.machineStatus} label={finding.machineStatus} compact />
          <StatusTag status={finding.severity} label={finding.severity} compact />
        </span>
      </summary>
      <div className="engineering-finding-body">
        <dl className="engineering-compact-dl">
          <div><dt>Rules</dt><dd><code>{joinValues(finding.ruleIds)}</code></dd></div>
          <div><dt>External gates</dt><dd><code>{joinValues(finding.externalGateIds)}</code></dd></div>
        </dl>

        <div className="engineering-json-grid">
          <JsonValue label="Observed" value={finding.observed} />
          <JsonValue label="Required" value={finding.required} />
        </div>

        <section aria-label={`Exact locations for ${finding.findingId}`}>
          <h4>Exact locations</h4>
          {finding.locations.length === 0 ? <p>{EMPTY_LABEL}</p> : (
            <ol className="engineering-location-list">
              {finding.locations.map((location, index) => (
                <li key={`${location.artifactId}-${location.startOffset}-${index}`}>
                  <p className="engineering-path"><code>{location.sourcePath}</code></p>
                  <dl className="engineering-location-data">
                    <div><dt>Line / column</dt><dd>{location.line} / {location.column}</dd></div>
                    <div><dt>Form / ordinal</dt><dd><code>{location.form}</code> / {location.ordinal}</dd></div>
                    <div><dt>UUID</dt><dd><code>{location.uuid ?? "Not present"}</code></dd></div>
                    <div><dt>Byte offsets</dt><dd>{location.startOffset}–{location.endOffset}</dd></div>
                    <div><dt>Artifact</dt><dd><code>{location.artifactId}</code></dd></div>
                    <div><dt>Artifact identity</dt><dd><IdentityValue identity={location.artifactIdentity} /></dd></div>
                  </dl>
                  <JsonValue label="Geometry" value={location.geometry} />
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="engineering-remediation" aria-label={`Remediation for ${finding.findingId}`}>
          <div className="engineering-remediation-head">
            <h4>Remediation</h4>
            <StatusTag status="review" label="ADVISORY ONLY" compact />
          </div>
          <p>{finding.remediation.summary}</p>
          <p className="engineering-new-revision">A new revision is required; this panel cannot mutate or waive the board.</p>
          <div className="engineering-remediation-grid">
            <div>
              <strong>Steps</strong>
              {finding.remediation.steps.length > 0 ? (
                <ol>{finding.remediation.steps.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
              ) : <p>{EMPTY_LABEL}</p>}
            </div>
            <div>
              <strong>Verification</strong>
              {finding.remediation.verification.length > 0 ? (
                <ol>{finding.remediation.verification.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
              ) : <p>{EMPTY_LABEL}</p>}
            </div>
          </div>
          <dl className="engineering-compact-dl">
            <div><dt>Rerun rules</dt><dd><code>{joinValues(finding.remediation.rerunRuleIds)}</code></dd></div>
            <div>
              <dt>Rerun stages</dt>
              <dd>{finding.remediation.rerunStages.length > 0
                ? finding.remediation.rerunStages.map(stageLabel).join(", ")
                : EMPTY_LABEL}</dd>
            </div>
          </dl>
        </section>

        <section aria-label={`Sources and assumptions for ${finding.findingId}`}>
          <h4>Sources</h4>
          <SourceLinks sourceIds={finding.sourceIds} sources={sources} />
          <h4>Assumptions</h4>
          {finding.assumptions.length > 0 ? (
            <ul>{finding.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul>
          ) : <p>{EMPTY_LABEL}</p>}
        </section>
      </div>
    </details>
  );
}

export function EngineeringPracticePanel({
  hasRun,
  inspection,
  findingPages = [],
  loading,
  loadingMore,
  error,
  onRetry,
  onLoadMore
}: EngineeringPracticePanelProps) {
  const alertRef = useRef<HTMLDivElement>(null);
  const findingListRef = useRef<HTMLDivElement>(null);
  const focusFindingIndex = useRef<number | null>(null);
  useEffect(() => {
    if (error) {
      focusFindingIndex.current = null;
      alertRef.current?.focus();
    }
  }, [error]);

  const sources = new Map(inspection?.sources.map((source) => [source.sourceId, source]) ?? []);
  const pages = findingPages.length > 0 ? findingPages : inspection ? [inspection] : [];
  const loadedFindings = pages.flatMap((page) => page.findings.items);
  const nextFindingCursor = pages.at(-1)?.findings.nextCursor ?? null;
  useEffect(() => {
    const index = focusFindingIndex.current;
    if (index === null || loadingMore || loadedFindings.length <= index) return;
    findingListRef.current
      ?.querySelectorAll<HTMLElement>("summary[data-engineering-finding-summary]")
      .item(index)
      ?.focus();
    focusFindingIndex.current = null;
  }, [loadedFindings.length, loadingMore]);
  const aside = inspection ? (
    <StatusTag status={inspection.disposition.status} label={inspection.disposition.status} />
  ) : error ? (
    <StatusTag status="error" label="UNAVAILABLE" />
  ) : loading ? (
    <StatusTag status="running" label="LOADING" />
  ) : (
    <StatusTag status="not_run" label={hasRun ? "NOT LOADED" : "NO RUN"} />
  );

  return (
    <section className="bench-panel engineering-panel" aria-labelledby="engineering-practice-title">
      <SectionHeading id="engineering-practice-title" index="E" title="Engineering practice" aside={aside} />

      <div className="engineering-proof-warning" role="note" aria-label="Proof fixture limitation">
        <ShieldWarning aria-hidden="true" weight="fill" />
        <div>
          <strong>Full-stack engineering proof fixture — candidate only</strong>
          <p>
            This inspection report never establishes qualification, authorizes manufacturing, or authorizes
            release. Fabricator, human, and physical gates remain separate authorities.
          </p>
        </div>
      </div>

      {error ? (
        <div className="engineering-error" role="alert" tabIndex={-1} ref={alertRef}>
          <WarningCircle aria-hidden="true" weight="fill" />
          <div>
            <strong>{inspection ? "Engineering findings request failed" : "Engineering inspection unavailable"}</strong>
            <p>{error}</p>
            {inspection ? (
              <p>The exact pages already returned remain visible, but package actions stay locked until a clean refresh.</p>
            ) : null}
            <p>No engineering PASS, POC, waiver, qualification, or release state was substituted.</p>
          </div>
          <button className="button button-secondary" type="button" disabled={loading} onClick={() => void onRetry()}>
            <ArrowClockwise aria-hidden="true" />
            Retry inspection
          </button>
        </div>
      ) : null}

      {loading && !inspection ? (
        <div className="engineering-loading" role="status" aria-live="polite">
          Reading the exact revision-bound engineering inspection…
        </div>
      ) : null}

      {!loading && !error && !inspection ? (
        <div className="engineering-empty" role="status">
          <strong>{hasRun ? "No engineering inspection was loaded." : "No run selected."}</strong>
          <p>{hasRun
            ? "Package actions remain unavailable until the server returns an authoritative inspection."
            : "Start or select a run to request the server-side engineering inspection."}</p>
        </div>
      ) : null}

      {inspection ? (
        <>
          {!inspection.isHeadRevision ? (
            <div className="engineering-head-warning" role="note">
              <WarningCircle aria-hidden="true" weight="fill" />
              <span>This inspection is historical and is not bound to the current head revision.</span>
            </div>
          ) : null}

          <section className={`engineering-disposition disposition-${inspection.disposition.status.toLocaleLowerCase("en-US")}`} aria-labelledby="engineering-disposition-title">
            <div>
              <span className="overline">SERVER DISPOSITION</span>
              <h3 id="engineering-disposition-title">{inspection.disposition.status}</h3>
              <p>
                {inspection.disposition.status === "PROVISIONAL_POC"
                  ? "Candidate-only proof-of-concept eligibility. This is not qualification, manufacturing readiness, or release."
                  : "Machine checks, coverage, exact bindings, or required execution remain diagnostic. Package export is locked."}
              </p>
            </div>
            <dl className="engineering-disposition-data">
              <div><dt>Reason codes</dt><dd><code>{joinValues(inspection.disposition.reasonCodes)}</code></dd></div>
              <div><dt>Machine blocker rules</dt><dd><code>{joinValues(inspection.disposition.machineBlockerRuleIds)}</code></dd></div>
              <div><dt>Open external gates</dt><dd><code>{joinValues(inspection.disposition.openExternalGateIds)}</code></dd></div>
            </dl>
          </section>

          <div className="engineering-check-grid">
            <CheckCard id="native-drc-title" title="Native DRC" check={inspection.checks.nativeDrc} />
            <CheckCard
              id="evleda-practice-title"
              title="EvlEDA Practice"
              check={inspection.checks.evledaPractice}
              practice={inspection.checks.evledaPractice}
            />
          </div>

          <section className="engineering-coverage" aria-labelledby="engineering-coverage-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">COMPLETE DENOMINATOR</span>
                <h3 id="engineering-coverage-title">Rule coverage</h3>
              </div>
              <StatusTag
                status={inspection.coverage.inventoryComplete ? "succeeded" : "UNKNOWN"}
                label={inspection.coverage.inventoryComplete ? "INVENTORY COMPLETE" : "INVENTORY INCOMPLETE"}
              />
            </div>
            <div className="table-scroll engineering-coverage-scroll" tabIndex={0} role="region" aria-label="Engineering coverage totals">
              <table className="data-table engineering-coverage-table">
                <caption>Complete engineering rule inventory and server-reported status totals</caption>
                <thead>
                  <tr>
                    <th scope="col">Inventory</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Evaluated</th>
                    <th scope="col">Applicable</th>
                    <th scope="col">PASS</th>
                    <th scope="col">FAIL</th>
                    <th scope="col">UNKNOWN</th>
                    <th scope="col">NOT_RUN</th>
                    <th scope="col">N/A</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">All rules</th>
                    <td>{inspection.coverage.expectedRuleCount}</td>
                    <td>{inspection.coverage.evaluatedRuleCount}</td>
                    <td>{inspection.coverage.applicableRuleCount}</td>
                    <td>{inspection.coverage.statusCounts.PASS}</td>
                    <td>{inspection.coverage.statusCounts.FAIL}</td>
                    <td>{inspection.coverage.statusCounts.UNKNOWN}</td>
                    <td>{inspection.coverage.statusCounts.NOT_RUN}</td>
                    <td>{inspection.coverage.notApplicableRuleCount}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <dl className="engineering-coverage-exceptions">
              <div><dt>Missing rule IDs</dt><dd><code>{joinValues(inspection.coverage.missingRuleIds)}</code></dd></div>
              <div><dt>Unexpected rule IDs</dt><dd><code>{joinValues(inspection.coverage.unexpectedRuleIds)}</code></dd></div>
            </dl>
          </section>

          <section className="engineering-owners" aria-labelledby="engineering-owners-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">SEPARATE AUTHORITIES</span>
                <h3 id="engineering-owners-title">Gate owners</h3>
              </div>
            </div>
            <div className="engineering-owner-grid">
              <article><strong>Machine</strong><span>{inspection.gateSummary.machineBlockers}</span><p>blocking rules</p></article>
              <article><strong>Fabricator</strong><span>{inspection.gateSummary.fabricatorOpen}</span><p>open gates</p></article>
              <article><strong>Human</strong><span>{inspection.gateSummary.humanOpen}</span><p>open gates</p></article>
              <article><strong>Physical</strong><span>{inspection.gateSummary.physicalOpen}</span><p>open gates</p></article>
            </div>
            <p className="engineering-owner-limitation">
              This v1 projection does not expose assembler as a separate owner. Fabricator status must not be
              treated as assembly confirmation.
            </p>
            {inspection.outstandingExternalGates.length > 0 ? (
              <div className="engineering-gate-list">
                {inspection.outstandingExternalGates.map((gate) => (
                  <details key={gate.gateId}>
                    <summary>
                      <span><strong>{gate.owner}</strong> <code>{gate.gateId}</code></span>
                      <StatusTag status={gate.status} label={gate.status} compact />
                    </summary>
                    <div>
                      <p>{gate.message}</p>
                      <dl className="engineering-compact-dl">
                        <div><dt>Rule</dt><dd><code>{gate.ruleId}</code></dd></div>
                        <div><dt>Reason</dt><dd><code>{gate.reasonCode}</code></dd></div>
                        <div><dt>Subjects</dt><dd><code>{joinValues(gate.subjectIds)}</code></dd></div>
                        <div><dt>Evidence</dt><dd><code>{joinValues(gate.evidenceIds)}</code></dd></div>
                        <div><dt>Inputs</dt><dd>{gate.exactInputIdentities.length > 0
                          ? gate.exactInputIdentities.map(identityLabel).join("; ")
                          : EMPTY_LABEL}</dd></div>
                      </dl>
                      <SourceLinks sourceIds={gate.sourceIds} sources={sources} />
                    </div>
                  </details>
                ))}
              </div>
            ) : <p className="engineering-inline-clear">No outstanding external gates were returned.</p>}
          </section>

          <section className="engineering-rules" aria-labelledby="engineering-rules-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">FULL INVENTORY</span>
                <h3 id="engineering-rules-title">Engineering rules</h3>
              </div>
              <span className="record-total">{inspection.rules.length} returned / {inspection.coverage.expectedRuleCount} expected</span>
            </div>
            <div className="table-scroll engineering-rule-scroll" tabIndex={0} role="region" aria-label="Complete engineering rule table">
              <table className="data-table engineering-rule-table">
                <caption>Complete server-returned engineering practice rule inventory</caption>
                <thead>
                  <tr>
                    <th scope="col">Rule</th>
                    <th scope="col">Applicability</th>
                    <th scope="col">Machine status</th>
                    <th scope="col">Decision / reason</th>
                    <th scope="col">Exact evidence bindings</th>
                    <th scope="col">References</th>
                  </tr>
                </thead>
                <tbody>
                  {inspection.rules.map((rule) => (
                    <tr key={rule.ruleId}>
                      <th scope="row"><code>{rule.ruleId}</code><span>{rule.title}</span></th>
                      <td><StatusTag status={rule.applicability} label={machineStatusLabel(rule.applicability)} compact /></td>
                      <td>
                        <StatusTag
                          status={rule.machineStatus ?? "NOT_APPLICABLE"}
                          label={machineStatusLabel(rule.machineStatus ?? "NOT_APPLICABLE")}
                          compact
                        />
                        <span>{rule.blocking ? "Blocking" : "Non-blocking"}</span>
                      </td>
                      <td><code>{rule.reasonCode}</code><span>{joinValues(rule.decisionClasses)}</span></td>
                      <td>
                        <strong>Inputs</strong>
                        <span>{rule.exactInputIdentities.length > 0
                          ? rule.exactInputIdentities.map(identityLabel).join("; ")
                          : EMPTY_LABEL}</span>
                        <strong>Checker results</strong>
                        <span>{rule.checkerResultIdentities.length > 0
                          ? rule.checkerResultIdentities.map(identityLabel).join("; ")
                          : EMPTY_LABEL}</span>
                      </td>
                      <td>
                        <strong>Sources</strong><span>{joinValues(rule.sourceIds)}</span>
                        <strong>Findings</strong><span>{joinValues(rule.findingIds)}</span>
                        <strong>External gates</strong><span>{joinValues(rule.externalGateIds)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="engineering-advisories" aria-labelledby="engineering-advisories-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">REVIEW SEPARATELY</span>
                <h3 id="engineering-advisories-title">Review advisories</h3>
              </div>
              <span className="record-total">{inspection.advisories.length} advisories</span>
            </div>
            {inspection.advisories.length > 0 ? (
              <ul className="engineering-advisory-list">
                {inspection.advisories.map((advisory) => (
                  <li key={advisory.advisoryId}>
                    <div>
                      <StatusTag status={advisory.severity} label={advisory.severity} compact />
                      <code>{advisory.advisoryId}</code>
                    </div>
                    <p>{advisory.message}</p>
                    <dl className="engineering-compact-dl">
                      <div><dt>Rules</dt><dd><code>{joinValues(advisory.ruleIds)}</code></dd></div>
                      <div><dt>Findings</dt><dd><code>{joinValues(advisory.findingIds)}</code></dd></div>
                      <div><dt>External gates</dt><dd><code>{joinValues(advisory.externalGateIds)}</code></dd></div>
                    </dl>
                    <SourceLinks sourceIds={advisory.sourceIds} sources={sources} />
                  </li>
                ))}
              </ul>
            ) : <p className="engineering-inline-clear">No review advisories were returned.</p>}
          </section>

          <section className="engineering-findings" aria-labelledby="engineering-findings-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">EXACT DIAGNOSTICS</span>
                <h3 id="engineering-findings-title">Findings</h3>
              </div>
              <span className="record-total">{loadedFindings.length} loaded / {inspection.findings.total} total</span>
            </div>
            {loadedFindings.length > 0 ? (
              <div className="engineering-finding-list" ref={findingListRef}>
                {loadedFindings.map((finding) => (
                  <FindingDetail key={finding.findingId} finding={finding} sources={sources} />
                ))}
              </div>
            ) : <p className="engineering-inline-clear">No findings are present in this page. Aggregate rule coverage above remains authoritative.</p>}
            {inspection.findings.total > 0 ? (
              <div className="engineering-pagination">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={nextFindingCursor === null || loadingMore}
                  onClick={() => {
                    focusFindingIndex.current = loadedFindings.length;
                    void onLoadMore();
                  }}
                >
                  {loadingMore
                    ? "Loading findings…"
                    : nextFindingCursor
                      ? "Load more findings"
                      : "All findings loaded"}
                </button>
                <span aria-live="polite">{loadedFindings.length} of {inspection.findings.total} findings loaded.</span>
              </div>
            ) : null}
          </section>

          <details className="engineering-identity-disclosure" open>
            <summary>Exact inspection and input identities</summary>
            <dl className="engineering-binding-grid">
              <div>
                <dt>Inspection page identities</dt>
                <dd>{pages.map((page, index) => (
                  <span className="engineering-page-identity" key={page.identity.digest}>
                    Page {index + 1}: <IdentityValue identity={page.identity} />
                  </span>
                ))}</dd>
              </div>
              <div><dt>Revision manifest</dt><dd><IdentityValue identity={inspection.bindings.revisionManifest} /></dd></div>
              <div><dt>Requirements</dt><dd><IdentityValue identity={inspection.bindings.requirementsIdentity} /></dd></div>
              <div><dt>Evidence root</dt><dd><IdentityValue identity={inspection.bindings.evidenceRootIdentity} /></dd></div>
              <div><dt>Practice catalog</dt><dd><IdentityValue identity={inspection.bindings.practiceCatalogIdentity} /></dd></div>
              <div><dt>Route-quality policy</dt><dd><IdentityValue identity={inspection.bindings.routeQualityPolicyIdentity} /></dd></div>
              <div><dt>Policy capture</dt><dd><IdentityValue identity={inspection.bindings.routeQualityPolicyCaptureIdentity} /></dd></div>
              <div><dt>Route-quality rule deck</dt><dd><IdentityValue identity={inspection.bindings.routeQualityRuleDeckIdentity} /></dd></div>
              <div><dt>Proof-fixture policy</dt><dd><IdentityValue identity={inspection.bindings.proofFixturePolicyIdentity} /></dd></div>
              <div><dt>Analyzer profile</dt><dd><IdentityValue identity={inspection.bindings.analyzerProfileIdentity} /></dd></div>
              <div><dt>Constraint binding</dt><dd><IdentityValue identity={inspection.bindings.constraintBindingIdentity} /></dd></div>
              <div><dt>Native board</dt><dd><IdentityValue identity={inspection.bindings.nativeBoardIdentity} /></dd></div>
            </dl>
          </details>

          <section className="engineering-sources" aria-labelledby="engineering-sources-title">
            <div className="engineering-subhead">
              <div>
                <span className="overline">SOURCE LEDGER</span>
                <h3 id="engineering-sources-title">Sources</h3>
              </div>
              <span className="record-total">{inspection.sources.length} sources</span>
            </div>
            {inspection.sources.length > 0 ? (
              <div className="engineering-source-list">
                {inspection.sources.map((source) => (
                  <article key={source.sourceId}>
                    <div className="engineering-source-head">
                      <div>
                        <code>{source.sourceId}</code>
                        <h4>
                          {source.url ? (
                            <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                          ) : <span>{source.title}</span>}
                        </h4>
                      </div>
                      <strong>{source.captureComplete ? "Capture complete" : "Capture incomplete"}</strong>
                    </div>
                    {source.authority === "internal_policy" ? (
                      <p className="engineering-internal-provenance">
                        Embedded internal product-policy provenance. No external URL or external-source authority is claimed.
                      </p>
                    ) : null}
                    <dl className="engineering-compact-dl">
                      <div><dt>Publisher</dt><dd>{source.publisher}</dd></div>
                      <div><dt>Revision / date</dt><dd>{source.revision} · {source.date.kind} {source.date.value}</dd></div>
                      <div><dt>Authority</dt><dd>{source.authority}</dd></div>
                      <div><dt>Scope / status</dt><dd>{source.accessScope} · {source.normativeStatus}</dd></div>
                      <div><dt>Locator</dt><dd>{source.locator ? `${source.locator.kind}: ${source.locator.value}` : "Not captured"}</dd></div>
                      <div><dt>Capture identity</dt><dd><IdentityValue identity={source.captureIdentity} /></dd></div>
                      <div><dt>Excerpt identity</dt><dd><IdentityValue identity={source.excerptIdentity} /></dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            ) : <p className="engineering-inline-clear">No sources were returned.</p>}
          </section>
        </>
      ) : null}
    </section>
  );
}
