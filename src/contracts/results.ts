import { z } from "zod";
import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import {
  PHYSICAL_OBSERVATION_CATEGORIES,
  physicalCategoryVerdictsSchema,
  stageSchema,
  type OperationName
} from "./operations.js";

export const contentIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    size: z.number().int().nonnegative()
  })
  .strict();

export const canonicalIdentitySchema = z
  .object({
    algorithm: z.literal("sha256"),
    digest: z.string().regex(/^[0-9a-f]{64}$/u),
    schemaVersion: z.string().min(1),
    canonicalizationVersion: z.literal("evleda-c14n-json-v1")
  })
  .strict();

export const exactIdentitySchema = z.union([contentIdentitySchema, canonicalIdentitySchema]);

export const LIVE_REGENERATION_POLICY = Object.freeze({
  scope: "live_model_or_research",
  claim: "traceable",
  reproducible: false
} as const);

export const LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION =
  "evleda.live-regeneration-policy.v1" as const;

/**
 * Independently reproducible canonical identity of LIVE_REGENERATION_POLICY.
 * The digest is SHA-256 over its evleda-c14n-json-v1 canonical JSON preimage.
 */
export const LIVE_REGENERATION_POLICY_IDENTITY = Object.freeze({
  algorithm: "sha256",
  digest: "fe777ec881b19b6f8aa66fd9beaa6b8426365b2b2297e8e667e7d13d83d54e12",
  schemaVersion: LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION,
  canonicalizationVersion: "evleda-c14n-json-v1"
} as const);

export const liveRegenerationPolicySchema = z
  .object({
    scope: z.literal("live_model_or_research"),
    claim: z.literal("traceable"),
    reproducible: z.literal(false)
  })
  .strict();

export const liveRegenerationPolicyIdentitySchema = canonicalIdentitySchema.extend({
  schemaVersion: z.literal(LIVE_REGENERATION_POLICY_IDENTITY_SCHEMA_VERSION)
}).strict();

export const toolIdentitySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    adapter: z.enum(["evleda", "kicad_cli", "kicad_mcp", "external", "human"]),
    executablePath: z.string().optional(),
    executableDigest: z.string().optional(),
    capabilityProfile: z.string().optional()
  })
  .strict();

export const validationStatusSchema = z.enum([
  "pass",
  "fail",
  "error",
  "not_run",
  "unsupported",
  "stale",
  "revoked",
  "waived"
]);

export const unresolvedAssumptionSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    severity: z.enum(["information", "warning", "blocking"]),
    sourceRequirementIds: z.array(z.string())
  })
  .strict();

export const artifactRecordSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    runId: z.string(),
    designRevisionId: z.string(),
    stage: stageSchema,
    logicalName: z.string(),
    mediaType: z.string(),
    blob: contentIdentitySchema,
    exactInputs: z.array(exactIdentitySchema),
    derivedFrom: z.array(z.string()),
    tool: toolIdentitySchema,
    validationStatus: validationStatusSchema,
    unresolvedAssumptions: z.array(unresolvedAssumptionSchema),
    lifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    createdAt: z.iso.datetime(),
    staleAt: z.iso.datetime().optional()
  })
  .strict();

export const evidenceRecordSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    runId: z.string(),
    designRevisionId: z.string(),
    stage: stageSchema,
    evidenceClass: z.enum(["agent_claim", "evleda_check", "kicad_native", "human_physical"]),
    claim: z.string(),
    subjectDigests: z.array(z.string()),
    rawArtifactId: z.string().optional(),
    parsedArtifactId: z.string().optional(),
    exactInputs: z.array(exactIdentitySchema),
    tool: toolIdentitySchema,
    validationStatus: validationStatusSchema,
    unresolvedAssumptions: z.array(unresolvedAssumptionSchema),
    lifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    createdAt: z.iso.datetime(),
    validUntil: z.iso.datetime().optional(),
    staleAt: z.iso.datetime().optional()
  })
  .strict();

export const engineeringMachineStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "UNKNOWN",
  "NOT_RUN"
]);

export const engineeringApplicabilitySchema = z.enum([
  "APPLICABLE",
  "NOT_APPLICABLE",
  "UNKNOWN"
]);

export const engineeringCheckSummarySchema = z
  .object({
    machineStatus: engineeringMachineStatusSchema,
    reasonCode: z.string().min(1),
    message: z.string().min(1),
    current: z.boolean(),
    artifactId: z.string().min(1).nullable(),
    evidenceId: z.string().min(1).nullable(),
    reportIdentity: contentIdentitySchema.nullable(),
    tool: toolIdentitySchema.nullable(),
    evaluatedAt: z.iso.datetime().nullable()
  })
  .strict()
  .superRefine((check, context) => {
    const hasExecution =
      check.artifactId !== null &&
      check.evidenceId !== null &&
      check.reportIdentity !== null &&
      check.tool !== null &&
      check.evaluatedAt !== null;
    if (check.machineStatus === "PASS" && (!check.current || !hasExecution)) {
      context.addIssue({
        code: "custom",
        path: ["machineStatus"],
        message: "PASS requires a current identity-bound execution"
      });
    }
    if (check.machineStatus === "NOT_RUN" && hasExecution) {
      context.addIssue({
        code: "custom",
        path: ["machineStatus"],
        message: "NOT_RUN cannot carry a complete execution authority"
      });
    }
  });

export const engineeringRuleProjectionSchema = z
  .object({
    ruleId: z.string().min(1),
    title: z.string().min(1),
    applicability: engineeringApplicabilitySchema,
    machineStatus: engineeringMachineStatusSchema.nullable(),
    blocking: z.boolean(),
    decisionClasses: z.array(z.string().min(1)),
    reasonCode: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
    exactInputIdentities: z.array(exactIdentitySchema),
    checkerResultIdentities: z.array(exactIdentitySchema),
    findingIds: z.array(z.string().min(1)),
    externalGateIds: z.array(z.string().min(1))
  })
  .strict()
  .superRefine((rule, context) => {
    const notApplicable = rule.applicability === "NOT_APPLICABLE";
    if (notApplicable !== (rule.machineStatus === null)) {
      context.addIssue({
        code: "custom",
        path: ["machineStatus"],
        message: "Only a proven NOT_APPLICABLE rule may have a null machine status"
      });
    }
    if (
      rule.machineStatus === "PASS" &&
      (rule.exactInputIdentities.length === 0 || rule.checkerResultIdentities.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["machineStatus"],
        message: "A passing machine rule requires exact inputs and checker-result identities"
      });
    }
  });

