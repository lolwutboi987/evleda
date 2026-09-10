import { expect, test, type Page, type Route } from "@playwright/test";
import { makeDemoSnapshot } from "../src/demo";
import {
  engineeringFinding,
  makeEngineeringInspection
} from "../src/testing/engineeringFixture";
import type {
  ArtifactRecord,
  DesignRun,
  EvidenceRecord,
  Project,
  RequirementsDocument,
  StageKey
} from "../src/model";
import { STAGE_ORDER } from "../src/model";

const MANIFEST_DIGEST = "d".repeat(64);
const EVIDENCE_ROOT_DIGEST = "e".repeat(64);
const HEAD_REVISION_ID = "revision-browser-head";
const RUN_ID = "run-browser-01";
const PROJECT_ID = "project-browser-01";

type Scenario = "empty" | "blocked" | "completed-physical";

interface ApiFixture {
  requirementsCredential?: string;
  qualificationCredential?: string;
  requirementsBody?: string;
  qualificationBody?: string;
}

const json = (route: Route, value: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });

const successfulAttempts = (): DesignRun["attempts"] =>
  Object.fromEntries(
    STAGE_ORDER.map((stage, index) => [
      stage,
      [
        {
          id: `attempt-browser-${stage}`,
          stage,
          attemptNumber: 1,
          state: "succeeded",
          artifactIds: [],
          evidenceIds: [],
          blockers: [],
          startedAt: `2026-09-03T0${Math.min(index, 9)}:00:00.000Z`,
          completedAt: `2026-09-03T0${Math.min(index, 9)}:01:00.000Z`
        }
      ]
    ])
  ) as DesignRun["attempts"];

const physicalRecords = (
  baseArtifact: ArtifactRecord,
  baseEvidence: EvidenceRecord
): { artifacts: readonly ArtifactRecord[]; evidence: readonly EvidenceRecord[] } => {
  const tool = {
    name: "human-physical-evidence",
    version: "2",
    adapter: "human",
    capabilityProfile: "verified-source-blobs-and-derived-observations-v2"
  };
  const raw: ArtifactRecord = {
    ...baseArtifact,
    id: "artifact-physical-sources",
    designRevisionId: HEAD_REVISION_ID,
    stage: "bringup_package",
    logicalName: "physical-evidence/BOARD-01-sources.zip",
    mediaType: "application/zip",
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    tool
  };
  const parsedBytes = JSON.stringify({
    schemaVersion: "evleda.human-physical-evidence.v2",
    boardSerial: "BOARD-01",
    overallVerdict: "pass",
    categoryCount: 7
  });
  const parsed: ArtifactRecord = {
    ...raw,
    id: "artifact-physical-record",
    logicalName: "physical-evidence/BOARD-01-record.json",
    mediaType: "application/json",
    blob: { ...raw.blob, digest: "b".repeat(64), size: new TextEncoder().encode(parsedBytes).byteLength }
  };
  const record: EvidenceRecord = {
    ...baseEvidence,
    id: "evidence-physical-v2",
    designRevisionId: HEAD_REVISION_ID,
    stage: "bringup_package",
    evidenceClass: "human_physical",
    claim: "Candidate-only passing physical-v2 observation record for BOARD-01.",
    validationStatus: "pass",
    unresolvedAssumptions: [],
    lifecycle: "candidate",
    tool,
    rawArtifactId: raw.id,
    parsedArtifactId: parsed.id,
    validUntil: "2099-01-01T00:00:00.000Z"
  };
  return { artifacts: [raw, parsed], evidence: [record] };
};

