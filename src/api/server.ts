import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest
} from "fastify";
import type { ApplicationService } from "../application/application-service.js";
import { createProductionApplicationService, resolveProductionApplicationPaths } from "../application/factory.js";
import type { CommandContext } from "../contracts/capabilities.js";
import type { HumanCapability } from "../contracts/capabilities.js";
import { localHumanContext, SYSTEM_CONTEXT } from "../contracts/capabilities.js";
import {
  failureEnvelope,
  httpStatusForError,
  successEnvelope,
  type FailureEnvelope,
  type OperationEnvelope
} from "../contracts/errors.js";
import {
  approveRequirementsInputSchema,
  authorizeManufacturingReleaseInputSchema,
  EXTERNAL_EVIDENCE_REQUEST_MAX_BYTES,
  humanActorSchema,
  qualifyRevisionInputSchema,
  revokeAttestationInputSchema,
  submitExternalEvidenceInputSchema,
  type OperationName
} from "../contracts/operations.js";
import { DomainError } from "../domain/errors.js";
import { createFluxDiagnostic } from "../domain/diagnostics.js";
import type { HumanActor } from "../domain/types.js";
import { registerFluxRoutes, type FluxRoutesOptions } from "../flux/routes.js";
import {
  FluxProductionCompositionError,
  createFluxSetupRequiredReadiness,
  loadFluxProductionComposition,
  type FluxProductionCompositionDependencies,
  type FluxReadinessDto,
} from "../flux/production-composition.js";

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

const HUMAN_CAPABILITIES = [
  "requirements_approval",
  "hardware_qualification",
  "manufacturing_release"
] as const satisfies readonly HumanCapability[];

const HUMAN_ROLE_BY_CAPABILITY = {
  requirements_approval: "requirements_reviewer",
  hardware_qualification: "hardware_qualifier",
  manufacturing_release: "release_authority"
} as const satisfies Readonly<Record<HumanCapability, HumanActor["role"]>>;

const HUMAN_CREDENTIAL_ENVIRONMENT = [
  {
    capability: "requirements_approval",
    credential: "EVLEDA_REQUIREMENTS_REVIEW_CREDENTIAL",
    actorId: "EVLEDA_REQUIREMENTS_REVIEW_ACTOR_ID",
    actorDisplayName: "EVLEDA_REQUIREMENTS_REVIEW_ACTOR_DISPLAY_NAME",
    defaultActorId: "local-requirements-reviewer",
    defaultActorDisplayName: "Local requirements reviewer"
  },
  {
    capability: "hardware_qualification",
    credential: "EVLEDA_HARDWARE_QUALIFICATION_CREDENTIAL",
    actorId: "EVLEDA_HARDWARE_QUALIFICATION_ACTOR_ID",
    actorDisplayName: "EVLEDA_HARDWARE_QUALIFICATION_ACTOR_DISPLAY_NAME",
    defaultActorId: "local-hardware-qualifier",
    defaultActorDisplayName: "Local hardware qualifier"
  },
  {
    capability: "manufacturing_release",
    credential: "EVLEDA_MANUFACTURING_RELEASE_CREDENTIAL",
    actorId: "EVLEDA_MANUFACTURING_RELEASE_ACTOR_ID",
    actorDisplayName: "EVLEDA_MANUFACTURING_RELEASE_ACTOR_DISPLAY_NAME",
    defaultActorId: "local-release-authority",
    defaultActorDisplayName: "Local manufacturing release authority"
  }
] as const;

export const HUMAN_CREDENTIAL_HEADER = "x-evleda-human-credential";
export const HUMAN_CREDENTIAL_MINIMUM_BYTES = 32;
export const HUMAN_CREDENTIAL_MINIMUM_DISTINCT_CHARACTERS = 16;

export interface HumanCredentialProvision {
  readonly credential: string;
  readonly actor: HumanActor;
}

export interface HumanCredentialBinding {
  readonly credentialDigest: string;
  readonly actor: HumanActor;
}

export type HumanCredentialProvisions = Readonly<
  Partial<Record<HumanCapability, HumanCredentialProvision>>
>;

export type HumanCredentialBindings = Readonly<
  Partial<Record<HumanCapability, HumanCredentialBinding>>
>;

const issuedHumanCredentialBindings = new WeakSet<object>();