export const engineeringAdvisoryProjectionSchema = z
  .object({
    advisoryId: z.string().min(1),
    ruleIds: z.array(z.string().min(1)).min(1),
    severity: z.enum(["advisory", "warning"]),
    message: z.string().min(1),
    sourceIds: z.array(z.string().min(1)),
    findingIds: z.array(z.string().min(1)).min(1),
    externalGateIds: z.array(z.string().min(1))
  })
  .strict();

export const engineeringExternalGateProjectionSchema = z
  .object({
    gateId: z.string().min(1),
    ruleId: z.string().min(1),
    owner: z.enum(["fabricator", "human", "physical"]),
    status: z.enum(["OPEN", "UNKNOWN"]),
    reasonCode: z.string().min(1),
    message: z.string().min(1),
    subjectIds: z.array(z.string().min(1)),
    sourceIds: z.array(z.string().min(1)),
    exactInputIdentities: z.array(exactIdentitySchema),
    evidenceIds: z.array(z.string().min(1))
  })
  .strict();

const engineeringFindingLocationProjectionSchema = z
  .object({
    artifactId: z.string().min(1),
    artifactIdentity: contentIdentitySchema,
    sourcePath: z.string().min(1),
    form: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    uuid: z.string().min(1).nullable(),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    geometry: z.record(z.string(), z.unknown())
  })
  .strict()
  .refine((location) => location.endOffset >= location.startOffset, {
    message: "Finding location endOffset must not precede startOffset",
    path: ["endOffset"]
  });

const engineeringFindingRemediationProjectionSchema = z
  .object({
    authority: z.literal("advisory_only"),
    requiresNewRevision: z.literal(true),
    summary: z.string().min(1),
    steps: z.array(z.string().min(1)).min(1),
    verification: z.array(z.string().min(1)).min(1),
    rerunRuleIds: z.array(z.string().min(1)).min(1),
    rerunStages: z.array(stageSchema).min(1)
  })
  .strict();

export const engineeringFindingProjectionSchema = z
  .object({
    findingId: z.string().min(1),
    ruleIds: z.array(z.string().min(1)).min(1),
    machineStatus: z.enum(["FAIL", "UNKNOWN", "NOT_RUN"]),
    severity: z.enum(["advisory", "warning", "error"]),
    message: z.string().min(1),
    observed: z.record(z.string(), z.unknown()),
    required: z.record(z.string(), z.unknown()),
    assumptions: z.array(z.string()),
    sourceIds: z.array(z.string().min(1)),
    externalGateIds: z.array(z.string().min(1)),
    locations: z.array(engineeringFindingLocationProjectionSchema),
    remediation: engineeringFindingRemediationProjectionSchema
  })
  .strict();

export const engineeringSourceProjectionSchema = z
  .object({
    sourceId: z.string().min(1),
    title: z.string().min(1),
    publisher: z.string().min(1),
    revision: z.string().min(1),
    date: z
      .object({
        kind: z.enum(["published", "revised", "accessed"]),
        value: z.string().min(1)
      })
      .strict(),
    url: z.url().refine((url) => url.startsWith("https://"), "Source URL must use HTTPS").nullable(),
    authority: z.enum([
      "standards_body",
      "component_manufacturer",
      "connector_manufacturer",
      "protection_manufacturer",
      "fabricator",
      "internal_policy"
    ]),
    accessScope: z.enum([
      "public_full_text",
      "public_scope_or_toc",
      "live_capability_page",
      "embedded_snapshot"
    ]),
    normativeStatus: z.enum([
      "current",
      "unmaintained_reference",
      "manufacturer_guidance",
      "fabricator_specific",
      "internal_product_policy"
    ]),
    captureIdentity: contentIdentitySchema.nullable(),
    locator: z
      .object({ kind: z.string().min(1), value: z.string().min(1) })
      .strict()
      .nullable(),
    excerptIdentity: contentIdentitySchema.nullable(),
    captureComplete: z.boolean()
  })
  .strict()
  .superRefine((source, context) => {
    const complete =
      source.captureIdentity !== null &&
      source.locator !== null &&
      source.excerptIdentity !== null;
    if (source.captureComplete !== complete) {
      context.addIssue({
        code: "custom",
        path: ["captureComplete"],
        message: "Source captureComplete must reproduce from capture, locator, and excerpt identities"
      });
    }
    if (
      (source.authority === "internal_policy") !==
        (source.url === null &&
          source.accessScope === "embedded_snapshot" &&
          source.normativeStatus === "internal_product_policy" &&
          source.captureComplete)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "Internal policy sources require a complete embedded snapshot and no external URL"
      });
    }
    if (source.authority !== "internal_policy" && source.url === null) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "External engineering sources require a validated HTTPS URL"
      });
    }
  });

