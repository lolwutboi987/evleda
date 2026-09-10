import { open } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  STAGE_CONTEXT_ENRICHMENT_SCHEMA,
  STAGE_PROVISION_SCHEMA,
  type StageContextProvider,
  type StageContextProviderRequest,
  type StageContextProvision,
} from "../application/ports.js";
import { canonicalIdentity, canonicalJson, contentIdentity, sha256 } from "../core/canonical.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceComponent,
  type ReferenceComponentKey,
  type ReferenceControllerProfile,
} from "../knowledge/reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH,
  reverifyReferenceControllerRevANativeAuthority,
  snapshotReferenceControllerRevANativeAuthority,
  type ReferenceControllerRevANativeAuthoritySnapshot,
} from "../knowledge/reference-controller-native-contract.js";
import {
  FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
  FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
  FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
  FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
  type FirmwareCompileBackend,
  type FirmwareTargetBuildBackend,
  type KicadGenerationBackend,
  type SimulationBackend,
} from "../workflow/contracts.js";
import {
  LocalFirmwareCompileBackend,
  type LocalFirmwareCompileBackendOptions,
} from "./firmware-compiler.js";
import {
  createArmGnuFirmwareTargetBuildBackend,
  type ArmGnuFirmwareTargetBuildBackendOptions,
} from "./firmware-target-builder.js";
import {
  DEFAULT_KICAD_10_CLI_PATH,
  KicadCliAdapter,
  type KicadExecutableIdentity,
} from "./kicad-cli.js";
import {
  assertDisjointDirectories,
  isPathWithin,
  resolveConfinedExistingFile,
  resolveExistingDirectory,
  resolveExistingFile,
} from "./path-boundary.js";
import {
  REFERENCE_KICAD_BACKEND_ID,
  REFERENCE_KICAD_VERSION,
  REFERENCE_VALIDATION_SCHEMA,
  ReferenceKicadBackend,
  type ReferenceKicadBackendOptions,
} from "./reference-kicad-backend.js";
import {
  REFERENCE_SIMULATION_BACKEND_ID,
  REFERENCE_SIMULATION_MODEL_SCHEMA,
  REFERENCE_SIMULATION_MODEL_VERSION,
  ReferenceSimulationBackend,
} from "./reference-simulation.js";

export const REFERENCE_STAGE_CONTEXT_SCHEMA = "evleda.reference-stage-context.v1";
export const SOURCE_CAPTURE_SCHEMA = "evleda.source-capture.v1";
export const SOURCE_EXTRACTION_SCHEMA = "evleda.source-extraction.v1";
export const PDF_PAGE_EXTRACTION_SCHEMA = "evleda.pdf-page-extraction.v1";
export const PIN_PAD_MAPPING_SCHEMA = "evleda.pin-pad-mapping.v1";
export const PIN_PAD_MAPPING_REVIEW_SCHEMA = "evleda.pin-pad-mapping-review.v1";
export const COMPONENT_EVIDENCE_REVIEWER_SCHEMA = "evleda.component-evidence-reviewer.v1";
export const REFERENCE_CONTEXT_TRUST_ROOT_SCHEMA = "evleda.reference-context-trust-root.v1";
export const FOOTPRINT_LIBRARY_CAPTURE_SCHEMA = "evleda.footprint-library-capture.v1";
export const FOOTPRINT_LIBRARY_SNAPSHOT_SCHEMA = "evleda.footprint-library-snapshot.v1";
export { STAGE_PROVISION_SCHEMA } from "../application/ports.js";
export const KICAD_BACKEND_CONFIGURATION_SCHEMA = "evleda.reference-kicad-backend-config.v1";
export const SIMULATION_BACKEND_CONFIGURATION_SCHEMA = "evleda.reference-simulation-backend-config.v1";

const DAY_MS = 24 * 60 * 60 * 1_000;
export const REFERENCE_CONTEXT_MAX_TTL_MS = Object.freeze({
  datasheet: 366 * DAY_MS,
  sourcing: 7 * DAY_MS,
  lifecycle: 90 * DAY_MS,
  pinPadMapping: 366 * DAY_MS,
  footprintLibrary: 366 * DAY_MS,
});
export const REFERENCE_CONTEXT_RESOURCE_LIMITS = Object.freeze({
  snapshotBytes: 4 * 1024 * 1024,
  trustRootBytes: 1024 * 1024,
  structuredDocumentBytes: 2 * 1024 * 1024,
  rawCaptureBytes: 32 * 1024 * 1024,
  footprintAssetBytes: 8 * 1024 * 1024,
  referenceValidationBytes: 8 * 1024 * 1024,
  referenceBindingBytes: 64 * 1024 * 1024,
  totalProvisionBytes: 512 * 1024 * 1024,
  maximumComponents: 64,
  maximumFootprintAssets: 2_048,
  maximumMappings: 4_096,
  maximumLocators: 8_192,
});

const REQUIRED_REFERENCE_SOURCE_PATHS = Object.freeze([
  "fp-lib-table",
  "robotics-controller-v0.kicad_pcb",
  "robotics-controller-v0.kicad_pro",
  "robotics-controller-v0.kicad_sch",
  "sym-lib-table",
] as const);

const KICAD_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "KICAD_CONFIG_HOME",
  "KICAD10_SYMBOL_DIR",
  "KICAD10_FOOTPRINT_DIR",
  "KICAD10_3DMODEL_DIR",
  "KICAD10_TEMPLATE_DIR",
  "KICAD10_USER_TEMPLATE_DIR",
] as const);

export const normalizeKicadChildEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const selected: Record<string, string> = {};
  for (const allowedKey of KICAD_ENVIRONMENT_KEYS) {
    const match = Object.entries(environment).find(
      ([key, value]) =>
        value !== undefined &&
        key.toLocaleUpperCase("en-US") === allowedKey.toLocaleUpperCase("en-US"),
    );
    if (match?.[1] !== undefined) {
      if (match[1].includes("\0")) {
        throw new DomainError("INVALID_ARGUMENT", `${allowedKey} must not contain NUL bytes.`);
      }
      selected[allowedKey] = match[1];
    }
  }
  return Object.freeze(selected);
};

const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const contentIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: sha256DigestSchema,
    size: z.number().int().positive(),
  })
  .strict();
const canonicalIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: sha256DigestSchema,
    schemaVersion: z.string().min(1),
    canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
  })
  .strict();
const timestampSchema = z.iso.datetime({ offset: true });
const httpUrlSchema = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}, "must use HTTP or HTTPS");
const relativeFileReferenceSchema = z
  .object({
    path: z.string().min(1).refine((value) => !path.isAbsolute(value), "must be relative"),
    identity: contentIdentitySchema,
  })
  .strict();
const toolIdentitySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    adapter: z.enum(["evleda", "kicad_cli", "kicad_mcp", "external"]),
    executableDigest: sha256DigestSchema,
    capabilityProfile: z.string().min(1),
  })
  .strict();
const reviewerIdentitySchema = z
  .object({
    type: z.literal("human"),
    id: z.string().min(1),
    displayName: z.string().min(1),
    role: z.literal("component_evidence_reviewer"),
    authorityIdentity: canonicalIdentitySchema,
  })
  .strict();
const claimLocatorSchema = z
  .object({
    kind: z.enum(["json_pointer", "css_selector", "pdf_page_text", "text_range"]),
    value: z.string().min(1),
    excerpt: z.string().min(1),
    excerptSha256: sha256DigestSchema,
  })
  .strict();

const sourceCategorySchema = z.enum(["datasheet", "sourcing", "lifecycle"]);
const sourceCaptureSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_CAPTURE_SCHEMA),
    category: sourceCategorySchema,
    component: z.string().min(1),
    sourceUrl: httpUrlSchema,
    observedAt: timestampSchema,
    validUntil: timestampSchema,
    raw: relativeFileReferenceSchema,
    tool: toolIdentitySchema,
  })
  .strict();
const orderCodeFieldSchema = z
  .object({
    position: z.number().int().min(0).max(6),
    field: z.enum([
      "product_family",
      "product_series",
      "product_line",
      "pin_count",
      "flash_density",
      "package",
      "temperature_grade",
    ]),
    code: z.string().regex(/^[A-Za-z0-9]+$/u),
    meaning: z.string().min(1),
    codeLocator: claimLocatorSchema,
    meaningLocator: claimLocatorSchema,
  })
  .strict();
const extractionClaimSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("datasheet"),
      manufacturerPartNumber: z.string().min(1),
      documentTitle: z.string().min(1),
      orderCodeEvidence: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("exact_order_code"),
            orderCode: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/u),
          })
          .strict(),
        z
          .object({
            kind: z.literal("documented_order_code_fields"),
            familySummary: z
              .object({
                token: z.literal("STM32G0B1xB/xC/xE"),
                locator: claimLocatorSchema,
              })
              .strict(),
            pinoutSummary: z
              .object({
                token: z.literal("STM32G0B1CxT"),
                locator: claimLocatorSchema,
              })
              .strict(),
            pinCountSupport: z.tuple([
              z
                .object({ token: z.literal("48-pin"), locator: claimLocatorSchema })
                .strict(),
              z
                .object({ token: z.literal("LQFP48 pinout"), locator: claimLocatorSchema })
                .strict(),
            ]),
            orderingTable: z
              .object({
                token: z.literal("STM32 G 0B1 R E T 6 xyy"),
                locator: claimLocatorSchema,
              })
              .strict(),
            fields: z.array(orderCodeFieldSchema).length(7),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sourcing"),
      manufacturerPartNumber: z.string().min(1),
      supplier: z.string().min(1),
      availability: z.enum(["in_stock", "not_available", "unknown"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("lifecycle"),
      manufacturerPartNumber: z.string().min(1),
      status: z.enum(["active", "nrnd", "obsolete", "unknown"]),
    })
    .strict(),
]);
const normalizationSchema = z.discriminatedUnion("field", [
  z
    .object({
      field: z.literal("availability"),
      rawValue: z.string().min(1),
      normalizedValue: z.enum(["in_stock", "not_available", "unknown"]),
      rule: z.enum([
        "evleda.availability.in-stock.v1",
        "evleda.availability.out-of-stock.v1",
        "evleda.availability.unknown.v1",
      ]),
      locator: claimLocatorSchema,
    })
    .strict(),
  z
    .object({
      field: z.literal("lifecycle"),
      rawValue: z.string().min(1),
      normalizedValue: z.enum(["active", "nrnd", "obsolete", "unknown"]),
      rule: z.enum([
        "evleda.lifecycle.active.v1",
        "evleda.lifecycle.nrnd.v1",
        "evleda.lifecycle.obsolete.v1",
        "evleda.lifecycle.unknown.v1",
      ]),
      locator: claimLocatorSchema,
    })
    .strict(),
]);
const pdfPageExtractionSchema = z
  .object({
    schemaVersion: z.literal(PDF_PAGE_EXTRACTION_SCHEMA),
    pdfIdentity: contentIdentitySchema,
    pageIndex: z.number().int().nonnegative(),
    pageNumbering: z.literal("zero_based_pdf_index"),
    text: relativeFileReferenceSchema,
    tool: toolIdentitySchema,
  })
  .strict();
const sourceExtractionSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_EXTRACTION_SCHEMA),
    category: sourceCategorySchema,
    component: z.string().min(1),
    captureIdentity: contentIdentitySchema,
    rawIdentity: contentIdentitySchema,
    extractedAt: timestampSchema,
    locators: z.array(claimLocatorSchema).min(1).max(32),
    normalizations: z.array(normalizationSchema).max(4),
    pdfPageExtractions: z.array(relativeFileReferenceSchema).max(64),
    claim: extractionClaimSchema,
    tool: toolIdentitySchema,
    authority: z.enum(["machine_derived", "human_accepted"]),
    review: z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        reviewedAt: timestampSchema,
        reviewer: reviewerIdentitySchema,
      })
      .strict()
      .optional(),
  })
  .strict();
const pinPadMappingSchema = z
  .object({
    schemaVersion: z.literal(PIN_PAD_MAPPING_SCHEMA),
    component: z.string().min(1),
    symbol: z.string().min(1),
    footprint: z.string().min(1),
    createdAt: timestampSchema,
    sources: z
      .object({
        datasheetIdentity: contentIdentitySchema,
        symbolIdentity: contentIdentitySchema,
        footprintIdentity: contentIdentitySchema,
      })
      .strict(),
    symbolPins: z.array(z.string().min(1)).min(1).max(4_096),
    footprintPads: z.array(z.string().min(1)).min(1).max(4_096),
    mappings: z
      .array(
        z
          .object({
            pin: z.string().min(1),
            pad: z.string().min(1),
            datasheetLocator: claimLocatorSchema,
            symbolLocator: claimLocatorSchema,
            footprintLocator: claimLocatorSchema,
          })
          .strict(),
      )
      .min(1)
      .max(4_096),
    tool: toolIdentitySchema,
  })
  .strict();
const pinPadMappingReviewSchema = z
  .object({
    schemaVersion: z.literal(PIN_PAD_MAPPING_REVIEW_SCHEMA),
    component: z.string().min(1),
    symbol: z.string().min(1),
    footprint: z.string().min(1),
    mappingIdentity: contentIdentitySchema,
    observedAt: timestampSchema,
    validUntil: timestampSchema,
    decision: z.enum(["pending", "reviewed", "mismatch"]),
    locators: z.array(claimLocatorSchema).min(2).max(8_192),
    reviewer: reviewerIdentitySchema.optional(),
  })
  .strict();
const footprintLibraryCaptureSchema = z
  .object({
    schemaVersion: z.literal(FOOTPRINT_LIBRARY_CAPTURE_SCHEMA),
    libraryId: z.string().min(1),
    observedAt: timestampSchema,
    validUntil: timestampSchema,
    catalogLocator: claimLocatorSchema,
    tool: toolIdentitySchema,
    assets: z
      .array(
        z
          .object({
            footprint: z.string().min(1),
            file: relativeFileReferenceSchema,
          })
          .strict(),
      )
      .min(1)
      .max(2_048),
  })
  .strict();
const evidencePairSchema = z
  .object({
    capture: relativeFileReferenceSchema,
    extraction: relativeFileReferenceSchema,
  })
  .strict();
