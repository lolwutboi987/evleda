import { useEffect, useState } from "react";
import { CompilationAuthority, type FluxAuthorityIntegrity } from "./CompilationAuthority";
import { iterationCapFromBounds, parseFluxIterationCapPolicy } from "./iteration-policy";
import type { FluxApprovalSubjectDto, FluxClarificationAnswerDto, FluxContractStateDto, FluxCreateInput, FluxRunDto, FluxRuntimePolicyDto, FluxRuntimeReadinessDto, FluxSourceCatalogDto } from "./model";
import { safeDisplay, safeDisplayDigest, safeDisplayLabel } from "./safe-display";

interface Props {
  readonly sources: readonly FluxSourceCatalogDto[];
  readonly run: FluxRunDto | undefined;
  readonly contract: FluxContractStateDto | undefined;
  readonly approval: FluxApprovalSubjectDto | undefined;
  readonly busy: string | undefined;
  readonly openedLabel: string | undefined;
  readonly policy: FluxRuntimePolicyDto | undefined;
  readonly readiness: FluxRuntimeReadinessDto | undefined;
  readonly lifecycleLocked: boolean;
  readonly runLocked: boolean;
  readonly authorityIntegrity: FluxAuthorityIntegrity;
  readonly onCreate: (input: FluxCreateInput) => void;
  readonly onInterpret: () => void;
  readonly onClarify: (answers: readonly FluxClarificationAnswerDto[]) => void;
  readonly onPrepare: () => void;
  readonly onOpen: () => void;
  readonly onCheckpoint: () => void;
  readonly onApprove: () => void;
  readonly onResume: () => void;
}

const editable = new Set<FluxRunDto["phase"]>(["draft", "awaiting_clarification", "contract_ready", "blocked", "failed", "needs_review", "completed"]);
const knownPhases = new Set<FluxRunDto["phase"]>(["draft", "interpreting", "awaiting_clarification", "contract_ready", "preparing", "awaiting_open", "opening", "awaiting_checkpoint", "checkpointing", "awaiting_approval", "approved", "queued", "running", "completed", "needs_review", "failed", "blocked"]);