const engineeringPracticeInspectionPayloadSchema = z
  .object({
    schemaVersion: z.literal("evleda.engineering-practice-inspection.v1"),
    projectId: z.string().min(1),
    runId: z.string().min(1),
    revisionId: z.string().min(1).nullable(),
    isHeadRevision: z.boolean(),
    proofFixture: z
      .object({
        purpose: z.literal("full_stack_engineering_proof_fixture"),
        classification: z.literal("candidate_only"),
        reportEstablishesQualification: z.literal(false),
        reportAuthorizesManufacturing: z.literal(false),
        reportAuthorizesRelease: z.literal(false)
      })
      .strict(),
    disposition: z
      .object({
        status: z.enum(["PROVISIONAL_POC", "BLOCKED_DIAGNOSTIC"]),
        reasonCodes: z.array(z.string().min(1)).min(1),
        machineBlockerRuleIds: z.array(z.string().min(1)),
        openExternalGateIds: z.array(z.string().min(1))
      })
      .strict(),
    bindings: z
      .object({
        revisionManifest: canonicalIdentitySchema.nullable(),
        requirementsIdentity: canonicalIdentitySchema.nullable(),
        evidenceRootIdentity: canonicalIdentitySchema,
        practiceCatalogIdentity: canonicalIdentitySchema.nullable(),
        routeQualityPolicyIdentity: canonicalIdentitySchema.nullable(),
        routeQualityPolicyCaptureIdentity: contentIdentitySchema.nullable(),
        routeQualityRuleDeckIdentity: canonicalIdentitySchema.nullable(),
        proofFixturePolicyIdentity: canonicalIdentitySchema.nullable(),
        analyzerProfileIdentity: canonicalIdentitySchema.nullable(),
        constraintBindingIdentity: canonicalIdentitySchema.nullable(),
        nativeBoardIdentity: contentIdentitySchema.nullable()
      })
      .strict(),
    checks: z
      .object({
        nativeDrc: engineeringCheckSummarySchema
          .and(z.object({ evidenceClass: z.literal("kicad_native") }).strict()),
        evledaPractice: engineeringCheckSummarySchema.and(
          z
            .object({
              evidenceClass: z.literal("evleda_check"),
              analysisOutcome: z.enum(["pass", "review", "fail"]).nullable(),
              reviewRequired: z.boolean(),
              advisoryCount: z.number().int().nonnegative()
            })
            .strict()
        )
      })
      .strict(),
    coverage: z
      .object({
        inventoryComplete: z.boolean(),
        expectedRuleCount: z.number().int().nonnegative(),
        evaluatedRuleCount: z.number().int().nonnegative(),
        applicableRuleCount: z.number().int().nonnegative(),
        notApplicableRuleCount: z.number().int().nonnegative(),
        statusCounts: z
          .object({
            PASS: z.number().int().nonnegative(),
            FAIL: z.number().int().nonnegative(),
            UNKNOWN: z.number().int().nonnegative(),
            NOT_RUN: z.number().int().nonnegative()
          })
          .strict(),
        missingRuleIds: z.array(z.string().min(1)),
        unexpectedRuleIds: z.array(z.string().min(1))
      })
      .strict(),
    rules: z.array(engineeringRuleProjectionSchema),
    advisories: z.array(engineeringAdvisoryProjectionSchema),
    outstandingExternalGates: z.array(engineeringExternalGateProjectionSchema),
    gateSummary: z
      .object({
        machineBlockers: z.number().int().nonnegative(),
        fabricatorOpen: z.number().int().nonnegative(),
        humanOpen: z.number().int().nonnegative(),
        physicalOpen: z.number().int().nonnegative()
      })
      .strict(),
    findings: z
      .object({
        total: z.number().int().nonnegative(),
        items: z.array(engineeringFindingProjectionSchema).max(100),
        nextCursor: z.string().min(1).max(2_048).nullable()
      })
      .strict(),
    sources: z.array(engineeringSourceProjectionSchema)
  })
  .strict();

