// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiResponseError,
  ApiUnavailableError,
  api,
  artifactPreviewPolicy,
  isApiUnavailable
} from "./api";
import type { ArtifactRecord } from "./model";
import { makeEngineeringInspection } from "./testing/engineeringFixture";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const jsonResponse = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });

describe("EvlEDA API client", () => {
  it("uses the canonical project and run routes", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { projects: [] } }))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            project: { id: "project-1", name: "Drive", runIds: [], revision: 3 },
            stateRevision: 7
          }
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          result: {
            stateRevision: 8,
            effectiveLifecycle: "qualified",
            activeAttestations: [
              {
                kind: "qualification",
                designRevisionId: "revision-1",
                subjectDigest: "d".repeat(64),
                evidenceRootDigest: "e".repeat(64)
              }
            ],
            headRevision: {
              id: "revision-1",
              projectId: "project-1",
              runId: "run-1",
              lifecycle: "candidate",
              manifest: {
                algorithm: "sha256",
                digest: "d".repeat(64),
                schemaVersion: "evleda.design-revision.v1",
                canonicalizationVersion: "evleda-c14n-json-v1"
              }
            },
            run: {
              id: "run-1",
              projectId: "project-1",
              state: "queued",
              lifecycle: "candidate",
              attempts: {},
              createdAt: "2026-09-03T00:00:00Z",
              updatedAt: "2026-09-03T00:00:00Z"
            }
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await api.listProjects();
    const creation = await api.createProject(
      "Drive",
      "A sufficiently detailed local controller description."
    );
    const started = await api.startRun(
      "project-1",
      "A sufficiently detailed local controller description.",
      creation.project.revision ?? creation.stateRevision
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/projects");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/projects");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/projects/project-1/runs");
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toMatch(
      /^create-project-/u
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).not.toHaveProperty(
      "idempotencyKey"
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(
      expect.objectContaining({ expectedRevision: 3, configuration: {} })
    );
    expect(started.effectiveLifecycle).toBe("qualified");
    expect(started.headRevision?.manifest.digest).toBe("d".repeat(64));
    expect(started.activeAttestations[0]?.kind).toBe("qualification");
  });

  it("falls back only for network failure or an explicit 503", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError("connection refused"))
      .mockResolvedValueOnce(jsonResponse({ message: "daemon unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ message: "policy denied" }, 500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listProjects()).rejects.toBeInstanceOf(ApiUnavailableError);
    await expect(api.listProjects()).rejects.toSatisfy(isApiUnavailable);
    await expect(api.listProjects()).rejects.toBeInstanceOf(ApiResponseError);
  });

  it("maps inspection, recovery, generation, and export calls to the stable v1 routes", async () => {
    const runResult = {
      stateRevision: 12,
      run: {
        id: "run-1",
        projectId: "project-1",
        state: "blocked",
        lifecycle: "candidate",
        attempts: {},
        headRevisionId: "revision-1",
        createdAt: "2026-09-03T00:00:00Z",
        updatedAt: "2026-09-03T00:00:00Z"
      }
    };
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async (input) => {
        const path = String(input);
        if (path.endsWith("/requirements")) {
          return jsonResponse({ ok: true, result: { requirements: { requirements: [] } } });
        }
        if (path.endsWith("/artifacts")) {
          return jsonResponse({ ok: true, result: { artifacts: [] } });
        }
        if (path.includes("/evidence")) {
          return jsonResponse({
            ok: true,
            result: {
              evidence: [],
              evidenceRoot: { algorithm: "sha256", digest: "c".repeat(64) }
            }
          });
        }
        if (path.includes("/exports/")) {
          return jsonResponse({ ok: true, result: { message: "Bundle prepared." } });
        }
        if (path.includes("/generations/")) {
          return jsonResponse({ ok: true, result: { artifact: {} } });
        }
        return jsonResponse({ ok: true, result: runResult });
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getRunStatus("run-1");
    await api.getRequirements("run-1");
    await api.listArtifacts("run-1");
    const evidenceInspection = await api.inspectEvidence("run-1", "revision-1");
    await api.approveRequirements(
      "run-1",
      {
        rationale: "The exact source limits and exclusions were reviewed.",
        subjectDigest: "a".repeat(64),
        capabilityToken: "test-human-capability-token"
      },
      12
    );
    await api.resumeRun("run-1", 12);
    await api.rerunStage("run-1", "component_selection", 12);
    await api.qualifyRevision(
      "revision-1",
      "a".repeat(64),
      "b".repeat(64),
      {
        scope: "One controlled prototype build",
        rationale: "Physical measurements and exact evidence bindings were reviewed.",
        capabilityToken: "test-qualification-capability-token"
      },
      12
    );
    await api.exportCandidate("revision-1", 12);
    await api.exportPrototype("revision-1", 12);
    await api.generateBringupPlan("revision-1", 12);
    await api.generateFirmwareScaffold("revision-1", 12);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/runs/run-1",
      "/api/v1/runs/run-1/requirements",
      "/api/v1/runs/run-1/artifacts",
      "/api/v1/runs/run-1/evidence?revisionId=revision-1",
      "/api/v1/runs/run-1/requirements/approval",
      "/api/v1/runs/run-1/resume",
      "/api/v1/runs/run-1/stages/component_selection/rerun",
      "/api/v1/revisions/revision-1/qualification",
      "/api/v1/revisions/revision-1/exports/candidate",
      "/api/v1/revisions/revision-1/exports/prototype",
      "/api/v1/revisions/revision-1/generations/bringup-plan",
      "/api/v1/revisions/revision-1/generations/firmware-scaffold"
    ]);
    expect(evidenceInspection.evidenceRootDigest).toBe("c".repeat(64));
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual(
      expect.objectContaining({
        requirementsDigest: "a".repeat(64),
        expectedRevision: 12
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).not.toHaveProperty("actor");
    expect(JSON.parse(String(fetchMock.mock.calls[7]?.[1]?.body))).not.toHaveProperty("actor");
    expect(
      new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get(
        "X-EvlEDA-Human-Credential"
      )
    ).toBe("test-human-capability-token");
    expect(
      new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get(
        "X-EvlEDA-Human-Approval-Token"
      )
    ).toBeNull();
    expect(
      new Headers(fetchMock.mock.calls[7]?.[1]?.headers).get(
        "X-EvlEDA-Human-Credential"
      )
    ).toBe("test-qualification-capability-token");
    expect(
      new Headers(fetchMock.mock.calls[5]?.[1]?.headers).get(
        "X-EvlEDA-Human-Credential"
      )
    ).toBeNull();
    for (const call of fetchMock.mock.calls.slice(4)) {
      const key = new Headers(call[1]?.headers).get("Idempotency-Key");
      expect(key?.length).toBeGreaterThanOrEqual(16);
      expect(key?.length).toBeLessThanOrEqual(128);
      expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty("idempotencyKey");
    }
  });

  it("decodes an envelope-bound base64 bundle into a browser download", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({
          ok: true,
          operation: "export_candidate_bundle",
          requestId: "request-1",
          result: {
            fileName: "candidate-review.zip",
            mediaType: "application/zip",
            bytesBase64: btoa("zip-bytes")
          }
        })
      );
    const createObjectUrl = vi.fn(() => "blob:evleda-candidate");
    const revokeObjectUrl = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: createObjectUrl,
      revokeObjectURL: revokeObjectUrl
    });

    const receipt = await api.exportCandidate("revision-1", 12);

    expect(receipt).toEqual({
      fileName: "candidate-review.zip",
      message: "candidate-review.zip downloaded."
    });
    expect(createObjectUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:evleda-candidate");
  });

  it("requests stale records only when explicitly included", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ ok: true, result: { artifacts: [], evidence: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.listArtifacts("run-1", { revisionId: "revision-1", includeStale: true });
    await api.inspectEvidence("run-1", "revision-1", true);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/runs/run-1/artifacts?revisionId=revision-1&includeStale=true",
      "/api/v1/runs/run-1/evidence?revisionId=revision-1&includeStale=true"
    ]);
  });

  it("reads the exact revision-bound engineering inspection with a stable findings cursor", async () => {
    const inspection = makeEngineeringInspection({
      projectId: "project-1",
      runId: "run-1",
      revisionId: "revision-1",
      findingsTotal: 101,
      nextCursor: "cursor-page-2"
    });
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(jsonResponse({ ok: true, result: inspection }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.inspectEngineeringPractices("run-1", {
      revisionId: "revision-1",
      findingCursor: "cursor-page-1",
      findingLimit: 50
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/runs/run-1/engineering-practices?revisionId=revision-1&findingCursor=cursor-page-1&findingLimit=50",
      expect.objectContaining({ headers: expect.any(Object) })
    );
    expect(result.schemaVersion).toBe("evleda.engineering-practice-inspection.v1");
    expect(result.checks.nativeDrc.evidenceClass).toBe("kicad_native");
    expect(result.checks.evledaPractice.evidenceClass).toBe("evleda_check");
    expect(result.findings.nextCursor).toBe("cursor-page-2");
    expect(result.sources.find((source) => source.authority === "internal_policy")).toMatchObject({
      sourceId: "evleda-route-quality-policy",
      url: null,
      accessScope: "embedded_snapshot",
      normativeStatus: "internal_product_policy",
      captureComplete: true
    });
  });

  it("rejects malformed or non-HTTPS engineering projections instead of inventing an empty result", async () => {
    const inspection = makeEngineeringInspection();
    const wrongAuthority = {
      ...inspection,
      checks: {
        ...inspection.checks,
        nativeDrc: { ...inspection.checks.nativeDrc, evidenceClass: "agent_claim" }
      }
    };
    const unsafeSource = {
      ...inspection,
      sources: [{ ...inspection.sources[0]!, url: "http://example.com/not-immutable" }]
    };
    const missingExternalUrl = {
      ...inspection,
      sources: inspection.sources.map((source) =>
        source.authority === "fabricator" ? { ...source, url: null } : source
      )
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ result: wrongAuthority }))
      .mockResolvedValueOnce(jsonResponse({ result: unsafeSource }))
      .mockResolvedValueOnce(jsonResponse({ result: missingExternalUrl }))
      .mockResolvedValueOnce(jsonResponse({ message: "Engineering route missing" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.inspectEngineeringPractices("run-1")).rejects.toThrow(
      /checks\.nativeDrc\.evidenceClass/i
    );
    await expect(api.inspectEngineeringPractices("run-1")).rejects.toThrow(/sources\[0\]\.url/i);
    await expect(api.inspectEngineeringPractices("run-1")).rejects.toThrow(/sources\[1\]\.url/i);
    await expect(api.inspectEngineeringPractices("run-1")).rejects.toMatchObject({ status: 404 });
  });

  it("previews only exact bounded UTF-8 JSON and rejects unsafe media without fetching", async () => {
    const bytes = JSON.stringify({ status: "candidate", manufacturingRelease: false });
    const artifact: ArtifactRecord = {
      id: "artifact-json",
      projectId: "project-1",
      runId: "run-1",
      designRevisionId: "revision-1",
      stage: "requirements",
      logicalName: "record.json",
      mediaType: "application/json",
      blob: { algorithm: "sha256", digest: "a".repeat(64), size: new TextEncoder().encode(bytes).byteLength },
      exactInputs: [],
      derivedFrom: [],
      tool: { name: "fixture", version: "1", adapter: "test" },
      validationStatus: "pass",
      unresolvedAssumptions: [],
      lifecycle: "candidate",
      createdAt: "2026-09-04T00:00:00.000Z"
    };
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: `"sha256:${artifact.blob.digest}"`
          }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const preview = await api.previewArtifact(artifact);
    expect(preview).toMatchObject({ kind: "json", size: artifact.blob.size });
    expect(preview.kind === "json" ? preview.text : "").toContain('"manufacturingRelease": false');

    const unsafe = { ...artifact, mediaType: "image/svg+xml" };
    expect(artifactPreviewPolicy(unsafe)).toMatchObject({ previewable: false });
    await expect(api.previewArtifact(unsafe)).rejects.toThrow(/approved text, JSON, and raster-image/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