async function installApiFixture(page: Page, scenario: Scenario): Promise<ApiFixture> {
  const capture: ApiFixture = {};
  const snapshot = makeDemoSnapshot(undefined, "Browser controller", scenario === "empty" ? "new" : "blocked");
  let requirements: RequirementsDocument = snapshot.requirements!;
  let project: Project = {
    ...snapshot.project,
    id: PROJECT_ID,
    name: "Browser controller",
    runIds: scenario === "empty" ? [] : [RUN_ID],
    headRevisionId: scenario === "completed-physical" ? HEAD_REVISION_ID : snapshot.project.headRevisionId,
    revision: 4
  };
  let run: DesignRun = {
    ...snapshot.run,
    id: RUN_ID,
    projectId: PROJECT_ID,
    requirements,
    revision: 4
  };
  let hasProject = scenario !== "empty";
  let qualified = false;
  let failFirstResume = scenario === "blocked";

  const previewBytes = JSON.stringify({ candidate: true, manufacturingRelease: false });
  const previewArtifact: ArtifactRecord = {
    ...snapshot.artifacts[0]!,
    id: "artifact-browser-preview",
    projectId: PROJECT_ID,
    runId: RUN_ID,
    designRevisionId: HEAD_REVISION_ID,
    logicalName: "browser-inspection.json",
    blob: {
      ...snapshot.artifacts[0]!.blob,
      digest: "a".repeat(64),
      size: new TextEncoder().encode(previewBytes).byteLength
    }
  };
  const staleArtifact: ArtifactRecord = {
    ...previewArtifact,
    id: "artifact-browser-stale",
    logicalName: "superseded-inspection.json",
    staleAt: "2026-09-03T22:00:00.000Z"
  };
  const physical = physicalRecords(previewArtifact, snapshot.evidence[0]!);
  let artifacts: readonly ArtifactRecord[] = scenario === "completed-physical"
    ? [previewArtifact, staleArtifact, ...physical.artifacts]
    : snapshot.artifacts.map((artifact) => ({ ...artifact, projectId: PROJECT_ID, runId: RUN_ID }));
  let evidence: readonly EvidenceRecord[] = scenario === "completed-physical"
    ? [
        ...physical.evidence,
        {
          ...snapshot.evidence[0]!,
          id: "evidence-browser-stale",
          projectId: PROJECT_ID,
          runId: RUN_ID,
          designRevisionId: HEAD_REVISION_ID,
          claim: "Superseded inspection evidence",
          staleAt: "2026-09-03T22:00:00.000Z"
        }
      ]
    : snapshot.evidence.map((record) => ({ ...record, projectId: PROJECT_ID, runId: RUN_ID }));

  if (scenario === "completed-physical") {
    requirements = { ...requirements, approvalId: "approval-browser-requirements" };
    run = {
      ...run,
      state: "completed",
      lifecycle: "candidate",
      attempts: successfulAttempts(),
      requirements,
      headRevisionId: HEAD_REVISION_ID
    };
  }

  const headRevision = {
    id: HEAD_REVISION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    lifecycle: "candidate" as const,
    manifest: {
      algorithm: "sha256" as const,
      digest: MANIFEST_DIGEST,
      schemaVersion: "evleda.design-revision.v1",
      canonicalizationVersion: "evleda-c14n-json-v1"
    }
  };

  const currentStage = (): StageKey => {
    if (run.state === "blocked") return "component_selection";
    if (run.state === "waiting_requirements_approval") return "requirements";
    return run.state === "completed" ? "bringup_package" : "system_architecture";
  };

  const status = () => ({
    project,
    run,
    stateRevision: run.revision ?? 0,
    currentStage: currentStage(),
    ...(run.headRevisionId ? { headRevision } : {}),
    effectiveLifecycle: qualified ? "qualified" : "candidate",
    activeAttestations: qualified
      ? [
          {
            id: "approval-browser-qualification",
            kind: "qualification",
            designRevisionId: HEAD_REVISION_ID,
            subjectDigest: MANIFEST_DIGEST,
            evidenceRootDigest: EVIDENCE_ROOT_DIGEST,
            qualificationApprovalId: "approval-browser-qualification"
          }
        ]
      : []
  });

  const content = new Map<string, { body: string; mediaType: string; fileName: string }>([
    [previewArtifact.id, { body: previewBytes, mediaType: "application/json", fileName: previewArtifact.logicalName }],
    [staleArtifact.id, { body: previewBytes, mediaType: "application/json", fileName: staleArtifact.logicalName }],
    [
      "artifact-physical-record",
      {
        body: JSON.stringify({ schemaVersion: "evleda.human-physical-evidence.v2", overallVerdict: "pass" }),
        mediaType: "application/json",
        fileName: "BOARD-01-record.json"
      }
    ],
    ["artifact-physical-sources", { body: "zip-source-fixture", mediaType: "application/zip", fileName: "BOARD-01-sources.zip" }]
  ]);

  await page.context().route("**/downloads/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1) ?? "bundle.zip";
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      headers: { "Content-Disposition": `attachment; filename="${name}"` },
      body: "browser-zip-fixture"
    });
  });

  await page.context().route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method === "GET" && path === "/api/v1/projects") {
      return json(route, { projects: hasProject ? [project] : [] });
    }
    if (method === "POST" && path === "/api/v1/projects") {
      hasProject = true;
      project = { ...project, runIds: [] };
      return json(route, { project, stateRevision: 4 });
    }
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/runs`) {
      project = { ...project, runIds: [RUN_ID] };
      run = {
        ...run,
        state: "waiting_requirements_approval",
        attempts: snapshot.run.attempts,
        requirements,
        headRevisionId: undefined
      } as DesignRun;
      return json(route, status());
    }
    if (method === "GET" && path === `/api/v1/runs/${RUN_ID}`) return json(route, status());
    if (method === "GET" && path === `/api/v1/runs/${RUN_ID}/requirements`) {
      return json(route, { requirements });
    }
    if (method === "GET" && path === `/api/v1/runs/${RUN_ID}/artifacts`) {
      const requested = url.searchParams.get("includeStale") === "true"
        ? artifacts
        : artifacts.filter((artifact) => artifact.staleAt === undefined);
      return json(route, { artifacts: requested });
    }
    if (method === "GET" && path === `/api/v1/runs/${RUN_ID}/evidence`) {
      const requested = url.searchParams.get("includeStale") === "true"
        ? evidence
        : evidence.filter((record) => record.staleAt === undefined);
      return json(route, {
        evidence: requested,
        evidenceRoot: {
          algorithm: "sha256",
          digest: EVIDENCE_ROOT_DIGEST,
          schemaVersion: "evleda.evidence-root.v1",
          canonicalizationVersion: "evleda-c14n-json-v1"
        }
      });
    }
    if (method === "GET" && path === `/api/v1/runs/${RUN_ID}/engineering-practices`) {
      const findingCursor = url.searchParams.get("findingCursor");
      const paginatedBlocked = scenario === "blocked";
      return json(
        route,
        makeEngineeringInspection({
          projectId: PROJECT_ID,
          runId: RUN_ID,
          revisionId: run.headRevisionId ?? null,
          isHeadRevision: run.headRevisionId !== undefined,
          disposition: run.state === "completed" ? "PROVISIONAL_POC" : "BLOCKED_DIAGNOSTIC",
          nativeDrcStatus: run.headRevisionId ? "PASS" : "NOT_RUN",
          practiceStatus: run.state === "completed" ? "PASS" : run.headRevisionId ? "FAIL" : "NOT_RUN",
          ...(paginatedBlocked
            ? {
                findings: [engineeringFinding(findingCursor ? "finding-route-style-2" : "finding-route-style-1")],
                ruleFindingIds: ["finding-route-style-1", "finding-route-style-2"],
                findingsTotal: 2,
                nextCursor: findingCursor ? null : "cursor-route-page-2",
                pageIdentityCharacter: findingCursor ? "e" : "f"
              }
            : {})
        })
      );
    }
    if (method === "POST" && path === `/api/v1/runs/${RUN_ID}/requirements/approval`) {
      capture.requirementsCredential = request.headers()["x-evleda-human-credential"];
      capture.requirementsBody = request.postData() ?? "";
      requirements = { ...requirements, approvalId: "approval-browser-requirements" };
      run = { ...run, state: "queued", requirements, revision: (run.revision ?? 0) + 1 };
      return json(route, status());
    }
    if (method === "POST" && path === `/api/v1/runs/${RUN_ID}/resume`) {
      if (failFirstResume) {
        failFirstResume = false;
        return json(route, { message: "The server rejected the first resume request; refresh and retry." }, 409);
      }
      const nextAttempts = {
        ...run.attempts,
        component_selection: [
          {
            ...run.attempts.component_selection?.at(-1)!,
            state: "running" as const,
            blockers: []
          }
        ]
      };
      run = { ...run, state: "running", attempts: nextAttempts, revision: (run.revision ?? 0) + 1 };
      return json(route, status());
    }
    if (method === "POST" && path === `/api/v1/revisions/${HEAD_REVISION_ID}/qualification`) {
      capture.qualificationCredential = request.headers()["x-evleda-human-credential"];
      capture.qualificationBody = request.postData() ?? "";
      qualified = true;
      run = { ...run, revision: (run.revision ?? 0) + 1 };
      return json(route, {
        approval: { id: "approval-browser-qualification" },
        effectiveLifecycle: "qualified",
        stateRevision: run.revision
      });
    }
    if (
      method === "POST" &&
      (path === `/api/v1/revisions/${HEAD_REVISION_ID}/exports/candidate` ||
        path === `/api/v1/revisions/${HEAD_REVISION_ID}/exports/prototype`)
    ) {
      const kind = path.endsWith("prototype") ? "prototype" : "candidate";
      return json(route, { downloadUrl: `/downloads/evleda-browser-${kind}.zip` });
    }
    const contentMatch = /^\/api\/v1\/artifacts\/([^/]+)\/content$/u.exec(path);
    if (method === "GET" && contentMatch?.[1]) {
      const item = content.get(decodeURIComponent(contentMatch[1]));
      if (!item) return json(route, { message: "Artifact content not found" }, 404);
      return route.fulfill({
        status: 200,
        contentType: item.mediaType,
        headers: {
          "Content-Disposition": `attachment; filename="${item.fileName}"`,
          ETag: `"sha256:${artifacts.find((artifact) => artifact.id === decodeURIComponent(contentMatch[1]!))?.blob.digest ?? "missing"}"`
        },
        body: item.body
      });
    }
    return json(route, { message: `Unhandled browser fixture route: ${method} ${path}` }, 500);
  });

  return capture;
}

test("intake and requirements approval bind a transient role credential", async ({ page }) => {
  const capture = await installApiFixture(page, "empty");
  await page.goto("/");

  await expect(page.getByText("No local projects")).toBeVisible();
  await page.getByLabel("Project name").fill("Browser controller");
  await page.getByLabel("Controller design brief").fill(
    "Input 12 V DC; one guarded motor load; USB debug; safe disable; board below 80 mm."
  );
  await page.getByRole("button", { name: "Create project + start run" }).click();
  await expect(page.getByRole("heading", { name: "Requirements gate" })).toBeVisible();

  await page.getByLabel("Review rationale").fill(
    "Electrical limits, exclusions, safe states, and acceptance criteria were reviewed."
  );
  await page.getByRole("checkbox", { name: /I am a human requirements reviewer/i }).check();
  await page.getByLabel("Requirements review credential").fill("requirements-secret-browser");
  await page.getByRole("button", { name: "Approve this requirements digest" }).click();

  await expect(page.getByText(/Human requirements approval was bound/i)).toBeVisible();
  expect(capture.requirementsCredential).toBe("requirements-secret-browser");
  expect(capture.requirementsBody).not.toContain("requirements-secret-browser");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("a blocked run exposes exact recovery and resumes only after a successful server response", async ({ page }) => {
  await installApiFixture(page, "blocked");
  await page.goto("/");

  await expect(page.getByText("PINNED_FOOTPRINT_UNAVAILABLE")).toBeVisible();
  await expect(page.getByText(/Approve a pinned symbol\/footprint pair/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Engineering practice" })).toBeVisible();
  const nativeDrc = page.locator("section.engineering-check-card").filter({
    has: page.getByRole("heading", { name: "Native DRC" })
  });
  const evledaPractice = page.locator("section.engineering-check-card").filter({
    has: page.getByRole("heading", { name: "EvlEDA Practice" })
  });
  await expect(nativeDrc.getByText("PASS", { exact: true })).toBeVisible();
  await expect(evledaPractice.getByText("FAIL", { exact: true })).toBeVisible();
  await page.getByText("finding-route-style-1", { exact: true }).click();
  await expect(page.getByText("design/robotics-controller.kicad_pcb")).toBeVisible();
  await expect(page.getByText(/Create a new routed revision/i)).toBeVisible();
  await expect(page.getByRole("link", { name: /EvlEDA PCB Route Quality Policy v1/i })).toHaveCount(0);
  await expect(page.getByText(/Embedded internal product-policy provenance/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /JLCPCB PCB Manufacturing Capabilities/i }).first()
  ).toHaveAttribute("href", "https://jlcpcb.com/capabilities/Capabilities");
  await page.getByRole("button", { name: "Resume run" }).click();
  const error = page.getByRole("alert");
  await expect(error).toContainText("server rejected the first resume request");
  await page.getByRole("button", { name: "Refresh from API" }).click();
  await page.getByRole("button", { name: "Resume run" }).click();

  await expect(page.getByText(/persisted run was asked to resume/i)).toBeVisible();
  await expect(page.getByText(/No blocker recorded for Component selection/i)).toBeVisible();
});

test("artifact, evidence, qualification, candidate, and prototype controls remain evidence-bound", async ({ page }) => {
  const capture = await installApiFixture(page, "completed-physical");
  await page.goto("/");

  await expect(page.getByText("superseded-inspection.json")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Include stale records returned by the API" }).check();
  await expect(page.getByText("superseded-inspection.json")).toBeVisible();
  await page.getByRole("button", { name: "browser-inspection.json" }).click();
  await page.getByRole("button", { name: "Preview content" }).click();
  await expect(page.getByLabel("json artifact preview")).toContainText('"manufacturingRelease": false');

  await expect(page.getByRole("link", { name: "Download original" })).toHaveAttribute(
    "href",
    "/api/v1/artifacts/artifact-browser-preview/content"
  );

  await page.getByRole("button", { name: /Evidence 2/i }).click();
  await page.getByRole("checkbox", { name: "Show records from all nine stages" }).check();
  await page.getByRole("button", { name: /Candidate-only passing physical-v2/i }).click();
  await expect(
    page.getByRole("article", { name: /Candidate-only passing physical-v2/i }).getByText("human physical", { exact: true })
  ).toBeVisible();
  await expect(page.getByText(new Date("2099-01-01T00:00:00.000Z").toLocaleString())).toBeVisible();

  await expect(page.getByText(/Not human-qualified\. Not for manufacturing/i)).toBeVisible();
  await expect(page.getByText("PROVISIONAL_POC", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Native DRC" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "EvlEDA Practice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Review advisories" })).toBeVisible();
  await expect(page.getByText(/candidate-only proof-of-concept eligibility/i)).toBeVisible();
  await expect(page.getByText(/evleda\.human-physical-evidence\.v2/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export prototype bundle" })).toBeDisabled();
  const candidateDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export candidate bundle" }).click();
  expect((await candidateDownload).suggestedFilename()).toBe(
    `evleda-${HEAD_REVISION_ID}-candidate.zip`
  );

  await page.getByText("Record exact hardware qualification").click();
  await page.getByLabel("Evidence and physical review rationale").fill(
    "All seven physical categories, linked sources, and exact evidence identities were reviewed."
  );
  await page.getByLabel("Hardware qualification credential").fill("qualification-secret-browser");
  await page.getByRole("checkbox", { name: /I am the human hardware qualifier/i }).check();
  await page.getByRole("button", { name: "Record exact qualification" }).click();

  await expect(page.getByText("Exact human qualification is active")).toBeVisible();
  expect(capture.qualificationCredential).toBe("qualification-secret-browser");
  expect(capture.qualificationBody).not.toContain("qualification-secret-browser");
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);

  const prototypeButton = page.getByRole("button", { name: "Export prototype bundle" });
  await expect(prototypeButton).toBeEnabled();
  const prototypeDownload = page.waitForEvent("download");
  await prototypeButton.click();
  expect((await prototypeDownload).suggestedFilename()).toBe(
    `evleda-${HEAD_REVISION_ID}-prototype.zip`
  );

  const body = (await page.locator("body").innerText()).toLocaleLowerCase("en-US");
  expect(body).not.toMatch(/release ready|production ready|manufacturing ready/u);
  expect(body).toContain("does not authorize production or manufacturing release");
});

test("engineering findings paginate against one snapshot without widening a 360px document", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await installApiFixture(page, "blocked");
  await page.goto("/");

  await expect(page.getByText("finding-route-style-1", { exact: true })).toBeVisible();
  const loadMore = page.getByRole("button", { name: "Load more findings" });
  await loadMore.focus();
  await loadMore.click();
  await expect(page.getByText("finding-route-style-2", { exact: true })).toBeVisible();
  await expect(page.getByText("2 of 2 findings loaded.")).toBeVisible();
  const allLoaded = page.getByRole("button", { name: "All findings loaded" });
  await expect(allLoaded).toBeDisabled();
  await expect(
    page.locator("summary[data-engineering-finding-summary]").filter({ hasText: "finding-route-style-2" })
  ).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("keyboard focus and narrow-screen reflow remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await installApiFixture(page, "empty");
  await page.goto("/");

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to commissioning bench" })).toBeFocused();
  await page.getByLabel("Project name").focus();
  await page.keyboard.press("Enter");
  const error = page.getByRole("alert");
  await expect(error).toHaveText(/job description needs attention/i);
  await expect(error).toBeFocused();

  await page.getByRole("button", { name: "Load bench example" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Controller design brief")).toBeFocused();

  const intake = await page.locator(".intake-panel").boundingBox();
  const center = await page.locator(".center-bay").boundingBox();
  expect(intake).not.toBeNull();
  expect(center).not.toBeNull();
  expect(Math.abs((intake?.x ?? 0) - (center?.x ?? 0))).toBeLessThan(2);
  expect((center?.y ?? 0)).toBeGreaterThan((intake?.y ?? 0));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const body = (await page.locator("body").innerText()).toLocaleLowerCase("en-US");
  expect(body).toContain("not for manufacturing");
  expect(body).not.toMatch(/release ready|production ready|manufacturing ready/u);
});
