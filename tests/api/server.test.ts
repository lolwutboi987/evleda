import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_OPERATION_ROUTES,
  buildApiServer,
  createHumanCredentialBindings,
  HUMAN_CREDENTIAL_HEADER,
  loadHumanCredentialBindingsFromEnvironment,
  type HumanCredentialBindings
} from "../../src/api/server.js";
import { OPERATION_NAMES } from "../../src/contracts/operations.js";
import { externalEvidenceResultSchema } from "../../src/contracts/results.js";
import { canonicalJson, contentIdentity } from "../../src/core/canonical.js";
import type { HumanActor } from "../../src/domain/types.js";
import {
  createCompletedRun,
  disposeApplicationRoots,
  makeApplication,
  physicalEvidenceInput,
  qualifier,
  reviewer,
  validPrompt
} from "../application/helpers.js";

afterEach(disposeApplicationRoots);

const headers = {
  host: "localhost:8765",
  origin: "http://localhost:8765"
};

const releaseAuthority: HumanActor = {
  type: "human",
  id: "release-1",
  displayName: "Release Authority",
  role: "release_authority"
};

const strongCredential = (label: string): string =>
  createHash("sha256").update(`evleda-api-test:${label}`, "utf8").digest("base64url");

const requirementsCredential = strongCredential("requirements");
const hardwareCredential = strongCredential("hardware");
const releaseCredential = strongCredential("release");

const humanCredentials = () => createHumanCredentialBindings({
  requirements_approval: { credential: requirementsCredential, actor: reviewer },
  hardware_qualification: { credential: hardwareCredential, actor: qualifier },
  manufacturing_release: { credential: releaseCredential, actor: releaseAuthority }
});

const credentialHeaders = (credential: string, idempotencyKey: string) => ({
  ...headers,
  "idempotency-key": idempotencyKey,
  [HUMAN_CREDENTIAL_HEADER]: credential
});

