import { WarningCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { X } from "@phosphor-icons/react/dist/csr/X";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, isApiUnavailable, userFacingError } from "./api";
import { BundleStation } from "./components/BundleStation";
import { BlockerPanel } from "./components/BlockerPanel";
import { EngineeringPracticePanel } from "./components/EngineeringPracticePanel";
import { Inspector } from "./components/Inspector";
import { ProjectIntake } from "./components/ProjectIntake";
import { RequirementsPanel } from "./components/RequirementsPanel";
import { SafetyBand, type DataMode } from "./components/SafetyBand";
import { StageRail } from "./components/StageRail";
import { makeDemoSnapshot } from "./demo";
import type {
  ApprovalInput,
  ArtifactRecord,
  DesignRevisionSummary,
  DesignRun,
  EngineeringExactIdentity,
  EngineeringPracticeInspectionResult,
  EvidenceRecord,
  LifecycleState,
  Project,
  QualificationInput,
  RequirementsDocument,
  StageKey
} from "./model";
import { currentAttempt, hasCurrentPassingPhysicalV2Evidence, STAGE_ORDER } from "./model";

interface Notice {
  readonly kind: "status" | "warning" | "error";
  readonly message: string;
}

const stageToInspect = (run: DesignRun): StageKey => {
  for (const targetState of ["blocked", "running", "waiting_approval", "interrupted", "succeeded"]) {
    const stage = STAGE_ORDER.find((entry) => currentAttempt(run, entry)?.state === targetState);
    if (stage) return stage;
  }
  return "requirements";
};

const sortProjects = (projects: readonly Project[]): readonly Project[] =>
  [...projects].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));

const engineeringIdentityAnchor = (identity: EngineeringExactIdentity | null): string | null => {
  if (!identity) return null;
  return "size" in identity
    ? `${identity.algorithm}:${identity.digest}:${identity.size}`
    : `${identity.algorithm}:${identity.digest}:${identity.schemaVersion}:${identity.canonicalizationVersion}`;
};

const engineeringPageAnchor = (inspection: EngineeringPracticeInspectionResult): string =>
  JSON.stringify([
    inspection.projectId,
    inspection.runId,
    inspection.revisionId,
    engineeringIdentityAnchor(inspection.bindings.revisionManifest),
    engineeringIdentityAnchor(inspection.bindings.evidenceRootIdentity),
    engineeringIdentityAnchor(inspection.bindings.practiceCatalogIdentity),
    engineeringIdentityAnchor(inspection.bindings.routeQualityPolicyIdentity),
    engineeringIdentityAnchor(inspection.bindings.routeQualityRuleDeckIdentity),
    engineeringIdentityAnchor(inspection.bindings.proofFixturePolicyIdentity),
    engineeringIdentityAnchor(inspection.bindings.analyzerProfileIdentity),
    engineeringIdentityAnchor(inspection.bindings.constraintBindingIdentity),
    engineeringIdentityAnchor(inspection.bindings.nativeBoardIdentity),
    engineeringIdentityAnchor(inspection.checks.nativeDrc.reportIdentity),
    inspection.checks.nativeDrc.evidenceId,
    engineeringIdentityAnchor(inspection.checks.evledaPractice.reportIdentity),
    inspection.checks.evledaPractice.evidenceId,
    inspection.findings.total
  ]);