export const engineeringPracticeInspectionResultSchema =
  engineeringPracticeInspectionPayloadSchema
    .extend({
      identity: canonicalIdentitySchema.extend({
        schemaVersion: z.literal("evleda.engineering-practice-inspection.v1")
      }).strict()
    })
    .strict()
    .superRefine((result, context) => {
      const duplicate = (values: readonly string[]): boolean =>
        new Set(values).size !== values.length;
      const addDuplicateIssue = (path: (string | number)[], values: readonly string[]): void => {
        if (duplicate(values)) {
          context.addIssue({ code: "custom", path, message: "Identifiers must be unique" });
        }
      };
      const ruleIds = result.rules.map((rule) => rule.ruleId);
      const advisoryIds = result.advisories.map((advisory) => advisory.advisoryId);
      const gateIds = result.outstandingExternalGates.map((gate) => gate.gateId);
      const findingIds = result.findings.items.map((finding) => finding.findingId);
      const sourceIds = result.sources.map((source) => source.sourceId);
      addDuplicateIssue(["rules"], ruleIds);
      addDuplicateIssue(["advisories"], advisoryIds);
      addDuplicateIssue(["outstandingExternalGates"], gateIds);
      addDuplicateIssue(["findings", "items"], findingIds);
      addDuplicateIssue(["sources"], sourceIds);
      addDuplicateIssue(["disposition", "reasonCodes"], result.disposition.reasonCodes);
      const sourceIdSet = new Set(sourceIds);
      const gateIdSet = new Set(gateIds);
      const danglingSourceId = [
        ...result.rules.flatMap((rule) => rule.sourceIds),
        ...result.advisories.flatMap((advisory) => advisory.sourceIds),
        ...result.outstandingExternalGates.flatMap((gate) => gate.sourceIds),
        ...result.findings.items.flatMap((finding) => finding.sourceIds)
      ].find((sourceId) => !sourceIdSet.has(sourceId));
      const danglingGateId = [
        ...result.rules.flatMap((rule) => rule.externalGateIds),
        ...result.advisories.flatMap((advisory) => advisory.externalGateIds),
        ...result.findings.items.flatMap((finding) => finding.externalGateIds)
      ].find((gateId) => !gateIdSet.has(gateId));
      if (danglingSourceId !== undefined || danglingGateId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["rules"],
          message: "Rule, advisory, gate, and finding references must resolve in the projection"
        });
      }
      if (result.revisionId === null) {
        if (
          result.isHeadRevision ||
          result.bindings.revisionManifest !== null ||
          result.checks.nativeDrc.machineStatus !== "NOT_RUN" ||
          result.checks.evledaPractice.machineStatus !== "NOT_RUN" ||
          result.checks.evledaPractice.analysisOutcome !== null ||
          result.coverage.inventoryComplete
        ) {
          context.addIssue({
            code: "custom",
            path: ["revisionId"],
            message: "A missing revision requires an honest non-head NOT_RUN diagnostic"
          });
        }
      } else if (result.bindings.revisionManifest === null) {
        context.addIssue({
          code: "custom",
          path: ["bindings", "revisionManifest"],
          message: "A selected revision requires its exact canonical manifest identity"
        });
      }
      if (
        result.checks.evledaPractice.machineStatus === "PASS" &&
        result.checks.evledaPractice.analysisOutcome !== "pass" &&
        result.checks.evledaPractice.analysisOutcome !== "review"
      ) {
        context.addIssue({
          code: "custom",
          path: ["checks", "evledaPractice", "analysisOutcome"],
          message: "A passing practice execution must expose its pass or review analysis outcome"
        });
      }

      const statusCounts = { PASS: 0, FAIL: 0, UNKNOWN: 0, NOT_RUN: 0 };
      for (const rule of result.rules) {
        if (rule.machineStatus !== null) statusCounts[rule.machineStatus] += 1;
      }
      const missing = new Set(result.coverage.missingRuleIds);
      const expectedEvaluated = result.rules.filter((rule) => !missing.has(rule.ruleId)).length;
      const expectedCoverage = {
        expectedRuleCount: result.rules.length,
        evaluatedRuleCount: expectedEvaluated,
        applicableRuleCount: result.rules.filter(
          (rule) => rule.applicability === "APPLICABLE"
        ).length,
        notApplicableRuleCount: result.rules.filter(
          (rule) => rule.applicability === "NOT_APPLICABLE"
        ).length,
        statusCounts
      };
      if (
        result.coverage.expectedRuleCount !== expectedCoverage.expectedRuleCount ||
        result.coverage.evaluatedRuleCount !== expectedCoverage.evaluatedRuleCount ||
        result.coverage.applicableRuleCount !== expectedCoverage.applicableRuleCount ||
        result.coverage.notApplicableRuleCount !== expectedCoverage.notApplicableRuleCount ||
        canonicalJson(result.coverage.statusCounts) !== canonicalJson(expectedCoverage.statusCounts)
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage"],
          message: "Coverage denominators and status counts must reproduce exactly from rules"
        });
      }
      if (
        result.coverage.missingRuleIds.some((ruleId) => !ruleIds.includes(ruleId)) ||
        duplicate(result.coverage.missingRuleIds) ||
        duplicate(result.coverage.unexpectedRuleIds)
      ) {
        context.addIssue({
          code: "custom",
          path: ["coverage", "missingRuleIds"],
          message: "Coverage IDs must be unique and missing rules must remain in the rule denominator"
        });
      }
      const expectedInventoryComplete =
        result.revisionId !== null &&
        result.coverage.missingRuleIds.length === 0 &&
        result.coverage.unexpectedRuleIds.length === 0 &&
        result.coverage.evaluatedRuleCount === result.coverage.expectedRuleCount;
      if (result.coverage.inventoryComplete !== expectedInventoryComplete) {
        context.addIssue({
          code: "custom",
          path: ["coverage", "inventoryComplete"],
          message: "inventoryComplete must reproduce from the complete selected-revision rule inventory"
        });
      }
      const expectedOpenGateIds = [...gateIds].sort();
      if (
        canonicalJson([...result.disposition.openExternalGateIds].sort()) !==
        canonicalJson(expectedOpenGateIds)
      ) {
        context.addIssue({
          code: "custom",
          path: ["disposition", "openExternalGateIds"],
          message: "Disposition must list every outstanding external gate exactly once"
        });
      }
      const machineBlockerRuleIds = result.rules
        .filter(
          (rule) =>
            rule.blocking &&
            rule.applicability !== "NOT_APPLICABLE" &&
            rule.machineStatus !== "PASS"
        )
        .map((rule) => rule.ruleId)
        .sort();
      if (
        canonicalJson([...result.disposition.machineBlockerRuleIds].sort()) !==
        canonicalJson(machineBlockerRuleIds)
      ) {
        context.addIssue({
          code: "custom",
          path: ["disposition", "machineBlockerRuleIds"],
          message: "Disposition machine blockers must reproduce from blocking rule statuses"
        });
      }
      const expectedGateSummary = {
        machineBlockers: machineBlockerRuleIds.length,
        fabricatorOpen: result.outstandingExternalGates.filter(
          (gate) => gate.owner === "fabricator"
        ).length,
        humanOpen: result.outstandingExternalGates.filter((gate) => gate.owner === "human").length,
        physicalOpen: result.outstandingExternalGates.filter(
          (gate) => gate.owner === "physical"
        ).length
      };
      if (canonicalJson(result.gateSummary) !== canonicalJson(expectedGateSummary)) {
        context.addIssue({
          code: "custom",
          path: ["gateSummary"],
          message: "Gate summary must reproduce from machine and external gate projections"
        });
      }
      if (result.findings.total < result.findings.items.length) {
        context.addIssue({
          code: "custom",
          path: ["findings", "total"],
          message: "Finding total cannot be smaller than the bounded page"
        });
      }
      const advisoryCount = result.advisories.filter(
        (advisory) => advisory.severity === "advisory"
      ).length;
      if (result.checks.evledaPractice.advisoryCount !== advisoryCount) {
        context.addIssue({
          code: "custom",
          path: ["checks", "evledaPractice", "advisoryCount"],
          message: "Practice advisory count must reproduce from advisory projections"
        });
      }
      const requiredBindings = Object.values(result.bindings).every((binding) => binding !== null);
      const everyApplicablePass = result.rules.every(
        (rule) =>
          !rule.blocking ||
          rule.applicability === "NOT_APPLICABLE" ||
          (rule.applicability === "APPLICABLE" && rule.machineStatus === "PASS")
      );
      const pocEligible =
        result.revisionId !== null &&
        result.isHeadRevision &&
        result.coverage.inventoryComplete &&
        result.rules.length > 0 &&
        everyApplicablePass &&
        result.checks.nativeDrc.current &&
        result.checks.nativeDrc.machineStatus === "PASS" &&
        result.checks.evledaPractice.current &&
        result.checks.evledaPractice.machineStatus === "PASS" &&
        machineBlockerRuleIds.length === 0 &&
        requiredBindings &&
        result.disposition.reasonCodes.length === 1 &&
        result.disposition.reasonCodes[0] === "COMPLETE_CURRENT_MACHINE_PASS";
      if ((result.disposition.status === "PROVISIONAL_POC") !== pocEligible) {
        context.addIssue({
          code: "custom",
          path: ["disposition", "status"],
          message: "PROVISIONAL_POC requires a complete current machine pass and full frozen bindings"
        });
      }
      const { identity: _identity, ...payload } = result;
      const expectedIdentity = canonicalIdentity(
        payload,
        "evleda.engineering-practice-inspection.v1"
      );
      if (canonicalJson(result.identity) !== canonicalJson(expectedIdentity)) {
        context.addIssue({
          code: "custom",
          path: ["identity"],
          message: "Inspection identity does not match its exact canonical payload"
        });
      }
    });

