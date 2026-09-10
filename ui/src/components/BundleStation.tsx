import { BracketsCurly } from "@phosphor-icons/react/dist/csr/BracketsCurly";
import { DownloadSimple } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { FileText } from "@phosphor-icons/react/dist/csr/FileText";
import { Package } from "@phosphor-icons/react/dist/csr/Package";
import { ShieldWarning } from "@phosphor-icons/react/dist/csr/ShieldWarning";
import type {
  DesignRun,
  EngineeringDispositionStatus,
  LifecycleState,
  QualificationInput
} from "../model";
import { shortDigest } from "../model";
import { QualificationGate } from "./QualificationGate";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface BundleStationProps {
  readonly run?: DesignRun | undefined;
  readonly effectiveLifecycle?: LifecycleState | undefined;
  readonly activeQualification: boolean;
  readonly qualificationReady: boolean;
  readonly engineeringDisposition?: EngineeringDispositionStatus | undefined;
  readonly revisionDigest?: string | undefined;
  readonly requirementsDigest?: string | undefined;
  readonly evidenceRootDigest?: string | undefined;
  readonly busyAction?: string | undefined;
  readonly actionMessage?: string | undefined;
  readonly onExportCandidate: () => Promise<void>;
  readonly onExportPrototype: () => Promise<void>;
  readonly onGenerateBringup: () => Promise<void>;
  readonly onGenerateFirmware: () => Promise<void>;
  readonly onQualify: (input: QualificationInput) => Promise<void>;
}