export interface ApiServerOptions {
  readonly service: ApplicationService;
  readonly uiRoot?: string;
  readonly allowedHosts?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly humanCredentials?: HumanCredentialBindings;
  readonly logger?: boolean;
  /** Candidate-only Flux surface; absent until its runtime adapter is composed. */
  readonly flux?: FluxRoutesOptions;
  /** Always-safe, path/key-free production setup projection. */
  readonly fluxReadiness?: FluxReadinessDto;
}

const invalidCredentialConfiguration = (message: string): DomainError =>
  new DomainError("INVALID_ARGUMENT", message);

const isCanonicalStrongCredential = (credential: string): boolean => {
  if (typeof credential !== "string" || !/^[A-Za-z0-9_-]{43,128}$/u.test(credential)) {
    return false;
  }
  const decoded = Buffer.from(credential, "base64url");
  return (
    decoded.byteLength >= HUMAN_CREDENTIAL_MINIMUM_BYTES &&
    decoded.toString("base64url") === credential &&
    new Set(credential).size >= HUMAN_CREDENTIAL_MINIMUM_DISTINCT_CHARACTERS
  );
};

const sameDigest = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
};

const immutableActor = (actor: HumanActor, capability: HumanCapability): HumanActor => {
  const parsed = humanActorSchema.parse(actor);
  if (parsed.role !== HUMAN_ROLE_BY_CAPABILITY[capability]) {
    throw invalidCredentialConfiguration(
      `The configured ${capability} actor has the wrong fixed role`
    );
  }
  return Object.freeze({ ...parsed });
};

const rejectDuplicateCredentialDigests = (bindings: HumanCredentialBindings): void => {
  const configured = HUMAN_CAPABILITIES.flatMap((capability) => {
    const binding = bindings[capability];
    return binding === undefined ? [] : [{ capability, digest: binding.credentialDigest }];
  });
  for (let leftIndex = 0; leftIndex < configured.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < configured.length; rightIndex += 1) {
      const left = configured[leftIndex];
      const right = configured[rightIndex];
      if (left !== undefined && right !== undefined && sameDigest(left.digest, right.digest)) {
        throw invalidCredentialConfiguration(
          "Human capability credentials must be distinct across roles"
        );
      }
    }
  }
};

export const createHumanCredentialBindings = (
  provisions: HumanCredentialProvisions
): HumanCredentialBindings => {
  const bindings: Partial<Record<HumanCapability, HumanCredentialBinding>> = {};
  for (const capability of HUMAN_CAPABILITIES) {
    const provision = provisions[capability];
    if (provision === undefined) continue;
    if (!isCanonicalStrongCredential(provision.credential)) {
      throw invalidCredentialConfiguration(
        `The ${capability} credential must be 43-128 canonical unpadded Base64URL characters, encode at least 32 bytes, and contain at least 16 distinct characters`
      );
    }
    bindings[capability] = Object.freeze({
      credentialDigest: createHash("sha256")
        .update(provision.credential, "utf8")
        .digest("hex"),
      actor: immutableActor(provision.actor, capability)
    });
  }
  rejectDuplicateCredentialDigests(bindings);
  const issued = Object.freeze(bindings);
  issuedHumanCredentialBindings.add(issued);
  return issued;
};

export const loadHumanCredentialBindingsFromEnvironment = (
  environment: NodeJS.ProcessEnv
): HumanCredentialBindings => {
  const rawCredentials = new Map<HumanCapability, string>();
  for (const specification of HUMAN_CREDENTIAL_ENVIRONMENT) {
    const credential = environment[specification.credential];
    if (credential !== undefined) rawCredentials.set(specification.capability, credential);
    delete environment[specification.credential];
  }
  const legacyCredential = environment.EVLEDA_HUMAN_APPROVAL_TOKEN;
  delete environment.EVLEDA_HUMAN_APPROVAL_TOKEN;
  if (legacyCredential !== undefined) {
    throw invalidCredentialConfiguration(
      "EVLEDA_HUMAN_APPROVAL_TOKEN is no longer accepted; configure separate role credentials"
    );
  }

  const provisions: Partial<Record<HumanCapability, HumanCredentialProvision>> = {};
  for (const specification of HUMAN_CREDENTIAL_ENVIRONMENT) {
    const credential = rawCredentials.get(specification.capability);
    const configuredActorId = environment[specification.actorId];
    const configuredDisplayName = environment[specification.actorDisplayName];
    if (credential === undefined) {
      if (configuredActorId !== undefined || configuredDisplayName !== undefined) {
        throw invalidCredentialConfiguration(
          `${specification.actorId} and ${specification.actorDisplayName} require ${specification.credential}`
        );
      }
      continue;
    }
    provisions[specification.capability] = {
      credential,
      actor: {
        type: "human",
        id: configuredActorId ?? specification.defaultActorId,
        displayName: configuredDisplayName ?? specification.defaultActorDisplayName,
        role: HUMAN_ROLE_BY_CAPABILITY[specification.capability]
      }
    };
  }
  return createHumanCredentialBindings(provisions);
};

