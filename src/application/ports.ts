import type {
  CommittedStateTransaction,
  EvlEdaState,
  MutableEvlEdaState
} from "../persistence/state-store.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import type { StageRegistryContract } from "../workflow/contracts.js";
import type {
  AuditEnvelope,
  AuditEvent,
  AuditOutboxSnapshot
} from "../persistence/audit-log.js";
import type { DesignRevision, DesignRun, Project } from "../domain/types.js";
import type { StageKey } from "../domain/stages.js";
import type { CandidateStageContext } from "../workflow/contracts.js";

export const STAGE_PROVISION_SCHEMA = "evleda.stage-provision.v1" as const;
export const STAGE_CONTEXT_ENRICHMENT_SCHEMA = "evleda.stage-context-enrichment.v1" as const;

export interface StateStorePort {
  readonly root: string;
  initialize(): Promise<void>;
  read(): Promise<EvlEdaState>;
  /**
   * Resolution is a fully successful commit. A CommittedStateTransactionError rejection
   * carries a linearized commit that needs post-commit repair; every other rejection is
   * definitely not committed.
   */
  transaction<Result>(
    expectedRevision: number | undefined,
    mutate: (state: MutableEvlEdaState) => Result | Promise<Result>
  ): Promise<CommittedStateTransaction<Result>>;
}

export interface ContentStorePort {
  readonly root: string;
  initialize(): Promise<void>;
  put(bytes: Uint8Array | string, expected?: ContentIdentity): Promise<ContentIdentity>;
  putJson(value: unknown): Promise<ContentIdentity>;
  get(identity: ContentIdentity): Promise<Buffer>;
  verify(identity: ContentIdentity): Promise<boolean>;
}

export interface AuditLogPort {
  readonly root: string;
  append(event: AuditEvent): Promise<AuditEnvelope>;
  drain(loadSnapshot: () => Promise<AuditOutboxSnapshot>): Promise<readonly AuditEnvelope[]>;
  readAndVerify(): Promise<readonly AuditEnvelope[]>;
}

export interface StageContextProviderRequest {
  readonly project: Project;
  readonly run: DesignRun;
  readonly revision: DesignRevision;
  readonly stage: Exclude<StageKey, "requirements">;
}

export type StageContextEnrichment = Pick<
  CandidateStageContext,
  | "profile"
  | "curatedDatasheets"
  | "sourcing"
  | "lifecycleObservations"
  | "pinPadMappingReviews"
  | "footprintLibrary"
  | "kicadBackend"
  | "simulationBackend"
  | "firmwareCompileBackend"
  | "firmwareCompileConfiguration"
  | "firmwareTargetBuildBackend"
  | "firmwareTargetBuildConfiguration"
>;

export interface StageProvisionManifest {
  readonly schemaVersion: typeof STAGE_PROVISION_SCHEMA;
  readonly request: {
    readonly projectId: string;
    readonly projectPolicyVersion: string;
    readonly runId: string;
    readonly workflowVersion: string;
    readonly configuration: CanonicalIdentity;
    readonly revisionId: string;
    readonly revisionManifest: CanonicalIdentity;
    readonly stage: Exclude<StageKey, "requirements">;
  };
  /** Identity of the serializable enrichment fields returned beside this manifest. */
  readonly enrichmentIdentity: CanonicalIdentity;
  readonly backends: {
    readonly kicad: { readonly backendId: string } | null;
    readonly simulation: { readonly backendId: string } | null;
    readonly firmwareCompile: {
      readonly backendId: string;
      readonly configurationIdentity: CanonicalIdentity;
    } | null;
    readonly firmwareTargetBuild?: {
      readonly backendId: string;
      readonly configurationIdentity: CanonicalIdentity;
    } | null;
  };
  /** Provider-specific captured provenance. It must remain canonical JSON, never executable state. */
  readonly providerEvidence: unknown;
}

export type StageContextProvision = StageContextEnrichment & {
  /**
   * Canonical identity of every provisioned profile, source snapshot, and backend/tool
   * configuration that can affect this stage. Functions themselves are never hashed.
   */
  readonly provisionIdentity: CanonicalIdentity;
  /** Exact canonical preimage for provisionIdentity; the application persists it in CAS. */
  readonly provisionManifest: StageProvisionManifest;
};

export interface StageContextProvider {
  provide(request: StageContextProviderRequest): Promise<StageContextProvision>;
}

export interface ApplicationPorts {
  readonly state: StateStorePort;
  readonly content: ContentStorePort;
  readonly audit?: AuditLogPort;
  readonly stages?: StageRegistryContract;
  readonly stageContext?: StageContextProvider;
}