const stageContextSnapshotSchema = z
  .object({
    schemaVersion: z.literal(REFERENCE_STAGE_CONTEXT_SCHEMA),
    profile: z
      .object({
        profileId: z.string().min(1),
        boardRevision: z.string().min(1),
        identity: canonicalIdentitySchema,
      })
      .strict(),
    components: z
      .array(
        z
          .object({
            component: z.string().min(1),
            datasheet: evidencePairSchema,
            sourcing: evidencePairSchema,
            lifecycle: evidencePairSchema,
            pinPadMapping: z
              .object({
                symbolSource: relativeFileReferenceSchema,
                mapping: relativeFileReferenceSchema,
                review: relativeFileReferenceSchema,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    footprintLibrary: relativeFileReferenceSchema,
  })
  .strict();

const trustRootSchema = z
  .object({
    schemaVersion: z.literal(REFERENCE_CONTEXT_TRUST_ROOT_SCHEMA),
    trustRootId: z.string().min(1),
    tools: z.array(toolIdentitySchema).min(1).max(64),
    reviewerAuthorities: z.array(canonicalIdentitySchema).max(64),
  })
  .strict();

export type ReferenceStageContextSnapshot = z.infer<typeof stageContextSnapshotSchema>;

const referenceFileBindingSchema = z
  .object({
    path: z.string().min(1),
    sha256: sha256DigestSchema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .passthrough();
const referenceValidationSchema = z
  .object({
    schemaVersion: z.literal(REFERENCE_VALIDATION_SCHEMA),
    validationRoot: canonicalIdentitySchema,
    executable: z
      .object({
        version: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{7,64}$/iu),
        sha256: sha256DigestSchema,
        sizeBytes: z.number().int().positive(),
        capabilityHelpSha256: sha256DigestSchema,
      })
      .passthrough(),
    sourceBindings: z.array(referenceFileBindingSchema).min(1),
  })
  .passthrough();

type SourceCategory = z.infer<typeof sourceCategorySchema>;
type SourceCaptureDocument = z.infer<typeof sourceCaptureSchema>;
type SourceExtractionDocument = z.infer<typeof sourceExtractionSchema>;
type TrustRootDocument = z.infer<typeof trustRootSchema>;
interface StableFile {
  readonly path: string;
  readonly bytes: Buffer;
  readonly identity: ContentIdentity;
}

class ProvisionResourceBudget {
  readonly #seen = new Map<string, number>();
  #totalBytes = 0;

  public record(file: StableFile): void {
    const previous = this.#seen.get(file.path);
    if (previous !== undefined) {
      if (previous !== file.identity.size) {
        throw retryable("EVIDENCE_STALE", `${file.path} changed size during provisioning.`);
      }
      return;
    }
    this.#seen.set(file.path, file.identity.size);
    this.#totalBytes += file.identity.size;
    if (this.#totalBytes > REFERENCE_CONTEXT_RESOURCE_LIMITS.totalProvisionBytes) {
      throw retryable("EVIDENCE_STALE", "Stage-context inputs exceed the total byte limit.", {
        maximumBytes: REFERENCE_CONTEXT_RESOURCE_LIMITS.totalProvisionBytes,
        actualBytes: this.#totalBytes,
      });
    }
  }
}

interface LoadedJson<Document> {
  readonly file: StableFile;
  readonly document: Document;
}

interface LoadedSourceEvidence {
  readonly capture: LoadedJson<SourceCaptureDocument>;
  readonly raw: StableFile;
  readonly extraction: LoadedJson<SourceExtractionDocument>;
  readonly pdfPages: readonly {
    readonly extraction: LoadedJson<z.infer<typeof pdfPageExtractionSchema>>;
    readonly text: StableFile;
  }[];
}

interface LoadedReferenceValidation {
  readonly file: StableFile;
  readonly validationRoot: CanonicalIdentity;
  readonly executable: {
    readonly version: string;
    readonly commit: string;
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly capabilityHelpSha256: string;
  };
  readonly bindings: readonly {
    readonly path: string;
    readonly identity: ContentIdentity;
  }[];
}

interface LoadedTrustRoot {
  readonly file: StableFile;
  readonly document: TrustRootDocument;
}

export interface ReferenceStageContextProviderOptions {
  readonly snapshotPath: string;
  readonly sourceRoot?: string;
  readonly trustRoot?: {
    readonly path: string;
    readonly identity: ContentIdentity;
  };
  readonly referenceDesignRoot: string;
  readonly kicadWorkRoot: string;
  readonly kicadExecutableCandidates?: readonly string[];
  readonly kicadExecutablePath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** Hermetic-test seams. Production composition does not supply these. */
  readonly profile?: ReferenceControllerProfile;
  readonly discoverKicadExecutableIdentity?: (
    candidate: string,
  ) => Promise<KicadExecutableIdentity>;
  readonly createKicadBackend?: (options: ReferenceKicadBackendOptions) => KicadGenerationBackend;
  readonly createSimulationBackend?: () => SimulationBackend;
  readonly createFirmwareCompileBackend?: (
    options: LocalFirmwareCompileBackendOptions,
  ) => FirmwareCompileBackend;
  readonly createFirmwareTargetBuildBackend?: (
    options: ArmGnuFirmwareTargetBuildBackendOptions,
  ) => FirmwareTargetBuildBackend | Promise<FirmwareTargetBuildBackend>;
}

const retryable = (
  code: DomainErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): DomainError => new DomainError(code, message, details, true);

const identityEqual = (left: ContentIdentity, right: ContentIdentity): boolean =>
  left.algorithm === right.algorithm && left.digest === right.digest && left.size === right.size;

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Readonly<Record<string, unknown>>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const immutableClone = <Value>(value: Value): Value => deepFreeze(structuredClone(value));

type StableStat = Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;

const sameStableStat = (left: StableStat, right: StableStat): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const readStableFile = async (
  filePath: string,
  label: string,
  maximumBytes: number,
  budget: ProvisionResourceBudget,
): Promise<StableFile> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("not a regular file");
    if (before.size > maximumBytes) {
      throw retryable("EVIDENCE_STALE", `${label} exceeds its byte limit.`, {
        maximumBytes,
        actualBytes: before.size,
      });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameStableStat(before, after) || bytes.byteLength !== after.size) {
      throw retryable("EVIDENCE_STALE", `${label} changed while it was being staged.`);
    }
    const file = { path: filePath, bytes, identity: contentIdentity(bytes) };
    budget.record(file);
    return file;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw retryable("EVIDENCE_MISSING", `${label} is absent or unreadable.`, {
      path: filePath,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const readExistingStableFile = async (
  rawPath: string,
  label: string,
  maximumBytes: number,
  budget: ProvisionResourceBudget,
): Promise<StableFile> => {
  let resolved: string;
  try {
    resolved = await resolveExistingFile(rawPath, label);
  } catch (error) {
    throw retryable("EVIDENCE_MISSING", `${label} is absent or unreadable.`, {
      path: path.resolve(rawPath),
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return readStableFile(resolved, label, maximumBytes, budget);
};

const readCapturedFile = async (
  sourceRoot: string,
  reference: z.infer<typeof relativeFileReferenceSchema>,
  label: string,
  maximumBytes: number,
  budget: ProvisionResourceBudget,
): Promise<StableFile> => {
  let filePath: string;
  try {
    filePath = await resolveConfinedExistingFile(sourceRoot, sourceRoot, reference.path, label);
  } catch (error) {
    throw retryable("EVIDENCE_MISSING", `${label} is absent, unreadable, or outside the source root.`, {
      path: reference.path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const file = await readStableFile(filePath, label, maximumBytes, budget);
  if (!identityEqual(file.identity, reference.identity)) {
    throw retryable("DIGEST_MISMATCH", `${label} does not match its declared content identity.`, {
      path: reference.path,
      expected: reference.identity,
      actual: file.identity,
    });
  }
  return file;
};

const parseJson = <Output>(bytes: Buffer, schema: z.ZodType<Output>, label: string): Output => {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw retryable("EVIDENCE_STALE", `${label} is not valid JSON.`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw retryable("EVIDENCE_STALE", `${label} failed schema validation.`, {
      issues: parsed.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
};

const loadCapturedJson = async <Output>(
  sourceRoot: string,
  reference: z.infer<typeof relativeFileReferenceSchema>,
  schema: z.ZodType<Output>,
  label: string,
  budget: ProvisionResourceBudget,
): Promise<LoadedJson<Output>> => {
  const file = await readCapturedFile(
    sourceRoot,
    reference,
    label,
    REFERENCE_CONTEXT_RESOURCE_LIMITS.structuredDocumentBytes,
    budget,
  );
  return { file, document: parseJson(file.bytes, schema, label) };
};

const loadTrustRoot = async (
  configured: ReferenceStageContextProviderOptions["trustRoot"],
  budget: ProvisionResourceBudget,
): Promise<LoadedTrustRoot> => {
  if (configured === undefined) {
    throw retryable(
      "POLICY_DENIED",
      "No pinned reference-context reviewer/tool trust root is configured.",
    );
  }
  const file = await readExistingStableFile(
    configured.path,
    "Reference-context trust root",
    REFERENCE_CONTEXT_RESOURCE_LIMITS.trustRootBytes,
    budget,
  );
  if (!identityEqual(file.identity, configured.identity)) {
    throw retryable("DIGEST_MISMATCH", "Reference-context trust root does not match its pinned identity.", {
      expected: configured.identity,
      actual: file.identity,
    });
  }
  const document = parseJson(file.bytes, trustRootSchema, "Reference-context trust root");
  const toolKeys = document.tools.map((tool) => canonicalJson(tool));
  const reviewerKeys = document.reviewerAuthorities.map(
    (identity) => `${identity.schemaVersion}:${identity.digest}`,
  );
  if (new Set(toolKeys).size !== toolKeys.length || new Set(reviewerKeys).size !== reviewerKeys.length) {
    throw retryable("EVIDENCE_STALE", "Reference-context trust root contains duplicate authorities.");
  }
  return { file, document };
};

const instant = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw retryable("EVIDENCE_STALE", `Invalid timestamp ${value}.`);
  return parsed;
};

const assertObservationWindow = (
  label: string,
  observedAt: string,
  validUntil: string,
  now: Date,
  maximumTtlMs: number,
): void => {
  const observed = instant(observedAt);
  const expires = instant(validUntil);
  const current = now.getTime();
  if (observed > current) {
    throw retryable("EVIDENCE_STALE", `${label} has a future observation timestamp.`, {
      observedAt,
      now: now.toISOString(),
    });
  }
  if (current >= expires) {
    throw retryable("EVIDENCE_STALE", `${label} expired at ${validUntil}.`, { validUntil });
  }
  if (expires <= observed || expires - observed > maximumTtlMs) {
    throw retryable("EVIDENCE_STALE", `${label} exceeds its maximum evidence lifetime.`, {
      observedAt,
      validUntil,
      maximumTtlMs,
    });
  }
};

const assertAtOrBeforeNow = (label: string, value: string, now: Date): void => {
  if (instant(value) > now.getTime()) {
    throw retryable("EVIDENCE_STALE", `${label} is in the future.`, {
      timestamp: value,
      now: now.toISOString(),
    });
  }
};

const jsonPointerValue = (bytes: Buffer, pointer: string): unknown => {
  if (!pointer.startsWith("/")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (!/^\d+$/u.test(token)) return undefined;
      value = value[Number(token)];
    } else if (value !== null && typeof value === "object") {
      value = (value as Readonly<Record<string, unknown>>)[token];
    } else {
      return undefined;
    }
  }
  return value;
};

const locatorSemanticallyMatches = (
  locator: z.infer<typeof claimLocatorSchema>,
  bytes: Buffer,
): boolean => {
  switch (locator.kind) {
    case "json_pointer": {
      const value = jsonPointerValue(bytes, locator.value);
      if (value === undefined) return false;
      const rendered = typeof value === "string" ? value : canonicalJson(value);
      return rendered === locator.excerpt;
    }
    case "text_range": {
      const match = /^(\d+):(\d+)$/u.exec(locator.value);
      if (match === null) return false;
      const start = Number(match[1]);
      const end = Number(match[2]);
      return start >= 0 && end > start && end <= bytes.byteLength &&
        bytes.subarray(start, end).toString("utf8") === locator.excerpt;
    }
    case "pdf_page_text":
      return /^pdf-index:\d+(?:#.+)?$/u.test(locator.value) &&
        bytes.includes(Buffer.from(locator.excerpt, "utf8"));
    case "css_selector":
      return /^(?:#|\.|\[|[a-zA-Z][\w-]*)/u.test(locator.value) &&
        bytes.includes(Buffer.from(locator.excerpt, "utf8"));
  }
};

const assertEvidenceLocator = (
  locator: z.infer<typeof claimLocatorSchema>,
  label: string,
  raw: StableFile,
  pdfPages: LoadedSourceEvidence["pdfPages"],
): void => {
  if (locator.kind !== "pdf_page_text") {
    assertLocator(locator, label, [raw.bytes]);
    return;
  }
  const match = /^pdf-index:(\d+)(?:#.+)?$/u.exec(locator.value);
  const pageIndex = match === null ? Number.NaN : Number(match[1]);
  const page = pdfPages.find((entry) => entry.extraction.document.pageIndex === pageIndex);
  if (page === undefined) {
    throw retryable("EVIDENCE_STALE", `${label} does not name a bound extracted PDF page.`);
  }
  assertLocator(locator, label, [page.text.bytes]);
};

const assertLocator = (
  locator: z.infer<typeof claimLocatorSchema>,
  label: string,
  sourceBytes?: readonly Buffer[],
): void => {
  const actual = sha256(locator.excerpt);
  if (actual !== locator.excerptSha256) {
    throw retryable("DIGEST_MISMATCH", `${label} excerpt digest is invalid.`, {
      expected: locator.excerptSha256,
      actual,
    });
  }
  if (
    sourceBytes !== undefined &&
    !sourceBytes.some((bytes) => locatorSemanticallyMatches(locator, bytes))
  ) {
    throw retryable("EVIDENCE_STALE", `${label} does not resolve against the bound source bytes.`);
  }
};

const assertClaimLocatorCoverage = (
  claim: z.infer<typeof extractionClaimSchema>,
  locators: readonly z.infer<typeof claimLocatorSchema>[],
  label: string,
): void => {
  const excerpts = new Set(locators.map((locator) => locator.excerpt));
  const required = claim.kind === "datasheet"
    ? [
        ...(claim.orderCodeEvidence.kind === "exact_order_code"
          ? [claim.orderCodeEvidence.orderCode]
          : []),
        claim.documentTitle,
      ]
    : claim.kind === "sourcing"
      ? [claim.manufacturerPartNumber, claim.supplier]
      : [claim.manufacturerPartNumber];
  const missing = required.filter((value) => !excerpts.has(value));
  if (missing.length > 0) {
    throw retryable("EVIDENCE_STALE", `${label} lacks exact locators for extracted claim fields.`, {
      missing,
    });
  }
};

const assertDatasheetOrderCodeEvidence = (
  selectedPartNumber: string,
  evidence: Extract<z.infer<typeof extractionClaimSchema>, { readonly kind: "datasheet" }>,
  raw: StableFile,
  pdfPages: LoadedSourceEvidence["pdfPages"],
): void => {
  if (evidence.manufacturerPartNumber !== selectedPartNumber) {
    throw retryable("DIGEST_MISMATCH", "Datasheet extraction names a different selected OPN.");
  }
  if (evidence.orderCodeEvidence.kind === "exact_order_code") {
    if (evidence.orderCodeEvidence.orderCode !== selectedPartNumber) {
      throw retryable("DIGEST_MISMATCH", "Exact datasheet order code does not match the selected OPN.");
    }
    return;
  }
  const documented = evidence.orderCodeEvidence;
  for (const support of [
    documented.familySummary,
    documented.pinoutSummary,
    ...documented.pinCountSupport,
    documented.orderingTable,
  ]) {
    if (support.locator.kind !== "pdf_page_text" || support.locator.excerpt !== support.token) {
      throw retryable("EVIDENCE_STALE", "STM32 order-code support token lacks its exact PDF-page locator.");
    }
    assertEvidenceLocator(support.locator, "STM32 order-code support locator", raw, pdfPages);
  }
  const expected = [
    [0, "product_family", "STM32"],
    [1, "product_series", "G"],
    [2, "product_line", "0B1"],
    [3, "pin_count", "C"],
    [4, "flash_density", "E"],
    [5, "package", "T"],
    [6, "temperature_grade", "6"],
  ] as const;
  for (const [index, fieldName, code] of expected) {
    const field = documented.fields[index];
    if (
      field === undefined ||
      field.position !== index ||
      field.field !== fieldName ||
      field.code !== code ||
      field.codeLocator.kind !== "pdf_page_text" ||
      field.meaningLocator.kind !== "pdf_page_text" ||
      field.codeLocator.excerpt !== field.code ||
      field.meaningLocator.excerpt !== field.meaning
    ) {
      throw retryable("EVIDENCE_STALE", "STM32 order-code fields are missing, reordered, or inconsistent.");
    }
    assertEvidenceLocator(field.codeLocator, `STM32 ${fieldName} code locator`, raw, pdfPages);
    assertEvidenceLocator(field.meaningLocator, `STM32 ${fieldName} meaning locator`, raw, pdfPages);
  }
  const meanings = Object.fromEntries(
    documented.fields.map((field) => [field.field, normalizedToken(field.meaning)]),
  );
  if (
    meanings.pin_count !== "48" ||
    !["512kb", "512kbytes"].includes(meanings.flash_density ?? "") ||
    meanings.package !== "lqfp" ||
    !/^40(?:c)?to85c$/u.test(meanings.temperature_grade ?? "")
  ) {
    throw retryable("EVIDENCE_STALE", "STM32 order-code field meanings do not describe the selected package.");
  }
  const reassembled = documented.fields.map((field) => field.code).join("");
  if (
    reassembled !== selectedPartNumber ||
    documented.familySummary.token !== "STM32G0B1xB/xC/xE" ||
    documented.pinoutSummary.token !== "STM32G0B1CxT" ||
    documented.orderingTable.token !== "STM32 G 0B1 R E T 6 xyy"
  ) {
    throw retryable("DIGEST_MISMATCH", "STM32 documented fields do not reassemble to the selected exact OPN.");
  }
};

const normalizedToken = (value: string): string =>
  value.trim().toLocaleLowerCase("en-US").replaceAll(/[^a-z0-9]/gu, "");

const normalizedValueForRule = (
  normalization: z.infer<typeof normalizationSchema>,
): string | undefined => {
  const token = normalizedToken(normalization.rawValue);
  switch (normalization.rule) {
    case "evleda.availability.in-stock.v1":
      return token === "instock" ? "in_stock" : undefined;
    case "evleda.availability.out-of-stock.v1":
      return token === "outofstock" ? "not_available" : undefined;
    case "evleda.availability.unknown.v1":
      return token === "unknown" ? "unknown" : undefined;
    case "evleda.lifecycle.active.v1":
      return token === "active" ? "active" : undefined;
    case "evleda.lifecycle.nrnd.v1":
      return token === "nrnd" || token === "notrecommendedfornewdesigns" ? "nrnd" : undefined;
    case "evleda.lifecycle.obsolete.v1":
      return token === "obsolete" || token === "discontinued" ? "obsolete" : undefined;
    case "evleda.lifecycle.unknown.v1":
      return token === "unknown" ? "unknown" : undefined;
  }
};

const assertReviewerIdentity = (
  reviewer: z.infer<typeof reviewerIdentitySchema>,
  label: string,
  trustRoot: TrustRootDocument,
): void => {
  const expected = canonicalIdentity(
    {
      type: reviewer.type,
      id: reviewer.id,
      displayName: reviewer.displayName,
      role: reviewer.role,
    },
    COMPONENT_EVIDENCE_REVIEWER_SCHEMA,
  );
  if (
    reviewer.authorityIdentity.schemaVersion !== expected.schemaVersion ||
    reviewer.authorityIdentity.digest !== expected.digest
  ) {
    throw retryable("DIGEST_MISMATCH", `${label} reviewer identity is detached from its principal fields.`, {
      expected,
      actual: reviewer.authorityIdentity,
    });
  }
  if (
    !trustRoot.reviewerAuthorities.some(
      (identity) =>
        identity.schemaVersion === reviewer.authorityIdentity.schemaVersion &&
        identity.digest === reviewer.authorityIdentity.digest,
    )
  ) {
    throw retryable("POLICY_DENIED", `${label} reviewer is not authorized by the pinned trust root.`, {
      reviewerAuthority: reviewer.authorityIdentity,
      trustRootId: trustRoot.trustRootId,
    });
  }
};

const assertTrustedTool = (
  tool: z.infer<typeof toolIdentitySchema>,
  label: string,
  trustRoot: TrustRootDocument,
): void => {
  if (!trustRoot.tools.some((trusted) => canonicalJson(trusted) === canonicalJson(tool))) {
    throw retryable("POLICY_DENIED", `${label} tool is not authorized by the pinned trust root.`, {
      tool,
      trustRootId: trustRoot.trustRootId,
    });
  }
};

const uniqueComponentCoverage = (
  records: readonly { readonly component: string }[],
  profile: ReferenceControllerProfile,
): void => {
  const expected = profile.components
    .map((component) => component.key)
    .sort((left, right) => left.localeCompare(right, "en"));
  const actual = records.map((record) => record.component).sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(actual).size !== actual.length || canonicalJson(actual) !== canonicalJson(expected)) {
    throw retryable("EVIDENCE_MISSING", "Stage-context snapshot must contain exactly one record per profile component.", {
      expected,
      actual,
    });
  }
};

const loadSourceEvidence = async (
  sourceRoot: string,
  pair: z.infer<typeof evidencePairSchema>,
  expectedCategory: SourceCategory,
  component: ReferenceComponent,
  now: Date,
  budget: ProvisionResourceBudget,
  trustRoot: TrustRootDocument,
): Promise<LoadedSourceEvidence> => {
  const label = `${component.key} ${expectedCategory}`;
  const capture = await loadCapturedJson(
    sourceRoot,
    pair.capture,
    sourceCaptureSchema,
    `${label} capture`,
    budget,
  );
  const extraction = await loadCapturedJson(
    sourceRoot,
    pair.extraction,
    sourceExtractionSchema,
    `${label} extraction`,
    budget,
  );
  const raw = await readCapturedFile(
    sourceRoot,
    capture.document.raw,
    `${label} raw source`,
    REFERENCE_CONTEXT_RESOURCE_LIMITS.rawCaptureBytes,
    budget,
  );
  const captureDocument = capture.document;
  const extractionDocument = extraction.document;
  if (
    captureDocument.category !== expectedCategory ||
    extractionDocument.category !== expectedCategory ||
    captureDocument.component !== component.key ||
    extractionDocument.component !== component.key ||
    extractionDocument.claim.kind !== expectedCategory
  ) {
    throw retryable("EVIDENCE_STALE", `${label} documents disagree about category or component.`);
  }
  if (
    !identityEqual(extractionDocument.captureIdentity, capture.file.identity) ||
    !identityEqual(extractionDocument.rawIdentity, raw.identity)
  ) {
    throw retryable("DIGEST_MISMATCH", `${label} extraction is detached from its capture or raw source.`);
  }
  const pdfPages: Array<LoadedSourceEvidence["pdfPages"][number]> = [];
  for (const pageReference of extractionDocument.pdfPageExtractions) {
    const pageExtraction = await loadCapturedJson(
      sourceRoot,
      pageReference,
      pdfPageExtractionSchema,
      `${label} PDF page extraction`,
      budget,
    );
    if (!identityEqual(pageExtraction.document.pdfIdentity, raw.identity)) {
      throw retryable("DIGEST_MISMATCH", `${label} PDF page extraction is detached from the captured PDF.`);
    }
    assertTrustedTool(pageExtraction.document.tool, `${label} PDF page extractor`, trustRoot);
    const text = await readCapturedFile(
      sourceRoot,
      pageExtraction.document.text,
      `${label} extracted PDF page text`,
      REFERENCE_CONTEXT_RESOURCE_LIMITS.structuredDocumentBytes,
      budget,
    );
    pdfPages.push({ extraction: pageExtraction, text });
  }
  if (
    new Set(pdfPages.map((page) => page.extraction.document.pageIndex)).size !== pdfPages.length ||
    (expectedCategory === "datasheet" && pdfPages.length === 0) ||
    (expectedCategory !== "datasheet" && pdfPages.length !== 0)
  ) {
    throw retryable(
      "EVIDENCE_STALE",
      `${label} has missing, duplicate, or category-inapplicable PDF page extractions.`,
    );
  }
  assertObservationWindow(
    `${label} capture`,
    captureDocument.observedAt,
    captureDocument.validUntil,
    now,
    REFERENCE_CONTEXT_MAX_TTL_MS[expectedCategory],
  );
  assertAtOrBeforeNow(`${label} extraction`, extractionDocument.extractedAt, now);
  if (instant(extractionDocument.extractedAt) < instant(captureDocument.observedAt)) {
    throw retryable("EVIDENCE_STALE", `${label} extraction predates its source capture.`);
  }
  assertTrustedTool(captureDocument.tool, `${label} capture`, trustRoot);
  assertTrustedTool(extractionDocument.tool, `${label} extraction`, trustRoot);
  if (extractionDocument.authority === "machine_derived") {
    if (extractionDocument.review !== undefined) {
      throw retryable("EVIDENCE_STALE", `${label} machine-derived extraction must not claim human review.`);
    }
  } else {
    const review = extractionDocument.review;
    if (review === undefined) {
      throw retryable("EVIDENCE_MISSING", `${label} human-accepted extraction lacks its review record.`);
    }
    assertAtOrBeforeNow(`${label} review`, review.reviewedAt, now);
    if (instant(review.reviewedAt) < instant(extractionDocument.extractedAt)) {
      throw retryable("EVIDENCE_STALE", `${label} review predates its extraction.`);
    }
    if (review.decision !== "accepted") {
      throw retryable("EVIDENCE_STALE", `${label} extraction was not accepted by its recorded reviewer.`);
    }
    assertReviewerIdentity(review.reviewer, `${label} review`, trustRoot);
  }
  for (const locator of extractionDocument.locators) {
    assertEvidenceLocator(locator, `${label} claim locator`, raw, pdfPages);
  }
  assertClaimLocatorCoverage(extractionDocument.claim, extractionDocument.locators, label);
  const normalizations = extractionDocument.normalizations;
  if (
    (expectedCategory === "datasheet" && normalizations.length !== 0) ||
    (expectedCategory === "sourcing" &&
      (normalizations.length !== 1 || normalizations[0]?.field !== "availability")) ||
    (expectedCategory === "lifecycle" &&
      (normalizations.length !== 1 || normalizations[0]?.field !== "lifecycle"))
  ) {
    throw retryable("EVIDENCE_STALE", `${label} has an invalid normalization set.`);
  }
  for (const normalization of normalizations) {
    if (normalization.locator.excerpt !== normalization.rawValue) {
      throw retryable("DIGEST_MISMATCH", `${label} normalization raw value is detached from its locator.`);
    }
    if (normalization.locator.kind === "pdf_page_text") {
      throw retryable("EVIDENCE_STALE", `${label} normalization must locate raw vendor text, not PDF extraction.`);
    }
    assertEvidenceLocator(normalization.locator, `${label} normalization locator`, raw, []);
    const normalized = normalizedValueForRule(normalization);
    if (normalized === undefined || normalized !== normalization.normalizedValue) {
      throw retryable("EVIDENCE_STALE", `${label} normalization does not satisfy its allowlisted rule.`);
    }
    if (
      (normalization.field === "availability" &&
        (extractionDocument.claim.kind !== "sourcing" ||
          extractionDocument.claim.availability !== normalization.normalizedValue)) ||
      (normalization.field === "lifecycle" &&
        (extractionDocument.claim.kind !== "lifecycle" ||
          extractionDocument.claim.status !== normalization.normalizedValue))
    ) {
      throw retryable("DIGEST_MISMATCH", `${label} normalized claim disagrees with its transformation.`);
    }
  }
  return { capture, raw, extraction, pdfPages };
};

const collectReferenceBindings = (
  value: unknown,
  output: Map<string, z.infer<typeof referenceFileBindingSchema>>,
): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferenceBindings(entry, output);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Readonly<Record<string, unknown>>;
  const binding = referenceFileBindingSchema.safeParse(record);
  if (binding.success) {
    const previous = output.get(binding.data.path);
    if (
      previous !== undefined &&
      (previous.sha256 !== binding.data.sha256 || previous.sizeBytes !== binding.data.sizeBytes)
    ) {
      throw retryable("EVIDENCE_STALE", `Reference validation has conflicting bindings for ${binding.data.path}.`);
    }
    output.set(binding.data.path, binding.data);
  }
  for (const entry of Object.values(record)) collectReferenceBindings(entry, output);
};

const loadReferenceValidation = async (
  referenceRoot: string,
  requireCanonicalSources: boolean,
  budget: ProvisionResourceBudget,
): Promise<LoadedReferenceValidation> => {
  let validationPath: string;
  try {
    validationPath = await resolveConfinedExistingFile(
      referenceRoot,
      referenceRoot,
      "validation/reference-validation.json",
      "Canonical reference validation",
    );
  } catch (error) {
    throw retryable("EVIDENCE_MISSING", "Canonical reference validation is absent or unreadable.", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const file = await readStableFile(
    validationPath,
    "Canonical reference validation",
    REFERENCE_CONTEXT_RESOURCE_LIMITS.referenceValidationBytes,
    budget,
  );
  const parsed = parseJson(file.bytes, referenceValidationSchema, "Canonical reference validation");
  if (parsed.validationRoot.schemaVersion !== REFERENCE_VALIDATION_SCHEMA) {
    throw retryable("EVIDENCE_STALE", "Canonical reference validation root uses an unsupported schema.");
  }
  const sourceBindingPaths = parsed.sourceBindings.map((binding) => binding.path);
  const sortedSourceBindingPaths = [...sourceBindingPaths].sort((left, right) => left.localeCompare(right, "en"));
  if (
    new Set(sourceBindingPaths).size !== sourceBindingPaths.length ||
    canonicalJson(sourceBindingPaths) !== canonicalJson(sortedSourceBindingPaths)
  ) {
    throw retryable("EVIDENCE_STALE", "Canonical reference source bindings must be unique and sorted.");
  }
  if (requireCanonicalSources) {
    const missing = REQUIRED_REFERENCE_SOURCE_PATHS.filter((required) => !sourceBindingPaths.includes(required));
    if (missing.length > 0) {
      throw retryable("EVIDENCE_MISSING", "Canonical reference validation omits required design sources.", {
        missing,
      });
    }
  }
  const rootPayload = structuredClone(parsed) as Record<string, unknown>;
  delete rootPayload.validationRoot;
  delete rootPayload.createdAt;
  const recomputed = canonicalIdentity(rootPayload, REFERENCE_VALIDATION_SCHEMA);
  if (recomputed.digest !== parsed.validationRoot.digest) {
    throw retryable("DIGEST_MISMATCH", "Canonical reference validation root is detached from its content.", {
      expected: parsed.validationRoot.digest,
      actual: recomputed.digest,
    });
  }

  const records = new Map<string, z.infer<typeof referenceFileBindingSchema>>();
  collectReferenceBindings(parsed, records);
  const bindings: { path: string; identity: ContentIdentity }[] = [];
  let nativeContractAuthority: ReferenceControllerRevANativeAuthoritySnapshot | undefined;
  for (const binding of [...records.values()].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    if (binding.path === REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_SOURCE_PATH) {
      try {
        nativeContractAuthority ??= await snapshotReferenceControllerRevANativeAuthority();
      } catch (error) {
        throw retryable(
          "EVIDENCE_STALE",
          "The module-owned Rev-A native-contract authority is unavailable or changed.",
          { reason: error instanceof Error ? error.message : String(error) },
        );
      }
      const actual = nativeContractAuthority.fileBinding;
      if (actual.sha256 !== binding.sha256 || actual.sizeBytes !== binding.sizeBytes) {
        throw retryable("DIGEST_MISMATCH", `Reference validation binding ${binding.path} is stale.`, {
          expected: { algorithm: "sha256", digest: binding.sha256, size: binding.sizeBytes },
          actual: nativeContractAuthority.contentIdentity,
        });
      }
      const bytes = Buffer.from(nativeContractAuthority.canonicalJson, "utf8");
      budget.record({
        path: `module-owned:${binding.path}`,
        bytes,
        identity: nativeContractAuthority.contentIdentity,
      });
      bindings.push({ path: binding.path, identity: nativeContractAuthority.contentIdentity });
      continue;
    }
    let boundPath: string;
    try {
      boundPath = await resolveConfinedExistingFile(
        referenceRoot,
        referenceRoot,
        binding.path,
        `Reference validation binding ${binding.path}`,
      );
    } catch (error) {
      throw retryable("EVIDENCE_STALE", `Reference validation binding ${binding.path} is missing.`, {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const bound = await readStableFile(
      boundPath,
      `Reference validation binding ${binding.path}`,
      REFERENCE_CONTEXT_RESOURCE_LIMITS.referenceBindingBytes,
      budget,
    );
    if (bound.identity.digest !== binding.sha256 || bound.identity.size !== binding.sizeBytes) {
      throw retryable("DIGEST_MISMATCH", `Reference validation binding ${binding.path} is stale.`, {
        expected: { algorithm: "sha256", digest: binding.sha256, size: binding.sizeBytes },
        actual: bound.identity,
      });
    }
    bindings.push({ path: binding.path, identity: bound.identity });
  }
  if (nativeContractAuthority !== undefined) {
    try {
      await reverifyReferenceControllerRevANativeAuthority(nativeContractAuthority);
    } catch (error) {
      throw retryable(
        "EVIDENCE_STALE",
        "The module-owned Rev-A native-contract authority changed during validation loading.",
        { reason: error instanceof Error ? error.message : String(error) },
      );
    }
  }
  return {
    file,
    validationRoot: parsed.validationRoot,
    executable: parsed.executable,
    bindings,
  };
};

const referenceValidationEqual = (
  left: LoadedReferenceValidation,
  right: LoadedReferenceValidation,
): boolean =>
  identityEqual(left.file.identity, right.file.identity) &&
  left.validationRoot.digest === right.validationRoot.digest &&
  canonicalJson(left.bindings) === canonicalJson(right.bindings);

const matchesValidatedExecutable = (
  identity: KicadExecutableIdentity,
  validation: LoadedReferenceValidation,
): boolean =>
  identity.version === REFERENCE_KICAD_VERSION &&
  identity.version === validation.executable.version &&
  identity.commit.toLocaleLowerCase("en-US") === validation.executable.commit.toLocaleLowerCase("en-US") &&
  identity.sha256 === validation.executable.sha256 &&
  identity.sizeBytes === validation.executable.sizeBytes &&
  identity.capabilityHelpSha256 === validation.executable.capabilityHelpSha256;

export class ReferenceStageContextProvider implements StageContextProvider {
  readonly #options: ReferenceStageContextProviderOptions;
  readonly #profile: ReferenceControllerProfile;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #firmwareEnvironment: Readonly<Record<string, string | undefined>>;
  readonly #executableCandidates: readonly string[];

  public constructor(options: ReferenceStageContextProviderOptions) {
    const sourceRoot = options.sourceRoot ?? path.dirname(options.snapshotPath);
    for (const [label, value] of [
      ["snapshotPath", options.snapshotPath],
      ["sourceRoot", sourceRoot],
      ["referenceDesignRoot", options.referenceDesignRoot],
      ["kicadWorkRoot", options.kicadWorkRoot],
    ] as const) {
      if (value.trim().length === 0 || !path.isAbsolute(value)) {
        throw new DomainError("INVALID_ARGUMENT", `${label} must be a non-empty absolute path.`);
      }
    }
    if (
      options.trustRoot !== undefined &&
      (options.trustRoot.path.trim().length === 0 ||
        !path.isAbsolute(options.trustRoot.path) ||
        !contentIdentitySchema.safeParse(options.trustRoot.identity).success)
    ) {
      throw new DomainError(
        "INVALID_ARGUMENT",
        "Configured reference-context trust root must have an absolute path and valid content identity.",
      );
    }
    if (
      options.trustRoot !== undefined &&
      isPathWithin(options.kicadWorkRoot, options.trustRoot.path, true)
    ) {
      throw new DomainError("INVALID_ARGUMENT", "Reference-context trust root must not be inside KiCad work.");
    }
    assertDisjointDirectories(
      options.referenceDesignRoot,
      options.kicadWorkRoot,
      "Reference design root",
      "KiCad work root",
    );
    assertDisjointDirectories(sourceRoot, options.kicadWorkRoot, "Stage-context source root", "KiCad work root");
    if (isPathWithin(options.kicadWorkRoot, options.snapshotPath, true)) {
      throw new DomainError("INVALID_ARGUMENT", "Stage-context snapshot must not be inside the KiCad work root.");
    }
    const candidates = options.kicadExecutableCandidates ?? [
      options.kicadExecutablePath ?? DEFAULT_KICAD_10_CLI_PATH,
    ];
    if (candidates.length === 0) {
      throw new DomainError("INVALID_ARGUMENT", "At least one KiCad executable candidate is required.");
    }
    for (const candidate of candidates) {
      if (candidate.trim().length === 0 || !path.isAbsolute(candidate)) {
        throw new DomainError("INVALID_ARGUMENT", "Every KiCad executable candidate must be an absolute path.");
      }
    }
    this.#executableCandidates = [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
    const { environment: _rawEnvironment, ...retainedOptions } = options;
    this.#options = { ...retainedOptions, sourceRoot };
    this.#profile = options.profile ?? ROBOTICS_CONTROLLER_V0;
    this.#firmwareEnvironment = Object.freeze({ ...(_rawEnvironment ?? process.env) });
    this.#environment = normalizeKicadChildEnvironment(this.#firmwareEnvironment);
  }

  public async provide(request: StageContextProviderRequest): Promise<StageContextProvision> {
    try {
      return await this.#provide(request);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw retryable("TOOL_RESULT_INCONCLUSIVE", "Stage-context provisioning failed unexpectedly.", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #referenceRoot(): Promise<string> {
    try {
      return await resolveExistingDirectory(this.#options.referenceDesignRoot, "Reference design root");
    } catch (error) {
      throw retryable("EVIDENCE_MISSING", "Reference design root is absent or unreadable.", {
        path: this.#options.referenceDesignRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #sourceRoot(): Promise<string> {
    try {
      return await resolveExistingDirectory(this.#options.sourceRoot!, "Stage-context source root");
    } catch (error) {
      throw retryable("EVIDENCE_MISSING", "Stage-context source root is absent or unreadable.", {
        path: this.#options.sourceRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #workRoot(): Promise<string> {
    try {
      return await resolveExistingDirectory(this.#options.kicadWorkRoot, "KiCad work root");
    } catch (error) {
      throw retryable("TOOLCHAIN_UNAVAILABLE", "KiCad work root is absent or unreadable.", {
        path: this.#options.kicadWorkRoot,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #discoverExecutable(
    referenceRoot: string,
    validation: LoadedReferenceValidation,
  ): Promise<KicadExecutableIdentity> {
    const unavailable: { path: string; reason: string }[] = [];
    const unsupported: { path: string; identity: KicadExecutableIdentity }[] = [];
    for (const candidate of this.#executableCandidates) {
      try {
        const identity = this.#options.discoverKicadExecutableIdentity === undefined
          ? (
              await KicadCliAdapter.create({
                workspaceRoot: path.dirname(referenceRoot),
                projectRoot: referenceRoot,
                executablePath: candidate,
                environment: this.#environment,
              })
            ).identity
          : await this.#options.discoverKicadExecutableIdentity(candidate);
        if (matchesValidatedExecutable(identity, validation)) return identity;
        unsupported.push({ path: candidate, identity });
      } catch (error) {
        unavailable.push({ path: candidate, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (unsupported.length > 0) {
      throw retryable("TOOLCHAIN_UNSUPPORTED", `No discovered executable matches validated KiCad ${REFERENCE_KICAD_VERSION}.`, {
        candidates: this.#executableCandidates,
        unsupported,
      });
    }
    throw retryable("TOOLCHAIN_UNAVAILABLE", "No configured KiCad 10 executable candidate is available.", {
      candidates: this.#executableCandidates,
      unavailable,
    });
  }

  async #provide(request: StageContextProviderRequest): Promise<StageContextProvision> {
    const budget = new ProvisionResourceBudget();
    const trustRoot = await loadTrustRoot(this.#options.trustRoot, budget);
    const snapshotFile = await readExistingStableFile(
      this.#options.snapshotPath,
      "Reference stage-context snapshot",
      REFERENCE_CONTEXT_RESOURCE_LIMITS.snapshotBytes,
      budget,
    );
    const snapshot = parseJson(
      snapshotFile.bytes,
      stageContextSnapshotSchema,
      "Reference stage-context snapshot",
    );
    const now = (this.#options.now ?? (() => new Date()))();
    if (!Number.isFinite(now.getTime())) {
      throw new DomainError("INVALID_ARGUMENT", "Stage-context clock returned an invalid date.");
    }
    const sourceRoot = await this.#sourceRoot();
    const referenceRoot = await this.#referenceRoot();
    const workRoot = await this.#workRoot();
    assertDisjointDirectories(referenceRoot, workRoot, "Reference design root", "KiCad work root");
    assertDisjointDirectories(sourceRoot, workRoot, "Stage-context source root", "KiCad work root");
    if (isPathWithin(workRoot, snapshotFile.path, true)) {
      throw retryable("EVIDENCE_STALE", "Stage-context snapshot resolves inside the KiCad work root.");
    }
    if (isPathWithin(workRoot, trustRoot.file.path, true)) {
      throw retryable("EVIDENCE_STALE", "Reference-context trust root resolves inside KiCad work.");
    }

    const profileIdentity = canonicalIdentity(this.#profile, "evleda.reference-profile.v1");
    if (
      snapshot.profile.profileId !== this.#profile.profileId ||
      snapshot.profile.boardRevision !== this.#profile.boardRevision ||
      snapshot.profile.identity.schemaVersion !== profileIdentity.schemaVersion ||
      snapshot.profile.identity.digest !== profileIdentity.digest
    ) {
      throw retryable("DIGEST_MISMATCH", "Stage-context snapshot is detached from the selected profile.", {
        expected: profileIdentity,
        actual: snapshot.profile.identity,
      });
    }
    uniqueComponentCoverage(snapshot.components, this.#profile);

    const footprintManifest = await loadCapturedJson(
      sourceRoot,
      snapshot.footprintLibrary,
      footprintLibraryCaptureSchema,
      "Footprint-library capture",
      budget,
    );
    const footprintDocument = footprintManifest.document;
    assertTrustedTool(footprintDocument.tool, "Footprint-library capture", trustRoot.document);
    assertObservationWindow(
      "Footprint-library capture",
      footprintDocument.observedAt,
      footprintDocument.validUntil,
      now,
      REFERENCE_CONTEXT_MAX_TTL_MS.footprintLibrary,
    );
    const footprintNames = footprintDocument.assets.map((asset) => asset.footprint);
    if (new Set(footprintNames).size !== footprintNames.length) {
      throw retryable("EVIDENCE_STALE", "Footprint-library capture contains duplicate footprint names.");
    }
    const footprintAssets = new Map<string, StableFile>();
    for (const asset of footprintDocument.assets) {
      footprintAssets.set(
        asset.footprint,
        await readCapturedFile(
          sourceRoot,
          asset.file,
          `Footprint asset ${asset.footprint}`,
          REFERENCE_CONTEXT_RESOURCE_LIMITS.footprintAssetBytes,
          budget,
        ),
      );
    }
    assertLocator(
      footprintDocument.catalogLocator,
      "Footprint-library catalog locator",
      [...footprintAssets.values()].map((file) => file.bytes),
    );
    const missingFootprints = this.#profile.components
      .map((component) => component.footprint)
      .filter((footprint) => !footprintAssets.has(footprint));
    if (missingFootprints.length > 0) {
      throw retryable("EVIDENCE_MISSING", "Footprint-library capture omits selected footprint assets.", {
        missingFootprints,
      });
    }
    const footprintLibraryIdentity = canonicalIdentity(
      {
        schemaVersion: FOOTPRINT_LIBRARY_SNAPSHOT_SCHEMA,
        manifestIdentity: footprintManifest.file.identity,
        assets: [...footprintAssets.entries()]
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([footprint, file]) => ({ footprint, identity: file.identity })),
      },
      FOOTPRINT_LIBRARY_SNAPSHOT_SCHEMA,
    );

    const profileByKey = new Map(this.#profile.components.map((component) => [component.key, component]));
    const curatedDatasheets: NonNullable<StageContextProvision["curatedDatasheets"]>[number][] = [];
    const sourcing: NonNullable<StageContextProvision["sourcing"]>[number][] = [];
    const lifecycleObservations: NonNullable<StageContextProvision["lifecycleObservations"]>[number][] = [];
    const pinPadMappingReviews: NonNullable<StageContextProvision["pinPadMappingReviews"]>[number][] = [];
    const sourceMaterial: unknown[] = [];

    for (const entry of snapshot.components) {
      const component = profileByKey.get(entry.component as ReferenceComponentKey);
      if (component === undefined) {
        throw retryable("EVIDENCE_STALE", `Unknown component ${entry.component} in stage-context snapshot.`);
      }
      const datasheet = await loadSourceEvidence(
        sourceRoot,
        entry.datasheet,
        "datasheet",
        component,
        now,
        budget,
        trustRoot.document,
      );
      const sourcingEvidence = await loadSourceEvidence(
        sourceRoot,
        entry.sourcing,
        "sourcing",
        component,
        now,
        budget,
        trustRoot.document,
      );
      const lifecycleEvidence = await loadSourceEvidence(
        sourceRoot,
        entry.lifecycle,
        "lifecycle",
        component,
        now,
        budget,
        trustRoot.document,
      );
      const datasheetClaim = datasheet.extraction.document.claim;
      if (
        component.datasheet.identity === undefined ||
        !identityEqual(component.datasheet.identity, datasheet.raw.identity) ||
        component.datasheet.url !== datasheet.capture.document.sourceUrl ||
        datasheetClaim.kind !== "datasheet"
      ) {
        throw retryable("DIGEST_MISMATCH", `${component.key} datasheet evidence is detached from the profile.`);
      }
      assertDatasheetOrderCodeEvidence(
        component.partNumber,
        datasheetClaim,
        datasheet.raw,
        datasheet.pdfPages,
      );
      if (
        sourcingEvidence.extraction.document.claim.kind !== "sourcing" ||
        sourcingEvidence.extraction.document.claim.manufacturerPartNumber !== component.partNumber
      ) {
        throw retryable("EVIDENCE_STALE", `${component.key} sourcing claim does not bind the selected part.`);
      }
      if (
        lifecycleEvidence.extraction.document.claim.kind !== "lifecycle" ||
        lifecycleEvidence.extraction.document.claim.manufacturerPartNumber !== component.partNumber ||
        lifecycleEvidence.capture.document.sourceUrl !== component.lifecycle.sourceUrl
      ) {
        throw retryable("EVIDENCE_STALE", `${component.key} lifecycle claim does not bind the selected part and URL.`);
      }

      const symbolSource = await readCapturedFile(
        sourceRoot,
        entry.pinPadMapping.symbolSource,
        `${component.key} KiCad symbol source`,
        REFERENCE_CONTEXT_RESOURCE_LIMITS.footprintAssetBytes,
        budget,
      );
      const mapping = await loadCapturedJson(
        sourceRoot,
        entry.pinPadMapping.mapping,
        pinPadMappingSchema,
        `${component.key} pin-pad mapping`,
        budget,
      );
      const mappingReview = await loadCapturedJson(
        sourceRoot,
        entry.pinPadMapping.review,
        pinPadMappingReviewSchema,
        `${component.key} pin-pad mapping review`,
        budget,
      );
      const mappingDocument = mapping.document;
      const reviewDocument = mappingReview.document;
      assertTrustedTool(mappingDocument.tool, `${component.key} pin-pad mapping`, trustRoot.document);
      if (reviewDocument.decision === "reviewed") {
        if (reviewDocument.reviewer === undefined) {
          throw retryable("EVIDENCE_MISSING", `${component.key} reviewed mapping lacks trusted reviewer authority.`);
        }
        assertReviewerIdentity(
          reviewDocument.reviewer,
          `${component.key} mapping review`,
          trustRoot.document,
        );
      } else if (reviewDocument.reviewer !== undefined) {
        throw retryable(
          "EVIDENCE_STALE",
          `${component.key} ${reviewDocument.decision} mapping must not claim reviewer authority.`,
        );
      }
      assertAtOrBeforeNow(`${component.key} mapping creation`, mappingDocument.createdAt, now);
      assertObservationWindow(
        `${component.key} mapping review`,
        reviewDocument.observedAt,
        reviewDocument.validUntil,
        now,
        REFERENCE_CONTEXT_MAX_TTL_MS.pinPadMapping,
      );
      const mappingPairs = mappingDocument.mappings.map(({ pin, pad }) => `${pin}\0${pad}`);
      const footprintAsset = footprintAssets.get(component.footprint)!;
      const symbolPins = [...mappingDocument.symbolPins].sort((left, right) => left.localeCompare(right, "en"));
      const footprintPads = [...mappingDocument.footprintPads].sort((left, right) => left.localeCompare(right, "en"));
      const mappedPins = mappingDocument.mappings
        .map((entry) => entry.pin)
        .sort((left, right) => left.localeCompare(right, "en"));
      const mappedPads = mappingDocument.mappings
        .map((entry) => entry.pad)
        .sort((left, right) => left.localeCompare(right, "en"));
      if (
        new Set(mappingPairs).size !== mappingPairs.length ||
        new Set(symbolPins).size !== symbolPins.length ||
        new Set(footprintPads).size !== footprintPads.length ||
        new Set(mappedPins).size !== mappedPins.length ||
        new Set(mappedPads).size !== mappedPads.length ||
        canonicalJson(symbolPins) !== canonicalJson(mappedPins) ||
        canonicalJson(footprintPads) !== canonicalJson(mappedPads)
      ) {
        throw retryable(
          "EVIDENCE_STALE",
          `${component.key} mapping does not cover every declared symbol pin and footprint pad exactly once.`,
        );
      }
      for (const mapped of mappingDocument.mappings) {
        assertEvidenceLocator(
          mapped.datasheetLocator,
          `${component.key} datasheet-pin locator`,
          datasheet.raw,
          datasheet.pdfPages,
        );
        assertLocator(mapped.symbolLocator, `${component.key} symbol-pin locator`, [symbolSource.bytes]);
        assertLocator(mapped.footprintLocator, `${component.key} footprint-pad locator`, [footprintAsset.bytes]);
        if (
          !mapped.datasheetLocator.excerpt.includes(mapped.pin) ||
          !mapped.symbolLocator.excerpt.includes(mapped.pin) ||
          !mapped.footprintLocator.excerpt.includes(mapped.pad)
        ) {
          throw retryable("EVIDENCE_STALE", `${component.key} mapping locator does not name its pin or pad.`);
        }
      }
      for (const locator of reviewDocument.locators) {
        assertLocator(locator, `${component.key} review locator`, [mapping.file.bytes]);
      }
      if (
        mappingDocument.component !== component.key ||
        reviewDocument.component !== component.key ||
        mappingDocument.symbol !== component.symbol ||
        reviewDocument.symbol !== component.symbol ||
        mappingDocument.footprint !== component.footprint ||
        reviewDocument.footprint !== component.footprint ||
        !identityEqual(reviewDocument.mappingIdentity, mapping.file.identity) ||
        !identityEqual(mappingDocument.sources.datasheetIdentity, datasheet.raw.identity) ||
        !identityEqual(mappingDocument.sources.symbolIdentity, symbolSource.identity) ||
        !identityEqual(mappingDocument.sources.footprintIdentity, footprintAsset.identity) ||
        instant(reviewDocument.observedAt) < instant(mappingDocument.createdAt)
      ) {
        throw retryable("DIGEST_MISMATCH", `${component.key} mapping review is detached from its exact inputs.`);
      }

      curatedDatasheets.push({
        component: component.key,
        url: datasheet.capture.document.sourceUrl,
        retrievedAt: datasheet.capture.document.observedAt,
        identity: datasheet.raw.identity,
      });
      sourcing.push({
        component: component.key,
        manufacturerPartNumber: sourcingEvidence.extraction.document.claim.manufacturerPartNumber,
        supplier: sourcingEvidence.extraction.document.claim.supplier,
        url: sourcingEvidence.capture.document.sourceUrl,
        retrievedAt: sourcingEvidence.capture.document.observedAt,
        availability: sourcingEvidence.extraction.document.claim.availability,
        identity: sourcingEvidence.raw.identity,
      });
      lifecycleObservations.push({
        component: component.key,
        status: lifecycleEvidence.extraction.document.claim.status,
        checkedAt: lifecycleEvidence.capture.document.observedAt,
        sourceUrl: lifecycleEvidence.capture.document.sourceUrl,
        sourceIdentity: lifecycleEvidence.raw.identity,
        requiresReview: false,
      });
      pinPadMappingReviews.push({
        component: component.key,
        symbol: component.symbol,
        footprint: component.footprint,
        status: reviewDocument.decision === "pending" ? "unreviewed" : reviewDocument.decision,
        checkedAt: reviewDocument.observedAt,
        mappingIdentity: mapping.file.identity,
        reviewIdentity: mappingReview.file.identity,
        requiresReview: reviewDocument.decision !== "reviewed",
      });
      sourceMaterial.push({
        component: component.key,
        datasheet: {
          captureIdentity: datasheet.capture.file.identity,
          capture: datasheet.capture.document,
          rawIdentity: datasheet.raw.identity,
          extractionIdentity: datasheet.extraction.file.identity,
          extraction: datasheet.extraction.document,
          pdfPages: datasheet.pdfPages.map((page) => ({
            extractionIdentity: page.extraction.file.identity,
            extraction: page.extraction.document,
            textIdentity: page.text.identity,
          })),
        },
        sourcing: {
          captureIdentity: sourcingEvidence.capture.file.identity,
          capture: sourcingEvidence.capture.document,
          rawIdentity: sourcingEvidence.raw.identity,
          extractionIdentity: sourcingEvidence.extraction.file.identity,
          extraction: sourcingEvidence.extraction.document,
        },
        lifecycle: {
          captureIdentity: lifecycleEvidence.capture.file.identity,
          capture: lifecycleEvidence.capture.document,
          rawIdentity: lifecycleEvidence.raw.identity,
          extractionIdentity: lifecycleEvidence.extraction.file.identity,
          extraction: lifecycleEvidence.extraction.document,
        },
        pinPadMapping: {
          symbolSourceIdentity: symbolSource.identity,
          mappingIdentity: mapping.file.identity,
          mapping: mappingDocument,
          reviewIdentity: mappingReview.file.identity,
          review: reviewDocument,
          footprintAssetIdentity: footprintAsset.identity,
        },
      });
    }

    const requireCanonicalSources =
      this.#profile.profileId === ROBOTICS_CONTROLLER_V0.profileId &&
      this.#profile.boardRevision === ROBOTICS_CONTROLLER_V0.boardRevision;
    const referenceValidation = await loadReferenceValidation(
      referenceRoot,
      requireCanonicalSources,
      budget,
    );
    const executableIdentity = await this.#discoverExecutable(referenceRoot, referenceValidation);
    const backendConfiguration = Object.freeze({
      workRoot,
      referenceDesignRoot: referenceRoot,
      executablePath: executableIdentity.path,
      environment: this.#environment,
    } satisfies ReferenceKicadBackendOptions);
    const kicadBackend = (this.#options.createKicadBackend ?? ((options) => new ReferenceKicadBackend(options)))(
      backendConfiguration,
    );
    const simulationBackend = (this.#options.createSimulationBackend ?? (() => new ReferenceSimulationBackend()))();
    const firmwareCompileBackend = (
      this.#options.createFirmwareCompileBackend ??
      ((options: LocalFirmwareCompileBackendOptions) => new LocalFirmwareCompileBackend(options))
    )({ environment: this.#firmwareEnvironment });
    const firmwareTargetBuildBackend = await (
      this.#options.createFirmwareTargetBuildBackend ??
      ((options: ArmGnuFirmwareTargetBuildBackendOptions) => createArmGnuFirmwareTargetBuildBackend(options))
    )({ environment: this.#firmwareEnvironment });
    if (
      kicadBackend.backendId !== REFERENCE_KICAD_BACKEND_ID ||
      simulationBackend.backendId !== REFERENCE_SIMULATION_BACKEND_ID ||
      firmwareCompileBackend.backendId !== firmwareCompileBackend.configuration.backendId ||
      firmwareCompileBackend.configuration.schemaVersion !==
        FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA ||
      firmwareTargetBuildBackend.backendId !== firmwareTargetBuildBackend.configuration.backendId ||
      firmwareTargetBuildBackend.configuration.schemaVersion !==
        FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA
    ) {
      throw retryable("TOOLCHAIN_UNSUPPORTED", "Constructed production backend identity is unsupported.", {
        kicadBackendId: kicadBackend.backendId,
        simulationBackendId: simulationBackend.backendId,
        firmwareCompileBackendId: firmwareCompileBackend.backendId,
        firmwareCompileConfigurationBackendId: firmwareCompileBackend.configuration.backendId,
        firmwareTargetBuildBackendId: firmwareTargetBuildBackend.backendId,
        firmwareTargetBuildConfigurationBackendId: firmwareTargetBuildBackend.configuration.backendId,
      });
    }
    const expectedFirmwareEnvironmentIdentity = canonicalIdentity(
      firmwareCompileBackend.configuration.environment,
      FIRMWARE_COMPILE_ENVIRONMENT_SCHEMA,
    );
    if (
      canonicalJson(expectedFirmwareEnvironmentIdentity) !==
      canonicalJson(firmwareCompileBackend.configuration.environmentIdentity)
    ) {
      throw retryable(
        "TOOLCHAIN_UNSUPPORTED",
        "Constructed firmware backend configuration has a detached environment identity.",
      );
    }
    const firmwareCompileConfiguration = immutableClone(firmwareCompileBackend.configuration);
    const firmwareCompileConfigurationIdentity = canonicalIdentity(
      firmwareCompileConfiguration,
      FIRMWARE_COMPILE_BACKEND_CONFIGURATION_SCHEMA,
    );
    const expectedTargetEnvironmentIdentity = canonicalIdentity(
      firmwareTargetBuildBackend.configuration.environment,
      FIRMWARE_TARGET_BUILD_ENVIRONMENT_SCHEMA,
    );
    if (
      canonicalJson(expectedTargetEnvironmentIdentity) !==
      canonicalJson(firmwareTargetBuildBackend.configuration.environmentIdentity)
    ) {
      throw retryable(
        "TOOLCHAIN_UNSUPPORTED",
        "Constructed firmware target backend configuration has a detached environment identity.",
      );
    }
    const firmwareTargetBuildConfiguration = immutableClone(firmwareTargetBuildBackend.configuration);
    const firmwareTargetBuildConfigurationIdentity = canonicalIdentity(
      firmwareTargetBuildConfiguration,
      FIRMWARE_TARGET_BUILD_CONFIGURATION_SCHEMA,
    );
    const kicadBackendConfigurationIdentity = canonicalIdentity(
      {
        backendId: kicadBackend.backendId,
        configuration: backendConfiguration,
        executableIdentity,
        referenceValidationIdentity: referenceValidation.file.identity,
        referenceValidationRoot: referenceValidation.validationRoot,
      },
      KICAD_BACKEND_CONFIGURATION_SCHEMA,
    );
    const simulationBackendConfigurationIdentity = canonicalIdentity(
      {
        backendId: simulationBackend.backendId,
        modelSchema: REFERENCE_SIMULATION_MODEL_SCHEMA,
        modelVersion: REFERENCE_SIMULATION_MODEL_VERSION,
      },
      SIMULATION_BACKEND_CONFIGURATION_SCHEMA,
    );

    const assertReferenceUnchanged = async (): Promise<void> => {
      const current = await loadReferenceValidation(referenceRoot, requireCanonicalSources, budget);
      if (!referenceValidationEqual(referenceValidation, current)) {
        throw retryable("EVIDENCE_STALE", "Canonical reference validation changed after provisioning.", {
          expected: referenceValidation.file.identity,
          actual: current.file.identity,
        });
      }
    };
    const boundKicadBackend: KicadGenerationBackend = {
      backendId: kicadBackend.backendId,
      execute: async (backendRequest) => {
        await assertReferenceUnchanged();
        try {
          return await kicadBackend.execute(backendRequest);
        } finally {
          await assertReferenceUnchanged();
        }
      },
    };
    const boundSimulationBackend: SimulationBackend = {
      backendId: simulationBackend.backendId,
      execute: async (simulationRequest) => simulationBackend.execute(simulationRequest),
    };
    const boundFirmwareCompileBackend: FirmwareCompileBackend = {
      backendId: firmwareCompileBackend.backendId,
      configuration: firmwareCompileConfiguration,
      execute: async (firmwareRequest) => {
        if (
          canonicalJson(firmwareRequest.configurationIdentity) !==
          canonicalJson(firmwareCompileConfigurationIdentity)
        ) {
          throw retryable(
            "TOOLCHAIN_UNSUPPORTED",
            "Firmware request is detached from its provisioned backend configuration.",
          );
        }
        return firmwareCompileBackend.execute(firmwareRequest);
      },
    };
    const boundFirmwareTargetBuildBackend: FirmwareTargetBuildBackend = {
      backendId: firmwareTargetBuildBackend.backendId,
      configuration: firmwareTargetBuildConfiguration,
      execute: async (firmwareRequest) => {
        if (
          canonicalJson(firmwareRequest.configurationIdentity) !==
          canonicalJson(firmwareTargetBuildConfigurationIdentity)
        ) {
          throw retryable(
            "TOOLCHAIN_UNSUPPORTED",
            "Firmware target request is detached from its provisioned backend configuration.",
          );
        }
        return firmwareTargetBuildBackend.execute(firmwareRequest);
      },
    };
    await assertReferenceUnchanged();

    const footprintLibrary = {
      libraryId: footprintDocument.libraryId,
      identity: immutableClone(footprintLibraryIdentity),
      footprints: immutableClone(
        [...footprintNames].sort((left, right) => left.localeCompare(right, "en")),
      ),
    };
    const enrichmentIdentity = canonicalIdentity(
      {
        profile: this.#profile,
        curatedDatasheets,
        sourcing,
        lifecycleObservations,
        pinPadMappingReviews,
        footprintLibrary,
        firmwareCompileConfiguration,
        firmwareTargetBuildConfiguration,
      },
      STAGE_CONTEXT_ENRICHMENT_SCHEMA,
    );
    const provisionManifest = {
      schemaVersion: STAGE_PROVISION_SCHEMA,
      request: {
        projectId: request.project.id,
        projectPolicyVersion: request.project.policyVersion,
        runId: request.run.id,
        workflowVersion: request.run.workflowVersion,
        configuration: request.run.configuration,
        revisionId: request.revision.id,
        revisionManifest: request.revision.manifest,
        stage: request.stage,
      },
      enrichmentIdentity,
      backends: {
        simulation: { backendId: simulationBackend.backendId },
        kicad: { backendId: kicadBackend.backendId },
        firmwareCompile: {
          backendId: firmwareCompileBackend.backendId,
          configurationIdentity: firmwareCompileConfigurationIdentity,
        },
        firmwareTargetBuild: {
          backendId: firmwareTargetBuildBackend.backendId,
          configurationIdentity: firmwareTargetBuildConfigurationIdentity,
        },
      },
      providerEvidence: {
        providerSchemaVersion: REFERENCE_STAGE_CONTEXT_SCHEMA,
        snapshot: {
          path: snapshotFile.path,
          identity: snapshotFile.identity,
          schemaVersion: snapshot.schemaVersion,
        },
        trustRoot: {
          identity: trustRoot.file.identity,
          document: trustRoot.document,
        },
        profile: {
          profileId: this.#profile.profileId,
          boardRevision: this.#profile.boardRevision,
          identity: profileIdentity,
        },
        sources: sourceMaterial,
        footprintLibrary: {
          manifestIdentity: footprintManifest.file.identity,
          manifest: footprintDocument,
          assetIdentities: [...footprintAssets.entries()]
            .sort(([left], [right]) => left.localeCompare(right, "en"))
            .map(([footprint, file]) => ({ footprint, identity: file.identity })),
          snapshotIdentity: footprintLibraryIdentity,
        },
        backendEvidence: {
          simulation: {
            configurationIdentity: simulationBackendConfigurationIdentity,
            modelSchema: REFERENCE_SIMULATION_MODEL_SCHEMA,
            modelVersion: REFERENCE_SIMULATION_MODEL_VERSION,
          },
          kicad: {
            configurationIdentity: kicadBackendConfigurationIdentity,
            configuration: backendConfiguration,
            executableCandidates: this.#executableCandidates,
            executableIdentity,
            referenceValidation: {
              identity: referenceValidation.file.identity,
              validationRoot: referenceValidation.validationRoot,
              bindings: referenceValidation.bindings,
            },
          },
          firmwareCompile: {
            configuration: firmwareCompileConfiguration,
            configurationIdentity: firmwareCompileConfigurationIdentity,
          },
          firmwareTargetBuild: {
            configuration: firmwareTargetBuildConfiguration,
            configurationIdentity: firmwareTargetBuildConfigurationIdentity,
          },
        },
      },
    } satisfies StageContextProvision["provisionManifest"];
    const provisionIdentity = canonicalIdentity(provisionManifest, STAGE_PROVISION_SCHEMA);

    return deepFreeze({
      provisionIdentity: immutableClone(provisionIdentity),
      provisionManifest: immutableClone(provisionManifest),
      profile: immutableClone(this.#profile),
      curatedDatasheets: immutableClone(curatedDatasheets),
      sourcing: immutableClone(sourcing),
      lifecycleObservations: immutableClone(lifecycleObservations),
      pinPadMappingReviews: immutableClone(pinPadMappingReviews),
      footprintLibrary,
      kicadBackend: boundKicadBackend,
      simulationBackend: boundSimulationBackend,
      firmwareCompileBackend: boundFirmwareCompileBackend,
      firmwareCompileConfiguration,
      firmwareTargetBuildBackend: boundFirmwareTargetBuildBackend,
      firmwareTargetBuildConfiguration,
    } satisfies StageContextProvision);
  }
}