const normalizeHumanCredentialBindings = (
  configured: HumanCredentialBindings | undefined
): HumanCredentialBindings => {
  if (configured === undefined) return Object.freeze({});
  if (!issuedHumanCredentialBindings.has(configured)) {
    throw invalidCredentialConfiguration(
      "humanCredentials must be created by createHumanCredentialBindings"
    );
  }
  for (const key of Object.keys(configured)) {
    if (!(HUMAN_CAPABILITIES as readonly string[]).includes(key)) {
      throw invalidCredentialConfiguration(`Unknown human capability credential binding: ${key}`);
    }
  }
  const normalized: Partial<Record<HumanCapability, HumanCredentialBinding>> = {};
  for (const capability of HUMAN_CAPABILITIES) {
    const binding = configured[capability];
    if (binding === undefined) continue;
    if (!/^[0-9a-f]{64}$/u.test(binding.credentialDigest)) {
      throw invalidCredentialConfiguration(
        `The ${capability} credential digest must be a lowercase SHA-256 digest`
      );
    }
    normalized[capability] = Object.freeze({
      credentialDigest: binding.credentialDigest,
      actor: immutableActor(binding.actor, capability)
    });
  }
  rejectDuplicateCredentialDigests(normalized);
  return Object.freeze(normalized);
};

const headerValue = (value: string | readonly string[] | undefined): string | undefined => {
  if (typeof value === "string" || value === undefined) {
    return value;
  }
  return value.length === 1 ? value[0] : undefined;
};

const safeDownloadName = (value: string): string =>
  value.replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 120) || "artifact.bin";

const hostnameFromHostHeader = (value: string): string | undefined => {
  try {
    const url = new URL(`http://${value}`);
    if (url.username !== "" || url.password !== "") return undefined;
    return url.hostname.toLocaleLowerCase("en-US");
  } catch {
    return undefined;
  }
};

const normalizedOrigin = (value: string): string | undefined => {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.origin === "null"
    ) {
      return undefined;
    }
    return url.origin.toLocaleLowerCase("en-US");
  } catch {
    return undefined;
  }
};

const securityFailure = (message: string, details: Record<string, unknown>): FailureEnvelope =>
  failureEnvelope(new DomainError("POLICY_DENIED", message, details));

const sendEnvelope = (
  reply: FastifyReply,
  envelope: OperationEnvelope
): FastifyReply => {
  if (!envelope.ok) {
    return reply.code(httpStatusForError(envelope.error.code)).send(envelope);
  }
  return reply.send(envelope);
};

const asObject = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_ARGUMENT", "Expected a JSON object request body");
  }
  return value as Record<string, unknown>;
};

const explicitBooleanQuery = (value: unknown, parameter: string): boolean => {
  if (value === undefined || value === false || value === "false") return false;
  if (value === true || value === "true") return true;
  throw new DomainError(
    "INVALID_ARGUMENT",
    `${parameter} must be exactly true or false`,
    { parameter, acceptedValues: ["true", "false"] }
  );
};

const explicitPositiveIntegerQuery = (
  value: unknown,
  parameter: string
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9][0-9]*$/u.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  throw new DomainError(
    "INVALID_ARGUMENT",
    `${parameter} must be a canonical positive base-10 integer`,
    { parameter }
  );
};

const assertExactQueryParameters = (
  value: unknown,
  allowed: readonly string[]
): void => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("INVALID_ARGUMENT", "Query parameters must form one object");
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Request contains unknown query parameters",
      { unknownParameters: unknown, allowedParameters: [...allowed] }
    );
  }
};