export const requirementSchema = z
  .object({
    id: z.string(),
    statement: z.string(),
    category: z.enum([
      "power",
      "compute",
      "actuator",
      "sensor",
      "communication",
      "mechanical",
      "environment",
      "safety",
      "firmware",
      "manufacturing"
    ]),
    priority: z.enum(["must", "should", "could"]),
    hazardClass: z.enum(["none", "functional", "electrical", "thermal", "mechanical"]),
    normalizedValue: z.string().optional(),
    tolerance: z.string().optional(),
    sourceSpans: z.array(
      z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), excerpt: z.string() }).strict()
    ),
    verificationMethod: z.string(),
    acceptanceCriteria: z.string()
  })
  .strict();

export const requirementsDocumentSchema = z
  .object({
    schemaVersion: z.literal("evleda.requirements.v1"),
    identity: canonicalIdentitySchema,
    sourcePrompt: contentIdentitySchema,
    requirements: z.array(requirementSchema),
    constraints: z.record(z.string(), z.string()),
    exclusions: z.array(z.string()),
    unresolvedAssumptions: z.array(unresolvedAssumptionSchema),
    approvalId: z.string().optional()
  })
  .strict();

export const blockerSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    stage: stageSchema,
    affectedInputDigests: z.array(z.string()),
    requiredAction: z.string(),
    retryable: z.boolean(),
    createdAt: z.iso.datetime()
  })
  .strict();

export const stageAttemptSchema = z
  .object({
    id: z.string(),
    stage: stageSchema,
    attemptNumber: z.number().int().positive(),
    state: z.enum([
      "pending",
      "running",
      "waiting_approval",
      "blocked",
      "interrupted",
      "succeeded",
      "stale"
    ]),
    inputManifest: canonicalIdentitySchema,
    provisionIdentity: canonicalIdentitySchema.optional(),
    provisionManifestBlob: contentIdentitySchema.optional(),
    outputIdentity: canonicalIdentitySchema.optional(),
    resultRevisionId: z.string().optional(),
    executionFence: z
      .object({
        inputManifest: canonicalIdentitySchema,
        parentRevisionId: z.string(),
        parentRevisionManifest: canonicalIdentitySchema,
        projectHeadRevisionId: z.string(),
        requirementsApprovalId: z.string(),
        requirementsApprovalDigest: z.string(),
        nativeProcessPlanBindings: z.array(z.object({
          schemaVersion: z.literal("evleda.native-process-plan-binding.v3"),
          profileDomain: z.enum(["kicad", "firmware"]),
          operation: z.enum([
            "kicad_erc",
            "kicad_drc",
            "kicad_netlist",
            "kicad_stats",
            "kicad_d356",
            "kicad_pdf",
            "compile",
            "link",
            "objcopy"
          ]),
          contractIdentity: canonicalIdentitySchema,
          planIdentity: canonicalIdentitySchema.extend({
            schemaVersion: z.literal("evleda.native-process-plan.v2")
          }).strict(),
          portableReceiptPlanIdentityV1: canonicalIdentitySchema.extend({
            schemaVersion: z.literal("evleda.native-process-plan.v1")
          }).strict()
        }).strict()).optional()
      })
      .strict()
      .optional(),
    artifactIds: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    blockers: z.array(blockerSchema),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    fencingEpoch: z.number().int().positive()
  })
  .strict();

export const projectSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    root: z.string(),
    policyVersion: z.string(),
    headRevisionId: z.string().optional(),
    runIds: z.array(z.string()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().nonnegative()
  })
  .strict();

export const designRunSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    parentRunId: z.string().optional(),
    sourcePrompt: contentIdentitySchema,
    workflowVersion: z.string(),
    configuration: canonicalIdentitySchema,
    state: z.enum([
      "queued",
      "running",
      "waiting_requirements_approval",
      "blocked",
      "interrupted",
      "completed",
      "cancelled"
    ]),
    lifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    requirements: requirementsDocumentSchema.optional(),
    attempts: z.record(stageSchema, z.array(stageAttemptSchema)),
    headRevisionId: z.string().optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().nonnegative()
  })
  .strict();

export const designRevisionSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    runId: z.string(),
    createdByAttemptId: z.string().optional(),
    ordinal: z.number().int().positive(),
    parentRevisionIds: z.array(z.string()),
    manifest: canonicalIdentitySchema,
    manifestRecordBlob: contentIdentitySchema.optional(),
    artifactIds: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    lifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    createdAt: z.iso.datetime()
  })
  .strict();

export const approvalRecordSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["requirements", "qualification", "manufacturing_release", "waiver"]),
    projectId: z.string(),
    runId: z.string().optional(),
    designRevisionId: z.string().optional(),
    subjectDigest: z.string(),
    evidenceRootDigest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
    qualificationApprovalId: z.string().optional(),
    policyVersion: z.string(),
    actor: z.object({
      type: z.literal("human"),
      id: z.string(),
      displayName: z.string(),
      role: z.enum(["requirements_reviewer", "hardware_qualifier", "release_authority"])
    }).strict(),
    scope: z.string(),
    rationale: z.string(),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().optional(),
    revokedAt: z.iso.datetime().optional()
  })
  .strict()
  .superRefine((approval, context) => {
    if (
      (approval.kind === "qualification" || approval.kind === "manufacturing_release") &&
      approval.evidenceRootDigest === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRootDigest"],
        message: "Qualification and release attestations require an exact evidence root"
      });
    }
    if (
      approval.kind === "manufacturing_release" &&
      approval.qualificationApprovalId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualificationApprovalId"],
        message: "Manufacturing release must bind the exact qualification approval"
      });
    }
  });

export const runStatusResultSchema = z
  .object({
    project: projectSchema,
    run: designRunSchema,
    headRevision: designRevisionSchema.optional(),
    currentStage: stageSchema,
    nextStage: stageSchema.optional(),
    blockers: z.array(
      z.object({
        code: z.string(),
        message: z.string(),
        stage: stageSchema,
        requiredAction: z.string(),
        retryable: z.boolean()
      }).strict()
    ),
    effectiveLifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    activeAttestations: z.array(approvalRecordSchema),
    stateRevision: z.number().int().nonnegative()
  })
  .strict();

