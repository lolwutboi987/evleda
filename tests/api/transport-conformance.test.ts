import { createHash } from "node:crypto";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationService } from "../../src/application/application-service.js";
import type { OperationResultByName } from "../../src/application/results.js";
import {
  buildApiServer,
  createHumanCredentialBindings,
  HUMAN_CREDENTIAL_HEADER
} from "../../src/api/server.js";
import { localHumanContext } from "../../src/contracts/capabilities.js";
import {
  failureEnvelope,
  failureEnvelopeSchema,
  httpStatusForError,
  type OperationEnvelope
} from "../../src/contracts/errors.js";
import {
  OPERATION_NAMES,
  operationInputSchemas,
  type OperationInputByName,
  type OperationName
} from "../../src/contracts/operations.js";
import { operationResultSchemas } from "../../src/contracts/results.js";
import { DomainError, type DomainErrorCode } from "../../src/domain/errors.js";
import { createMcpServer } from "../../src/mcp/server.js";
import {
  disposeApplicationRoots,
  makeApplication,
  physicalEvidenceInput,
  qualifier,
  reviewer,
  validPrompt
} from "../application/helpers.js";

afterEach(disposeApplicationRoots);

const FIXED_NOW = new Date("2026-09-04T12:00:00.000Z");
const REST_HEADERS = {
  host: "localhost:8765",
  origin: "http://localhost:8765"
};
const REQUIREMENTS_CREDENTIAL = createHash("sha256")
  .update("transport-conformance-requirements", "utf8")
  .digest("base64url");
const DURABLE_OPERATIONS = new Set<OperationName>([
  "create_project",
  "start_design_run",
  "approve_requirements",
  "resume_run",
  "rerun_stage",
  "export_candidate_bundle",
  "export_prototype_bundle",
  "generate_bringup_plan",
  "generate_firmware_scaffold"
]);

interface ConnectedMcp {
  readonly server: ReturnType<typeof createMcpServer>;
  readonly client: Client;
}

interface Pair {
  readonly restService: ApplicationService;
  readonly mcpService: ApplicationService;
  readonly rest: FastifyInstance;
  readonly mcp: ConnectedMcp;
}