export function BundleStation({
  run,
  effectiveLifecycle,
  activeQualification,
  qualificationReady,
  engineeringDisposition,
  revisionDigest,
  requirementsDigest,
  evidenceRootDigest,
  busyAction,
  actionMessage,
  onExportCandidate,
  onExportPrototype,
  onGenerateBringup,
  onGenerateFirmware,
  onQualify
}: BundleStationProps) {
  const hasRevision = Boolean(run?.headRevisionId);
  const workflowComplete = hasRevision && run?.state === "completed";
  const engineeringPackageReady = engineeringDisposition === "PROVISIONAL_POC";
  const candidateReady = workflowComplete && engineeringPackageReady;
  const displayedLifecycle = effectiveLifecycle ?? run?.lifecycle;
  const exactQualificationActive =
    activeQualification &&
    (displayedLifecycle === "qualified" || displayedLifecycle === "release_authorized");
  const prototypeAllowed = candidateReady && exactQualificationActive;
  const busy = Boolean(busyAction);

  return (
    <section className="bench-panel bundle-panel" aria-labelledby="bundle-title">
      <SectionHeading
        id="bundle-title"
        index="G"
        title="Package station"
        aside={run && displayedLifecycle ? <StatusTag status={displayedLifecycle} /> : <StatusTag status="not_run" label="No revision" />}
      />
      <div className="revision-plate">
        <span>BOUND REVISION</span>
        <strong className="mono" title={run?.headRevisionId}>
          {shortDigest(run?.headRevisionId)}
        </strong>
        <p>Exports bind their manifest to this exact revision; they do not change its lifecycle.</p>
      </div>

      <QualificationGate
        ready={qualificationReady && engineeringPackageReady}
        qualified={exactQualificationActive}
        exportEnabled={prototypeAllowed}
        busy={busyAction === "qualification"}
        revisionDigest={revisionDigest}
        requirementsDigest={requirementsDigest}
        evidenceRootDigest={evidenceRootDigest}
        onQualify={onQualify}
      />

      <div className="bundle-stack">
        <article className="bundle-card candidate-bundle">
          <div className="bundle-card-title">
            <Package aria-hidden="true" weight="duotone" />
            <div>
              <span className="overline">CANDIDATE</span>
              <h3>Candidate bundle</h3>
            </div>
            {engineeringDisposition ? (
              <StatusTag status={engineeringDisposition} label={engineeringDisposition} compact />
            ) : null}
          </div>
          <p>
            Editable sources, available reports, firmware contracts, evidence manifest, and unresolved
            assumptions. Not human-qualified. Not for manufacturing.
          </p>
          {!candidateReady ? (
            <div className="policy-lock candidate-lock" role="note">
              <ShieldWarning aria-hidden="true" weight="fill" />
              <span>
                {!workflowComplete
                  ? "Locked: COMPLETE ALL NINE WORKFLOW STAGES"
                  : engineeringDisposition === "BLOCKED_DIAGNOSTIC"
                    ? "Locked: BLOCKED_DIAGNOSTIC ENGINEERING DISPOSITION"
                    : "Locked: AUTHORITATIVE ENGINEERING INSPECTION UNAVAILABLE"}
              </span>
            </div>
          ) : null}
          <button
            className="button button-primary full-button"
            type="button"
            disabled={!candidateReady || busy}
            onClick={() => void onExportCandidate()}
          >
            <DownloadSimple aria-hidden="true" />
            {busyAction === "candidate" ? "Preparing candidate…" : "Export candidate bundle"}
          </button>
        </article>

        <article className="bundle-card prototype-bundle">
          <div className="bundle-card-title">
            <ShieldWarning aria-hidden="true" weight="duotone" />
            <div>
              <span className="overline">CONTROLLED PROTOTYPE</span>
              <h3>Prototype bundle</h3>
            </div>
          </div>
          <p>
            Requires current passing <code>evleda.human-physical-evidence.v2</code> for the exact head and
            evidence root, plus an active human qualification attestation bound to those identities. It still
            does not authorize production or manufacturing release.
          </p>
          {!prototypeAllowed ? (
            <div className="policy-lock" role="note">
              <ShieldWarning aria-hidden="true" weight="fill" />
              <span>
                {!engineeringPackageReady
                  ? engineeringDisposition === "BLOCKED_DIAGNOSTIC"
                    ? "Locked: BLOCKED_DIAGNOSTIC ENGINEERING DISPOSITION"
                    : "Locked: AUTHORITATIVE ENGINEERING INSPECTION UNAVAILABLE"
                  : qualificationReady
                    ? "Locked: EXACT HUMAN QUALIFICATION REQUIRED"
                    : "Locked: CURRENT PASSING PHYSICAL-V2 EVIDENCE REQUIRED"}
              </span>
            </div>
          ) : null}
          <button
            className="button button-secondary full-button"
            type="button"
            disabled={!hasRevision || !prototypeAllowed || busy}
            aria-describedby={!prototypeAllowed ? "prototype-policy" : undefined}
            onClick={() => void onExportPrototype()}
          >
            <DownloadSimple aria-hidden="true" />
            {busyAction === "prototype" ? "Preparing prototype…" : "Export prototype bundle"}
          </button>
          {!prototypeAllowed ? (
            <span id="prototype-policy" className="sr-only">
              Prototype export is unavailable until the server returns PROVISIONAL_POC for the exact head,
              current passing physical-v2 evidence is present, and an active human qualification is bound to
              this exact revision and current evidence root.
            </span>
          ) : null}
        </article>
      </div>

      <div className="generation-station">
        <h3>Regenerate revision-bound documents</h3>
        <p>Generation creates candidate artifacts and evidence; it does not bypass a workflow gate.</p>
        <div className="generation-buttons">
          <button
            className="button button-quiet"
            type="button"
            disabled={!hasRevision || busy}
            onClick={() => void onGenerateBringup()}
          >
            <FileText aria-hidden="true" />
            {busyAction === "bringup" ? "Generating…" : "Generate bring-up plan"}
          </button>
          <button
            className="button button-quiet"
            type="button"
            disabled={!hasRevision || busy}
            onClick={() => void onGenerateFirmware()}
          >
            <BracketsCurly aria-hidden="true" />
            {busyAction === "firmware" ? "Generating…" : "Generate firmware scaffold"}
          </button>
        </div>
      </div>

      {actionMessage ? (
        <div className="action-message" role="status" aria-live="polite">
          {actionMessage}
        </div>
      ) : null}
    </section>
  );
}