export const bundleManifestArtifactSchema = z
  .object({
    path: z.string(),
    logicalName: z.string(),
    mediaType: z.string(),
    identity: contentIdentitySchema,
    stage: stageSchema,
    validationStatus: validationStatusSchema,
    sourceArtifactId: z.string(),
    sourceKind: z.enum(["stored_artifact", "bundle_generated"]),
    sourceDesignRevisionId: z.string(),
    projectId: z.string(),
    runId: z.string(),
    designRevisionId: z.string(),
    exactInputs: z.array(exactIdentitySchema),
    derivedFrom: z.array(z.string()),
    tool: toolIdentitySchema,
    unresolvedAssumptions: z.array(unresolvedAssumptionSchema),
    lifecycle: z.enum(["candidate", "qualified", "release_authorized"]),
    createdAt: z.iso.datetime().nullable(),
    staleAt: z.iso.datetime().nullable(),
    generationRole: z
      .enum(["revision_record", "evidence_inventory", "readme", "warning", "cover"])
      .optional()
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.sourceKind === "bundle_generated" && artifact.generationRole === undefined) {
      context.addIssue({
        code: "custom",
        path: ["generationRole"],
        message: "Bundle-generated artifacts require a generation role"
      });
    }
    if (artifact.sourceKind === "stored_artifact" && artifact.generationRole !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["generationRole"],
        message: "Stored artifacts cannot declare a generation role"
      });
    }
  });

const bundleManifestBaseShape = {
  canonicalizationVersion: z.literal("evleda-c14n-json-v1"),
  bundleKind: z.enum(["candidate", "prototype"]),
  lifecycle: z.enum(["candidate", "qualified"]),
  projectId: z.string(),
  runId: z.string(),
  designRevisionId: z.string(),
  designRevisionOrdinal: z.number().int().positive(),
  revisionManifest: canonicalIdentitySchema,
  revisionRecordPath: z.literal("provenance/revision.json"),
  evidenceRoot: canonicalIdentitySchema,
  evidenceInventoryPath: z.literal("evidence/evidence.json"),
  warning: z.string(),
  artifacts: z.array(bundleManifestArtifactSchema),
  toolchain: z.array(toolIdentitySchema),
  unresolvedAssumptions: z.array(unresolvedAssumptionSchema)
} as const;

type ParsedCanonicalIdentity = z.infer<typeof canonicalIdentitySchema>;
type ParsedExactIdentity = z.infer<typeof exactIdentitySchema>;
type ParsedBundleManifestArtifact = z.infer<typeof bundleManifestArtifactSchema>;
type ParsedToolIdentity = z.infer<typeof toolIdentitySchema>;
type BundleCapabilityProfile = "deterministic-zip-v2" | "deterministic-zip-v3";

const expectedBundleTool = (capabilityProfile: BundleCapabilityProfile): ParsedToolIdentity => ({
  name: "evleda-deterministic-bundler",
  version: "0.1.0",
  adapter: "evleda",
  capabilityProfile
});

const sameToolIdentity = (left: ParsedToolIdentity, right: ParsedToolIdentity): boolean =>
  canonicalJson(left) === canonicalJson(right);

const isBundleToolFamily = (tool: ParsedToolIdentity): boolean =>
  tool.name === "evleda-deterministic-bundler" ||
  tool.capabilityProfile?.startsWith("deterministic-zip-") === true;

const sameCanonicalIdentity = (
  left: ParsedCanonicalIdentity,
  right: ParsedCanonicalIdentity
): boolean =>
  left.algorithm === right.algorithm &&
  left.digest === right.digest &&
  left.schemaVersion === right.schemaVersion &&
  left.canonicalizationVersion === right.canonicalizationVersion;

const sameExactIdentity = (
  left: ParsedExactIdentity,
  right: ParsedCanonicalIdentity
): boolean => !("size" in left) && sameCanonicalIdentity(left, right);

const exactInputsMatch = (
  actual: readonly ParsedExactIdentity[],
  expected: readonly ParsedCanonicalIdentity[]
): boolean =>
  actual.length === expected.length &&
  actual.every((identity, index) => {
    const expectedIdentity = expected[index];
    return expectedIdentity !== undefined && sameExactIdentity(identity, expectedIdentity);
  });

const requireManifestRootSchemas = (
  manifest: {
    readonly revisionManifest: ParsedCanonicalIdentity;
    readonly evidenceRoot: ParsedCanonicalIdentity;
  },
  context: z.RefinementCtx
): void => {
  if (manifest.revisionManifest.schemaVersion !== "evleda.design-revision.v1") {
    context.addIssue({
      code: "custom",
      path: ["revisionManifest", "schemaVersion"],
      message: "Bundle revision identity must use evleda.design-revision.v1"
    });
  }
  if (manifest.evidenceRoot.schemaVersion !== "evleda.evidence-root.v1") {
    context.addIssue({
      code: "custom",
      path: ["evidenceRoot", "schemaVersion"],
      message: "Bundle evidence identity must use evleda.evidence-root.v1"
    });
  }
};

const requireGeneratedArtifactInputs = (
  artifacts: readonly ParsedBundleManifestArtifact[],
  expectedInputs: readonly ParsedCanonicalIdentity[],
  capabilityProfile: BundleCapabilityProfile,
  context: z.RefinementCtx
): void => {
  const requiredTool = expectedBundleTool(capabilityProfile);
  artifacts.forEach((artifact, index) => {
    if (artifact.sourceKind !== "bundle_generated") return;
    if (!exactInputsMatch(artifact.exactInputs, expectedInputs)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", index, "exactInputs"],
        message: "Bundle-generated artifact exact inputs must match the ordered bundle inputs"
      });
    }
    if (!sameToolIdentity(artifact.tool, requiredTool)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", index, "tool"],
        message: `Bundle-generated artifacts require the exact ${capabilityProfile} bundler identity`
      });
    }
  });
};

