import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FluxApiError, FluxIntentStorageError, fluxApi } from "./api";
import { verifyFluxPublicAuthority } from "./authority-verification";
import { fluxAuthorityIssue, type FluxAuthorityIntegrity } from "./CompilationAuthority";
import { DiagnosticNotice } from "./DiagnosticNotice";
import { DesignInspector } from "./DesignInspector";
import { OperationTimeline } from "./OperationTimeline";
import { PreviewCanvas } from "./PreviewCanvas";
import { PromptThreadPanel } from "./PromptThreadPanel";
import { policyMatchesReadiness, RuntimeStatus, type FluxBootstrapState } from "./RuntimeStatus";
import { safeDisplay, safeDisplayDate, safeDisplayDigest } from "./safe-display";
import { parseFluxIterationCapPolicy } from "./iteration-policy";
import { parseFluxReadinessToolchain } from "./toolchain-readiness";
import type { FluxApi, FluxApprovalSubjectDto, FluxClarificationAnswerDto, FluxContractStateDto, FluxCreateInput, FluxDiagnosticDto, FluxInspectorSnapshot, FluxPreviewDto, FluxRunDto, FluxRuntimePolicyDto, FluxRuntimeReadinessDto, FluxSequencedEventDto, FluxSourceCatalogDto } from "./model";

export const FLUX_POLL_DELAY_MS = Object.freeze({ active: 1_000, idle: 5_000, retry: 1_500 });

export const mergeFluxEvents = (current: readonly FluxSequencedEventDto[], incoming: readonly FluxSequencedEventDto[]): readonly FluxSequencedEventDto[] => {
  const events = new Map<number, FluxSequencedEventDto>();
  current.forEach((event) => events.set(event.eventSeq, event)); incoming.forEach((event) => events.set(event.eventSeq, event));
  return [...events.values()].sort((left, right) => left.eventSeq - right.eventSeq);
};

const ACTIVE = new Set<FluxRunDto["phase"]>(["interpreting", "preparing", "opening", "checkpointing", "queued", "running"]);
const sameRunProjection = (left: FluxRunDto, right: FluxRunDto): boolean => {
  try {
    const leftText = JSON.stringify(left); const rightText = JSON.stringify(right);
    return leftText.length <= 2 * 1024 * 1024 && rightText.length <= 2 * 1024 * 1024 && leftText === rightText;
  } catch { return false; }
};
const safeError = (reason: unknown, fallback: string): string => {
  const message = reason instanceof Error && reason.message.trim() ? reason.message : fallback;
  const displayed = safeDisplay(message, fallback);
  return displayed.startsWith("[redacted") || displayed.startsWith("[unsupported") ? fallback : displayed;
};

const lostResponseMessage = (reason: unknown): string => reason instanceof FluxApiError
  ? "The Flux operation failed closed. Review the structured run diagnostic or safe readiness status."
  : reason instanceof FluxIntentStorageError
    ? safeError(reason, "Durable operation-key storage failed closed; explicit reset is required.")
  : reason instanceof Error && /durable browser|operation completed|storage is unsafe/iu.test(reason.message)
    ? safeError(reason, "Durable operation-key storage failed closed; no further mutation is allowed on this page.")
    : "The connection was lost. Retrying the same action will reuse its durable operation key.";

