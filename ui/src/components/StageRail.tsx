import { CaretRight } from "@phosphor-icons/react/dist/csr/CaretRight";
import type { DesignRun, StageKey } from "../model";
import { currentAttempt, STAGE_ORDER, stageLabel } from "../model";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface StageRailProps {
  readonly run?: DesignRun | undefined;
  readonly selectedStage: StageKey;
  readonly onSelectStage: (stage: StageKey) => void;
}

export function StageRail({ run, selectedStage, onSelectStage }: StageRailProps) {
  return (
    <section className="bench-panel stage-panel" aria-labelledby="workflow-title">
      <SectionHeading
        id="workflow-title"
        index="B"
        title="Nine-stage workflow"
        aside={run ? <StatusTag status={run.state} /> : <StatusTag status="not_run" label="No run" />}
      />
      <p className="section-lede">
        Select a numbered terminal to bind the requirement, failure, artifact, and evidence views to that stage.
      </p>

      {run ? (
        <nav aria-label="Design workflow stages" className="stage-rail-wrap">
          <ol className="stage-rail">
            {STAGE_ORDER.map((stage, index) => {
              const attempt = currentAttempt(run, stage);
              const state = attempt?.state ?? "pending";
              const count = (attempt?.artifactIds.length ?? 0) + (attempt?.evidenceIds.length ?? 0);
              const selected = selectedStage === stage;
              return (
                <li key={stage} className={`stage-node stage-node-${state}`}>
                  <button
                    type="button"
                    className="stage-button"
                    aria-current={selected ? "step" : undefined}
                    aria-label={`${index + 1}. ${stageLabel(stage)} — ${state.replaceAll("_", " ")}, ${count} records`}
                    onClick={() => onSelectStage(stage)}
                  >
                    <span className="stage-number">{String(index + 1).padStart(2, "0")}</span>
                    <span className="stage-label">{stageLabel(stage)}</span>
                    <span className="stage-state">
                      <span aria-hidden="true" className="state-terminal" />
                      {state.replaceAll("_", " ")}
                    </span>
                    <span className="stage-count">{count} records</span>
                    <CaretRight className="stage-caret" aria-hidden="true" weight="bold" />
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      ) : (
        <div className="empty-state">
          <div>
            <strong>No workflow to inspect</strong>
            <p>Start a design run to energize the stage bus.</p>
          </div>
        </div>
      )}

      <div className="stage-legend" aria-label="Workflow status legend">
        <StatusTag status="succeeded" compact />
        <StatusTag status="running" compact />
        <StatusTag status="waiting_approval" compact />
        <StatusTag status="blocked" compact />
        <StatusTag status="pending" compact />
      </div>
    </section>
  );
}