const durableBody = (request: FastifyRequest, body: unknown): Record<string, unknown> => {
  const raw = headerValue(request.headers["idempotency-key"]);
  if (raw === undefined) {
    throw new DomainError(
      "INVALID_ARGUMENT",
      "Durable mutations require one Idempotency-Key header"
    );
  }
  const parsed = asObject(body);
  if (parsed.idempotencyKey !== undefined && parsed.idempotencyKey !== raw) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Body and Idempotency-Key header do not match"
    );
  }
  return { ...parsed, idempotencyKey: raw };
};

const execute = async <Name extends OperationName>(
  service: ApplicationService,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: Name,
  input: unknown,
  context: CommandContext = SYSTEM_CONTEXT
): Promise<FastifyReply> => {
  const envelope = await service.dispatch(operation, input, context, request.id);
  return sendEnvelope(reply, envelope);
};

const catchRouteError = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
  request.log.debug({ err: error }, "API request rejected");
  return sendEnvelope(reply, failureEnvelope(error));
};

interface ResolvedHumanCredential {
  readonly capability: HumanCapability;
  readonly actor: HumanActor;
}

const exactlyMatchesActor = (value: unknown, actor: HumanActor): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 4 &&
    keys.every((key) => ["type", "id", "displayName", "role"].includes(key)) &&
    candidate.type === actor.type &&
    candidate.id === actor.id &&
    candidate.displayName === actor.displayName &&
    candidate.role === actor.role
  );
};

const bindRequestActor = (
  body: Record<string, unknown>,
  binding: ResolvedHumanCredential
): Record<string, unknown> => {
  if (body.actor !== undefined && !exactlyMatchesActor(body.actor, binding.actor)) {
    throw new DomainError(
      "CAPABILITY_REQUIRED",
      "Request actor metadata does not match the credential-bound actor",
      { capability: binding.capability }
    );
  }
  return { ...body, actor: binding.actor };
};

export const API_OPERATION_ROUTES = [
  ["POST", "/api/v1/projects", "create_project"],
  ["POST", "/api/v1/projects/:projectId/runs", "start_design_run"],
  ["GET", "/api/v1/runs/:runId", "get_run_status"],
  ["GET", "/api/v1/runs/:runId/requirements", "inspect_requirements"],
  ["POST", "/api/v1/runs/:runId/requirements/approval", "approve_requirements"],
  ["POST", "/api/v1/runs/:runId/resume", "resume_run"],
  ["GET", "/api/v1/runs/:runId/artifacts", "list_artifacts"],
  ["GET", "/api/v1/runs/:runId/evidence", "inspect_evidence"],
  ["GET", "/api/v1/runs/:runId/engineering-practices", "inspect_engineering_practices"],
  ["POST", "/api/v1/runs/:runId/stages/:stage/rerun", "rerun_stage"],
  ["POST", "/api/v1/revisions/:revisionId/exports/candidate", "export_candidate_bundle"],
  ["POST", "/api/v1/revisions/:revisionId/exports/prototype", "export_prototype_bundle"],
  ["POST", "/api/v1/revisions/:revisionId/generations/bringup-plan", "generate_bringup_plan"],
  ["POST", "/api/v1/revisions/:revisionId/generations/firmware-scaffold", "generate_firmware_scaffold"]
] as const;

