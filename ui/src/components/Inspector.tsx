import { Database } from "@phosphor-icons/react/dist/csr/Database";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { Eye } from "@phosphor-icons/react/dist/csr/Eye";
import { FileCode } from "@phosphor-icons/react/dist/csr/FileCode";
import { MagnifyingGlass } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  artifactPreviewPolicy,
  ARTIFACT_PREVIEW_LIMITS,
  type ArtifactPreview
} from "../api";
import type {
  ArtifactRecord,
  CanonicalIdentity,
  ContentIdentity,
  EvidenceRecord,
  StageKey,
  UnresolvedAssumption
} from "../model";
import { shortDigest, stageLabel, statusLabel, VALIDATION_STATUSES } from "../model";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface InspectorProps {
  readonly selectedStage: StageKey;
  readonly artifacts: readonly ArtifactRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly contentAvailable?: boolean;
}

const digestOf = (identity: ContentIdentity | CanonicalIdentity): string => identity.digest;

function AssumptionList({ assumptions }: { readonly assumptions: readonly UnresolvedAssumption[] }) {
  return assumptions.length > 0 ? (
    <ul className="detail-list">
      {assumptions.map((assumption) => (
        <li key={assumption.id}>
          <strong>{assumption.severity}</strong>
          <span>{assumption.statement}</span>
        </li>
      ))}
    </ul>
  ) : (
    <span>None reported</span>
  );
}

const dateLabel = (value: string | undefined): string =>
  value === undefined ? "Not set" : new Date(value).toLocaleString();

const evidenceCurrency = (record: EvidenceRecord): "current" | "stale" | "expired" => {
  if (record.staleAt !== undefined) return "stale";
  return record.validUntil !== undefined && Date.parse(record.validUntil) <= Date.now()
    ? "expired"
    : "current";
};