export default function App() {
  const [mode, setMode] = useState<DataMode>("connecting");
  const [initialLoading, setInitialLoading] = useState(true);
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [project, setProject] = useState<Project>();
  const [run, setRun] = useState<DesignRun>();
  const [requirements, setRequirements] = useState<RequirementsDocument>();
  const [artifacts, setArtifacts] = useState<readonly ArtifactRecord[]>([]);
  const [evidence, setEvidence] = useState<readonly EvidenceRecord[]>([]);
  const [headRevision, setHeadRevision] = useState<DesignRevisionSummary>();
  const [evidenceRootDigest, setEvidenceRootDigest] = useState<string>();
  const [effectiveLifecycle, setEffectiveLifecycle] = useState<LifecycleState>("candidate");
  const [activeQualification, setActiveQualification] = useState(false);
  const [engineeringPages, setEngineeringPages] = useState<readonly EngineeringPracticeInspectionResult[]>([]);
  const engineeringInspection = engineeringPages[0];
  const [engineeringError, setEngineeringError] = useState<string>();
  const [engineeringLoading, setEngineeringLoading] = useState(false);
  const [engineeringLoadingMore, setEngineeringLoadingMore] = useState(false);
  const [selectedStage, setSelectedStage] = useState<StageKey>("requirements");
  const [busyAction, setBusyAction] = useState<string>();
  const [notice, setNotice] = useState<Notice>();
  const [actionMessage, setActionMessage] = useState<string>();
  const engineeringRequestSequence = useRef(0);

  const loadEngineeringInspection = useCallback(
    async (
      expectedProjectId: string,
      runId: string,
      revisionId?: string
    ): Promise<EngineeringPracticeInspectionResult | undefined> => {
      const requestSequence = engineeringRequestSequence.current + 1;
      engineeringRequestSequence.current = requestSequence;
      setEngineeringPages([]);
      setEngineeringError(undefined);
      setEngineeringLoading(true);
      setEngineeringLoadingMore(false);
      try {
        const inspection = await api.inspectEngineeringPractices(runId, {
          ...(revisionId === undefined ? {} : { revisionId }),
          findingLimit: 50
        });
        if (
          inspection.projectId !== expectedProjectId ||
          inspection.runId !== runId ||
          inspection.revisionId !== (revisionId ?? null)
        ) {
          throw new Error(
            "Engineering inspection identity does not match the selected project, run, and revision."
          );
        }
        if (engineeringRequestSequence.current !== requestSequence) return undefined;
        setEngineeringPages([inspection]);
        return inspection;
      } catch (error) {
        if (engineeringRequestSequence.current !== requestSequence) return undefined;
        setEngineeringError(userFacingError(error));
        return undefined;
      } finally {
        if (engineeringRequestSequence.current === requestSequence) {
          setEngineeringLoading(false);
        }
      }
    },
    []
  );

  const installDemo = useCallback(
    (scenario: "blocked" | "new" = "blocked", prompt?: string, name?: string) => {
      const snapshot = makeDemoSnapshot(prompt, name, scenario);
      engineeringRequestSequence.current += 1;
      setMode("demo");
      setProjects(snapshot.projects);
      setProject(snapshot.project);
      setRun(snapshot.run);
      setRequirements(snapshot.requirements);
      setArtifacts(snapshot.artifacts);
      setEvidence(snapshot.evidence);
      setHeadRevision(undefined);
      setEvidenceRootDigest(undefined);
      setEffectiveLifecycle("candidate");
      setActiveQualification(false);
      setEngineeringPages([]);
      setEngineeringError(
        "Engineering inspection is unavailable while the workbench is using labeled local demo data."
      );
      setEngineeringLoading(false);
      setEngineeringLoadingMore(false);
      setSelectedStage(stageToInspect(snapshot.run));
      setNotice({
        kind: "warning",
        message:
          "The local API is unavailable. This is labeled demo data; controls do not operate on KiCad files or create an engineering bundle."
      });
    },
    []
  );

  const hydrateProject = useCallback(
    async (nextProject: Project, allProjects?: readonly Project[]): Promise<void> => {
      engineeringRequestSequence.current += 1;
      setProject(nextProject);
      setEngineeringPages([]);
      setEngineeringError(undefined);
      setEngineeringLoading(true);
      setEngineeringLoadingMore(false);
      if (allProjects) setProjects(allProjects);
      const runId = nextProject.runIds.at(-1);
      if (!runId) {
        setRun(undefined);
        setRequirements(undefined);
        setArtifacts([]);
        setEvidence([]);
        setHeadRevision(undefined);
        setEvidenceRootDigest(undefined);
        setEffectiveLifecycle("candidate");
        setActiveQualification(false);
        setEngineeringPages([]);
        setEngineeringError(undefined);
        setEngineeringLoading(false);
        setEngineeringLoadingMore(false);
        setSelectedStage("requirements");
        return;
      }

      const status = await api.getRunStatus(runId);
      const nextRun = status.run;
      const [nextRequirements, nextArtifacts, nextEvidenceInspection, currentEvidenceInspection] = await Promise.all([
        api.getRequirements(runId),
        api.listArtifacts(runId, {
          ...(nextRun.headRevisionId === undefined ? {} : { revisionId: nextRun.headRevisionId }),
          includeStale: true
        }),
        api.inspectEvidence(runId, nextRun.headRevisionId, true),
        api.inspectEvidence(runId, nextRun.headRevisionId, false)
      ]);
      setRun(nextRun);
      setHeadRevision(status.headRevision);
      setEffectiveLifecycle(status.effectiveLifecycle ?? nextRun.lifecycle);
      if (status.project) {
        setProject(status.project);
        setProjects((current) =>
          current.map((entry) => (entry.id === status.project?.id ? status.project : entry))
        );
      }
      setRequirements(nextRequirements ?? nextRun.requirements);
      setArtifacts(nextArtifacts);
      setEvidence(nextEvidenceInspection.evidence);
      setEvidenceRootDigest(currentEvidenceInspection.evidenceRootDigest);
      setActiveQualification(
        status.effectiveLifecycle !== undefined &&
          status.effectiveLifecycle !== "candidate" &&
          status.activeAttestations.some(
            (attestation) =>
              attestation.kind === "qualification" &&
              attestation.designRevisionId === nextRun.headRevisionId &&
              attestation.subjectDigest === status.headRevision?.manifest.digest &&
              attestation.evidenceRootDigest === currentEvidenceInspection.evidenceRootDigest
          )
      );
      await loadEngineeringInspection(nextRun.projectId, nextRun.id, nextRun.headRevisionId);
      setSelectedStage(stageToInspect(nextRun));
    },
    [loadEngineeringInspection]
  );

  const bootstrap = useCallback(async (): Promise<void> => {
    setInitialLoading(true);
    setMode("connecting");
    try {
      const listed = sortProjects(await api.listProjects());
      setMode("api");
      setNotice(undefined);
      if (listed.length === 0) {
        engineeringRequestSequence.current += 1;
        setProjects([]);
        setProject(undefined);
        setRun(undefined);
        setRequirements(undefined);
        setArtifacts([]);
        setEvidence([]);
        setHeadRevision(undefined);
        setEvidenceRootDigest(undefined);
        setEffectiveLifecycle("candidate");
        setActiveQualification(false);
        setEngineeringPages([]);
        setEngineeringError(undefined);
        setEngineeringLoading(false);
        setEngineeringLoadingMore(false);
      } else {
        const first = listed[0];
        if (first) await hydrateProject(first, listed);
      }
    } catch (error) {
      if (isApiUnavailable(error)) {
        installDemo();
      } else {
        engineeringRequestSequence.current += 1;
        setMode("error");
        setProjects([]);
        setProject(undefined);
        setRun(undefined);
        setRequirements(undefined);
        setArtifacts([]);
        setEvidence([]);
        setHeadRevision(undefined);
        setEvidenceRootDigest(undefined);
        setEffectiveLifecycle("candidate");
        setActiveQualification(false);
        setEngineeringPages([]);
        setEngineeringError(undefined);
        setEngineeringLoading(false);
        setEngineeringLoadingMore(false);
        setNotice({ kind: "error", message: userFacingError(error) });
      }
    } finally {
      setInitialLoading(false);
    }
  }, [hydrateProject, installDemo]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const refreshCurrent = useCallback(async (): Promise<void> => {
    if (!project) return;
    setBusyAction("refresh");
    setNotice(undefined);
    try {
      if (mode === "demo") {
        await bootstrap();
        return;
      }
      await hydrateProject(project);
      setMode("api");
      setNotice({ kind: "status", message: "Run status and evidence were refreshed from the local API." });
    } catch (error) {
      setMode("error");
      setEngineeringPages([]);
      setEngineeringError(
        "Core run refresh failed, so the previous engineering inspection was cleared instead of being reused."
      );
      setEngineeringLoading(false);
      setNotice({
        kind: isApiUnavailable(error) ? "warning" : "error",
        message: isApiUnavailable(error)
          ? "The API became unavailable. The last API snapshot remains visible; it has not been replaced with demo data."
          : userFacingError(error)
      });
    } finally {
      setBusyAction(undefined);
    }
  }, [bootstrap, hydrateProject, mode, project]);

  const handleCreate = async (name: string, prompt: string): Promise<void> => {
    setBusyAction("create");
    setNotice(undefined);
    setActionMessage(undefined);
    try {
      const creation = await api.createProject(name, prompt);
      const started = await api.startRun(
        creation.project.id,
        prompt,
        creation.project.revision ?? creation.stateRevision
      );
      const startedProject = started.project ?? creation.project;
      const withRun = startedProject.runIds.includes(started.run.id)
        ? startedProject
        : { ...startedProject, runIds: [...startedProject.runIds, started.run.id] };
      const listed = sortProjects([withRun, ...projects.filter((entry) => entry.id !== withRun.id)]);
      setMode("api");
      setProjects(listed);
      setProject(withRun);
      setRun(started.run);
      setHeadRevision(started.headRevision);
      setEffectiveLifecycle(started.effectiveLifecycle ?? started.run.lifecycle);
      setActiveQualification(false);
      setRequirements(started.run.requirements);
      setArtifacts([]);
      setEvidence([]);
      setEvidenceRootDigest(undefined);
      setSelectedStage(started.currentStage ?? stageToInspect(started.run));
      await loadEngineeringInspection(
        started.run.projectId,
        started.run.id,
        started.run.headRevisionId
      );
      setNotice({
        kind: "status",
        message: "Project created. The requirements stage is now parsing the exact submitted prompt."
      });
    } catch (error) {
      if (isApiUnavailable(error)) {
        installDemo("new", prompt, name);
      } else {
        setMode("error");
        setNotice({ kind: "error", message: userFacingError(error) });
      }
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleSelectProject = async (projectId: string): Promise<void> => {
    const selected = projects.find((entry) => entry.id === projectId);
    if (!selected) return;
    if (mode === "demo") {
      setProject(selected);
      return;
    }
    setBusyAction("select");
    try {
      await hydrateProject(selected);
    } catch (error) {
      setEngineeringPages([]);
      setEngineeringError(
        "The selected run could not be loaded, so no engineering inspection is being reused."
      );
      setEngineeringLoading(false);
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleApprove = async (input: ApprovalInput): Promise<void> => {
    if (!run || !requirements) return;
    setBusyAction("approve");
    setActionMessage(undefined);
    try {
      if (mode === "demo") {
        const approvedRequirements = {
          ...requirements,
          approvalId: "approval_demo_local_only"
        };
        const requirementAttempt = currentAttempt(run, "requirements");
        const approvedAttempts = requirementAttempt
          ? {
              ...run.attempts,
              requirements: [
                ...((run.attempts.requirements ?? []).slice(0, -1)),
                { ...requirementAttempt, state: "succeeded" as const, completedAt: new Date().toISOString() }
              ]
            }
          : run.attempts;
        setRequirements(approvedRequirements);
        setRun({ ...run, requirements: approvedRequirements, attempts: approvedAttempts, state: "running" });
        setNotice({
          kind: "warning",
          message: "Demo approval recorded in browser memory only. It is not a persisted human approval."
        });
      } else {
        await api.approveRequirements(run.id, input, run.revision ?? 0);
        await hydrateProject(project ?? projects[0]!);
        setNotice({
          kind: "status",
          message: "Human requirements approval was bound to the submitted requirements digest."
        });
      }
    } catch (error) {
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleRerun = async (stage: StageKey): Promise<void> => {
    if (!run) return;
    setBusyAction("rerun");
    setActionMessage(undefined);
    try {
      if (mode === "demo") {
        setNotice({
          kind: "warning",
          message: "Demo mode: the rerun request was not sent and the blocker remains unchanged."
        });
      } else {
        await api.rerunStage(run.id, stage, run.revision ?? 0);
        if (project) await hydrateProject(project);
        setNotice({
          kind: "status",
          message: `Rerun requested for ${stage.replaceAll("_", " ")}.`
        });
      }
    } catch (error) {
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleResume = async (): Promise<void> => {
    if (!run) return;
    setBusyAction("resume");
    setActionMessage(undefined);
    try {
      if (mode === "demo") {
        setNotice({ kind: "warning", message: "Demo mode: no persisted run was resumed." });
      } else {
        await api.resumeRun(run.id, run.revision ?? 0);
        if (project) await hydrateProject(project);
        setNotice({
          kind: "status",
          message: "The persisted run was asked to resume from its current gate."
        });
      }
    } catch (error) {
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const runRevisionAction = async (
    action: "candidate" | "prototype" | "bringup" | "firmware"
  ): Promise<void> => {
    const revisionId = run?.headRevisionId;
    if (!revisionId) return;
    if (
      (action === "candidate" || action === "prototype") &&
      !(
        mode === "api" &&
        !engineeringError &&
        engineeringInspection?.isHeadRevision === true &&
        engineeringInspection.disposition.status === "PROVISIONAL_POC"
      )
    ) {
      setNotice({
        kind: "error",
        message:
          "Package export is locked until the server returns PROVISIONAL_POC for the exact current head inspection."
      });
      return;
    }
    setBusyAction(action);
    setActionMessage(undefined);
    try {
      if (mode === "demo") {
        setActionMessage(
          `Demo mode: no ${action} artifact or bundle was created. Reconnect the local daemon to operate on a bound revision.`
        );
        return;
      }
      if (action === "candidate") {
        const receipt = await api.exportCandidate(revisionId, run.revision ?? 0);
        setActionMessage(receipt.message);
      } else if (action === "prototype") {
        const receipt = await api.exportPrototype(revisionId, run.revision ?? 0);
        setActionMessage(receipt.message);
      } else if (action === "bringup") {
        await api.generateBringupPlan(revisionId, run.revision ?? 0);
        setActionMessage("Bring-up plan generation completed for the bound revision.");
      } else {
        await api.generateFirmwareScaffold(revisionId, run.revision ?? 0);
        setActionMessage("Firmware scaffold generation completed for the bound revision.");
      }
      if (project) await hydrateProject(project);
    } catch (error) {
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleQualify = async (input: QualificationInput): Promise<void> => {
    const revisionId = run?.headRevisionId;
    const revisionDigest = headRevision?.manifest.digest;
    const requirementsDigest = requirements?.identity.digest;
    if (!run || !revisionId || !revisionDigest || !requirementsDigest || !evidenceRootDigest) {
      setNotice({
        kind: "error",
        message: "Qualification identities are incomplete. Refresh the completed run before retrying."
      });
      return;
    }
    setBusyAction("qualification");
    try {
      if (mode === "demo") {
        setNotice({
          kind: "warning",
          message: "Demo mode never accepts or simulates a hardware qualification."
        });
        return;
      }
      await api.qualifyRevision(
        revisionId,
        requirementsDigest,
        evidenceRootDigest,
        input,
        run.revision ?? 0
      );
      if (project) await hydrateProject(project);
      setNotice({
        kind: "status",
        message:
          "Human qualification was recorded for the exact design manifest and evidence root. This is not manufacturing release."
      });
    } catch (error) {
      setNotice({ kind: "error", message: userFacingError(error) });
    } finally {
      setBusyAction(undefined);
    }
  };

  const handleRetryEngineering = async (): Promise<void> => {
    if (!run || mode !== "api") {
      await bootstrap();
      return;
    }
    await loadEngineeringInspection(run.projectId, run.id, run.headRevisionId);
  };

  const handleLoadMoreEngineeringFindings = async (): Promise<void> => {
    const firstPage = engineeringPages[0];
    const currentPage = engineeringPages.at(-1);
    const cursor = currentPage?.findings.nextCursor;
    if (!firstPage || !currentPage || !cursor || engineeringLoadingMore) return;

    setEngineeringLoadingMore(true);
    setEngineeringError(undefined);
    try {
      const nextPage = await api.inspectEngineeringPractices(firstPage.runId, {
        ...(firstPage.revisionId === null ? {} : { revisionId: firstPage.revisionId }),
        findingCursor: cursor,
        findingLimit: 50
      });
      if (engineeringPageAnchor(nextPage) !== engineeringPageAnchor(firstPage)) {
        throw new Error(
          "The next findings page is not bound to the same immutable engineering report snapshot."
        );
      }
      if (nextPage.findings.nextCursor === cursor) {
        throw new Error("The engineering findings cursor did not advance.");
      }
      const loadedIds = new Set(
        engineeringPages.flatMap((page) => page.findings.items.map((finding) => finding.findingId))
      );
      if (nextPage.findings.items.some((finding) => loadedIds.has(finding.findingId))) {
        throw new Error("The next engineering findings page repeats a previously loaded finding identity.");
      }
      const nextLoadedCount = loadedIds.size + nextPage.findings.items.length;
      if (
        nextLoadedCount > firstPage.findings.total ||
        (nextPage.findings.items.length === 0 && nextPage.findings.nextCursor !== null)
      ) {
        throw new Error("The engineering findings page is inconsistent with the server-reported total.");
      }
      setEngineeringPages((currentPages) => {
        const currentFirst = currentPages[0];
        const currentLast = currentPages.at(-1);
        if (
          !currentFirst ||
          engineeringPageAnchor(currentFirst) !== engineeringPageAnchor(firstPage) ||
          currentLast?.findings.nextCursor !== cursor
        ) {
          return currentPages;
        }
        const currentIds = new Set(
          currentPages.flatMap((page) => page.findings.items.map((finding) => finding.findingId))
        );
        if (nextPage.findings.items.some((finding) => currentIds.has(finding.findingId))) {
          return currentPages;
        }
        return [...currentPages, nextPage];
      });
    } catch (error) {
      setEngineeringError(userFacingError(error));
    } finally {
      setEngineeringLoadingMore(false);
    }
  };

  return (
    <div className="app-shell">
      <SafetyBand
        mode={mode}
        lifecycle={effectiveLifecycle}
        projectName={project?.name}
        runId={run?.id}
      />

      {notice ? (
        <div className={`global-notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          <WarningCircle aria-hidden="true" weight="fill" />
          <span>{notice.message}</span>
          {notice.kind === "error" ? (
            <button
              className="notice-retry"
              type="button"
              onClick={() => void (project ? refreshCurrent() : bootstrap())}
            >
              {project ? "Refresh from API" : "Retry API"}
            </button>
          ) : null}
          <button type="button" aria-label="Dismiss status message" onClick={() => setNotice(undefined)}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {initialLoading ? (
        <main id="bench-main" className="loading-bench" aria-busy="true">
          <div className="loading-meter" role="status" aria-live="polite">
            <span className="meter-block" aria-hidden="true" />
            <div>
              <strong>Checking local workcell</strong>
              <p>Reading projects from <code>/api/v1/projects</code>…</p>
            </div>
          </div>
        </main>
      ) : (
        <main id="bench-main" className="bench-layout">
          <ProjectIntake
            projects={projects}
            project={project}
            run={run}
            effectiveLifecycle={effectiveLifecycle}
            mode={mode}
            busy={Boolean(busyAction)}
            onCreate={handleCreate}
            onSelectProject={handleSelectProject}
            onRefresh={refreshCurrent}
          />

          <div className="center-bay">
            <StageRail run={run} selectedStage={selectedStage} onSelectStage={setSelectedStage} />
            <BlockerPanel
              run={run}
              selectedStage={selectedStage}
              busy={Boolean(busyAction)}
              onRerun={handleRerun}
              onResume={handleResume}
            />
            <RequirementsPanel
              requirements={requirements}
              busy={busyAction === "approve"}
              requiresCapabilityToken={mode !== "demo"}
              onApprove={handleApprove}
            />
            <EngineeringPracticePanel
              hasRun={run !== undefined}
              inspection={engineeringInspection}
              findingPages={engineeringPages}
              loading={engineeringLoading}
              loadingMore={engineeringLoadingMore}
              error={engineeringError}
              onRetry={handleRetryEngineering}
              onLoadMore={handleLoadMoreEngineeringFindings}
            />
          </div>

          <div className="right-bay">
            <Inspector
              selectedStage={selectedStage}
              artifacts={artifacts}
              evidence={evidence}
              contentAvailable={mode === "api"}
            />
            <BundleStation
              run={run}
              effectiveLifecycle={effectiveLifecycle}
              activeQualification={activeQualification}
              engineeringDisposition={
                mode === "api" && !engineeringError && engineeringInspection?.isHeadRevision
                  ? engineeringInspection.disposition.status
                  : undefined
              }
              qualificationReady={Boolean(
                run?.state === "completed" &&
                  headRevision?.manifest.digest &&
                  requirements?.identity.digest &&
                  evidenceRootDigest &&
                  hasCurrentPassingPhysicalV2Evidence(
                    evidence,
                    artifacts,
                    run.headRevisionId
                  )
              )}
              revisionDigest={headRevision?.manifest.digest}
              requirementsDigest={requirements?.identity.digest}
              evidenceRootDigest={evidenceRootDigest}
              busyAction={busyAction}
              actionMessage={actionMessage}
              onExportCandidate={() => runRevisionAction("candidate")}
              onExportPrototype={() => runRevisionAction("prototype")}
              onGenerateBringup={() => runRevisionAction("bringup")}
              onGenerateFirmware={() => runRevisionAction("firmware")}
              onQualify={handleQualify}
            />
          </div>
        </main>
      )}

      <footer className="bench-footer">
        <span>EVLEDA / LOCAL-FIRST ENGINEERING WORKCELL</span>
        <span>Human review and physical validation remain outside autonomous candidate generation.</span>
      </footer>
    </div>
  );
}