const requireExactManifestToolchain = (
  artifacts: readonly ParsedBundleManifestArtifact[],
  toolchain: readonly ParsedToolIdentity[],
  capabilityProfile: BundleCapabilityProfile,
  context: z.RefinementCtx
): void => {
  const artifactTools = new Map<string, ParsedToolIdentity>();
  artifacts.forEach((artifact, index) => {
    const identity = canonicalIdentity(artifact.tool, "evleda.tool-identity.v1").digest;
    const existing = artifactTools.get(identity);
    if (existing !== undefined && !sameToolIdentity(existing, artifact.tool)) {
      context.addIssue({
        code: "custom",
        path: ["artifacts", index, "tool"],
        message: "Bundle artifact tool identity collides with a different canonical tool"
      });
    }
    artifactTools.set(identity, artifact.tool);
  });
  const expectedToolchain = [...artifactTools.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, tool]) => tool);
  if (canonicalJson(toolchain) !== canonicalJson(expectedToolchain)) {
    context.addIssue({
      code: "custom",
      path: ["toolchain"],
      message: "Bundle manifest toolchain must be the exact unique artifact-tool union"
    });
  }

  const requiredTool = expectedBundleTool(capabilityProfile);
  const bundleTools = toolchain.filter(isBundleToolFamily);
  if (bundleTools.length !== 1 || !sameToolIdentity(bundleTools[0]!, requiredTool)) {
    context.addIssue({
      code: "custom",
      path: ["toolchain"],
      message: `Bundle manifest toolchain requires exactly one ${capabilityProfile} bundler identity`
    });
  }
};

/** Strict compatibility schema for original, unlabeled bundle-manifest v2 data. */
export const legacyBundleManifestSchema = z
  .object({
    schemaVersion: z.literal("evleda.bundle-manifest.v2"),
    ...bundleManifestBaseShape
  })
  .strict()
  .superRefine((manifest, context) => {
    requireManifestRootSchemas(manifest, context);
    requireGeneratedArtifactInputs(
      manifest.artifacts,
      [manifest.revisionManifest, manifest.evidenceRoot],
      "deterministic-zip-v2",
      context
    );
    requireExactManifestToolchain(
      manifest.artifacts,
      manifest.toolchain,
      "deterministic-zip-v2",
      context
    );
  });

/** Current v3 bundle schema with a canonical, ordered policy dependency. */
export const bundleManifestSchema = z
  .object({
    schemaVersion: z.literal("evleda.bundle-manifest.v3"),
    ...bundleManifestBaseShape,
    exactInputs: z.tuple([
      canonicalIdentitySchema,
      canonicalIdentitySchema,
      liveRegenerationPolicyIdentitySchema
    ]),
    liveRegenerationPolicy: liveRegenerationPolicySchema,
    liveRegenerationPolicyIdentity: liveRegenerationPolicyIdentitySchema
  })
  .strict()
  .superRefine((manifest, context) => {
    requireManifestRootSchemas(manifest, context);
    const expectedInputs = [
      manifest.revisionManifest,
      manifest.evidenceRoot,
      manifest.liveRegenerationPolicyIdentity
    ] as const;
    if (!exactInputsMatch(manifest.exactInputs, expectedInputs)) {
      context.addIssue({
        code: "custom",
        path: ["exactInputs"],
        message: "Bundle manifest exact inputs must be revision, evidence, then policy identity"
      });
    }
    if (!sameCanonicalIdentity(
      manifest.liveRegenerationPolicyIdentity,
      LIVE_REGENERATION_POLICY_IDENTITY
    )) {
      context.addIssue({
        code: "custom",
        path: ["liveRegenerationPolicyIdentity"],
        message: "Live-regeneration policy identity does not match the exact policy"
      });
    }
    requireGeneratedArtifactInputs(
      manifest.artifacts,
      expectedInputs,
      "deterministic-zip-v3",
      context
    );
    requireExactManifestToolchain(
      manifest.artifacts,
      manifest.toolchain,
      "deterministic-zip-v3",
      context
    );
  });

export const bundleManifestV3Schema = bundleManifestSchema;

const bundleExportResultBaseShape = {
  projectId: z.string(),
  runId: z.string(),
  designRevisionId: z.string(),
  workflowStage: z.literal("manufacturing_package"),
  fileName: z.string(),
  mediaType: z.literal("application/zip"),
  identity: contentIdentitySchema,
  bytesBase64: z.string(),
  tool: toolIdentitySchema,
  validationStatus: validationStatusSchema,
  unresolvedAssumptions: z.array(unresolvedAssumptionSchema),
  lifecycle: z.enum(["candidate", "qualified"])
} as const;

const legacyBundleExportResultObjectSchema = z.object({
  ...bundleExportResultBaseShape,
  manifest: legacyBundleManifestSchema,
  exactInputs: z.tuple([canonicalIdentitySchema, canonicalIdentitySchema])
}).strict();

const currentBundleExportResultObjectSchema = z.object({
  ...bundleExportResultBaseShape,
  manifest: bundleManifestSchema,
  exactInputs: z.tuple([
    canonicalIdentitySchema,
    canonicalIdentitySchema,
    liveRegenerationPolicyIdentitySchema
  ]),
  liveRegenerationPolicy: liveRegenerationPolicySchema,
  liveRegenerationPolicyIdentity: liveRegenerationPolicyIdentitySchema
}).strict();

const requireLegacyBundleExportBindings = (
  result: Pick<
    z.infer<typeof legacyBundleExportResultObjectSchema>,
    "manifest" | "exactInputs" | "tool"
  >,
  context: z.RefinementCtx
): void => {
  if (!exactInputsMatch(result.exactInputs, [
    result.manifest.revisionManifest,
    result.manifest.evidenceRoot
  ])) {
    context.addIssue({
      code: "custom",
      path: ["exactInputs"],
      message: "Legacy export exact inputs must be revision then evidence"
    });
  }
  if (!sameToolIdentity(result.tool, expectedBundleTool("deterministic-zip-v2"))) {
    context.addIssue({
      code: "custom",
      path: ["tool"],
      message: "Legacy v2 exports require the exact deterministic-zip-v2 bundler identity"
    });
  }
};