const connectMcp = async (service: ApplicationService): Promise<ConnectedMcp> => {
  const server = createMcpServer(service);
  const client = new Client({ name: "transport-conformance", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
};

const createPair = async (): Promise<Pair> => {
  const [restService, mcpService] = await Promise.all([
    makeApplication(undefined, undefined, { now: () => new Date(FIXED_NOW) }),
    makeApplication(undefined, undefined, { now: () => new Date(FIXED_NOW) })
  ]);
  const rest = await buildApiServer({
    service: restService,
    humanCredentials: createHumanCredentialBindings({
      requirements_approval: {
        credential: REQUIREMENTS_CREDENTIAL,
        actor: reviewer
      }
    })
  });
  return { restService, mcpService, rest, mcp: await connectMcp(mcpService) };
};

const closePair = async (pair: Pair): Promise<void> => {
  await Promise.all([pair.rest.close(), pair.mcp.client.close()]);
  await pair.mcp.server.close();
};

const without = (
  value: Readonly<Record<string, unknown>>,
  ...keys: readonly string[]
): Record<string, unknown> => {
  const result = { ...value };
  for (const key of keys) delete result[key];
  return result;
};

const pathPart = (value: unknown): string => encodeURIComponent(String(value));

const restRequest = async <Name extends OperationName>(
  app: FastifyInstance,
  operation: Name,
  input: OperationInputByName[Name],
  options: {
    readonly bodyIdempotencyKey?: string;
    readonly idempotencyHeader?: string;
    readonly omitIdempotencyHeader?: boolean;
  } = {}
): Promise<LightMyRequestResponse> => {
  const values = input as unknown as Readonly<Record<string, unknown>>;
  const idempotencyKey = values.idempotencyKey;
  const headers: Record<string, string> = { ...REST_HEADERS };
  if (!options.omitIdempotencyHeader && typeof idempotencyKey === "string") {
    headers["idempotency-key"] = options.idempotencyHeader ?? idempotencyKey;
  }
  if (operation === "approve_requirements") {
    headers[HUMAN_CREDENTIAL_HEADER] = REQUIREMENTS_CREDENTIAL;
  }
  const body = (...keys: readonly string[]): Record<string, unknown> => ({
    ...without(values, ...keys, "idempotencyKey"),
    ...(options.bodyIdempotencyKey === undefined
      ? {}
      : { idempotencyKey: options.bodyIdempotencyKey })
  });

  switch (operation) {
    case "create_project":
      return app.inject({ method: "POST", url: "/api/v1/projects", headers, payload: body() });
    case "start_design_run":
      return app.inject({
        method: "POST",
        url: `/api/v1/projects/${pathPart(values.projectId)}/runs`,
        headers,
        payload: body("projectId")
      });
    case "get_run_status":
      return app.inject({ method: "GET", url: `/api/v1/runs/${pathPart(values.runId)}`, headers });
    case "inspect_requirements":
      return app.inject({ method: "GET", url: `/api/v1/runs/${pathPart(values.runId)}/requirements`, headers });
    case "approve_requirements":
      return app.inject({
        method: "POST",
        url: `/api/v1/runs/${pathPart(values.runId)}/requirements/approval`,
        headers,
        payload: body("runId")
      });
    case "resume_run":
      return app.inject({
        method: "POST",
        url: `/api/v1/runs/${pathPart(values.runId)}/resume`,
        headers,
        payload: body("runId")
      });
    case "list_artifacts": {
      const query = new URLSearchParams();
      for (const field of ["revisionId", "stage", "includeStale"] as const) {
        if (values[field] !== undefined) query.set(field, String(values[field]));
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return app.inject({ method: "GET", url: `/api/v1/runs/${pathPart(values.runId)}/artifacts${suffix}`, headers });
    }
    case "inspect_evidence": {
      const query = new URLSearchParams();
      for (const field of ["revisionId", "evidenceId", "stage", "includeStale"] as const) {
        if (values[field] !== undefined) query.set(field, String(values[field]));
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return app.inject({ method: "GET", url: `/api/v1/runs/${pathPart(values.runId)}/evidence${suffix}`, headers });
    }
    case "inspect_engineering_practices": {
      const query = new URLSearchParams();
      for (const field of ["revisionId", "findingCursor", "findingLimit"] as const) {
        if (values[field] !== undefined) query.set(field, String(values[field]));
      }
      const suffix = query.size === 0 ? "" : `?${query.toString()}`;
      return app.inject({
        method: "GET",
        url: `/api/v1/runs/${pathPart(values.runId)}/engineering-practices${suffix}`,
        headers
      });
    }
    case "rerun_stage":
      return app.inject({
        method: "POST",
        url: `/api/v1/runs/${pathPart(values.runId)}/stages/${pathPart(values.stage)}/rerun`,
        headers,
        payload: body("runId", "stage")
      });
    case "export_candidate_bundle":
      return app.inject({
        method: "POST",
        url: `/api/v1/revisions/${pathPart(values.revisionId)}/exports/candidate`,
        headers,
        payload: body("revisionId")
      });
    case "export_prototype_bundle":
      return app.inject({
        method: "POST",
        url: `/api/v1/revisions/${pathPart(values.revisionId)}/exports/prototype`,
        headers,
        payload: body("revisionId")
      });
    case "generate_bringup_plan":
      return app.inject({
        method: "POST",
        url: `/api/v1/revisions/${pathPart(values.revisionId)}/generations/bringup-plan`,
        headers,
        payload: body("revisionId")
      });
    case "generate_firmware_scaffold":
      return app.inject({
        method: "POST",
        url: `/api/v1/revisions/${pathPart(values.revisionId)}/generations/firmware-scaffold`,
        headers,
        payload: body("revisionId")
      });
  }
};

const mcpRequest = async <Name extends OperationName>(
  client: Client,
  operation: Name,
  input: OperationInputByName[Name]
) => client.callTool({
  name: operation,
  arguments: input as unknown as Record<string, unknown>
});

const envelopeFromRest = (response: LightMyRequestResponse): OperationEnvelope<unknown> =>
  response.json() as OperationEnvelope<unknown>;

const envelopeFromMcp = (response: Awaited<ReturnType<typeof mcpRequest>>): OperationEnvelope<unknown> =>
  response.structuredContent as unknown as OperationEnvelope<unknown>;

const normalizeSemantics = (value: unknown, key?: string): unknown => {
  if (key === "root" && typeof value === "string") return "<workspace-root>";
  if (typeof value === "string" && /^attempt_[0-9a-f-]{36}$/u.test(value)) {
    return "<runtime-attempt-id>";
  }
  if (Array.isArray(value)) return value.map((entry) => normalizeSemantics(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalizeSemantics(entryValue, entryKey)
      ])
    );
  }
  return value;
};

const stableLogicalName = (value: string): string =>
  value.replace(/evidence_[a-z0-9]+/gu, "<evidence>");

const statusProjection = (value: OperationResultByName["get_run_status"]): unknown => ({
  project: {
    id: value.project.id,
    name: value.project.name,
    description: value.project.description,
    policyVersion: value.project.policyVersion,
    revision: value.project.revision,
    runIds: value.project.runIds
  },
  run: {
    id: value.run.id,
    projectId: value.run.projectId,
    state: value.run.state,
    lifecycle: value.run.lifecycle,
    revision: value.run.revision,
    attempts: Object.fromEntries(
      Object.entries(value.run.attempts).map(([stage, attempts]) => [
        stage,
        attempts.map((attempt) => ({
          stage: attempt.stage,
          attemptNumber: attempt.attemptNumber,
          state: attempt.state,
          artifactCount: attempt.artifactIds.length,
          evidenceCount: attempt.evidenceIds.length,
          blockerCodes: attempt.blockers.map((blocker) => blocker.code),
          fencingEpoch: attempt.fencingEpoch,
          hasProvision: attempt.provisionIdentity !== undefined,
          hasOutput: attempt.outputIdentity !== undefined
        }))
      ])
    )
  },
  headRevision: value.headRevision === undefined
    ? undefined
    : {
        ordinal: value.headRevision.ordinal,
        lifecycle: value.headRevision.lifecycle,
        artifactCount: value.headRevision.artifactIds.length,
        evidenceCount: value.headRevision.evidenceIds.length,
        parentCount: value.headRevision.parentRevisionIds.length,
        manifestSchema: value.headRevision.manifest.schemaVersion
      },
  currentStage: value.currentStage,
  nextStage: value.nextStage,
  blockers: value.blockers,
  effectiveLifecycle: value.effectiveLifecycle,
  activeAttestationKinds: value.activeAttestations.map((approval) => approval.kind),
  stateRevision: value.stateRevision
});

const semanticProjection = <Name extends OperationName>(
  operation: Name,
  value: OperationResultByName[Name]
): unknown => {
  switch (operation) {
    case "create_project": {
      const result = value as OperationResultByName["create_project"];
      return {
        project: {
          id: result.project.id,
          name: result.project.name,
          description: result.project.description,
          policyVersion: result.project.policyVersion,
          revision: result.project.revision,
          runIds: result.project.runIds
        },
        stateRevision: result.stateRevision
      };
    }
    case "start_design_run":
    case "get_run_status":
    case "approve_requirements":
    case "resume_run":
    case "rerun_stage":
      return statusProjection(value as OperationResultByName["get_run_status"]);
    case "inspect_requirements":
      return normalizeSemantics(value);
    case "list_artifacts": {
      const result = value as OperationResultByName["list_artifacts"];
      return {
        projectId: result.projectId,
        runId: result.runId,
        hasRevisionSelection: result.revisionId !== undefined,
        artifacts: result.artifacts
          .map((artifact) => ({
            logicalName: stableLogicalName(artifact.logicalName),
            mediaType: artifact.mediaType,
            stage: artifact.stage,
            validationStatus: artifact.validationStatus,
            unresolvedAssumptions: artifact.unresolvedAssumptions,
            lifecycle: artifact.lifecycle,
            tool: artifact.tool,
            derivedFromCount: artifact.derivedFrom.length,
            exactInputCount: artifact.exactInputs.length,
            stale: artifact.staleAt !== undefined
          }))
          .sort((left, right) => left.logicalName.localeCompare(right.logicalName, "en"))
      };
    }
    case "inspect_evidence": {
      const result = value as OperationResultByName["inspect_evidence"];
      return {
        projectId: result.projectId,
        runId: result.runId,
        hasRevisionSelection: result.revisionId !== undefined,
        rootSchema: result.evidenceRoot.schemaVersion,
        evidence: result.evidence
          .map((entry) => ({
            stage: entry.stage,
            evidenceClass: entry.evidenceClass,
            claim: entry.claim,
            validationStatus: entry.validationStatus,
            unresolvedAssumptions: entry.unresolvedAssumptions,
            lifecycle: entry.lifecycle,
            tool: entry.tool,
            subjectCount: entry.subjectDigests.length,
            exactInputCount: entry.exactInputs.length,
            hasRawArtifact: entry.rawArtifactId !== undefined,
            hasParsedArtifact: entry.parsedArtifactId !== undefined,
            stale: entry.staleAt !== undefined
          }))
          .sort((left, right) =>
            `${left.stage}:${left.claim}`.localeCompare(`${right.stage}:${right.claim}`, "en")
          )
      };
    }
    case "inspect_engineering_practices": {
      const result = value as OperationResultByName["inspect_engineering_practices"];
      return {
        schemaVersion: result.schemaVersion,
        isHeadRevision: result.isHeadRevision,
        proofFixture: result.proofFixture,
        disposition: result.disposition,
        checks: {
          nativeDrc: {
            machineStatus: result.checks.nativeDrc.machineStatus,
            reasonCode: result.checks.nativeDrc.reasonCode,
            current: result.checks.nativeDrc.current,
            evidenceClass: result.checks.nativeDrc.evidenceClass
          },
          evledaPractice: {
            machineStatus: result.checks.evledaPractice.machineStatus,
            reasonCode: result.checks.evledaPractice.reasonCode,
            current: result.checks.evledaPractice.current,
            evidenceClass: result.checks.evledaPractice.evidenceClass,
            analysisOutcome: result.checks.evledaPractice.analysisOutcome,
            reviewRequired: result.checks.evledaPractice.reviewRequired,
            advisoryCount: result.checks.evledaPractice.advisoryCount
          }
        },
        coverage: result.coverage,
        rules: result.rules.map((rule) => ({
          ruleId: rule.ruleId,
          applicability: rule.applicability,
          machineStatus: rule.machineStatus,
          blocking: rule.blocking,
          reasonCode: rule.reasonCode,
          findingCount: rule.findingIds.length,
          externalGateCount: rule.externalGateIds.length
        })),
        gateSummary: result.gateSummary,
        findingTotal: result.findings.total,
        sourceIds: result.sources.map((source) => source.sourceId)
      };
    }
    case "export_candidate_bundle":
    case "export_prototype_bundle": {
      const result = value as OperationResultByName["export_candidate_bundle"];
      return {
        projectId: result.projectId,
        runId: result.runId,
        workflowStage: result.workflowStage,
        fileName: result.fileName.replace(/revision_[a-z0-9]+/u, "<revision>"),
        mediaType: result.mediaType,
        validationStatus: result.validationStatus,
        unresolvedAssumptions: result.unresolvedAssumptions,
        lifecycle: result.lifecycle,
        manifest: {
          schemaVersion: result.manifest.schemaVersion,
          bundleKind: result.manifest.bundleKind,
          lifecycle: result.manifest.lifecycle,
          warning: result.manifest.warning,
          artifacts: result.manifest.artifacts
            .map((artifact) => ({
              logicalName: stableLogicalName(artifact.logicalName),
              stage: artifact.stage,
              sourceKind: artifact.sourceKind,
              generationRole: artifact.generationRole,
              mediaType: artifact.mediaType,
              validationStatus: artifact.validationStatus,
              lifecycle: artifact.lifecycle
            }))
            .sort((left, right) => left.logicalName.localeCompare(right.logicalName, "en")),
          toolchain: [...result.manifest.toolchain].sort((left, right) =>
            `${left.name}:${left.version}`.localeCompare(`${right.name}:${right.version}`, "en")
          ),
          unresolvedAssumptions: result.manifest.unresolvedAssumptions
        }
      };
    }
    case "generate_bringup_plan":
    case "generate_firmware_scaffold": {
      const result = value as OperationResultByName["generate_bringup_plan"];
      return {
        projectId: result.projectId,
        runId: result.runId,
        workflowStage: result.workflowStage,
        artifact: {
          logicalName: result.artifact.logicalName,
          mediaType: result.artifact.mediaType,
          stage: result.artifact.stage,
          validationStatus: result.artifact.validationStatus,
          lifecycle: result.artifact.lifecycle,
          unresolvedAssumptions: result.artifact.unresolvedAssumptions
        },
        revision: {
          ordinal: result.revision.ordinal,
          lifecycle: result.revision.lifecycle,
          parentCount: result.revision.parentRevisionIds.length,
          artifactCount: result.revision.artifactIds.length,
          evidenceCount: result.revision.evidenceIds.length
        }
      };
    }
  }
};

const requireSuccess = <Name extends OperationName>(
  operation: Name,
  envelope: OperationEnvelope<unknown>
): OperationResultByName[Name] => {
  expect(envelope).toMatchObject({ ok: true, operation, requestId: expect.any(String) });
  if (!envelope.ok) throw new Error(`${operation} unexpectedly failed with ${envelope.error.code}`);
  return operationResultSchemas[operation].parse(envelope.result) as unknown as OperationResultByName[Name];
};

const invokeEquivalent = async <Name extends OperationName>(
  pair: Pair,
  operation: Name,
  input: OperationInputByName[Name],
  covered: Set<OperationName>,
  options: {
    readonly mcpInput?: OperationInputByName[Name];
    readonly compare?: (value: OperationResultByName[Name]) => unknown;
  } = {}
): Promise<{ readonly rest: OperationResultByName[Name]; readonly mcp: OperationResultByName[Name] }> => {
  const mcpInput = options.mcpInput ?? input;
  const compare = options.compare ?? ((result: OperationResultByName[Name]) =>
    semanticProjection(operation, result));
  operationInputSchemas[operation].parse(input);
  operationInputSchemas[operation].parse(mcpInput);
  const [restResponse, mcpResponse] = await Promise.all([
    restRequest(pair.rest, operation, input),
    mcpRequest(pair.mcp.client, operation, mcpInput)
  ]);
  expect(restResponse.statusCode, JSON.stringify(restResponse.json())).toBe(200);
  expect(mcpResponse.isError).not.toBe(true);
  const restResult = requireSuccess(operation, envelopeFromRest(restResponse));
  const mcpResult = requireSuccess(operation, envelopeFromMcp(mcpResponse));
  expect(compare(restResult)).toStrictEqual(compare(mcpResult));

  if (DURABLE_OPERATIONS.has(operation)) {
    const [restReplay, mcpReplay] = await Promise.all([
      restRequest(pair.rest, operation, input),
      mcpRequest(pair.mcp.client, operation, mcpInput)
    ]);
    const replayedRestResult = requireSuccess(operation, envelopeFromRest(restReplay));
    const replayedMcpResult = requireSuccess(operation, envelopeFromMcp(mcpReplay));
    expect(replayedRestResult).toStrictEqual(restResult);
    expect(replayedMcpResult).toStrictEqual(mcpResult);
  }

  covered.add(operation);
  return { rest: restResult, mcp: mcpResult };
};

const approvalProjection = (value: OperationResultByName["approve_requirements"]): unknown => ({
  state: value.run.state,
  revision: value.run.revision,
  approvalId: value.run.requirements?.approvalId,
  activeAttestations: value.activeAttestations,
  stateRevision: value.stateRevision
});

describe("REST and MCP operation conformance", () => {
  it("executes all 14 operations against equivalent state with only human approval transport-limited", async () => {
    const pair = await createPair();
    const covered = new Set<OperationName>();
    try {
      const created = await invokeEquivalent(pair, "create_project", {
        name: "Transport conformance controller",
        description: "Equivalent REST and MCP state",
        workspace: "transport-conformance",
        idempotencyKey: "transport-create-project-0001"
      }, covered);
      const projectId = created.rest.project.id;

      const started = await invokeEquivalent(pair, "start_design_run", {
        projectId,
        prompt: validPrompt,
        configuration: { conformance: true },
        expectedRevision: created.rest.project.revision,
        idempotencyKey: "transport-start-design-run-01"
      }, covered);
      const runId = started.rest.run.id;

      await invokeEquivalent(pair, "get_run_status", { runId }, covered);
      const requirements = await invokeEquivalent(pair, "inspect_requirements", { runId }, covered);
      await invokeEquivalent(pair, "inspect_engineering_practices", {
        runId,
        findingLimit: 50
      }, covered);
      const approvalInput: OperationInputByName["approve_requirements"] = {
        runId,
        requirementsDigest: requirements.rest.requirementsDigest,
        actor: reviewer,
        rationale: "The exact bounded fixture requirements were independently reviewed.",
        scope: "exact requirements document",
        expectedRevision: started.rest.run.revision,
        idempotencyKey: "transport-approve-requirements-01"
      };
      operationInputSchemas.approve_requirements.parse(approvalInput);

      const mcpRevisionBeforeApproval = (await pair.mcpService.getRunStatus({ runId })).run.revision;
      const [restApprovalResponse, mcpApprovalResponse] = await Promise.all([
        restRequest(pair.rest, "approve_requirements", approvalInput),
        mcpRequest(pair.mcp.client, "approve_requirements", approvalInput)
      ]);
      expect(restApprovalResponse.statusCode).toBe(200);
      const restApproval = requireSuccess(
        "approve_requirements",
        envelopeFromRest(restApprovalResponse)
      );
      const mcpApprovalFailure = envelopeFromMcp(mcpApprovalResponse);
      expect(mcpApprovalResponse.isError).toBe(true);
      expect(failureEnvelopeSchema.parse(mcpApprovalFailure)).toMatchObject({
        ok: false,
        error: { code: "CAPABILITY_REQUIRED", retryable: false }
      });
      expect((await pair.mcpService.getRunStatus({ runId })).run.revision).toBe(
        mcpRevisionBeforeApproval
      );

      const restApprovalReplay = requireSuccess(
        "approve_requirements",
        envelopeFromRest(await restRequest(pair.rest, "approve_requirements", approvalInput))
      );
      expect(restApprovalReplay).toStrictEqual(restApproval);
      const directMcpApproval = await pair.mcpService.approveRequirements(
        approvalInput,
        localHumanContext(reviewer, "requirements_approval")
      );
      operationResultSchemas.approve_requirements.parse(directMcpApproval);
      expect(approvalProjection(restApproval)).toStrictEqual(approvalProjection(directMcpApproval));
      covered.add("approve_requirements");

      const resumed = await invokeEquivalent(pair, "resume_run", {
        runId,
        expectedRevision: restApproval.run.revision,
        idempotencyKey: "transport-resume-complete-0001"
      }, covered);
      expect(resumed.rest.run.state).toBe("completed");
      const completedRevisionId = resumed.rest.headRevision!.id;
      const mcpCompletedRevisionId = resumed.mcp.headRevision!.id;

      await invokeEquivalent(pair, "list_artifacts", {
        runId,
        revisionId: completedRevisionId,
        includeStale: false
      }, covered, {
        mcpInput: { runId, revisionId: mcpCompletedRevisionId, includeStale: false }
      });
      await invokeEquivalent(pair, "inspect_evidence", {
        runId,
        revisionId: completedRevisionId,
        includeStale: false
      }, covered, {
        mcpInput: { runId, revisionId: mcpCompletedRevisionId, includeStale: false }
      });
      const selectedArtifacts = await invokeEquivalent(pair, "list_artifacts", {
        runId,
        includeStale: true
      }, covered);
      expect(selectedArtifacts.rest.revisionId).toBe(completedRevisionId);
      expect(selectedArtifacts.mcp.revisionId).toBe(mcpCompletedRevisionId);
      const selectedEvidence = await invokeEquivalent(pair, "inspect_evidence", {
        runId,
        includeStale: true
      }, covered);
      expect(selectedEvidence.rest.revisionId).toBe(completedRevisionId);
      expect(selectedEvidence.mcp.revisionId).toBe(mcpCompletedRevisionId);
      await invokeEquivalent(pair, "export_candidate_bundle", {
        revisionId: completedRevisionId,
        expectedRevision: resumed.rest.run.revision,
        idempotencyKey: "transport-candidate-export-0001"
      }, covered, {
        mcpInput: {
          revisionId: mcpCompletedRevisionId,
          expectedRevision: resumed.mcp.run.revision,
          idempotencyKey: "transport-candidate-export-0001"
        }
      });

      const [restAfterCandidate, mcpAfterCandidate] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      expect(mcpAfterCandidate.run.revision).toBe(restAfterCandidate.run.revision);

      const [restPhysicalInput, mcpPhysicalInput] = await Promise.all([
        physicalEvidenceInput(
          pair.restService,
          runId,
          completedRevisionId,
          restAfterCandidate.run.revision,
          "transport-physical-evidence-01",
          "TRANSPORT-001"
        ),
        physicalEvidenceInput(
          pair.mcpService,
          runId,
          mcpCompletedRevisionId,
          mcpAfterCandidate.run.revision,
          "transport-physical-evidence-01",
          "TRANSPORT-001"
        )
      ]);
      const [restPhysical, mcpPhysical] = await Promise.all([
        pair.restService.submitExternalEvidence(
          restPhysicalInput,
          localHumanContext(qualifier, "hardware_qualification")
        ),
        pair.mcpService.submitExternalEvidence(
          mcpPhysicalInput,
          localHumanContext(qualifier, "hardware_qualification")
        )
      ]);
      expect({
        verdict: restPhysical.overallVerdict,
        categories: restPhysical.categoryVerdicts,
        rawStatus: restPhysical.rawArtifact.validationStatus,
        parsedStatus: restPhysical.parsedArtifact.validationStatus,
        evidenceStatus: restPhysical.evidence.validationStatus,
        stateRevision: restPhysical.stateRevision
      }).toStrictEqual({
        verdict: mcpPhysical.overallVerdict,
        categories: mcpPhysical.categoryVerdicts,
        rawStatus: mcpPhysical.rawArtifact.validationStatus,
        parsedStatus: mcpPhysical.parsedArtifact.validationStatus,
        evidenceStatus: mcpPhysical.evidence.validationStatus,
        stateRevision: mcpPhysical.stateRevision
      });
      const [restAfterPhysical, mcpAfterPhysical] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      const restQualificationInput = {
        revisionId: completedRevisionId,
        requirementsDigest: resumed.rest.run.requirements!.identity.digest,
        evidenceRootDigest: restPhysical.evidenceRoot.digest,
        actor: qualifier,
        scope: "one exact controlled prototype",
        rationale: "The exact physical evidence set was independently reviewed.",
        expectedRevision: restAfterPhysical.run.revision,
        idempotencyKey: "transport-qualification-00001"
      } as const;
      const mcpQualificationInput = {
        ...restQualificationInput,
        revisionId: mcpCompletedRevisionId,
        requirementsDigest: resumed.mcp.run.requirements!.identity.digest,
        evidenceRootDigest: mcpPhysical.evidenceRoot.digest,
        expectedRevision: mcpAfterPhysical.run.revision
      } as const;
      expect(mcpAfterPhysical.run.revision).toBe(restAfterPhysical.run.revision);
      const [restQualification, mcpQualification] = await Promise.all([
        pair.restService.qualifyRevision(
          restQualificationInput,
          localHumanContext(qualifier, "hardware_qualification")
        ),
        pair.mcpService.qualifyRevision(
          mcpQualificationInput,
          localHumanContext(qualifier, "hardware_qualification")
        )
      ]);
      expect({
        kind: restQualification.approval.kind,
        actor: restQualification.approval.actor,
        scope: restQualification.approval.scope,
        rationale: restQualification.approval.rationale,
        stateRevision: restQualification.stateRevision
      }).toStrictEqual({
        kind: mcpQualification.approval.kind,
        actor: mcpQualification.approval.actor,
        scope: mcpQualification.approval.scope,
        rationale: mcpQualification.approval.rationale,
        stateRevision: mcpQualification.stateRevision
      });

      const [restQualified, mcpQualified] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      expect(mcpQualified.run.revision).toBe(restQualified.run.revision);
      await invokeEquivalent(pair, "export_prototype_bundle", {
        revisionId: completedRevisionId,
        expectedRevision: restQualified.run.revision,
        idempotencyKey: "transport-prototype-export-0001"
      }, covered, {
        mcpInput: {
          revisionId: mcpCompletedRevisionId,
          expectedRevision: mcpQualified.run.revision,
          idempotencyKey: "transport-prototype-export-0001"
        }
      });

      const [restAfterPrototype, mcpAfterPrototype] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      expect(mcpAfterPrototype.run.revision).toBe(restAfterPrototype.run.revision);

      const bringup = await invokeEquivalent(pair, "generate_bringup_plan", {
        revisionId: completedRevisionId,
        expectedRevision: restAfterPrototype.run.revision,
        idempotencyKey: "transport-generate-bringup-0001"
      }, covered, {
        mcpInput: {
          revisionId: mcpCompletedRevisionId,
          expectedRevision: mcpAfterPrototype.run.revision,
          idempotencyKey: "transport-generate-bringup-0001"
        }
      });
      const [restAfterBringup, mcpAfterBringup] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      expect(mcpAfterBringup.run.revision).toBe(restAfterBringup.run.revision);
      await invokeEquivalent(pair, "generate_firmware_scaffold", {
        revisionId: bringup.rest.revision.id,
        language: "c",
        expectedRevision: restAfterBringup.run.revision,
        idempotencyKey: "transport-generate-firmware-001"
      }, covered, {
        mcpInput: {
          revisionId: bringup.mcp.revision.id,
          language: "c",
          expectedRevision: mcpAfterBringup.run.revision,
          idempotencyKey: "transport-generate-firmware-001"
        }
      });

      const [restBeforeRerun, mcpBeforeRerun] = await Promise.all([
        pair.restService.getRunStatus({ runId }),
        pair.mcpService.getRunStatus({ runId })
      ]);
      expect(mcpBeforeRerun.run.revision).toBe(restBeforeRerun.run.revision);
      await invokeEquivalent(pair, "rerun_stage", {
        runId,
        stage: "firmware_contract",
        reason: "Verify both transports append the same logical branch and stale descendants.",
        expectedRevision: restBeforeRerun.run.revision,
        idempotencyKey: "transport-rerun-firmware-0001"
      }, covered, {
        compare: (value) => ({
          state: value.run.state,
          revision: value.run.revision,
          currentStage: value.currentStage,
          nextStage: value.nextStage,
          activeFirmwareAttempts: value.run.attempts.firmware_contract.map((attempt) => attempt.state),
          simulationAttempts: value.run.attempts.simulation_checks.map((attempt) => attempt.state),
          headOrdinal: value.headRevision?.ordinal,
          headManifestSchema: value.headRevision?.manifest.schemaVersion,
          blockers: value.blockers,
          lifecycle: value.effectiveLifecycle,
          stateRevision: value.stateRevision
        })
      });

      expect([...covered].sort()).toEqual([...OPERATION_NAMES].sort());
    } finally {
      await closePair(pair);
    }
  }, 60_000);

  it("preserves real domain failures for every operation", async () => {
    const pair = await createPair();
    const digest = "0".repeat(64);
    const cases = [
      ["create_project", { name: "Denied policy", policyVersion: "other-policy", idempotencyKey: "failure-create-project-0001" }],
      ["start_design_run", { projectId: "project_missing", prompt: validPrompt, configuration: {}, expectedRevision: 0, idempotencyKey: "failure-start-design-run-01" }],
      ["get_run_status", { runId: "run_missing" }],
      ["inspect_requirements", { runId: "run_missing" }],
      ["approve_requirements", { runId: "run_missing", requirementsDigest: digest, actor: reviewer, rationale: "Review attempt.", expectedRevision: 0, idempotencyKey: "failure-approve-requirements" }],
      ["resume_run", { runId: "run_missing", expectedRevision: 0, idempotencyKey: "failure-resume-run-000001" }],
      ["list_artifacts", { runId: "run_missing", includeStale: false }],
      ["inspect_evidence", { runId: "run_missing", includeStale: false }],
      ["inspect_engineering_practices", { runId: "run_missing", findingLimit: 50 }],
      ["rerun_stage", { runId: "run_missing", stage: "schematic", reason: "Failure coverage.", expectedRevision: 0, idempotencyKey: "failure-rerun-stage-00001" }],
      ["export_candidate_bundle", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "failure-candidate-export-01" }],
      ["export_prototype_bundle", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "failure-prototype-export-01" }],
      ["generate_bringup_plan", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "failure-generate-bringup-01" }],
      ["generate_firmware_scaffold", { revisionId: "revision_missing", language: "c", expectedRevision: 0, idempotencyKey: "failure-generate-firmware-1" }]
    ] as const satisfies readonly (readonly [OperationName, OperationInputByName[OperationName]])[];

    try {
      expect(cases.map(([operation]) => operation)).toEqual(OPERATION_NAMES);
      for (const [operation, input] of cases) {
        operationInputSchemas[operation].parse(input);
        const [restResponse, mcpResponse] = await Promise.all([
          restRequest(pair.rest, operation, input),
          mcpRequest(pair.mcp.client, operation, input)
        ]);
        const restEnvelope = envelopeFromRest(restResponse);
        const mcpEnvelope = envelopeFromMcp(mcpResponse);
        if (operation === "approve_requirements") {
          expect(restResponse.statusCode).toBe(404);
          expect(restEnvelope).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
          expect(mcpResponse.isError).toBe(true);
          expect(mcpEnvelope).toMatchObject({
            ok: false,
            error: { code: "CAPABILITY_REQUIRED" }
          });
          continue;
        }
        expect(mcpResponse.isError).toBe(true);
        expect(restResponse.statusCode).toBe(httpStatusForError(
          failureEnvelopeSchema.parse(restEnvelope).error.code as DomainErrorCode
        ));
        expect(restEnvelope).toStrictEqual(mcpEnvelope);
      }
    } finally {
      await closePair(pair);
    }
  });

  it("enforces the declared request schema for every operation on both transports", async () => {
    const pair = await createPair();
    const cases = [
      ["create_project", { name: "", idempotencyKey: "invalid-create-project-0001" }],
      ["start_design_run", { projectId: "project_missing", prompt: "", configuration: {}, expectedRevision: 0, idempotencyKey: "invalid-start-design-run-01" }],
      ["get_run_status", { runId: "x" }],
      ["inspect_requirements", { runId: "x" }],
      ["approve_requirements", { runId: "run_missing", requirementsDigest: "not-a-digest", actor: reviewer, rationale: "Invalid request.", expectedRevision: 0, idempotencyKey: "invalid-approve-requirements" }],
      ["resume_run", { runId: "x", expectedRevision: 0, idempotencyKey: "invalid-resume-run-000001" }],
      ["list_artifacts", { runId: "x", includeStale: false }],
      ["inspect_evidence", { runId: "x", includeStale: false }],
      ["inspect_engineering_practices", { runId: "x", findingLimit: 1 }],
      ["rerun_stage", { runId: "run_missing", stage: "invalid_stage", reason: "Invalid request.", expectedRevision: 0, idempotencyKey: "invalid-rerun-stage-00001" }],
      ["export_candidate_bundle", { revisionId: "x", expectedRevision: 0, idempotencyKey: "invalid-candidate-export-01" }],
      ["export_prototype_bundle", { revisionId: "x", expectedRevision: 0, idempotencyKey: "invalid-prototype-export-01" }],
      ["generate_bringup_plan", { revisionId: "x", expectedRevision: 0, idempotencyKey: "invalid-generate-bringup-01" }],
      ["generate_firmware_scaffold", { revisionId: "x", language: "c", expectedRevision: 0, idempotencyKey: "invalid-generate-firmware-1" }]
    ] as const;

    try {
      expect(cases.map(([operation]) => operation)).toEqual(OPERATION_NAMES);
      for (const [operation, input] of cases) {
        expect(operationInputSchemas[operation].safeParse(input).success).toBe(false);
        const [restResponse, mcpResponse] = await Promise.all([
          restRequest(
            pair.rest,
            operation,
            input as unknown as OperationInputByName[typeof operation]
          ),
          pair.mcp.client.callTool({
            name: operation,
            arguments: input as unknown as Record<string, unknown>
          })
        ]);
        expect(restResponse.statusCode).toBe(400);
        expect(envelopeFromRest(restResponse)).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT", retryable: false }
        });
        expect(mcpResponse.isError).toBe(true);
        const mcpEnvelope = envelopeFromMcp(mcpResponse);
        failureEnvelopeSchema.parse(mcpEnvelope);
        expect(mcpEnvelope).toStrictEqual(envelopeFromRest(restResponse));
      }
    } finally {
      await closePair(pair);
    }
  });
});