describe("human credential configuration", () => {
  it("loads immutable role actors, removes raw secrets, and retains no plaintext", () => {
    const environment: NodeJS.ProcessEnv = {
      EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL: requirementsCredential,
      EVLEDA_REQUIREMENTS_REVIEW_ACTOR_ID: "configured-reviewer",
      EVLEDA_REQUIREMENTS_REVIEW_ACTOR_DISPLAY_NAME: "Configured Reviewer",
      EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL: hardwareCredential,
      EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL: releaseCredential
    };

    const configured = loadHumanCredentialBindingsFromEnvironment(environment);

    expect(environment.EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL).toBeUndefined();
    expect(environment.EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL).toBeUndefined();
    expect(environment.EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL).toBeUndefined();
    expect(configured.requirements_approval?.actor).toEqual({
      type: "human",
      id: "configured-reviewer",
      displayName: "Configured Reviewer",
      role: "requirements_reviewer"
    });
    expect(Object.isFrozen(configured)).toBe(true);
    expect(Object.isFrozen(configured.requirements_approval)).toBe(true);
    expect(Object.isFrozen(configured.requirements_approval?.actor)).toBe(true);
    const retained = JSON.stringify(configured);
    expect(retained).not.toContain(requirementsCredential);
    expect(retained).not.toContain(hardwareCredential);
    expect(retained).not.toContain(releaseCredential);
  });

  it("allows absent roles for candidate-only operation but rejects incomplete role setup", () => {
    expect(loadHumanCredentialBindingsFromEnvironment({})).toEqual({});
    expect(() => loadHumanCredentialBindingsFromEnvironment({
      EVLEDA_REQUIREMENTS_REVIEW_ACTOR_ID: "reviewer-without-credential"
    })).toThrow(/require EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL/u);
  });

  it.each([
    ["empty", ""],
    ["too short", "weak-local-token"],
    ["low diversity", "A".repeat(43)]
  ])("rejects %s credentials without retaining or disclosing them", (_label, weakCredential) => {
    const environment: NodeJS.ProcessEnv = {
      EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL: weakCredential
    };
    let thrown: unknown;
    try {
      loadHumanCredentialBindingsFromEnvironment(environment);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(environment.EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL).toBeUndefined();
    expect(String(thrown)).not.toContain(weakCredential || "<empty>");
  });

  it("rejects credentials reused across roles and removes every raw value first", () => {
    const environment: NodeJS.ProcessEnv = {
      EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL: requirementsCredential,
      EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL: requirementsCredential
    };
    expect(() => loadHumanCredentialBindingsFromEnvironment(environment)).toThrow(
      /must be distinct across roles/u
    );
    expect(environment.EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL).toBeUndefined();
    expect(environment.EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL).toBeUndefined();
  });

  it("rejects and deletes the disabled legacy shared token", () => {
    const environment: NodeJS.ProcessEnv = {
      EVLEDA_HUMAN_APPROVAL_TOKEN: requirementsCredential
    };
    expect(() => loadHumanCredentialBindingsFromEnvironment(environment)).toThrow(
      /is no longer accepted/u
    );
    expect(environment.EVLEDA_HUMAN_APPROVAL_TOKEN).toBeUndefined();
  });

  it("requires embedders to use the raw-secret constructor and rejects forged hashes", async () => {
    expect(() => createHumanCredentialBindings({
      requirements_approval: { credential: "embedder-password", actor: reviewer }
    })).toThrow(/credential must be/u);

    const forged = {
      requirements_approval: {
        credentialDigest: createHash("sha256").update("embedder-password").digest("hex"),
        actor: reviewer
      }
    } as HumanCredentialBindings;
    await expect(buildApiServer({
      service: await makeApplication(),
      humanCredentials: forged
    })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
      message: "humanCredentials must be created by createHumanCredentialBindings"
    });

    const copied = { ...humanCredentials() } as HumanCredentialBindings;
    await expect(buildApiServer({
      service: await makeApplication(),
      humanCredentials: copied
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});

describe("REST /api/v1 transport", () => {
  it("registers every public operation exactly once", () => {
    expect(API_OPERATION_ROUTES.map((entry) => entry[2])).toEqual(OPERATION_NAMES);
    expect(new Set(API_OPERATION_ROUTES.map((entry) => `${entry[0]} ${entry[1]}`)).size).toBe(14);
  });

  it.each(["artifacts", "evidence"] as const)(
    "accepts only explicit boolean includeStale values for %s queries",
    async (resource) => {
      const service = await makeApplication();
      const project = await service.createProject({
        name: `REST ${resource} query`,
        idempotencyKey: `rest-${resource}-query-project`
      });
      const started = await service.startDesignRun({
        projectId: project.project.id,
        prompt: validPrompt,
        configuration: {},
        expectedRevision: project.project.revision,
        idempotencyKey: `rest-${resource}-query-run-0001`
      });
      const app = await buildApiServer({ service });
      try {
        for (const value of [undefined, "true", "false"] as const) {
          const suffix = value === undefined ? "" : `?includeStale=${value}`;
          const accepted = await app.inject({
            method: "GET",
            url: `/api/v1/runs/${started.run.id}/${resource}${suffix}`,
            headers
          });
          expect(accepted.statusCode).toBe(200);
          expect(accepted.json()).toMatchObject({
            ok: true,
            operation: resource === "artifacts" ? "list_artifacts" : "inspect_evidence"
          });
        }

        for (const value of ["", "0", "1", "TRUE", "False", "null", "true&includeStale=false"]) {
          const rejected = await app.inject({
            method: "GET",
            url: `/api/v1/runs/${started.run.id}/${resource}?includeStale=${value}`,
            headers
          });
          expect(rejected.statusCode).toBe(400);
          expect(rejected.json()).toMatchObject({
            ok: false,
            error: {
              code: "INVALID_ARGUMENT",
              message: "includeStale must be exactly true or false",
              retryable: false,
              details: {
                parameter: "includeStale",
                acceptedValues: ["true", "false"]
              }
            }
          });
        }
      } finally {
        await app.close();
      }
    }
  );

  it("exposes honest engineering NOT_RUN state and parses findingLimit exactly", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "REST engineering inspection",
      idempotencyKey: "rest-engineering-project-0001"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "rest-engineering-run-000001"
    });
    const app = await buildApiServer({ service });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${started.run.id}/engineering-practices?findingLimit=1`,
        headers
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        operation: "inspect_engineering_practices",
        result: {
          revisionId: null,
          disposition: { status: "BLOCKED_DIAGNOSTIC" },
          checks: {
            nativeDrc: { machineStatus: "NOT_RUN" },
            evledaPractice: { machineStatus: "NOT_RUN" }
          }
        }
      });

      for (const value of ["0", "-1", "1.0", "01", "+1", "1e2", "101"]) {
        const rejected = await app.inject({
          method: "GET",
          url: `/api/v1/runs/${started.run.id}/engineering-practices?findingLimit=${encodeURIComponent(value)}`,
          headers
        });
        expect(rejected.statusCode, value).toBe(400);
        expect(rejected.json(), value).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT" }
        });
      }
      const misspelled = await app.inject({
        method: "GET",
        url: `/api/v1/runs/${started.run.id}/engineering-practices?findingLimt=10`,
        headers
      });
      expect(misspelled.statusCode).toBe(400);
      expect(misspelled.json()).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_ARGUMENT",
          details: {
            unknownParameters: ["findingLimt"],
            allowedParameters: ["revisionId", "findingCursor", "findingLimit"]
          }
        }
      });
    } finally {
      await app.close();
    }
  });

  it("rejects untrusted Host and exact cross-origin requests without CORS", async () => {
    const app = await buildApiServer({ service: await makeApplication() });
    const badHost = await app.inject({ method: "GET", url: "/api/v1/health", headers: { host: "evil.test" } });
    expect(badHost.statusCode).toBe(403);
    const badOrigin = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { host: "localhost:8765", origin: "http://localhost:9999" }
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("denies approval without a configured human credential with zero run mutation", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "REST Policy",
      idempotencyKey: "rest-create-policy"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "rest-start-policy-1"
    });
    const requirements = await service.inspectRequirements({ runId: started.run.id });
    const app = await buildApiServer({ service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${started.run.id}/requirements/approval`,
      headers: { ...headers, "idempotency-key": "rest-approve-policy" },
      payload: {
        requirementsDigest: requirements.requirementsDigest,
        actor: reviewer,
        rationale: "Reviewed.",
        expectedRevision: started.run.revision
      }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "CAPABILITY_REQUIRED" } });
    expect((await service.getRunStatus({ runId: started.run.id })).run.revision).toBe(0);
    await app.close();
  });

  it("injects the credential-bound reviewer and accepts only the matching role credential", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "REST Trusted",
      idempotencyKey: "rest-create-trusted"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "rest-start-trusted"
    });
    const requirements = await service.inspectRequirements({ runId: started.run.id });
    const app = await buildApiServer({
      service,
      humanCredentials: humanCredentials()
    });
    const payload = {
      requirementsDigest: requirements.requirementsDigest,
      rationale: "Reviewed.",
      expectedRevision: started.run.revision
    };
    for (const [idempotencyKey, credential] of [
      ["rest-approve-missing-0001", undefined],
      ["rest-approve-empty-000001", ""]
    ] as const) {
      const missing = await app.inject({
        method: "POST",
        url: `/api/v1/runs/${started.run.id}/requirements/approval`,
        headers: {
          ...headers,
          "idempotency-key": idempotencyKey,
          ...(credential === undefined ? {} : { [HUMAN_CREDENTIAL_HEADER]: credential })
        },
        payload
      });
      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_REQUIRED" }
      });
    }
    const wrong = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${started.run.id}/requirements/approval`,
      headers: {
        ...credentialHeaders(hardwareCredential, "rest-approve-wrong")
      },
      payload
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).not.toContain(hardwareCredential);
    expect((await service.getRunStatus({ runId: started.run.id })).run.revision).toBe(0);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${started.run.id}/requirements/approval`,
      headers: {
        ...credentialHeaders(requirementsCredential, "rest-approve-right")
      },
      payload
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      ok: true,
      operation: "approve_requirements",
      result: { run: { state: "queued" } }
    });
    expect(accepted.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    await app.close();
  });

  it("rejects cross-role credentials and body actor role or identity spoofing without mutation", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "REST Actor Binding",
      idempotencyKey: "rest-create-actor-binding"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "rest-start-actor-binding"
    });
    const requirements = await service.inspectRequirements({ runId: started.run.id });
    const app = await buildApiServer({ service, humanCredentials: humanCredentials() });
    const basePayload = {
      requirementsDigest: requirements.requirementsDigest,
      rationale: "The exact requirements were reviewed.",
      expectedRevision: started.run.revision
    };

    const attempts = [
      {
        credential: releaseCredential,
        key: "rest-cross-role-release-0001",
        payload: basePayload
      },
      {
        credential: requirementsCredential,
        key: "rest-spoof-role-0001",
        payload: { ...basePayload, actor: releaseAuthority }
      },
      {
        credential: requirementsCredential,
        key: "rest-spoof-id-0000001",
        payload: { ...basePayload, actor: { ...reviewer, id: "attacker-selected-id" } }
      }
    ];
    for (const attempt of attempts) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/runs/${started.run.id}/requirements/approval`,
        headers: credentialHeaders(attempt.credential, attempt.key),
        payload: attempt.payload
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_REQUIRED" }
      });
    }

    const legacyHeaderOnly = await app.inject({
      method: "POST",
      url: `/api/v1/runs/${started.run.id}/requirements/approval`,
      headers: {
        ...headers,
        "idempotency-key": "rest-legacy-header-0001",
        "x-evleda-human-approval-token": requirementsCredential
      },
      payload: basePayload
    });
    expect(legacyHeaderOnly.statusCode).toBe(403);
    expect(legacyHeaderOnly.body).not.toContain(requirementsCredential);
    expect((await service.getRunStatus({ runId: started.run.id })).run.revision).toBe(0);
    await app.close();
  });

  it("accepts strict physical evidence on the supplemental human route and rejects incomplete categories", async () => {
    const service = await makeApplication();
    const completed = await createCompletedRun(service);
    const input = await physicalEvidenceInput(
      service,
      completed.run.id,
      completed.headRevision!.id,
      completed.run.revision,
      "rest-physical-evidence-01",
      "REST-PHYSICAL-001"
    );
    const app = await buildApiServer({
      service,
      humanCredentials: humanCredentials()
    });
    const wrongRole = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/external-evidence`,
      headers: credentialHeaders(requirementsCredential, input.idempotencyKey),
      payload: input
    });
    expect(wrongRole.statusCode).toBe(403);
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      completed.run.revision
    );

    const declared = { algorithm: "sha256", digest: "0".repeat(64), size: 0 } as const;
    const legacyExploit = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/external-evidence`,
      headers: credentialHeaders(hardwareCredential, "rest-reject-legacy-physical-exploit"),
      payload: {
        boardSerial: "REST-SPOOF-001",
        assemblyBuild: declared,
        camBundle: declared,
        bom: declared,
        firmware: declared,
        procedure: declared,
        instruments: [{ id: "DMM-NOT-CALIBRATED", calibration: declared }],
        measurements: {},
        verdict: "pass",
        rationale: "A legacy caller-selected verdict must be rejected.",
        expectedRevision: completed.run.revision
      }
    });
    expect(legacyExploit.statusCode).toBe(400);
    expect(legacyExploit.json()).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENT" } });
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      completed.run.revision
    );

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/external-evidence`,
      headers: credentialHeaders(hardwareCredential, input.idempotencyKey),
      payload: input
    });
    expect(accepted.statusCode).toBe(200);
    const acceptedEnvelope = accepted.json();
    expect(acceptedEnvelope).toMatchObject({
      ok: true,
      operation: "submit_external_evidence",
      result: { overallVerdict: "pass" }
    });
    expect(externalEvidenceResultSchema.parse(acceptedEnvelope.result).overallVerdict).toBe("pass");

    const beforeRejected = await service.getRunStatus({ runId: completed.run.id });
    const incomplete = structuredClone(
      await physicalEvidenceInput(
        service,
        completed.run.id,
        completed.headRevision!.id,
        beforeRejected.run.revision,
        "rest-physical-evidence-02",
        "REST-PHYSICAL-002"
      )
    );
    const acceptanceRecord = JSON.parse(
      (await service.readArtifact(incomplete.artifactBindings.acceptance.artifactId)).bytes.toString("utf8")
    ) as {
      readonly tests: readonly { readonly caseId: string; readonly category: string }[];
    };
    const omittedSensorCases = new Set(
      acceptanceRecord.tests
        .filter((test) => test.category === "sensors")
        .map((test) => test.caseId)
    );
    const mutableIncomplete = incomplete as unknown as {
      sourceBlobs: Array<{
        role: string;
        identity: ReturnType<typeof contentIdentity>;
        bytesBase64: string;
      }>;
    };
    const measurementSource = mutableIncomplete.sourceBlobs.find(
      (source) => source.role === "parsed_measurement_record"
    )!;
    const measurementRecord = JSON.parse(
      Buffer.from(measurementSource.bytesBase64, "base64").toString("utf8")
    ) as { caseExecutions: Array<{ readonly caseId: string }> };
    measurementRecord.caseExecutions = measurementRecord.caseExecutions.filter(
      (execution) => !omittedSensorCases.has(execution.caseId)
    );
    const incompleteBytes = Buffer.from(`${canonicalJson(measurementRecord)}\n`, "utf8");
    measurementSource.identity = contentIdentity(incompleteBytes);
    measurementSource.bytesBase64 = incompleteBytes.toString("base64");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/external-evidence`,
      headers: credentialHeaders(hardwareCredential, incomplete.idempotencyKey),
      payload: incomplete
    });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "EVIDENCE_MISSING" } });
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      beforeRejected.run.revision
    );

    const afterPhysical = await service.getRunStatus({ runId: completed.run.id });
    const qualification = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/qualification`,
      headers: credentialHeaders(hardwareCredential, "rest-qualification-0001"),
      payload: {
        requirementsDigest: completed.run.requirements!.identity.digest,
        evidenceRootDigest: acceptedEnvelope.result.evidenceRoot.digest,
        scope: "one exact controlled prototype",
        rationale: "Physical observations and exact evidence bindings were independently reviewed.",
        expectedRevision: afterPhysical.run.revision
      }
    });
    expect(qualification.statusCode).toBe(200);
    const qualificationEnvelope = qualification.json();
    expect(qualificationEnvelope).toMatchObject({
      ok: true,
      operation: "qualify_revision",
      result: { approval: { actor: qualifier } }
    });

    const afterQualification = await service.getRunStatus({ runId: completed.run.id });
    const releasePayload = {
      subjectDigest: completed.headRevision!.manifest.digest,
      evidenceRootDigest: acceptedEnvelope.result.evidenceRoot.digest,
      qualificationApprovalId: qualificationEnvelope.result.approval.id,
      scope: "exact reference build only",
      rationale: "Independent manufacturing release review completed.",
      expectedRevision: afterQualification.run.revision
    };
    const wrongReleaseRole = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/manufacturing-release`,
      headers: credentialHeaders(hardwareCredential, "rest-release-wrong-role-0001"),
      payload: releasePayload
    });
    expect(wrongReleaseRole.statusCode).toBe(403);

    const release = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${completed.headRevision!.id}/manufacturing-release`,
      headers: credentialHeaders(releaseCredential, "rest-release-correct-0001"),
      payload: releasePayload
    });
    expect(release.statusCode).toBe(200);
    const releaseEnvelope = release.json();
    expect(releaseEnvelope).toMatchObject({
      ok: true,
      operation: "authorize_manufacturing_release",
      result: {
        effectiveLifecycle: "release_authorized",
        approval: { actor: releaseAuthority }
      }
    });

    const beforeRevocation = await service.getRunStatus({ runId: completed.run.id });
    const revokePayload = {
      reason: "The release fixture was withdrawn from service.",
      expectedRevision: beforeRevocation.run.revision
    };
    const wrongRevocationRole = await app.inject({
      method: "POST",
      url: `/api/v1/attestations/${releaseEnvelope.result.approval.id}/revocation`,
      headers: credentialHeaders(hardwareCredential, "rest-revoke-wrong-role-0001"),
      payload: revokePayload
    });
    expect(wrongRevocationRole.statusCode).toBe(403);
    expect((await service.getRunStatus({ runId: completed.run.id })).run.revision).toBe(
      beforeRevocation.run.revision
    );

    const revocation = await app.inject({
      method: "POST",
      url: `/api/v1/attestations/${releaseEnvelope.result.approval.id}/revocation`,
      headers: credentialHeaders(releaseCredential, "rest-revoke-correct-0001"),
      payload: revokePayload
    });
    expect(revocation.statusCode).toBe(200);
    expect(revocation.json()).toMatchObject({
      ok: true,
      operation: "revoke_attestation",
      result: { effectiveLifecycle: "qualified" }
    });
    await app.close();
  });

  it("returns 422 GATE_FAILED for candidate export of a partial run", async () => {
    const service = await makeApplication();
    const project = await service.createProject({
      name: "REST Partial",
      idempotencyKey: "rest-create-partial"
    });
    const started = await service.startDesignRun({
      projectId: project.project.id,
      prompt: validPrompt,
      configuration: {},
      expectedRevision: project.project.revision,
      idempotencyKey: "rest-start-partial-1"
    });
    const requirements = await service.inspectRequirements({ runId: started.run.id });
    const approved = await service.approveRequirements(
      {
        runId: started.run.id,
        requirementsDigest: requirements.requirementsDigest,
        actor: reviewer,
        rationale: "Reviewed.",
        scope: "exact requirements document",
        expectedRevision: started.run.revision,
        idempotencyKey: "rest-direct-approve"
      },
      {
        kind: "human",
        transport: "trusted_host",
        capability: "requirements_approval",
        actor: reviewer
      }
    );
    const app = await buildApiServer({ service });
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/revisions/${approved.headRevision!.id}/exports/candidate`,
      headers: { ...headers, "idempotency-key": "rest-partial-export" },
      payload: { expectedRevision: approved.run.revision }
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "GATE_FAILED" } });
    await app.close();
  });
});