function ArtifactContentPanel({
  artifact,
  contentAvailable
}: {
  readonly artifact: ArtifactRecord;
  readonly contentAvailable: boolean;
}) {
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [imageUrl, setImageUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const errorRef = useRef<HTMLDivElement>(null);
  const policy = artifactPreviewPolicy(artifact);

  useEffect(() => {
    setPreview(undefined);
    setError(undefined);
  }, [artifact.id]);

  useEffect(() => {
    if (preview?.kind !== "image" || typeof URL.createObjectURL !== "function") {
      setImageUrl(undefined);
      return;
    }
    const nextUrl = URL.createObjectURL(preview.blob);
    setImageUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [preview]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  const loadPreview = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      setPreview(await api.previewArtifact(artifact));
    } catch (cause) {
      setPreview(undefined);
      setError(cause instanceof Error ? cause.message : "Artifact preview failed.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="artifact-content" aria-labelledby="artifact-content-title">
      <div className="artifact-content-head">
        <div>
          <span className="overline">CONTENT ACCESS</span>
          <h4 id="artifact-content-title">Bound artifact bytes</h4>
        </div>
        <div className="artifact-content-actions">
          <button
            className="button button-quiet"
            type="button"
            disabled={!contentAvailable || !policy.previewable || loading}
            onClick={() => void loadPreview()}
          >
            <MagnifyingGlass aria-hidden="true" />
            {loading ? "Loading preview…" : preview ? "Reload preview" : "Preview content"}
          </button>
          {contentAvailable ? (
            <a
              className="button button-primary"
              href={api.artifactContentUrl(artifact.id)}
              download={artifact.logicalName}
            >
              <DownloadSimple aria-hidden="true" />
              Download original
            </a>
          ) : (
            <button className="button button-primary" type="button" disabled>
              <DownloadSimple aria-hidden="true" />
              Download original
            </button>
          )}
        </div>
      </div>
      <p className="preview-policy">
        Text and JSON previews are capped at {ARTIFACT_PREVIEW_LIMITS.textBytes.toLocaleString()} bytes;
        approved raster images are capped at {ARTIFACT_PREVIEW_LIMITS.imageBytes.toLocaleString()} bytes.
        Content type and exact byte count must match the record. Downloads use the daemon&apos;s attachment response.
      </p>
      {!contentAvailable ? (
        <p className="preview-unavailable" role="note">
          Demo metadata has no backing artifact bytes. Reconnect the local API to preview or download.
        </p>
      ) : !policy.previewable ? (
        <p className="preview-unavailable" role="note">{policy.reason} Download remains available.</p>
      ) : null}
      {error ? (
        <div className="preview-error" role="alert" tabIndex={-1} ref={errorRef}>
          <strong>Artifact content could not be loaded</strong>
          <span>{error}</span>
          <button className="button button-quiet" type="button" onClick={() => void loadPreview()}>
            Retry preview
          </button>
        </div>
      ) : null}
      {preview?.kind === "text" || preview?.kind === "json" ? (
        <div className="artifact-preview" aria-label={`${preview.kind} artifact preview`}>
          <div className="artifact-preview-meta">
            <StatusTag status="pass" label={`${preview.kind} / ${preview.size.toLocaleString()} bytes`} compact />
          </div>
          <pre><code>{preview.text}</code></pre>
        </div>
      ) : preview?.kind === "image" && imageUrl ? (
        <figure className="artifact-preview image-preview">
          <img src={imageUrl} alt={`Preview of ${artifact.logicalName}`} />
          <figcaption>{preview.mediaType} / {preview.size.toLocaleString()} bytes</figcaption>
        </figure>
      ) : null}
    </section>
  );
}

function ArtifactDetail({
  artifact,
  contentAvailable
}: {
  readonly artifact: ArtifactRecord;
  readonly contentAvailable: boolean;
}) {
  return (
    <article className="record-detail" aria-labelledby="artifact-detail-title">
      <div className="record-detail-head">
        <div>
          <span className="overline">ARTIFACT RECORD</span>
          <h3 id="artifact-detail-title">{artifact.logicalName}</h3>
        </div>
        <StatusTag status={artifact.validationStatus} />
      </div>
      <dl className="record-dl">
        <div>
          <dt>Artifact ID</dt>
          <dd className="mono">{artifact.id}</dd>
        </div>
        <div>
          <dt>Project / run</dt>
          <dd className="mono">{artifact.projectId} / {artifact.runId}</dd>
        </div>
        <div>
          <dt>Design revision</dt>
          <dd className="mono">{artifact.designRevisionId}</dd>
        </div>
        <div>
          <dt>Workflow stage</dt>
          <dd>{stageLabel(artifact.stage)}</dd>
        </div>
        <div>
          <dt>Lifecycle</dt>
          <dd><StatusTag status={artifact.lifecycle} /></dd>
        </div>
        <div>
          <dt>Media / size</dt>
          <dd>{artifact.mediaType} / {artifact.blob.size.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>Content identity</dt>
          <dd><code title={artifact.blob.digest}>{artifact.blob.algorithm}:{artifact.blob.digest}</code></dd>
        </div>
        <div>
          <dt>Tool identity</dt>
          <dd>
            <strong>{artifact.tool.name} {artifact.tool.version}</strong>
            <span>{artifact.tool.adapter}{artifact.tool.capabilityProfile ? ` / ${artifact.tool.capabilityProfile}` : ""}</span>
            {artifact.tool.executableDigest ? <code>{artifact.tool.executableDigest}</code> : null}
          </dd>
        </div>
        <div>
          <dt>Exact inputs</dt>
          <dd>
            {artifact.exactInputs.length > 0 ? (
              <ul className="digest-list">
                {artifact.exactInputs.map((identity, index) => (
                  <li key={`${digestOf(identity)}-${index}`}><code title={digestOf(identity)}>{shortDigest(digestOf(identity))}</code></li>
                ))}
              </ul>
            ) : "None recorded"}
          </dd>
        </div>
        <div>
          <dt>Derived from</dt>
          <dd>{artifact.derivedFrom.length > 0 ? artifact.derivedFrom.join(", ") : "Primary artifact"}</dd>
        </div>
        <div>
          <dt>Unresolved assumptions</dt>
          <dd><AssumptionList assumptions={artifact.unresolvedAssumptions} /></dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd><time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString()}</time></dd>
        </div>
        <div>
          <dt>Stale at</dt>
          <dd>{artifact.staleAt ? <time dateTime={artifact.staleAt}>{dateLabel(artifact.staleAt)}</time> : "Current record"}</dd>
        </div>
      </dl>
      <ArtifactContentPanel artifact={artifact} contentAvailable={contentAvailable} />
    </article>
  );
}

function EvidenceDetail({ record }: { readonly record: EvidenceRecord }) {
  return (
    <article className="record-detail" aria-labelledby="evidence-detail-title">
      <div className="record-detail-head">
        <div>
          <span className="overline">EVIDENCE RECORD / {statusLabel(record.evidenceClass).toLocaleUpperCase("en-US")}</span>
          <h3 id="evidence-detail-title">{record.claim}</h3>
        </div>
        <div className="inline-tags">
          <StatusTag status={record.validationStatus} />
          <StatusTag
            status={evidenceCurrency(record) === "current" ? "pass" : "stale"}
            label={evidenceCurrency(record)}
          />
        </div>
      </div>
      <dl className="record-dl">
        <div>
          <dt>Evidence ID</dt>
          <dd className="mono">{record.id}</dd>
        </div>
        <div>
          <dt>Project / run</dt>
          <dd className="mono">{record.projectId} / {record.runId}</dd>
        </div>
        <div>
          <dt>Design revision</dt>
          <dd className="mono">{record.designRevisionId}</dd>
        </div>
        <div>
          <dt>Workflow stage</dt>
          <dd>{stageLabel(record.stage)}</dd>
        </div>
        <div>
          <dt>Evidence class</dt>
          <dd>{statusLabel(record.evidenceClass)}</dd>
        </div>
        <div>
          <dt>Validation / lifecycle</dt>
          <dd className="inline-tags"><StatusTag status={record.validationStatus} /><StatusTag status={record.lifecycle} /></dd>
        </div>
        <div>
          <dt>Tool identity</dt>
          <dd>
            <strong>{record.tool.name} {record.tool.version}</strong>
            <span>{record.tool.adapter}{record.tool.capabilityProfile ? ` / ${record.tool.capabilityProfile}` : ""}</span>
            {record.tool.executablePath ? <span className="mono">{record.tool.executablePath}</span> : null}
            {record.tool.executableDigest ? <code>{record.tool.executableDigest}</code> : null}
          </dd>
        </div>
        <div>
          <dt>Subject identities</dt>
          <dd>
            <ul className="digest-list">
              {record.subjectDigests.map((digest) => (
                <li key={digest}><code title={digest}>{shortDigest(digest)}</code></li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Exact inputs</dt>
          <dd>
            {record.exactInputs.length > 0 ? (
              <ul className="digest-list">
                {record.exactInputs.map((identity, index) => (
                  <li key={`${digestOf(identity)}-${index}`}><code title={digestOf(identity)}>{shortDigest(digestOf(identity))}</code></li>
                ))}
              </ul>
            ) : "None recorded"}
          </dd>
        </div>
        <div>
          <dt>Raw / parsed artifact</dt>
          <dd className="mono">{record.rawArtifactId ?? "—"} / {record.parsedArtifactId ?? "—"}</dd>
        </div>
        <div>
          <dt>Unresolved assumptions</dt>
          <dd><AssumptionList assumptions={record.unresolvedAssumptions} /></dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></dd>
        </div>
        <div>
          <dt>Valid until</dt>
          <dd>{record.validUntil ? <time dateTime={record.validUntil}>{dateLabel(record.validUntil)}</time> : "No expiry recorded"}</dd>
        </div>
        <div>
          <dt>Stale at</dt>
          <dd>{record.staleAt ? <time dateTime={record.staleAt}>{dateLabel(record.staleAt)}</time> : "Not marked stale"}</dd>
        </div>
      </dl>
    </article>
  );
}

export function Inspector({
  selectedStage,
  artifacts,
  evidence,
  contentAvailable = true
}: InspectorProps) {
  const [kind, setKind] = useState<"artifacts" | "evidence">("artifacts");
  const [showAll, setShowAll] = useState(false);
  const [includeStale, setIncludeStale] = useState(false);
  const currentArtifacts = useMemo(
    () => (includeStale ? artifacts : artifacts.filter((artifact) => artifact.staleAt === undefined)),
    [artifacts, includeStale]
  );
  const currentEvidence = useMemo(
    () => (includeStale ? evidence : evidence.filter((record) => record.staleAt === undefined)),
    [evidence, includeStale]
  );
  const visibleArtifacts = useMemo(
    () => (showAll ? currentArtifacts : currentArtifacts.filter((artifact) => artifact.stage === selectedStage)),
    [currentArtifacts, selectedStage, showAll]
  );
  const visibleEvidence = useMemo(
    () => (showAll ? currentEvidence : currentEvidence.filter((record) => record.stage === selectedStage)),
    [currentEvidence, selectedStage, showAll]
  );
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string>();

  useEffect(() => {
    setSelectedArtifactId(visibleArtifacts[0]?.id);
    setSelectedEvidenceId(visibleEvidence[0]?.id);
  }, [selectedStage, showAll, includeStale, artifacts, evidence]);

  const selectedArtifact =
    visibleArtifacts.find((artifact) => artifact.id === selectedArtifactId) ?? visibleArtifacts[0];
  const selectedEvidence =
    visibleEvidence.find((record) => record.id === selectedEvidenceId) ?? visibleEvidence[0];

  return (
    <section className="bench-panel inspector-panel" aria-labelledby="inspector-title">
      <SectionHeading
        id="inspector-title"
        index="F"
        title="Evidence cabinet"
        aside={<span className="record-total">{artifacts.length + evidence.length} total records</span>}
      />
      <p className="section-lede">
        Every claim stays distinct from EvlEDA checks, KiCad-native results, and human physical evidence.
      </p>

      <details className="validation-legend">
        <summary>Validation states ({VALIDATION_STATUSES.length})</summary>
        <div className="inline-tags" aria-label="All supported validation states">
          {VALIDATION_STATUSES.map((status) => <StatusTag key={status} status={status} compact />)}
        </div>
      </details>

      <div className="segmented-control" aria-label="Inspection record type">
        <button
          type="button"
          aria-pressed={kind === "artifacts"}
          onClick={() => setKind("artifacts")}
        >
          <FileCode aria-hidden="true" />
          Artifacts <span>{artifacts.length}</span>
        </button>
        <button
          type="button"
          aria-pressed={kind === "evidence"}
          onClick={() => setKind("evidence")}
        >
          <Database aria-hidden="true" />
          Evidence <span>{evidence.length}</span>
        </button>
      </div>

      <label className="checkbox-row scope-checkbox">
        <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
        <span>Show records from all nine stages</span>
      </label>
      <label className="checkbox-row scope-checkbox">
        <input
          type="checkbox"
          checked={includeStale}
          onChange={(event) => setIncludeStale(event.target.checked)}
        />
        <span>Include stale records returned by the API</span>
      </label>

      <div className="inspection-scope">
        <span>SCOPE</span>
        <strong>{showAll ? "All workflow stages" : stageLabel(selectedStage)}</strong>
      </div>

      {kind === "artifacts" ? (
        visibleArtifacts.length > 0 ? (
          <>
            <div className="table-scroll inspector-table-scroll" tabIndex={0} role="region" aria-label="Artifact records">
              <table className="data-table inspector-table">
                <caption>Artifacts in the current inspection scope</caption>
                <thead>
                  <tr><th scope="col">Artifact</th><th scope="col">Stage</th><th scope="col">Validation</th></tr>
                </thead>
                <tbody>
                  {visibleArtifacts.map((artifact) => (
                    <tr key={artifact.id} className={artifact.id === selectedArtifact?.id ? "selected-row" : undefined}>
                      <th scope="row">
                        <button type="button" className="record-select" onClick={() => setSelectedArtifactId(artifact.id)}>
                          {artifact.logicalName}
                        </button>
                        <code>{shortDigest(artifact.blob.digest)}</code>
                      </th>
                      <td>{stageLabel(artifact.stage)}</td>
                      <td><StatusTag status={artifact.validationStatus} compact /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selectedArtifact ? (
              <ArtifactDetail artifact={selectedArtifact} contentAvailable={contentAvailable} />
            ) : null}
          </>
        ) : (
          <div className="empty-state">
            <Stack aria-hidden="true" weight="duotone" />
            <div><strong>No artifact records in scope</strong><p>The stage has not emitted an inspectable artifact.</p></div>
          </div>
        )
      ) : visibleEvidence.length > 0 ? (
        <>
          <div className="table-scroll inspector-table-scroll" tabIndex={0} role="region" aria-label="Evidence records">
            <table className="data-table inspector-table">
              <caption>Evidence records in the current inspection scope</caption>
              <thead>
                <tr><th scope="col">Claim</th><th scope="col">Class</th><th scope="col">Validation</th></tr>
              </thead>
              <tbody>
                {visibleEvidence.map((record) => (
                  <tr key={record.id} className={record.id === selectedEvidence?.id ? "selected-row" : undefined}>
                    <th scope="row">
                      <button type="button" className="record-select" onClick={() => setSelectedEvidenceId(record.id)}>
                        {record.claim}
                      </button>
                      <code>{shortDigest(record.id)}</code>
                    </th>
                    <td>{statusLabel(record.evidenceClass)}</td>
                    <td><StatusTag status={record.validationStatus} compact /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {selectedEvidence ? <EvidenceDetail record={selectedEvidence} /> : null}
        </>
      ) : (
        <div className="empty-state">
          <Eye aria-hidden="true" weight="duotone" />
          <div><strong>No evidence records in scope</strong><p>No claim or check is available for this stage yet.</p></div>
        </div>
      )}
    </section>
  );
}