const DOMAIN_ERROR_CODES = [
  "ARTIFACT_INTEGRITY_ERROR",
  "CAPABILITY_REQUIRED",
  "DIGEST_MISMATCH",
  "EVIDENCE_MISSING",
  "EVIDENCE_STALE",
  "EXTERNAL_ACCEPTANCE_REQUIRED",
  "GATE_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "PATH_OUTSIDE_WORKSPACE",
  "POLICY_DENIED",
  "REQUIREMENTS_NOT_APPROVED",
  "REVISION_CONFLICT",
  "STAGE_ALREADY_RUNNING",
  "STAGE_BLOCKED",
  "TOOL_RESULT_INCONCLUSIVE",
  "TOOLCHAIN_UNAVAILABLE",
  "TOOLCHAIN_UNSUPPORTED"
] as const satisfies readonly DomainErrorCode[];

describe("transport error and idempotency contracts", () => {
  it("maps every public service error identically while REST adds the stable HTTP status", async () => {
    let selectedError: DomainError | Error = new Error("not selected");
    const service = {
      initialize: async () => undefined,
      dispatch: async () => failureEnvelope(selectedError)
    } as unknown as ApplicationService;
    const app = await buildApiServer({ service });
    const mcp = await connectMcp(service);
    try {
      for (const code of [...DOMAIN_ERROR_CODES, "INTERNAL_ERROR"] as const) {
        selectedError = code === "INTERNAL_ERROR"
          ? new Error("private implementation failure")
          : new DomainError(
              code,
              `transport failure ${code}`,
              { marker: code },
              code === "STAGE_ALREADY_RUNNING" || code === "TOOLCHAIN_UNAVAILABLE"
            );
        const expected = failureEnvelope(selectedError);
        const [restResponse, mcpResponse] = await Promise.all([
          app.inject({ method: "GET", url: "/api/v1/runs/run_error_mapping", headers: REST_HEADERS }),
          mcp.client.callTool({ name: "get_run_status", arguments: { runId: "run_error_mapping" } })
        ]);
        expect(restResponse.statusCode).toBe(httpStatusForError(expected.error.code));
        expect(envelopeFromRest(restResponse)).toStrictEqual(expected);
        expect(mcpResponse.isError).toBe(true);
        expect(envelopeFromMcp(mcpResponse)).toStrictEqual(expected);
        failureEnvelopeSchema.parse(mcpResponse.structuredContent);
      }
    } finally {
      await Promise.all([app.close(), mcp.client.close()]);
      await mcp.server.close();
    }
  });

  it("requires one REST header and one MCP argument for every durable command", async () => {
    const pair = await createPair();
    const digest = "0".repeat(64);
    const durableCases = [
      ["create_project", { name: "Missing key", idempotencyKey: "missing-create-project-0001" }],
      ["start_design_run", { projectId: "project_missing", prompt: validPrompt, configuration: {}, expectedRevision: 0, idempotencyKey: "missing-start-design-run-01" }],
      ["approve_requirements", { runId: "run_missing", requirementsDigest: digest, actor: reviewer, rationale: "Missing key.", expectedRevision: 0, idempotencyKey: "missing-approve-requirements" }],
      ["resume_run", { runId: "run_missing", expectedRevision: 0, idempotencyKey: "missing-resume-run-000001" }],
      ["rerun_stage", { runId: "run_missing", stage: "schematic", reason: "Missing key.", expectedRevision: 0, idempotencyKey: "missing-rerun-stage-00001" }],
      ["export_candidate_bundle", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "missing-candidate-export-01" }],
      ["export_prototype_bundle", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "missing-prototype-export-01" }],
      ["generate_bringup_plan", { revisionId: "revision_missing", expectedRevision: 0, idempotencyKey: "missing-generate-bringup-01" }],
      ["generate_firmware_scaffold", { revisionId: "revision_missing", language: "c", expectedRevision: 0, idempotencyKey: "missing-generate-firmware-1" }]
    ] as const satisfies readonly (readonly [OperationName, OperationInputByName[OperationName]])[];

    try {
      expect(durableCases.map(([operation]) => operation).sort()).toEqual(
        [...DURABLE_OPERATIONS].sort()
      );
      for (const [operation, input] of durableCases) {
        const restResponse = await restRequest(pair.rest, operation, input, {
          omitIdempotencyHeader: true
        });
        expect(restResponse.statusCode).toBe(400);
        expect(envelopeFromRest(restResponse)).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT", retryable: false }
        });

        const bodyKey = (input as unknown as { readonly idempotencyKey: string }).idempotencyKey;
        const mismatch = await restRequest(pair.rest, operation, input, {
          idempotencyHeader: "different-header-key-0001",
          bodyIdempotencyKey: bodyKey
        });
        expect(mismatch.statusCode).toBe(409);
        expect(envelopeFromRest(mismatch)).toMatchObject({
          ok: false,
          error: {
            code: "IDEMPOTENCY_CONFLICT",
            message: "Body and Idempotency-Key header do not match",
            retryable: false
          }
        });

        const withoutKey = without(
          input as unknown as Readonly<Record<string, unknown>>,
          "idempotencyKey"
        );
        const rejected = await pair.mcp.client.callTool({
          name: operation,
          arguments: withoutKey
        });
        expect(rejected.isError).toBe(true);
        expect(failureEnvelopeSchema.parse(rejected.structuredContent)).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARGUMENT", retryable: false }
        });
      }
    } finally {
      await closePair(pair);
    }
  });
});