const requireCurrentBundleExportBindings = (
  result: Pick<
    z.infer<typeof currentBundleExportResultObjectSchema>,
    | "manifest"
    | "exactInputs"
    | "tool"
    | "liveRegenerationPolicy"
    | "liveRegenerationPolicyIdentity"
  >,
  context: z.RefinementCtx
): void => {
  const expectedInputs = [
    result.manifest.revisionManifest,
    result.manifest.evidenceRoot,
    result.manifest.liveRegenerationPolicyIdentity
  ] as const;
  if (!exactInputsMatch(result.exactInputs, expectedInputs)) {
    context.addIssue({
      code: "custom",
      path: ["exactInputs"],
      message: "Current export exact inputs must be revision, evidence, then policy identity"
    });
  }
  if (
    result.liveRegenerationPolicy.scope !== result.manifest.liveRegenerationPolicy.scope ||
    result.liveRegenerationPolicy.claim !== result.manifest.liveRegenerationPolicy.claim ||
    result.liveRegenerationPolicy.reproducible !==
      result.manifest.liveRegenerationPolicy.reproducible
  ) {
    context.addIssue({
      code: "custom",
      path: ["liveRegenerationPolicy"],
      message: "Result and bundle manifest live-regeneration policies must match exactly"
    });
  }
  if (!sameCanonicalIdentity(
    result.liveRegenerationPolicyIdentity,
    result.manifest.liveRegenerationPolicyIdentity
  )) {
    context.addIssue({
      code: "custom",
      path: ["liveRegenerationPolicyIdentity"],
      message: "Result and bundle manifest live-regeneration policy identities must match exactly"
    });
  }
  if (!sameToolIdentity(result.tool, expectedBundleTool("deterministic-zip-v3"))) {
    context.addIssue({
      code: "custom",
      path: ["tool"],
      message: "Current v3 exports require the exact deterministic-zip-v3 bundler identity"
    });
  }
};

export const legacyBundleExportResultSchema = legacyBundleExportResultObjectSchema.superRefine(
  requireLegacyBundleExportBindings
);
export const currentBundleExportResultSchema = currentBundleExportResultObjectSchema.superRefine(
  requireCurrentBundleExportBindings
);
export const bundleExportResultSchema = z.union([
  currentBundleExportResultSchema,
  legacyBundleExportResultSchema
]);

export const legacyStoredBundleExportResultSchema = legacyBundleExportResultObjectSchema
  .omit({ bytesBase64: true })
  .superRefine(requireLegacyBundleExportBindings);
export const currentStoredBundleExportResultSchema = currentBundleExportResultObjectSchema
  .omit({ bytesBase64: true })
  .superRefine(requireCurrentBundleExportBindings);
export const storedBundleExportResultSchema = z.union([
  currentStoredBundleExportResultSchema,
  legacyStoredBundleExportResultSchema
]);

export const bundleExportReplayV1Schema = z.object({
  schemaVersion: z.literal("evleda.bundle-export-replay.v1"),
  result: legacyStoredBundleExportResultSchema
}).strict();
export const bundleExportReplayV2Schema = z.object({
  schemaVersion: z.literal("evleda.bundle-export-replay.v2"),
  result: currentStoredBundleExportResultSchema
}).strict();
export const bundleExportReplaySchema = z.discriminatedUnion("schemaVersion", [
  bundleExportReplayV1Schema,
  bundleExportReplayV2Schema
]);

const generatedArtifactResultSchema = z
  .object({
    projectId: z.string(),
    runId: z.string(),
    designRevisionId: z.string(),
    workflowStage: z.enum(["bringup_package", "firmware_contract"]),
    artifact: artifactRecordSchema,
    revision: designRevisionSchema
  })
  .strict();

export const externalEvidenceResultSchema = z
  .object({
    rawArtifact: artifactRecordSchema,
    parsedArtifact: artifactRecordSchema,
    evidence: evidenceRecordSchema,
    evidenceRootBefore: canonicalIdentitySchema,
    evidenceRoot: canonicalIdentitySchema,
    categoryVerdicts: physicalCategoryVerdictsSchema,
    overallVerdict: z.enum(["pass", "fail"]),
    stateRevision: z.number().int().nonnegative()
  })
  .strict()
  .superRefine((result, context) => {
    const derivedOverall = PHYSICAL_OBSERVATION_CATEGORIES.every(
      (category) => result.categoryVerdicts[category] === "pass"
    )
      ? "pass"
      : "fail";
    if (result.overallVerdict !== derivedOverall) {
      context.addIssue({
        code: "custom",
        path: ["overallVerdict"],
        message: "Overall physical verdict does not match category verdicts"
      });
    }
    if (
      result.rawArtifact.lifecycle !== "candidate" ||
      result.parsedArtifact.lifecycle !== "candidate" ||
      result.evidence.lifecycle !== "candidate"
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence", "lifecycle"],
        message: "External physical evidence records must remain candidate-only"
      });
    }
    if (
      result.evidence.rawArtifactId !== result.rawArtifact.id ||
      result.evidence.parsedArtifactId !== result.parsedArtifact.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "Physical evidence result artifact references do not match"
      });
    }
    if (
      result.rawArtifact.validationStatus !== result.overallVerdict ||
      result.parsedArtifact.validationStatus !== result.overallVerdict ||
      result.evidence.validationStatus !== result.overallVerdict
    ) {
      context.addIssue({
        code: "custom",
        path: ["overallVerdict"],
        message: "Physical evidence statuses do not match the derived overall verdict"
      });
    }
  });

export const operationResultSchemas = {
  create_project: z.object({ project: projectSchema, stateRevision: z.number().int().nonnegative() }).strict(),
  start_design_run: runStatusResultSchema,
  get_run_status: runStatusResultSchema,
  inspect_requirements: z.object({
    projectId: z.string(),
    runId: z.string(),
    requirements: requirementsDocumentSchema,
    requirementsDigest: z.string(),
    approvable: z.boolean(),
    approval: approvalRecordSchema.optional()
  }).strict(),
  approve_requirements: runStatusResultSchema,
  resume_run: runStatusResultSchema,
  list_artifacts: z.object({
    projectId: z.string(),
    runId: z.string(),
    revisionId: z.string().nullable(),
    artifacts: z.array(artifactRecordSchema)
  }).strict(),
  inspect_evidence: z.object({
    projectId: z.string(),
    runId: z.string(),
    revisionId: z.string().nullable(),
    evidence: z.array(evidenceRecordSchema),
    evidenceRoot: canonicalIdentitySchema
  }).strict(),
  inspect_engineering_practices: engineeringPracticeInspectionResultSchema,
  rerun_stage: runStatusResultSchema,
  export_candidate_bundle: bundleExportResultSchema,
  export_prototype_bundle: bundleExportResultSchema,
  generate_bringup_plan: generatedArtifactResultSchema,
  generate_firmware_scaffold: generatedArtifactResultSchema
} as const satisfies Record<OperationName, z.ZodType>;