export const buildApiServer = async (options: ApiServerOptions): Promise<FastifyInstance> => {
  const humanCredentials = normalizeHumanCredentialBindings(options.humanCredentials);
  const app = Fastify({
    logger: options.logger === true
      ? {
          redact: {
            paths: [
              `req.headers['${HUMAN_CREDENTIAL_HEADER}']`,
              "req.headers['x-evleda-human-approval-token']"
            ],
            censor: "[REDACTED]"
          }
        }
      : false,
    logController: new LogController({ disableRequestLogging: true })
  });
  const allowedHosts = new Set(
    (options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS).map((entry) =>
      entry.toLocaleLowerCase("en-US")
    )
  );
  const allowedOrigins = new Set(
    (options.allowedOrigins ?? [
      "http://127.0.0.1:8765",
      "http://localhost:8765",
      "http://[::1]:8765",
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ]).map((entry) => new URL(entry).origin.toLocaleLowerCase("en-US"))
  );
  const trustedHumanCredential = async (
    request: FastifyRequest,
    requiredCapability?: HumanCapability
  ): Promise<ResolvedHumanCredential> => {
    const origin = headerValue(request.headers.origin);
    const normalized = origin === undefined ? undefined : normalizedOrigin(origin);
    if (normalized === undefined || !allowedOrigins.has(normalized)) {
      throw new DomainError(
        "CAPABILITY_REQUIRED",
        "Human-only operations require an exact trusted browser Origin",
        { origin: origin ?? null }
      );
    }
    const supplied = headerValue(request.headers[HUMAN_CREDENTIAL_HEADER]);
    if (supplied === undefined || supplied.length === 0) {
      throw new DomainError(
        "CAPABILITY_REQUIRED",
        "A valid local human capability credential is required",
        { capability: requiredCapability ?? null }
      );
    }
    const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest("hex");
    let matched: ResolvedHumanCredential | undefined;
    for (const capability of HUMAN_CAPABILITIES) {
      const configured = humanCredentials[capability];
      if (
        configured !== undefined &&
        sameDigest(suppliedDigest, configured.credentialDigest)
      ) {
        matched = { capability, actor: configured.actor };
      }
    }
    if (
      matched === undefined ||
      (requiredCapability !== undefined && matched.capability !== requiredCapability)
    ) {
      throw new DomainError(
        "CAPABILITY_REQUIRED",
        "A valid local human capability credential is required",
        { capability: requiredCapability ?? null }
      );
    }
    return matched;
  };

  app.addHook("onRequest", async (request, reply) => {
    const host = headerValue(request.headers.host);
    const hostname = host === undefined ? undefined : hostnameFromHostHeader(host);
    if (hostname === undefined || !allowedHosts.has(hostname)) {
      await reply.code(403).send(
        securityFailure("Host header is not in the local allowlist", { host: host ?? null })
      );
      return;
    }
    const origin = headerValue(request.headers.origin);
    if (origin !== undefined) {
      const exactOrigin = normalizedOrigin(origin);
      if (exactOrigin === undefined || !allowedOrigins.has(exactOrigin)) {
        await reply.code(403).send(
          securityFailure("Origin header is not in the local allowlist", { origin })
        );
        return;
      }
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'"
    );
  });

  app.get("/api/v1/health", async (request, reply) => {
    try {
      await options.service.initialize();
      return reply.send(
        successEnvelope("health", { status: "ok", service: "evleda", version: "0.1.0" }, request.id)
      );
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get("/api/v1/flux/readiness", async (request, reply) => {
    try {
      if (Reflect.ownKeys(request.query as object).length !== 0) {
        throw new DomainError("INVALID_ARGUMENT", "Flux readiness does not accept query parameters");
      }
      return reply.send({
        ok: true as const,
        operation: "flux_readiness" as const,
        requestId: request.id,
        result: options.fluxReadiness ?? createFluxSetupRequiredReadiness(),
      });
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get("/api/v1/projects", async (request, reply) => {
    try {
      const projects = await options.service.listProjects();
      return reply.send(successEnvelope("list_projects", { projects }, request.id));
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/runs",
    async (request, reply) => {
      try {
        const runs = await options.service.listRuns(request.params.projectId);
        return reply.send(
          successEnvelope(
            "list_runs",
            { projectId: request.params.projectId, runs },
            request.id
          )
        );
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post("/api/v1/projects", async (request, reply) => {
    try {
      return await execute(
        options.service,
        request,
        reply,
        "create_project",
        durableBody(request, request.body)
      );
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/runs",
    async (request, reply) => {
      try {
        return await execute(
          options.service,
          request,
          reply,
          "start_design_run",
          {
            ...durableBody(request, request.body),
            projectId: request.params.projectId
          }
        );
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", async (request, reply) =>
    execute(options.service, request, reply, "get_run_status", { runId: request.params.runId })
  );

  app.get<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId/requirements",
    async (request, reply) =>
      execute(options.service, request, reply, "inspect_requirements", {
        runId: request.params.runId
      })
  );

  app.post<{ Params: { runId: string } }>(
    "/api/v1/runs/:runId/requirements/approval",
    async (request, reply) => {
      try {
        const binding = await trustedHumanCredential(request, "requirements_approval");
        const input = approveRequirementsInputSchema.parse({
          ...bindRequestActor(durableBody(request, request.body), binding),
          runId: request.params.runId
        });
        const context = localHumanContext(binding.actor, binding.capability);
        return execute(options.service, request, reply, "approve_requirements", input, context);
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { runId: string } }>("/api/v1/runs/:runId/resume", async (request, reply) => {
    try {
      return await execute(options.service, request, reply, "resume_run", {
        ...durableBody(request, request.body),
        runId: request.params.runId
      });
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get<{
    Params: { runId: string };
    Querystring: {
      revisionId?: string;
      stage?: string;
      includeStale?: string | boolean;
    };
  }>("/api/v1/runs/:runId/artifacts", async (request, reply) => {
    try {
      return await execute(options.service, request, reply, "list_artifacts", {
        runId: request.params.runId,
        ...(request.query.revisionId === undefined ? {} : { revisionId: request.query.revisionId }),
        ...(request.query.stage === undefined ? {} : { stage: request.query.stage }),
        includeStale: explicitBooleanQuery(request.query.includeStale, "includeStale")
      });
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get<{
    Params: { runId: string };
    Querystring: {
      revisionId?: string;
      evidenceId?: string;
      stage?: string;
      includeStale?: string | boolean;
    };
  }>("/api/v1/runs/:runId/evidence", async (request, reply) => {
    try {
      return await execute(options.service, request, reply, "inspect_evidence", {
        runId: request.params.runId,
        ...(request.query.revisionId === undefined ? {} : { revisionId: request.query.revisionId }),
        ...(request.query.evidenceId === undefined ? {} : { evidenceId: request.query.evidenceId }),
        ...(request.query.stage === undefined ? {} : { stage: request.query.stage }),
        includeStale: explicitBooleanQuery(request.query.includeStale, "includeStale")
      });
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.get<{
    Params: { runId: string };
    Querystring: {
      revisionId?: string;
      findingCursor?: string;
      findingLimit?: string | number;
    };
  }>("/api/v1/runs/:runId/engineering-practices", async (request, reply) => {
    try {
      assertExactQueryParameters(request.query, [
        "revisionId",
        "findingCursor",
        "findingLimit"
      ]);
      const findingLimit = explicitPositiveIntegerQuery(
        request.query.findingLimit,
        "findingLimit"
      );
      return await execute(
        options.service,
        request,
        reply,
        "inspect_engineering_practices",
        {
          runId: request.params.runId,
          ...(request.query.revisionId === undefined
            ? {}
            : { revisionId: request.query.revisionId }),
          ...(request.query.findingCursor === undefined
            ? {}
            : { findingCursor: request.query.findingCursor }),
          ...(findingLimit === undefined ? {} : { findingLimit })
        }
      );
    } catch (error) {
      return catchRouteError(request, reply, error);
    }
  });

  app.post<{ Params: { runId: string; stage: string } }>(
    "/api/v1/runs/:runId/stages/:stage/rerun",
    async (request, reply) => {
      try {
        return await execute(options.service, request, reply, "rerun_stage", {
          ...durableBody(request, request.body),
          runId: request.params.runId,
          stage: request.params.stage
        });
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/exports/candidate",
    async (request, reply) => {
      try {
        return await execute(options.service, request, reply, "export_candidate_bundle", {
          ...durableBody(request, request.body),
          revisionId: request.params.revisionId
        });
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/external-evidence",
    { bodyLimit: EXTERNAL_EVIDENCE_REQUEST_MAX_BYTES },
    async (request, reply) => {
      try {
        const binding = await trustedHumanCredential(request, "hardware_qualification");
        const input = submitExternalEvidenceInputSchema.parse({
          ...bindRequestActor(durableBody(request, request.body), binding),
          revisionId: request.params.revisionId
        });
        const context = localHumanContext(binding.actor, binding.capability);
        const result = await options.service.submitExternalEvidence(input, context);
        return reply.send(successEnvelope("submit_external_evidence", result, request.id));
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/qualification",
    async (request, reply) => {
      try {
        const binding = await trustedHumanCredential(request, "hardware_qualification");
        const input = qualifyRevisionInputSchema.parse({
          ...bindRequestActor(durableBody(request, request.body), binding),
          revisionId: request.params.revisionId
        });
        const context = localHumanContext(binding.actor, binding.capability);
        const result = await options.service.qualifyRevision(input, context);
        return reply.send(successEnvelope("qualify_revision", result, request.id));
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/manufacturing-release",
    async (request, reply) => {
      try {
        const binding = await trustedHumanCredential(request, "manufacturing_release");
        const input = authorizeManufacturingReleaseInputSchema.parse({
          ...bindRequestActor(durableBody(request, request.body), binding),
          revisionId: request.params.revisionId
        });
        const context = localHumanContext(binding.actor, binding.capability);
        const result = await options.service.authorizeManufacturingRelease(input, context);
        return reply.send(
          successEnvelope("authorize_manufacturing_release", result, request.id)
        );
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { approvalId: string } }>(
    "/api/v1/attestations/:approvalId/revocation",
    async (request, reply) => {
      try {
        const binding = await trustedHumanCredential(request);
        const input = revokeAttestationInputSchema.parse({
          ...bindRequestActor(durableBody(request, request.body), binding),
          approvalId: request.params.approvalId
        });
        const context = localHumanContext(binding.actor, binding.capability);
        const result = await options.service.revokeAttestation(input, context);
        return reply.send(successEnvelope("revoke_attestation", result, request.id));
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/exports/prototype",
    async (request, reply) => {
      try {
        return await execute(options.service, request, reply, "export_prototype_bundle", {
          ...durableBody(request, request.body),
          revisionId: request.params.revisionId
        });
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/generations/bringup-plan",
    async (request, reply) => {
      try {
        return await execute(options.service, request, reply, "generate_bringup_plan", {
          ...durableBody(request, request.body),
          revisionId: request.params.revisionId
        });
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.post<{ Params: { revisionId: string } }>(
    "/api/v1/revisions/:revisionId/generations/firmware-scaffold",
    async (request, reply) => {
      try {
        return await execute(options.service, request, reply, "generate_firmware_scaffold", {
          ...durableBody(request, request.body),
          revisionId: request.params.revisionId
        });
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  app.get<{ Params: { artifactId: string } }>(
    "/api/v1/artifacts/:artifactId/content",
    async (request, reply) => {
      try {
        const { artifact, bytes } = await options.service.readArtifact(request.params.artifactId);
        reply.type(artifact.mediaType);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${safeDownloadName(artifact.logicalName)}"`
        );
        reply.header("ETag", `"sha256:${artifact.blob.digest}"`);
        return reply.send(bytes);
      } catch (error) {
        return catchRouteError(request, reply, error);
      }
    }
  );

  await registerFluxRoutes(app, options.flux);

  const uiRoot = path.resolve(options.uiRoot ?? path.join(process.cwd(), "ui", "dist"));
  try {
    await access(path.join(uiRoot, "index.html"));
    await app.register(fastifyStatic, {
      root: uiRoot,
      prefix: "/",
      wildcard: false,
      index: ["index.html"],
      list: false
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send(
          failureEnvelope(new DomainError("NOT_FOUND", "API route was not found"))
        );
      }
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    });
  } catch {
    app.setNotFoundHandler(async (_request, reply) =>
      reply.code(404).send(failureEnvelope(new DomainError("NOT_FOUND", "Route was not found")))
    );
  }

  return app;
};

const isLoopbackHost = (host: string): boolean => host === "127.0.0.1" || host === "::1" || host.toLocaleLowerCase("en-US") === "localhost";
const parsePort = (value: string | undefined): number => {
  const port = value === undefined ? 8765 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("EVLEDA_PORT must be an integer from 1 through 65535");
  return port;
};

export interface LocalApiServerDependencies {
  readonly fluxProduction?: FluxProductionCompositionDependencies;
}

/** Compose the local daemon while leaving Flux unavailable unless its complete production profile is bound. */
export const createLocalApiServer = async (
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: LocalApiServerDependencies = {},
) => {
  const humanCredentials = loadHumanCredentialBindingsFromEnvironment(environment);
  const host = environment.EVLEDA_HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host)) throw new Error("EvlEDA refuses a non-loopback EVLEDA_HOST without an authenticated remote-listener implementation");
  const port = parsePort(environment.EVLEDA_PORT);
  const paths = resolveProductionApplicationPaths(environment, process.cwd());
  const fluxSource = environment.EVLEDA_FLUX_SOURCE_ROOT;
  const fluxWorkspace = environment.EVLEDA_FLUX_WORKSPACE_ROOT;
  const profileConfigured = [
    environment.EVLEDA_FLUX_PRODUCTION_PROFILE_PATH,
    environment.EVLEDA_FLUX_PRODUCTION_PROFILE_SHA256,
    environment.EVLEDA_FLUX_PRODUCTION_PROFILE_SIZE_BYTES,
  ].some((value) => value !== undefined);
  if ((fluxSource === undefined) !== (fluxWorkspace === undefined)) {
    throw new FluxProductionCompositionError("ROOTS_INCOMPLETE");
  }
  if (fluxSource === undefined && profileConfigured) {
    throw new FluxProductionCompositionError("ROOTS_INCOMPLETE");
  }
  // This complete read-only preflight deliberately precedes application-store
  // construction, which may create durable data/workspace directories.
  let production: Awaited<ReturnType<typeof loadFluxProductionComposition>> | undefined;
  let fluxReadiness = createFluxSetupRequiredReadiness();
  if (fluxSource !== undefined) {
    try {
      production = await loadFluxProductionComposition(environment, dependencies.fluxProduction);
      fluxReadiness = production.readiness;
    } catch (error) {
      if (!(error instanceof FluxProductionCompositionError)
        || ![
          "CODEX_LOCAL_READ_ACK_REQUIRED",
          "CODEX_CONFIG_INCOMPATIBLE",
          "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED",
          "KICAD_PROCESS_TERMINATION_UNCONFIRMED",
          "KICAD_TOOLCHAIN_UNAVAILABLE",
          "KICAD_MCP_RUNTIME_UNAVAILABLE",
        ].includes(error.reasonCode)) throw error;
      // These closed pre-runtime failures are safe setup states, never
      // authority to instantiate the interpreter/runtime.
      if (error.reasonCode === "CODEX_CONFIG_INCOMPATIBLE") {
        if (error.evidenceIdentity === undefined) throw error;
        fluxReadiness = createFluxSetupRequiredReadiness(
          [error.reasonCode],
          createFluxDiagnostic(error.reasonCode, {
            boundary: "codex_configuration_preflight",
            result: "incompatible",
            preflightEvidence: error.evidenceIdentity,
          }),
        );
      } else if (error.reasonCode === "PROVIDER_PROCESS_TERMINATION_UNCONFIRMED") {
        if (error.evidenceIdentity === undefined) throw error;
        fluxReadiness = createFluxSetupRequiredReadiness(
          [error.reasonCode],
          createFluxDiagnostic("PROVIDER_REQUEST_FAILED", {
            boundary: "provider_startup_probe",
            result: "termination_unconfirmed",
            probeEvidence: error.evidenceIdentity,
          }),
        );
      } else if (error.reasonCode === "KICAD_PROCESS_TERMINATION_UNCONFIRMED") {
        if (error.evidenceIdentity === undefined) throw error;
        fluxReadiness = createFluxSetupRequiredReadiness(
          [error.reasonCode],
          createFluxDiagnostic("TOOLCHAIN_FAILURE", {
            boundary: "kicad_readiness_probe",
            result: "termination_unconfirmed",
            probeEvidence: error.evidenceIdentity,
          }),
        );
      } else {
        fluxReadiness = createFluxSetupRequiredReadiness([error.reasonCode]);
      }
    }
  }
  const service = await createProductionApplicationService({ paths, environment });
  const flux = production === undefined ? undefined : await production.createRuntime();
  const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
  const sourceUiRoot = path.resolve(moduleRoot, "../../ui/dist");
  const builtUiRoot = path.resolve(moduleRoot, "../../../ui/dist");
  const app = await buildApiServer({
    service,
    uiRoot: existsSync(path.join(sourceUiRoot, "index.html")) ? sourceUiRoot : builtUiRoot,
    logger: true,
    humanCredentials,
    ...(flux === undefined ? {} : { flux: flux.routes }),
    fluxReadiness,
    allowedOrigins: environment.EVLEDA_ALLOWED_ORIGINS === undefined ? [
      `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
      `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
      "http://localhost:5173", "http://127.0.0.1:5173",
    ] : environment.EVLEDA_ALLOWED_ORIGINS.split(",").map((entry) => entry.trim()).filter(Boolean),
  });
  return { app, host, port, flux };
};
