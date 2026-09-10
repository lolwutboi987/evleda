import { ArrowClockwise } from "@phosphor-icons/react/dist/csr/ArrowClockwise";
import { Play } from "@phosphor-icons/react/dist/csr/Play";
import { TerminalWindow } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { useEffect, useRef, useState } from "react";
import { DEMO_PROMPT } from "../demo";
import type { DesignRun, LifecycleState, Project } from "../model";
import { shortDigest } from "../model";
import type { DataMode } from "./SafetyBand";
import { SectionHeading } from "./SectionHeading";
import { StatusTag } from "./StatusTag";

interface IntakeErrors {
  readonly name?: string;
  readonly prompt?: string;
}

interface ProjectIntakeProps {
  readonly projects: readonly Project[];
  readonly project?: Project | undefined;
  readonly run?: DesignRun | undefined;
  readonly effectiveLifecycle?: LifecycleState | undefined;
  readonly mode: DataMode;
  readonly busy: boolean;
  readonly onCreate: (name: string, prompt: string) => Promise<void>;
  readonly onSelectProject: (projectId: string) => Promise<void>;
  readonly onRefresh: () => Promise<void>;
}

const validate = (name: string, prompt: string): IntakeErrors => {
  const errors: { name?: string; prompt?: string } = {};
  if (name.trim().length < 3) errors.name = "Enter a project name with at least 3 characters.";
  if (prompt.trim().length < 40) {
    errors.prompt = "Describe the electrical envelope and board behavior in at least 40 characters.";
  }
  return errors;
};

export function ProjectIntake({
  projects,
  project,
  run,
  effectiveLifecycle,
  mode,
  busy,
  onCreate,
  onSelectProject,
  onRefresh
}: ProjectIntakeProps) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [errors, setErrors] = useState<IntakeErrors>({});
  const errorSummaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (errors.name || errors.prompt) errorSummaryRef.current?.focus();
  }, [errors]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors = validate(name, prompt);
    setErrors(nextErrors);
    if (nextErrors.name || nextErrors.prompt) return;
    await onCreate(name.trim(), prompt.trim());
  };

  const handleUseExample = () => {
    setName("RBX-2 Controller");
    setPrompt(DEMO_PROMPT);
    setErrors({});
    document.querySelector<HTMLTextAreaElement>("#design-prompt")?.focus();
  };

  return (
    <section className="bench-panel intake-panel" aria-labelledby="intake-title">
      <SectionHeading
        id="intake-title"
        index="A"
        title="Job intake"
        aside={<StatusTag status={mode === "api" ? "pass" : mode === "demo" ? "waived" : "not_run"} label={mode} compact />}
      />

      {projects.length > 0 ? (
        <div className="field-group">
          <label htmlFor="project-select">Loaded project</label>
          <div className="field-help">Select a local project and inspect its latest design run.</div>
          <select
            id="project-select"
            value={project?.id ?? ""}
            disabled={busy}
            onChange={(event) => void onSelectProject(event.target.value)}
          >
            {projects.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <TerminalWindow aria-hidden="true" weight="duotone" />
          <div>
            <strong>No local projects</strong>
            <p>Describe the first controller candidate below.</p>
          </div>
        </div>
      )}

      {project && run ? (
        <div className="workpiece-card" aria-label="Active design run">
          <div className="workpiece-head">
            <p className="overline">ACTIVE WORKPIECE</p>
            <StatusTag status={run.state} compact />
          </div>
          <strong>{project.name}</strong>
          <dl className="compact-dl">
            <div>
              <dt>Project</dt>
              <dd className="mono">{shortDigest(project.id)}</dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd className="mono">{shortDigest(run.headRevisionId)}</dd>
            </div>
            <div>
              <dt>Effective</dt>
              <dd>{(effectiveLifecycle ?? run.lifecycle).replaceAll("_", " ")}</dd>
            </div>
          </dl>
          <button className="button button-secondary full-button" type="button" disabled={busy} onClick={() => void onRefresh()}>
            <ArrowClockwise aria-hidden="true" />
            Refresh run
          </button>
        </div>
      ) : null}

      <div className="panel-rule" />

      <form className="intake-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
        <div className="form-intro">
          <p className="overline">NEW CANDIDATE</p>
          <p>
            State the electrical limits, loads, interfaces, mechanical constraints, faults, and safe states.
          </p>
        </div>

        {errors.name || errors.prompt ? (
          <div
            className="error-summary"
            role="alert"
            tabIndex={-1}
            ref={errorSummaryRef}
            aria-labelledby="intake-errors-title"
          >
            <strong id="intake-errors-title">The job description needs attention</strong>
            <ul>
              {errors.name ? (
                <li>
                  <a href="#project-name">{errors.name}</a>
                </li>
              ) : null}
              {errors.prompt ? (
                <li>
                  <a href="#design-prompt">{errors.prompt}</a>
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <div className="field-group">
          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            autoComplete="off"
            maxLength={120}
            required
            value={name}
            aria-invalid={errors.name ? "true" : "false"}
            aria-describedby={errors.name ? "project-name-error" : undefined}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. RBX-2 Controller"
          />
          {errors.name ? (
            <span id="project-name-error" className="field-error">
              {errors.name}
            </span>
          ) : null}
        </div>

        <div className="field-group">
          <label htmlFor="design-prompt">Controller design brief</label>
          <textarea
            id="design-prompt"
            rows={9}
            maxLength={200_000}
            required
            value={prompt}
            aria-invalid={errors.prompt ? "true" : "false"}
            aria-describedby="prompt-help prompt-error"
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Input: 7–16.8 V DC. Loads: 2 motor channels for brushed-DC loads at 0.5 A RMS/channel…"
          />
          <span id="prompt-help" className="field-help">
            The daemon must block ambiguous or unsupported requirements; it will not guess missing limits.
          </span>
          {errors.prompt ? (
            <span id="prompt-error" className="field-error">
              {errors.prompt}
            </span>
          ) : null}
        </div>

        <div className="button-stack">
          <button className="button button-primary full-button" type="submit" disabled={busy}>
            <Play aria-hidden="true" weight="fill" />
            {busy ? "Starting candidate…" : "Create project + start run"}
          </button>
          <button className="button button-quiet full-button" type="button" disabled={busy} onClick={handleUseExample}>
            Load bench example
          </button>
        </div>
      </form>
    </section>
  );
}
