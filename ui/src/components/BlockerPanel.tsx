import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { WarningOctagon } from "@phosphor-icons/react/dist/csr/WarningOctagon";
import { Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import type { DesignRun, StageKey } from "../model";
import { currentAttempt, shortDigest, stageLabel } from "../model";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface BlockerPanelProps {
  readonly run?: DesignRun | undefined;
  readonly selectedStage: StageKey;
  readonly busy: boolean;
  readonly onRerun: (stage: StageKey) => Promise<void>;
  readonly onResume: () => Promise<void>;
}

export function BlockerPanel({ run, selectedStage, busy, onRerun, onResume }: BlockerPanelProps) {
  const attempt = run ? currentAttempt(run, selectedStage) : undefined;
  const blockers = attempt?.blockers ?? [];
  const canResume = Boolean(
    run?.requirements?.approvalId && ["queued", "blocked", "interrupted"].includes(run.state)
  );

  return (
    <section className="bench-panel blocker-panel" aria-labelledby="failure-title">
      <SectionHeading
        id="failure-title"
        index="D"
        title="Failure station"
        aside={
          <StatusTag
            status={blockers.length > 0 ? "blocked" : "pass"}
            label={blockers.length > 0 ? `${blockers.length} blockers` : "Clear"}
          />
        }
      />

      <div className="selected-stage-readout">
        <span>INSPECTING STAGE</span>
        <strong>{stageLabel(selectedStage)}</strong>
        <code>{attempt?.id ?? "No attempt"}</code>
      </div>

      {blockers.length > 0 ? (
        <div className="blocker-stack">
          {blockers.map((blocker, index) => (
            <article
              className="blocker-card"
              key={`${blocker.code}-${blocker.createdAt}-${index}`}
            >
              <div className="blocker-code">
                <WarningOctagon aria-hidden="true" weight="fill" />
                <span>{blocker.code}</span>
              </div>
              <h3>{blocker.message}</h3>
              <dl className="failure-dl">
                <div>
                  <dt>Required action</dt>
                  <dd>{blocker.requiredAction}</dd>
                </div>
                <div>
                  <dt>Retry policy</dt>
                  <dd>{blocker.retryable ? "Retry permitted after inputs change" : "Manual intervention required"}</dd>
                </div>
                <div>
                  <dt>Recorded</dt>
                  <dd>
                    <time dateTime={blocker.createdAt}>{new Date(blocker.createdAt).toLocaleString()}</time>
                  </dd>
                </div>
              </dl>
              <details className="digest-disclosure">
                <summary>Affected input identities ({blocker.affectedInputDigests.length})</summary>
                {blocker.affectedInputDigests.length > 0 ? (
                  <ul>
                    {blocker.affectedInputDigests.map((digest) => (
                      <li key={digest}>
                        <code title={digest}>{shortDigest(digest)}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No digests were attached to this blocker.</p>
                )}
              </details>
              {blocker.retryable ? (
                <button
                  className="button button-danger"
                  type="button"
                  disabled={busy}
                  onClick={() => void onRerun(selectedStage)}
                >
                  <ArrowClockwise aria-hidden="true" />
                  {busy ? "Requesting rerun…" : `Rerun ${stageLabel(selectedStage)}`}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="clear-station">
          <CheckCircle aria-hidden="true" weight="fill" />
          <div>
            <strong>No blocker recorded for {stageLabel(selectedStage)}</strong>
            <p>
              Clear means the latest attempt reports no blocker. It does not mean the stage passed, the
              evidence is current, or the hardware is safe.
            </p>
          </div>
        </div>
      )}

      {run && canResume ? (
        <div className="resume-row">
          <Wrench aria-hidden="true" weight="duotone" />
          <div>
            <strong>{run.state === "queued" ? "Requirements approved" : "Inputs corrected?"}</strong>
            <p>
              {run.state === "queued"
                ? "Start the persisted candidate workflow from the first uncompleted stage."
                : "Resume re-evaluates the persisted run. It does not waive a failed gate."}
            </p>
          </div>
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => void onResume()}>
            {busy ? "Resuming…" : run.state === "queued" ? "Start workflow" : "Resume run"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