export default function FluxDesignerApp({ client = fluxApi }: { readonly client?: FluxApi }) {
  const [bootstrapState, setBootstrapState] = useState<FluxBootstrapState>("loading");
  const [bootstrapError, setBootstrapError] = useState<string>();
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [readiness, setReadiness] = useState<FluxRuntimeReadinessDto>();
  const [sources, setSources] = useState<readonly FluxSourceCatalogDto[]>([]);
  const [policy, setPolicy] = useState<FluxRuntimePolicyDto>();
  const [run, setRun] = useState<FluxRunDto>();
  const [contract, setContract] = useState<FluxContractStateDto>();
  const [approval, setApproval] = useState<FluxApprovalSubjectDto>();
  const [preview, setPreview] = useState<FluxPreviewDto>();
  const [inspector, setInspector] = useState<FluxInspectorSnapshot>();
  const [events, setEvents] = useState<readonly FluxSequencedEventDto[]>([]);
  const [openedLabel, setOpenedLabel] = useState<string>();
  const [openSyncPending, setOpenSyncPending] = useState(false);
  const [authorityIntegrity, setAuthorityIntegrity] = useState<FluxAuthorityIntegrity>("not_applicable");
  const [mutationBusy, setMutationBusy] = useState<string>();
  const [previewBusy, setPreviewBusy] = useState(false);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [actionDiagnostic, setActionDiagnostic] = useState<FluxDiagnosticDto>();
  const [actionRequestId, setActionRequestId] = useState<string>();
  const [intentResetRequired, setIntentResetRequired] = useState(false);
  const [pollError, setPollError] = useState<string>();
  const [pollNonce, setPollNonce] = useState(0);
  const eventSeq = useRef(0);
  const runRef = useRef<FluxRunDto | undefined>(undefined);
  const mutationAbort = useRef<AbortController | undefined>(undefined);
  const previewAbort = useRef<AbortController | undefined>(undefined);
  const inspectAbort = useRef<AbortController | undefined>(undefined);
  const mutationBusyRef = useRef(false);

  const adoptRun = useCallback((next: FluxRunDto): void => {
    const current = runRef.current;
    if (current?.id === next.id && current.updatedAt > next.updatedAt) return;
    if (current?.id === next.id && current.updatedAt === next.updatedAt && current.phase === next.phase && sameRunProjection(current, next)) return;
    runRef.current = next;
    setRun(next);
    if (next.diagnostic !== undefined) setActionDiagnostic(undefined);
    setContract(next.contractState);
    if (next.phase !== "awaiting_open" && next.phase !== "opening") setOpenSyncPending(false);
    if (next.phase !== "awaiting_approval") setApproval(undefined);
    if (next.preview === undefined) setPreview(undefined);
  }, []);

  const hydrateSupplemental = useCallback(async (next: FluxRunDto, signal?: AbortSignal): Promise<void> => {
    const version = `${next.id}:${next.updatedAt}:${next.phase}`;
    const tasks: Promise<void>[] = [];
    if (next.preview !== undefined) tasks.push(client.preview(next.id, signal).then((value) => {
      const current = runRef.current;
      if (!signal?.aborted && current !== undefined && `${current.id}:${current.updatedAt}:${current.phase}` === version) setPreview(value);
    }));
    if (next.phase === "awaiting_approval") tasks.push(client.approvalSubject(next.id, signal).then((value) => {
      const current = runRef.current;
      if (!signal?.aborted && current !== undefined && `${current.id}:${current.updatedAt}:${current.phase}` === version) setApproval(value);
    }));
    if (tasks.length === 0) return;
    const results = await Promise.allSettled(tasks);
    if (!signal?.aborted && results.some((result) => result.status === "rejected")) setPollError("The run is current, but one read-only projection could not be refreshed. Polling will retry.");
  }, [client]);

  const acceptRun = useCallback((next: FluxRunDto, signal?: AbortSignal): void => {
    adoptRun(next);
    void hydrateSupplemental(next, signal);
  }, [adoptRun, hydrateSupplemental]);

  useEffect(() => {
    const controller = new AbortController();
    const initialize = async (): Promise<void> => {
      setBootstrapState("loading"); setBootstrapError(undefined); setActionError(undefined); setPollError(undefined);
      try {
        const currentReadiness = await client.readiness(controller.signal);
        if (controller.signal.aborted) return;
        setReadiness(currentReadiness);
        if (!currentReadiness.configured || currentReadiness.status === "setup_required") {
          const exactSetupShape = !currentReadiness.configured && currentReadiness.status === "setup_required" && currentReadiness.provider === null && currentReadiness.compiler === null && currentReadiness.toolchain === null && currentReadiness.kicadMcpRuntime === null;
          setPolicy(undefined); setSources([]); setBootstrapState(exactSetupShape ? "setup_required" : "readiness_invalid");
          return;
        }
        if (currentReadiness.provider === null || currentReadiness.compiler === null || parseFluxReadinessToolchain(currentReadiness.toolchain) === undefined || currentReadiness.kicadMcpRuntime === null || currentReadiness.reasonCodes.length !== 0 || currentReadiness.diagnostic !== null) {
          setPolicy(undefined); setSources([]); setBootstrapState("readiness_invalid");
          return;
        }
        const [currentPolicy, catalog, runs] = await Promise.all([client.policy(controller.signal), client.sources(controller.signal), client.runs(controller.signal)]);
        if (controller.signal.aborted) return;
        if (parseFluxIterationCapPolicy(currentPolicy.iterationCap) === undefined) {
          setPolicy(undefined); setSources(catalog); setBootstrapState("policy_invalid");
          return;
        }
        if (!policyMatchesReadiness(currentReadiness, currentPolicy)) {
          setPolicy(undefined); setSources(catalog); setBootstrapState("policy_mismatch");
          return;
        }
        setPolicy(currentPolicy); setSources(catalog);
        const latest = [...runs].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        if (latest !== undefined) {
          eventSeq.current = 0; setEvents([]); adoptRun(latest);
          try {
            const page = await client.poll(latest.id, 0, controller.signal);
            if (!controller.signal.aborted) {
              eventSeq.current = Math.max(eventSeq.current, page.nextEventSeq);
              setEvents(page.events);
              acceptRun(page.run, controller.signal);
            }
          } catch (reason) {
            if (!controller.signal.aborted) {
              setPollError(safeError(reason, "Initial run synchronization failed. Polling will retry."));
              acceptRun(latest, controller.signal);
            }
          }
        } else {
          runRef.current = undefined; setRun(undefined); setContract(undefined); setApproval(undefined); setPreview(undefined); setEvents([]); setOpenSyncPending(false); eventSeq.current = 0;
        }
        setBootstrapState("ready");
        void client.inspector(controller.signal).then((value) => { if (!controller.signal.aborted) setInspector(value); }).catch(() => {
          if (!controller.signal.aborted) setInspector(undefined);
        });
      } catch (reason) {
        if (!controller.signal.aborted) {
          setBootstrapError(safeError(reason, "The safe Flux readiness snapshot could not be loaded."));
          setBootstrapState("error");
        }
      }
    };
    void initialize();
    return () => controller.abort();
  }, [acceptRun, adoptRun, bootstrapNonce, client]);

  useEffect(() => {
    if (bootstrapState !== "ready" || run === undefined) return;
    const controller = new AbortController();
    let timer: number | undefined;
    let stopped = false;
    const schedule = (delay: number): void => { if (!stopped) timer = window.setTimeout(() => { void poll(); }, delay); };
    const poll = async (): Promise<void> => {
      let delay: number = ACTIVE.has(runRef.current?.phase ?? "draft") ? FLUX_POLL_DELAY_MS.active : FLUX_POLL_DELAY_MS.idle;
      try {
        const page = await client.poll(run.id, eventSeq.current, controller.signal);
        if (stopped || controller.signal.aborted || runRef.current?.id !== run.id) return;
        eventSeq.current = Math.max(eventSeq.current, page.nextEventSeq);
        setEvents((current) => mergeFluxEvents(current, page.events));
        acceptRun(page.run, controller.signal);
        setPollError(undefined);
        delay = ACTIVE.has(page.run.phase) ? FLUX_POLL_DELAY_MS.active : FLUX_POLL_DELAY_MS.idle;
      } catch (reason) {
        if (stopped || controller.signal.aborted) return;
        setPollError(safeError(reason, "Run polling was interrupted; automatic recovery remains active."));
        delay = FLUX_POLL_DELAY_MS.retry;
      } finally {
        if (!stopped && !controller.signal.aborted) schedule(delay);
      }
    };
    schedule(pollNonce === 0 ? (ACTIVE.has(run.phase) ? FLUX_POLL_DELAY_MS.active : FLUX_POLL_DELAY_MS.idle) : 0);
    return () => { stopped = true; controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [acceptRun, bootstrapState, client, pollNonce, run?.id]);

  const mutate = useCallback(async <Result,>(name: string, operation: (signal: AbortSignal) => Promise<Result>, accept: (result: Result, signal: AbortSignal) => void | Promise<void>, recoveryRunId?: string) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    const controller = new AbortController(); mutationAbort.current = controller;
    setMutationBusy(name); setActionError(undefined); setActionDiagnostic(undefined); setActionRequestId(undefined);
    try {
      const result = await operation(controller.signal);
      if (!controller.signal.aborted) await accept(result, controller.signal);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof FluxIntentStorageError) setIntentResetRequired(true);
      if (reason instanceof FluxApiError) { if (reason.diagnostic !== undefined) setActionDiagnostic(reason.diagnostic); if (reason.requestId !== undefined) setActionRequestId(reason.requestId); }
      setActionError(lostResponseMessage(reason));
      if (recoveryRunId !== undefined) {
        try { const recovered = await client.getRun(recoveryRunId, controller.signal); acceptRun(recovered, controller.signal); if ((recovered.phase === "failed" || recovered.phase === "blocked") && recovered.diagnostic !== undefined) setActionError(undefined); } catch { /* Keep the durable retry guidance and let polling recover. */ }
      }
    } finally {
      if (mutationAbort.current === controller) mutationAbort.current = undefined;
      mutationBusyRef.current = false; setMutationBusy(undefined);
    }
  }, [acceptRun, client]);

  const refreshPreview = useCallback(() => {
    const current = runRef.current; if (current === undefined) return;
    previewAbort.current?.abort(); const controller = new AbortController(); previewAbort.current = controller;
    setPreviewBusy(true);
    void client.refreshPreview(current.id, controller.signal).then((value) => { if (!controller.signal.aborted && runRef.current?.id === current.id) setPreview(value); }).catch((reason) => {
      if (!controller.signal.aborted) setActionError(safeError(reason, "Candidate views could not be refreshed."));
    }).finally(() => { if (previewAbort.current === controller) { previewAbort.current = undefined; setPreviewBusy(false); } });
  }, [client]);

  const inspect = useCallback(() => {
    inspectAbort.current?.abort(); const controller = new AbortController(); inspectAbort.current = controller;
    setInspectBusy(true);
    void client.inspect(controller.signal).then((value) => { if (!controller.signal.aborted) setInspector(value); }).catch((reason) => {
      if (!controller.signal.aborted) setActionError(safeError(reason, "Read-only KiCad inspection is unavailable."));
    }).finally(() => { if (inspectAbort.current === controller) { inspectAbort.current = undefined; setInspectBusy(false); } });
  }, [client]);

  useEffect(() => () => { mutationAbort.current?.abort(); previewAbort.current?.abort(); inspectAbort.current?.abort(); }, []);

  const authorityIssue = useMemo(() => fluxAuthorityIssue(run, readiness), [readiness, run]);
  const needsAuthorityVerification = run?.workflowKind === "generic" && run.contractState?.disposition === "ready";
  useEffect(() => {
    let cancelled = false;
    if (!needsAuthorityVerification) { setAuthorityIntegrity("not_applicable"); return; }
    if (authorityIssue !== undefined || run === undefined) { setAuthorityIntegrity("invalid"); return; }
    setAuthorityIntegrity("pending");
    void verifyFluxPublicAuthority(run).then((valid) => { if (!cancelled) setAuthorityIntegrity(valid ? "valid" : "invalid"); });
    return () => { cancelled = true; };
  }, [authorityIssue, needsAuthorityVerification, run]);
  const runtimeLocked = bootstrapState !== "ready" || policy === undefined || intentResetRequired;
  const runLocked = openSyncPending || ((authorityIssue !== undefined || (needsAuthorityVerification && authorityIntegrity !== "valid")) && run !== undefined && !["completed", "needs_review", "failed", "blocked"].includes(run.phase));
  const controlBusy = mutationBusy ?? (openSyncPending ? "open-sync" : undefined);

  return <main id="flux-workspace-main" className="flux-shell">
    <header className="flux-header"><div><p className="eyebrow">EVLEDA / FLUX GENERIC LIFECYCLE</p><h1>Flux design workspace</h1></div><p className="flux-header-note">Candidate-only operator view. Server-owned policy and safe contract projections only.</p></header>
    <RuntimeStatus readiness={readiness} state={bootstrapState} error={bootstrapError} onRetry={() => setBootstrapNonce((value) => value + 1)} />
    {actionError ? <div className="flux-error" role="alert"><span>{actionError}</span><button className="button button-quiet" type="button" onClick={() => setActionError(undefined)}>Dismiss</button></div> : null}
    {actionDiagnostic ? <section className="flux-action-diagnostic" aria-label="Immediate operation diagnostic"><DiagnosticNotice diagnostic={actionDiagnostic} /></section> : null}
    {actionRequestId ? <p className="flux-request-correlation" role="status">Request correlation <code>{safeDisplay(actionRequestId)}</code>. This identifier is informational and does not authorize replay or receipt consumption.</p> : null}
    {intentResetRequired ? <aside className="flux-intent-reset" role="alert" aria-label="Browser intent reset required"><div><strong>Mutation replay protection is locked</strong><p>Inspect server run history before resetting. Resetting abandons replay protection for unresolved browser operations and must be an explicit operator choice.</p></div><button className="button button-secondary" type="button" onClick={() => { try { client.resetBrowserIntents(); setIntentResetRequired(false); setActionError(undefined); } catch (reason) { setActionError(safeError(reason, "Browser intent reset failed; mutations remain locked.")); } }}>Reset local operation intents</button></aside> : null}
    {pollError ? <div className="flux-poll-warning" role="status"><span>{pollError}</span><button className="button button-quiet" type="button" onClick={() => setPollNonce((value) => value + 1)}>Retry polling now</button></div> : null}
    <div className="flux-layout"><PromptThreadPanel sources={sources} run={run} contract={contract} approval={approval} busy={controlBusy} openedLabel={openedLabel} policy={policy} readiness={readiness} lifecycleLocked={runtimeLocked} runLocked={runLocked} authorityIntegrity={authorityIntegrity}
      onCreate={(input: FluxCreateInput) => policy && void mutate("create", (signal) => client.createRun(input, policy, signal), (next, signal) => { eventSeq.current = 0; setEvents([]); setOpenedLabel(undefined); acceptRun(next, signal); })}
      onInterpret={() => run && void mutate("interpret", (signal) => client.interpret(run.id, signal, { projectId: run.projectId, threadId: run.threadId }), (next, signal) => acceptRun(next, signal), run.id)}
      onClarify={(answers: readonly FluxClarificationAnswerDto[]) => run && void mutate("clarify", (signal) => client.clarifications(run.id, answers, signal, { projectId: run.projectId, threadId: run.threadId }), (next, signal) => acceptRun(next, signal), run.id)}
      onPrepare={() => run && void mutate("prepare", (signal) => client.prepare(run.id, signal), (next, signal) => acceptRun(next, signal), run.id)}
      onOpen={() => run && void mutate("open", (signal) => client.open(run.projectId, run.id, signal), async (result, signal) => {
        setOpenedLabel(safeDisplay(result.label));
        setOpenSyncPending(true);
        try {
          const page = await client.poll(run.id, eventSeq.current, signal);
          if (signal.aborted || runRef.current?.id !== run.id) return;
          eventSeq.current = Math.max(eventSeq.current, page.nextEventSeq); setEvents((current) => mergeFluxEvents(current, page.events)); acceptRun(page.run, signal);
        } catch {
          if (!signal.aborted) setPollError("Open completed, but its new phase could not be read yet. Mutation controls remain locked while polling recovers it.");
        }
      }, run.id)}
      onCheckpoint={() => run && void mutate("checkpoint", (signal) => client.checkpointOpen(run.id, signal), (next, signal) => acceptRun(next, signal), run.id)}
      onApprove={() => run && approval && void mutate("approve", (signal) => client.approve(run.id, approval.digest, signal), (next, signal) => acceptRun(next, signal), run.id)}
      onResume={() => run && void mutate("resume", (signal) => client.resume(run.id, signal), (next, signal) => acceptRun(next, signal), run.id)} />
      <PreviewCanvas client={client} run={run} preview={preview} busy={previewBusy} onRefresh={refreshPreview} />
      <DesignInspector snapshot={inspector} contract={contract} authorityIntegrity={authorityIntegrity} busy={inspectBusy} onInspect={inspect} /></div>
    <OperationTimeline events={events} />
    {run?.reports.length ? <section className="flux-timeline"><div className="flux-panel-heading"><p className="overline">05 / REPORT HISTORY</p><h2>Immutable reports</h2></div><ol>{run.reports.map((report) => <li key={report.reportId}><div><strong>{safeDisplay(report.title)} · {safeDisplay(report.disposition, "disposition unavailable")}</strong><p>{report.disposition === "failed" || report.disposition === "blocked" ? "Structured terminal diagnostic recorded above." : safeDisplay(report.summary ?? report.mediaType)}</p><p className="mono">SHA-256 {safeDisplayDigest(report.reportSha256 ?? report.digest, false)}</p>{report.freshAcceptance ? <p>Fresh acceptance: {report.freshAcceptance.passed ? "pass" : `review required (${safeDisplay(report.freshAcceptance.missing.length)})`}</p> : null}</div><time dateTime={safeDisplay(report.createdAt)}>{safeDisplayDate(report.createdAt)}</time></li>)}</ol></section> : null}
  </main>;
}