export function PromptThreadPanel({ sources, run, contract, approval, busy, openedLabel, policy, readiness, lifecycleLocked, runLocked, authorityIntegrity, onCreate, onInterpret, onClarify, onPrepare, onOpen, onCheckpoint, onApprove, onResume }: Props) {
  const disabled = busy !== undefined;
  const clarification = contract ?? run?.contractState;
  const canCreate = editable.has(run?.phase ?? "draft");
  const canClarify = run?.phase === "awaiting_clarification" && clarification?.disposition === "needs_clarification" && clarification.questions.length > 0;
  const phaseClass = run !== undefined && knownPhases.has(run.phase) ? `flux-state-${run.phase}` : "flux-state-unknown";
  const capPolicy = parseFluxIterationCapPolicy(policy?.iterationCap);
  const [iterationCap, setIterationCap] = useState<number | undefined>(undefined);
  useEffect(() => { setIterationCap(capPolicy?.recommended); }, [capPolicy?.minimum, capPolicy?.maximum, capPolicy?.recommended]);
  const capAllowed = capPolicy !== undefined && iterationCap !== undefined && Number.isSafeInteger(iterationCap) && iterationCap >= capPolicy.minimum && iterationCap <= capPolicy.maximum;
  return <aside className="flux-thread" aria-labelledby="flux-thread-title">
    <div className="flux-panel-heading"><p className="overline">01 / GENERIC LIFECYCLE</p><h2 id="flux-thread-title">{run?.preview?.title ? safeDisplay(run.preview.title) : "New design contract"}</h2>{run ? <span className={`flux-state ${phaseClass}`}>{safeDisplayLabel(run.phase)}</span> : null}</div>
    <form key={run?.id ?? "new"} className="flux-thread-form" onSubmit={(event) => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      if (policy === undefined || capPolicy === undefined || iterationCap === undefined) return;
      const selectedCap = iterationCapFromBounds(capPolicy, iterationCap);
      onCreate({ sourceKey: String(data.get("sourceKey") ?? ""), projectName: String(data.get("projectName") ?? ""), threadTitle: String(data.get("threadTitle") ?? ""), prompt: String(data.get("prompt") ?? ""), iterationCap: selectedCap });
    }}>
      <label htmlFor="flux-source">Source</label><select id="flux-source" name="sourceKey" disabled={disabled || !editable.has(run?.phase ?? "draft")} required>{sources.map((source) => <option key={source.key} value={source.key}>{safeDisplay(source.label)}</option>)}</select>
      <label htmlFor="flux-project-name">Project name</label><input id="flux-project-name" name="projectName" defaultValue="flux-candidate" pattern={policy?.freshProjectNamePattern} disabled={disabled || !editable.has(run?.phase ?? "draft")} required />
      <label htmlFor="flux-thread-name">Thread title</label><input id="flux-thread-name" name="threadTitle" defaultValue="Design contract" disabled={disabled || !editable.has(run?.phase ?? "draft")} required />
      <label htmlFor="flux-prompt">Design brief</label><textarea id="flux-prompt" name="prompt" defaultValue={run?.prompt ? safeDisplay(run.prompt) : "Describe the board candidate, its interfaces, power, constraints, and intended checks."} rows={8} disabled={disabled || !editable.has(run?.phase ?? "draft")} required />
      <label htmlFor="flux-iteration-cap">Agent iteration cap</label>
      {capPolicy === undefined ? policy === undefined ? null : <p className="flux-policy-invalid" role="alert">No valid server iteration range is available.</p> : capPolicy.minimum === capPolicy.maximum ? <><input id="flux-iteration-cap" type="number" value={capPolicy.minimum} min={capPolicy.minimum} max={capPolicy.maximum} step={1} readOnly aria-describedby="flux-iteration-cap-note" /><p id="flux-iteration-cap-note" className="flux-form-note">Server policy fixes this run to exactly {safeDisplay(capPolicy.minimum)} iteration.</p></> : <><input id="flux-iteration-cap" type="number" value={iterationCap ?? ""} min={capPolicy.minimum} max={capPolicy.maximum} step={1} required disabled={disabled || !editable.has(run?.phase ?? "draft")} aria-describedby="flux-iteration-cap-note" onChange={(event) => { const value = event.currentTarget.valueAsNumber; setIterationCap(Number.isSafeInteger(value) ? value : undefined); }} /><p id="flux-iteration-cap-note" className="flux-form-note">Server-approved range: {safeDisplay(capPolicy.minimum)}–{safeDisplay(capPolicy.maximum)}. Recommended default: {safeDisplay(capPolicy.recommended)}. A changed cap starts a new run and cannot reuse another create intent.</p></>}
      <p className="flux-form-note">A changed brief starts a new generic run. It cannot reuse or preserve later isolated-copy, checkpoint, approval, or report state.</p>
      <button className="button button-primary" type="submit" disabled={disabled || lifecycleLocked || !canCreate || !capAllowed || sources.length === 0 || policy === undefined}>{busy === "create" ? "Creating…" : "Create generic run"}</button>
    </form>
    <div className="flux-action-stack" aria-label="Run controls">
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "draft"} onClick={onInterpret}>{busy === "interpret" ? "Interpreting…" : "Interpret"}</button>
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "contract_ready" || contract?.disposition !== "ready" || run.compilationBundleRef === undefined} onClick={onPrepare}>{busy === "prepare" ? "Preparing…" : "Prepare isolated run"}</button>
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "awaiting_open"} onClick={onOpen}>{busy === "open" ? "Opening…" : busy === "open-sync" ? "Synchronizing Open…" : "Open isolated copy"}</button>
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "awaiting_checkpoint"} onClick={onCheckpoint}>{busy === "checkpoint" ? "Checkpointing…" : "Checkpoint Open"}</button>
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "awaiting_approval" || approval === undefined} onClick={onApprove}>{busy === "approve" ? "Approving…" : "Approve exact digest"}</button>
      <button className="button button-secondary" type="button" disabled={disabled || lifecycleLocked || runLocked || run?.phase !== "approved"} onClick={onResume}>{busy === "resume" ? "Queuing…" : "Resume"}</button>
    </div>
    {canClarify ? <form className="flux-clarifications" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); onClarify(clarification.questions.map((question, index) => ({ id: question.id, answer: String(data.get(`question-${index}`) ?? "") })).filter((answer) => answer.answer.trim().length > 0)); }}>
      <h3>Clarifications required</h3><p>Submit one complete answer batch. The server recompiles the contract and invalidates later candidate state.</p>
      {clarification.questions.map((question, index) => <label key={`${index}-${question.id}`} htmlFor={`flux-question-${index}`}><span>{safeDisplay(question.question)}</span><textarea id={`flux-question-${index}`} name={`question-${index}`} required disabled={disabled} rows={3} /></label>)}
      <button className="button button-primary" type="submit" disabled={disabled || lifecycleLocked || runLocked}>{busy === "clarify" ? "Recompiling…" : "Submit clarification batch"}</button>
    </form> : null}
    {openedLabel ? <p className="flux-canvas-note" role="status">{safeDisplay(openedLabel)}</p> : null}
    <CompilationAuthority run={run} approval={approval} readiness={readiness} integrity={authorityIntegrity} />
    <section className="flux-boundary-note"><h3>Approval boundary</h3><p>{approval ? <>Approval binds the current compiled identities and digest <code title={safeDisplayDigest(approval.digest, false)}>{safeDisplayDigest(approval.digest)}</code>.</> : run?.phase === "awaiting_checkpoint" ? "Record the provider-free post-Open checkpoint before approval." : "Interpret and prepare the current contract before an approval subject exists."}</p><p>Policy, selected rules, and identities are server-owned. The isolated working copy remains candidate-only; no release or manufacturing action is available.</p></section>
  </aside>;
}
