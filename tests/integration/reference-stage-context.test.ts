import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StageContextProviderRequest } from "../../src/application/ports.js";
import { canonicalIdentity, canonicalJson, contentIdentity, sha256 } from "../../src/core/canonical.js";
import { parseRequirements } from "../../src/core/requirements.js";
import type { ApprovalRecord } from "../../src/domain/types.js";
import { componentSelectionStageExecutor } from "../../src/generators/component-selection-generator.js";
import { finalizeStageResult } from "../../src/generators/draft-utils.js";
import type { KicadExecutableIdentity } from "../../src/integrations/kicad-cli.js";
import {
  REFERENCE_KICAD_BACKEND_ID,
  REFERENCE_VALIDATION_SCHEMA,
  type ReferenceKicadBackendOptions,
} from "../../src/integrations/reference-kicad-backend.js";
import {
  FOOTPRINT_LIBRARY_CAPTURE_SCHEMA,
  COMPONENT_EVIDENCE_REVIEWER_SCHEMA,
  PIN_PAD_MAPPING_REVIEW_SCHEMA,
  PIN_PAD_MAPPING_SCHEMA,
  PDF_PAGE_EXTRACTION_SCHEMA,
  REFERENCE_STAGE_CONTEXT_SCHEMA,
  REFERENCE_CONTEXT_TRUST_ROOT_SCHEMA,
  REFERENCE_CONTEXT_RESOURCE_LIMITS,
  ReferenceStageContextProvider,
  SOURCE_CAPTURE_SCHEMA,
  SOURCE_EXTRACTION_SCHEMA,
  type ReferenceStageContextProviderOptions,
} from "../../src/integrations/reference-stage-context.js";
import { REFERENCE_SIMULATION_BACKEND_ID } from "../../src/integrations/reference-simulation.js";
import {
  ROBOTICS_CONTROLLER_V0,
  type ReferenceControllerProfile,
} from "../../src/knowledge/reference-controller-v0.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const CAPTURE_TOOL = {
  name: "fixture-capture",
  version: "1.0.0",
  adapter: "external" as const,
  executableDigest: sha256("fixture-capture-executable"),
  capabilityProfile: "read-only-http-capture",
};
const EXTRACTION_TOOL = {
  name: "fixture-extractor",
  version: "1.0.0",
  adapter: "evleda" as const,
  executableDigest: sha256("fixture-extractor-executable"),
  capabilityProfile: "versioned-claim-extraction",
};
const PDF_EXTRACTION_TOOL = {
  name: "fixture-pdf-page-extractor",
  version: "1.0.0",
  adapter: "external" as const,
  executableDigest: sha256("fixture-pdf-page-extractor-executable"),
  capabilityProfile: "pdf-page-text-with-zero-based-index",
};
const REVIEWER = {
  type: "human" as const,
  id: "reviewer_fixture",
  displayName: "Fixture Hardware Reviewer",
  role: "component_evidence_reviewer" as const,
  authorityIdentity: canonicalIdentity(
    {
      type: "human",
      id: "reviewer_fixture",
      displayName: "Fixture Hardware Reviewer",
      role: "component_evidence_reviewer",
    },
    COMPONENT_EVIDENCE_REVIEWER_SCHEMA,
  ),
};

const locator = (
  kind: "json_pointer" | "pdf_page_text" | "text_range",
  value: string,
  excerpt: string,
) => ({
  kind,
  value,
  excerpt,
  excerptSha256: sha256(excerpt),
});

const textRangeLocator = (source: string, excerpt: string) => {
  const start = Buffer.byteLength(source.slice(0, source.indexOf(excerpt)), "utf8");
  const end = start + Buffer.byteLength(excerpt, "utf8");
  return locator("text_range", `${start}:${end}`, excerpt);
};

const executableIdentity = (executablePath: string): KicadExecutableIdentity => ({
  kind: "kicad-cli",
  path: executablePath,
  version: "10.0.3",
  commit: "1".repeat(40),
  sha256: "2".repeat(64),
  sizeBytes: 123_456,
  capabilityHelpSha256: "3".repeat(64),
  confirmedCapabilities: ["sch erc", "pcb drc"],
});

interface FileReference {
  readonly path: string;
  readonly identity: ReturnType<typeof contentIdentity>;
}

interface FixtureOptions {
  readonly observedAt?: string;
  readonly sourcingValidUntil?: string;
  readonly now?: string;
  readonly extractionAuthority?: "machine_derived" | "human_accepted";
  readonly mappingDecision?: "pending" | "reviewed" | "mismatch";
  readonly includeReviewerAuthorities?: boolean;
  readonly sourcingAvailability?: "in_stock" | "not_available" | "unknown";
  readonly lifecycleStatus?: "active" | "nrnd" | "obsolete" | "unknown";
}

interface Fixture {
  readonly root: string;
  readonly snapshotPath: string;
  readonly sourceRoot: string;
  readonly referenceRoot: string;
  readonly workRoot: string;
  readonly profile: ReferenceControllerProfile;
  readonly request: StageContextProviderRequest;
  readonly snapshot: Record<string, any>;
  readonly providerOptions: ReferenceStageContextProviderOptions;
  readonly provider: ReferenceStageContextProvider;
  readonly attemptedExecutables: string[];
  readonly backendConfigurations: ReferenceKicadBackendOptions[];
  readonly firstSourcingExtraction: FileReference;
  readonly firstFootprintAsset: FileReference;
  readonly firstMappingReview: FileReference;
}

const jsonBytes = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");

const makeFixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), "evleda-structured-context-"));
  roots.push(root);
  const sourceRoot = path.join(root, "evidence", "sources");
  const referenceRoot = path.join(root, "reference");
  const workRoot = path.join(root, "work");
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(path.join(referenceRoot, "validation"), { recursive: true }),
    mkdir(workRoot, { recursive: true }),
  ]);

  const writeBytes = async (relativePath: string, bytes: Buffer): Promise<FileReference> => {
    const target = path.join(sourceRoot, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { path: relativePath, identity: contentIdentity(bytes) };
  };
  const writeJson = async (relativePath: string, value: unknown): Promise<FileReference> =>
    writeBytes(relativePath, jsonBytes(value));

  const trustRootPath = path.join(root, "evidence", "trust-root.json");
  const trustRootBytes = jsonBytes({
    schemaVersion: REFERENCE_CONTEXT_TRUST_ROOT_SCHEMA,
    trustRootId: "fixture-trust-root",
    tools: [CAPTURE_TOOL, EXTRACTION_TOOL, PDF_EXTRACTION_TOOL],
    reviewerAuthorities: options.includeReviewerAuthorities === false ? [] : [REVIEWER.authorityIdentity],
  });
  await writeFile(trustRootPath, trustRootBytes);

  const observedAt = options.observedAt ?? "2026-09-01T00:00:00Z";
  const now = options.now ?? "2026-09-04T00:00:00Z";
  const validity = {
    datasheet: "2027-09-01T00:00:00Z",
    sourcing: options.sourcingValidUntil ?? "2026-09-07T00:00:00Z",
    lifecycle: "2026-11-30T00:00:00Z",
    mapping: "2027-09-01T00:00:00Z",
    library: "2027-09-01T00:00:00Z",
  };
  const extractionAuthority = options.extractionAuthority ?? "human_accepted";
  const mappingDecision = options.mappingDecision ?? "reviewed";
  const sourcingAvailability = options.sourcingAvailability ?? "in_stock";
  const lifecycleStatus = options.lifecycleStatus ?? "active";

  const uniqueFootprints = [...new Set(ROBOTICS_CONTROLLER_V0.components.map((entry) => entry.footprint))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const footprintAssets = new Map<string, FileReference>();
  for (const [index, footprint] of uniqueFootprints.entries()) {
    const content = Buffer.from(
      `library=fixture-library\nfootprint=${footprint}\npin=1\npad=1\nindex=${index}\n`,
      "utf8",
    );
    footprintAssets.set(footprint, await writeBytes(`library/asset-${index}.kicad_mod`, content));
  }
  const footprintManifest = {
    schemaVersion: FOOTPRINT_LIBRARY_CAPTURE_SCHEMA,
    libraryId: "fixture-library-v1",
    observedAt,
    validUntil: validity.library,
    catalogLocator: textRangeLocator("library=fixture-library", "library=fixture-library"),
    tool: CAPTURE_TOOL,
    assets: uniqueFootprints.map((footprint) => ({
      footprint,
      file: footprintAssets.get(footprint)!,
    })),
  };
  const footprintManifestReference = await writeJson("library/capture.json", footprintManifest);

  const profileComponents = [];
  const snapshotComponents: Record<string, unknown>[] = [];
  let firstSourcingExtraction: FileReference | undefined;
  let firstMappingReview: FileReference | undefined;
  for (const component of ROBOTICS_CONTROLLER_V0.components) {
    const prefix = `components/${component.key}`;
    const documentTitle = `${component.partNumber} data`;
    const isMcu = component.key === "mcu";
    const datasheetPages = isMcu
      ? [
          {
            pageIndex: 0,
            text: `STM32G0B1xB/xC/xE\nDocument title: ${documentTitle}\n`,
          },
          {
            pageIndex: 34,
            text: "STM32G0B1CxT\n48-pin\nLQFP48 pinout\nPin 1\n",
          },
          {
            pageIndex: 164,
            text:
              "STM32 G 0B1 R E T 6 xyy\n" +
              "STM32\nSTM32 microcontroller\nG\nSTM32G series\n0B1\nSTM32G0B1 product line\n" +
              "C\n48\nE\n512 Kbytes\nT\nLQFP\n6\n-40 to 85 °C\n",
          },
        ]
      : [
          {
            pageIndex: 0,
            text: `Manufacturer order code: ${component.partNumber}\nDocument title: ${documentTitle}\nPin 1`,
          },
        ];
    const rawDatasheetBytes = Buffer.from(
      "%PDF-1.7\n1 0 obj\n<< /Filter /FlateDecode /Length 8 >>\nstream\nx\\x9cCOMPRESSED\nendstream\n",
      "utf8",
    );
    const rawAvailability = sourcingAvailability === "in_stock"
      ? "InStock"
      : sourcingAvailability === "not_available"
        ? "OutOfStock"
        : "Unknown";
    const rawLifecycleStatus = lifecycleStatus === "active"
      ? "Active"
      : lifecycleStatus === "nrnd"
        ? "Not Recommended for New Designs"
        : lifecycleStatus === "obsolete"
          ? "Obsolete"
          : "Unknown";
    const rawSourcingText = JSON.stringify({
      manufacturerPartNumber: component.partNumber,
      supplier: "Captured Distributor",
      availability: rawAvailability,
    });
    const rawLifecycleText = JSON.stringify({
      manufacturerPartNumber: component.partNumber,
      status: rawLifecycleStatus,
    });
    const rawDatasheet = await writeBytes(`${prefix}/datasheet.pdf`, rawDatasheetBytes);
    const rawSourcing = await writeBytes(`${prefix}/sourcing.raw`, Buffer.from(rawSourcingText));
    const rawLifecycle = await writeBytes(`${prefix}/lifecycle.raw`, Buffer.from(rawLifecycleText));
    const pageExtractions: FileReference[] = [];
    for (const page of datasheetPages) {
      const pageText = await writeBytes(
        `${prefix}/datasheet-page-${page.pageIndex}.txt`,
        Buffer.from(page.text),
      );
      pageExtractions.push(
        await writeJson(`${prefix}/datasheet-page-${page.pageIndex}.json`, {
          schemaVersion: PDF_PAGE_EXTRACTION_SCHEMA,
          pdfIdentity: rawDatasheet.identity,
          pageIndex: page.pageIndex,
          pageNumbering: "zero_based_pdf_index",
          text: pageText,
          tool: PDF_EXTRACTION_TOOL,
        }),
      );
    }
    const clonedComponent = {
      ...component,
      datasheet: {
        ...component.datasheet,
        retrievedAt: observedAt,
        identity: rawDatasheet.identity,
      },
      referenceCircuits: component.referenceCircuits.map((circuit) => ({
        ...circuit,
        sourceIdentity: rawDatasheet.identity,
      })),
    };
    profileComponents.push(clonedComponent);

    const makeSourcePair = async (
      category: "datasheet" | "sourcing" | "lifecycle",
      sourceUrl: string,
      raw: FileReference,
      validUntil: string,
      locators: readonly ReturnType<typeof locator>[],
      claim: Record<string, unknown>,
      normalizations: readonly Record<string, unknown>[] = [],
      pdfPageExtractions: readonly FileReference[] = [],
    ) => {
      const captureDocument = {
        schemaVersion: SOURCE_CAPTURE_SCHEMA,
        category,
        component: component.key,
        sourceUrl,
        observedAt,
        validUntil,
        raw,
        tool: CAPTURE_TOOL,
      };
      const capture = await writeJson(`${prefix}/${category}.capture.json`, captureDocument);
      const extractionDocument = {
        schemaVersion: SOURCE_EXTRACTION_SCHEMA,
        category,
        component: component.key,
        captureIdentity: capture.identity,
        rawIdentity: raw.identity,
        extractedAt: "2026-09-02T00:00:00Z",
        locators,
        normalizations,
        pdfPageExtractions,
        claim,
        tool: EXTRACTION_TOOL,
        authority: extractionAuthority,
        ...(extractionAuthority === "human_accepted"
          ? {
              review: {
                decision: "accepted",
                reviewedAt: "2026-09-03T00:00:00Z",
                reviewer: REVIEWER,
              },
            }
          : {}),
      };
      const extraction = await writeJson(`${prefix}/${category}.extraction.json`, extractionDocument);
      return { capture, extraction };
    };

    const orderField = (
      position: number,
      field: string,
      code: string,
      meaning: string,
    ) => ({
      position,
      field,
      code,
      meaning,
      codeLocator: locator("pdf_page_text", `pdf-index:164#${field}-code`, code),
      meaningLocator: locator("pdf_page_text", `pdf-index:164#${field}-meaning`, meaning),
    });
    const orderCodeEvidence = isMcu
      ? {
          kind: "documented_order_code_fields",
          familySummary: {
            token: "STM32G0B1xB/xC/xE",
            locator: locator("pdf_page_text", "pdf-index:0#family-summary", "STM32G0B1xB/xC/xE"),
          },
          pinoutSummary: {
            token: "STM32G0B1CxT",
            locator: locator("pdf_page_text", "pdf-index:34#pinout-summary", "STM32G0B1CxT"),
          },
          pinCountSupport: [
            {
              token: "48-pin",
              locator: locator("pdf_page_text", "pdf-index:34#pin-count", "48-pin"),
            },
            {
              token: "LQFP48 pinout",
              locator: locator("pdf_page_text", "pdf-index:34#package-pinout", "LQFP48 pinout"),
            },
          ],
          orderingTable: {
            token: "STM32 G 0B1 R E T 6 xyy",
            locator: locator(
              "pdf_page_text",
              "pdf-index:164#ordering-table",
              "STM32 G 0B1 R E T 6 xyy",
            ),
          },
          fields: [
            orderField(0, "product_family", "STM32", "STM32 microcontroller"),
            orderField(1, "product_series", "G", "STM32G series"),
            orderField(2, "product_line", "0B1", "STM32G0B1 product line"),
            orderField(3, "pin_count", "C", "48"),
            orderField(4, "flash_density", "E", "512 Kbytes"),
            orderField(5, "package", "T", "LQFP"),
            orderField(6, "temperature_grade", "6", "-40 to 85 °C"),
          ],
        }
      : { kind: "exact_order_code", orderCode: component.partNumber };
    const datasheet = await makeSourcePair(
      "datasheet",
      component.datasheet.url,
      rawDatasheet,
      validity.datasheet,
      [
        ...(isMcu
          ? []
          : [
              locator(
                "pdf_page_text",
                "pdf-index:0#manufacturer-order-code",
                component.partNumber,
              ),
            ]),
        locator("pdf_page_text", "pdf-index:0#document-title", documentTitle),
      ],
      {
        kind: "datasheet",
        manufacturerPartNumber: component.partNumber,
        documentTitle,
        orderCodeEvidence,
      },
      [],
      pageExtractions,
    );
    const sourcing = await makeSourcePair(
      "sourcing",
      `https://supplier.example/${encodeURIComponent(component.partNumber)}`,
      rawSourcing,
      validity.sourcing,
      [
        locator("json_pointer", "/manufacturerPartNumber", component.partNumber),
        locator("json_pointer", "/supplier", "Captured Distributor"),
      ],
      {
        kind: "sourcing",
        manufacturerPartNumber: component.partNumber,
        supplier: "Captured Distributor",
        availability: sourcingAvailability,
      },
      [
        {
          field: "availability",
          rawValue: rawAvailability,
          normalizedValue: sourcingAvailability,
          rule: sourcingAvailability === "in_stock"
            ? "evleda.availability.in-stock.v1"
            : sourcingAvailability === "not_available"
              ? "evleda.availability.out-of-stock.v1"
              : "evleda.availability.unknown.v1",
          locator: locator("json_pointer", "/availability", rawAvailability),
        },
      ],
    );
    firstSourcingExtraction ??= sourcing.extraction;
    const lifecycle = await makeSourcePair(
      "lifecycle",
      component.lifecycle.sourceUrl,
      rawLifecycle,
      validity.lifecycle,
      [
        locator("json_pointer", "/manufacturerPartNumber", component.partNumber),
      ],
      { kind: "lifecycle", manufacturerPartNumber: component.partNumber, status: lifecycleStatus },
      [
        {
          field: "lifecycle",
          rawValue: rawLifecycleStatus,
          normalizedValue: lifecycleStatus,
          rule: lifecycleStatus === "active"
            ? "evleda.lifecycle.active.v1"
            : lifecycleStatus === "nrnd"
              ? "evleda.lifecycle.nrnd.v1"
              : lifecycleStatus === "obsolete"
                ? "evleda.lifecycle.obsolete.v1"
                : "evleda.lifecycle.unknown.v1",
          locator: locator("json_pointer", "/status", rawLifecycleStatus),
        },
      ],
    );

    const footprintAsset = footprintAssets.get(component.footprint)!;
    const footprintAssetText =
      `library=fixture-library\nfootprint=${component.footprint}\npin=1\npad=1\n` +
      `index=${uniqueFootprints.indexOf(component.footprint)}\n`;
    const symbolSourceText = `symbol=${component.symbol}\npin=1\n`;
    const symbolSource = await writeBytes(
      `${prefix}/symbol.kicad_sym`,
      Buffer.from(symbolSourceText),
    );
    const mappingDocument = {
      schemaVersion: PIN_PAD_MAPPING_SCHEMA,
      component: component.key,
      symbol: component.symbol,
      footprint: component.footprint,
      createdAt: "2026-09-02T00:00:00Z",
      sources: {
        datasheetIdentity: rawDatasheet.identity,
        symbolIdentity: symbolSource.identity,
        footprintIdentity: footprintAsset.identity,
      },
      symbolPins: ["1"],
      footprintPads: ["1"],
      mappings: [
        {
          pin: "1",
          pad: "1",
          datasheetLocator: locator(
            "pdf_page_text",
            `pdf-index:${isMcu ? 34 : 0}#pin-1`,
            "Pin 1",
          ),
          symbolLocator: textRangeLocator(symbolSourceText, "pin=1"),
          footprintLocator: textRangeLocator(footprintAssetText, "pad=1"),
        },
      ],
      tool: EXTRACTION_TOOL,
    };
    const mappingBytes = jsonBytes(mappingDocument);
    const mapping = await writeBytes(`${prefix}/pin-pad.mapping.json`, mappingBytes);
    const mappingReviewDocument = {
      schemaVersion: PIN_PAD_MAPPING_REVIEW_SCHEMA,
      component: component.key,
      symbol: component.symbol,
      footprint: component.footprint,
      mappingIdentity: mapping.identity,
      observedAt: "2026-09-03T00:00:00Z",
      validUntil: validity.mapping,
      decision: mappingDecision,
      locators: [
        locator("json_pointer", "/mappings/0/pin", "1"),
        locator("json_pointer", "/mappings/0/pad", "1"),
      ],
      ...(mappingDecision === "reviewed" ? { reviewer: REVIEWER } : {}),
    };
    const mappingReview = await writeJson(`${prefix}/pin-pad.review.json`, mappingReviewDocument);
    firstMappingReview ??= mappingReview;
    snapshotComponents.push({
      component: component.key,
      datasheet,
      sourcing,
      lifecycle,
      pinPadMapping: { symbolSource, mapping, review: mappingReview },
    });
  }

  const profile: ReferenceControllerProfile = {
    ...ROBOTICS_CONTROLLER_V0,
    profileId: "robotics-controller-full-provider-fixture",
    boardRevision: "PROVIDER-FIXTURE-REV-A",
    components: profileComponents,
  };
  const snapshot: Record<string, any> = {
    schemaVersion: REFERENCE_STAGE_CONTEXT_SCHEMA,
    profile: {
      profileId: profile.profileId,
      boardRevision: profile.boardRevision,
      identity: canonicalIdentity(profile, "evleda.reference-profile.v1"),
    },
    components: snapshotComponents,
    footprintLibrary: footprintManifestReference,
  };
  const snapshotPath = path.join(root, "evidence", "reference-stage-context.v1.json");
  await writeFile(snapshotPath, jsonBytes(snapshot));

  const referenceBytes = Buffer.from("reference source binding\n");
  await writeFile(path.join(referenceRoot, "source.txt"), referenceBytes);
  const userCandidate = path.join(root, "user-local", "kicad-cli.exe");
  const systemCandidate = path.join(root, "system", "kicad-cli.exe");
  const executable = executableIdentity(systemCandidate);
  const validationPayload = {
    schemaVersion: REFERENCE_VALIDATION_SCHEMA,
    lifecycle: "candidate",
    releaseAuthorized: false,
    checksPass: false,
    executable: {
      version: executable.version,
      commit: executable.commit,
      sha256: executable.sha256,
      sizeBytes: executable.sizeBytes,
      capabilityHelpSha256: executable.capabilityHelpSha256,
    },
    sourceBindings: [
      {
        path: "source.txt",
        sha256: contentIdentity(referenceBytes).digest,
        sizeBytes: referenceBytes.byteLength,
      },
    ],
    unresolvedAssumptions: [],
  };
  const validation = {
    ...validationPayload,
    createdAt: "2026-09-04T00:00:00Z",
    validationRoot: canonicalIdentity(validationPayload, REFERENCE_VALIDATION_SCHEMA),
  };
  await writeFile(
    path.join(referenceRoot, "validation", "reference-validation.json"),
    jsonBytes(validation),
  );

  const attemptedExecutables: string[] = [];
  const backendConfigurations: ReferenceKicadBackendOptions[] = [];
  const providerOptions: ReferenceStageContextProviderOptions = {
    snapshotPath,
    sourceRoot,
    trustRoot: { path: trustRootPath, identity: contentIdentity(trustRootBytes) },
    referenceDesignRoot: referenceRoot,
    kicadWorkRoot: workRoot,
    kicadExecutableCandidates: [userCandidate, systemCandidate],
    environment: { Path: "fixture-path", TEMP: root, SECRET_TOKEN: "must-not-propagate" },
    profile,
    now: () => new Date(now),
    discoverKicadExecutableIdentity: async (candidate) => {
      attemptedExecutables.push(candidate);
      if (candidate === userCandidate) throw new Error("user-local candidate absent");
      return executableIdentity(candidate);
    },
    createKicadBackend: (configuration) => {
      backendConfigurations.push(configuration);
      return {
        backendId: REFERENCE_KICAD_BACKEND_ID,
        execute: async () => {
          throw new Error("Provider test must not execute KiCad.");
        },
      };
    },
    createSimulationBackend: () => ({
      backendId: REFERENCE_SIMULATION_BACKEND_ID,
      execute: async () => {
        throw new Error("Provider test must not execute simulation.");
      },
    }),
  };
  const provider = new ReferenceStageContextProvider(providerOptions);
  const request = {
    project: { id: "project_fixture", policyVersion: "evleda-policy-v1" },
    run: {
      id: "run_fixture",
      workflowVersion: "evleda-workflow-v1",
      configuration: canonicalIdentity({}, "evleda.run-configuration.v1"),
    },
    revision: {
      id: "revision_fixture",
      manifest: canonicalIdentity({ revision: "fixture" }, "evleda.revision-manifest.v1"),
    },
    stage: "component_selection",
  } as unknown as StageContextProviderRequest;
  return {
    root,
    snapshotPath,
    sourceRoot,
    referenceRoot,
    workRoot,
    profile,
    request,
    snapshot,
    providerOptions,
    provider,
    attemptedExecutables,
    backendConfigurations,
    firstSourcingExtraction: firstSourcingExtraction!,
    firstFootprintAsset: footprintAssets.values().next().value!,
    firstMappingReview: firstMappingReview!,
  };
};

const mutateMcuDatasheetExtraction = async (
  fixture: Fixture,
  mutate: (extraction: Record<string, any>) => void,
): Promise<void> => {
  const componentEntry = fixture.snapshot.components.find(
    (entry: Record<string, any>) => entry.component === "mcu",
  );
  const extractionReference = componentEntry.datasheet.extraction;
  const extractionPath = path.join(fixture.sourceRoot, extractionReference.path);
  const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
  mutate(extraction);
  const extractionBytes = jsonBytes(extraction);
  await writeFile(extractionPath, extractionBytes);
  extractionReference.identity = contentIdentity(extractionBytes);
  await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));
};

describe("ReferenceStageContextProvider structured evidence", () => {
  it("derives all eight components from validated capture/extraction/review documents", async () => {
    const fixture = await makeFixture();
    const first = await fixture.provider.provide(fixture.request);
    const second = await fixture.provider.provide(fixture.request);
    const nextStage = await fixture.provider.provide({ ...fixture.request, stage: "system_architecture" });

    expect(first.provisionIdentity).toEqual(second.provisionIdentity);
    expect(canonicalIdentity(first.provisionManifest, "evleda.stage-provision.v1")).toEqual(
      first.provisionIdentity
    );
    expect(first.provisionManifest.request).toMatchObject({
      runId: fixture.request.run.id,
      revisionId: fixture.request.revision.id,
      stage: fixture.request.stage
    });
    expect(first.provisionManifest.backends.firmwareCompile).toMatchObject({
      backendId: first.firmwareCompileBackend?.backendId
    });
    expect(canonicalJson(first.firmwareCompileBackend?.configuration)).toBe(
      canonicalJson(first.firmwareCompileConfiguration)
    );
    expect(nextStage.provisionIdentity.digest).not.toBe(first.provisionIdentity.digest);
    expect(first.curatedDatasheets).toHaveLength(8);
    expect(first.sourcing).toHaveLength(8);
    expect(first.lifecycleObservations).toHaveLength(8);
    expect(first.pinPadMappingReviews).toHaveLength(8);
    expect(first.sourcing?.every((entry) => entry.availability === "in_stock")).toBe(true);
    expect(first.lifecycleObservations?.every((entry) => entry.status === "active")).toBe(true);
    expect(first.pinPadMappingReviews?.every((entry) => entry.status === "reviewed")).toBe(true);
    expect(fixture.attemptedExecutables.slice(0, 2)).toEqual(
      fixture.providerOptions.kicadExecutableCandidates,
    );
    expect(fixture.backendConfigurations[0]).toMatchObject({
      referenceDesignRoot: fixture.referenceRoot,
      workRoot: fixture.workRoot,
      executablePath: fixture.providerOptions.kicadExecutableCandidates?.[1],
      environment: { PATH: "fixture-path", TEMP: fixture.root },
    });
    expect(fixture.backendConfigurations[0]?.environment).not.toHaveProperty("SECRET_TOKEN");
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.profile)).toBe(true);
    expect(Object.isFrozen(first.sourcing)).toBe(true);
    expect(Object.isFrozen(first.provisionManifest)).toBe(true);
    expect(Object.isFrozen(first.firmwareCompileConfiguration)).toBe(true);

    const changedEnvironment = new ReferenceStageContextProvider({
      ...fixture.providerOptions,
      environment: { PATH: "different-path", TEMP: fixture.root },
    });
    const changed = await changedEnvironment.provide(fixture.request);
    expect(changed.provisionIdentity.digest).not.toBe(first.provisionIdentity.digest);
  });

  it("provisions zero-authority machine observations and pending mappings for domain-specific blockers", async () => {
    const fixture = await makeFixture({
      extractionAuthority: "machine_derived",
      mappingDecision: "pending",
      includeReviewerAuthorities: false,
      sourcingAvailability: "not_available",
      lifecycleStatus: "unknown",
    });
    const provision = await fixture.provider.provide(fixture.request);

    expect(provision.sourcing?.every((entry) => entry.availability === "not_available")).toBe(true);
    expect(provision.lifecycleObservations?.every((entry) => entry.status === "unknown")).toBe(true);
    expect(
      provision.pinPadMappingReviews?.every(
        (entry) => entry.status === "unreviewed" && entry.requiresReview,
      ),
    ).toBe(true);

    const prompt =
      "Build a two-channel brushed motor controller for a 7-16.8 V DC battery. " +
      "Each motor is limited to 0.5 A RMS. Provide USB-C, CAN, UART, I2C, SPI, " +
      "two quadrature encoders, and SWD programming.";
    const requirements = parseRequirements(prompt).document;
    const approval: ApprovalRecord = {
      id: "approval_pending_context",
      kind: "requirements",
      projectId: "project_fixture",
      runId: "run_fixture",
      subjectDigest: requirements.identity.digest,
      policyVersion: "evleda-policy-v1",
      actor: {
        type: "human",
        id: "requirements_reviewer_fixture",
        displayName: "Requirements Reviewer",
        role: "requirements_reviewer",
      },
      scope: "exact fixture requirements",
      rationale: "fixture approval",
      createdAt: "2026-09-03T00:00:00Z",
    };
    const result = await componentSelectionStageExecutor.execute({
      projectId: "project_fixture",
      runId: "run_fixture",
      designRevisionId: "revision_fixture",
      requirements,
      requirementsApproval: approval,
      upstream: [finalizeStageResult("system_architecture", [], [], [])],
      upstreamSourceRevisionBindings: [],
      profile: provision.profile!,
      curatedDatasheets: provision.curatedDatasheets!,
      sourcing: provision.sourcing!,
      lifecycleObservations: provision.lifecycleObservations!,
      pinPadMappingReviews: provision.pinPadMappingReviews!,
      footprintLibrary: provision.footprintLibrary!,
    });
    const blockerCodes = result.blockers.map((blocker) => blocker.code);
    expect(blockerCodes).toEqual([...blockerCodes].sort((left, right) => left.localeCompare(right, "en")));
    expect(blockerCodes).toContain("PART_UNAVAILABLE");
    expect(blockerCodes).toContain("COMPONENT_LIFECYCLE_UNACCEPTABLE");
    expect(blockerCodes).toContain("PIN_PAD_MAPPING_MISMATCH");
  });

  it("derives the exact STM32 OPN from genuine family, pinout, table, and field excerpts", async () => {
    const fixture = await makeFixture({ extractionAuthority: "machine_derived" });
    const provision = await fixture.provider.provide(fixture.request);

    expect(provision.profile?.components.find((component) => component.key === "mcu")?.partNumber).toBe(
      "STM32G0B1CET6",
    );
    expect(provision.lifecycleObservations?.find((entry) => entry.component === "mcu")?.status).toBe(
      "active",
    );
  });

  it("rejects a wrong documented STM32 field code", async () => {
    const fixture = await makeFixture({ extractionAuthority: "machine_derived" });
    await mutateMcuDatasheetExtraction(fixture, (extraction) => {
      extraction.claim.orderCodeEvidence.fields[3].code = "D";
    });

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects reordered or missing STM32 order-code fields", async () => {
    const fixture = await makeFixture({ extractionAuthority: "machine_derived" });
    await mutateMcuDatasheetExtraction(fixture, (extraction) => {
      [extraction.claim.orderCodeEvidence.fields[3], extraction.claim.orderCodeEvidence.fields[4]] = [
        extraction.claim.orderCodeEvidence.fields[4],
        extraction.claim.orderCodeEvidence.fields[3],
      ];
    });
    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });

    const missing = await makeFixture({ extractionAuthority: "machine_derived" });
    await mutateMcuDatasheetExtraction(missing, (extraction) => {
      extraction.claim.orderCodeEvidence.fields.pop();
    });
    await expect(missing.provider.provide(missing.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects tampered STM32 field locators and the removed wildcard shape", async () => {
    const fixture = await makeFixture({ extractionAuthority: "machine_derived" });
    await mutateMcuDatasheetExtraction(fixture, (extraction) => {
      const locator = extraction.claim.orderCodeEvidence.fields[3].meaningLocator;
      locator.excerpt = "49";
      locator.excerptSha256 = sha256(locator.excerpt);
    });
    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });

    const wildcard = await makeFixture({ extractionAuthority: "machine_derived" });
    await mutateMcuDatasheetExtraction(wildcard, (extraction) => {
      extraction.claim.orderCodeEvidence = {
        kind: "documented_single_suffix_wildcard",
        pattern: "STM32G0B1CETx",
      };
    });
    await expect(wildcard.provider.provide(wildcard.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("fails closed without a pinned trust root or when a tool is not trusted", async () => {
    const fixture = await makeFixture();
    const { trustRoot: _trustRoot, ...withoutTrustOptions } = fixture.providerOptions;
    const withoutTrust = new ReferenceStageContextProvider(withoutTrustOptions);
    await expect(withoutTrust.provide(fixture.request)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      retryable: true,
    });

    const trustPath = fixture.providerOptions.trustRoot!.path;
    const trustDocument = JSON.parse(await readFile(trustPath, "utf8"));
    trustDocument.tools = [CAPTURE_TOOL];
    const trustBytes = jsonBytes(trustDocument);
    await writeFile(trustPath, trustBytes);
    const missingToolAuthority = new ReferenceStageContextProvider({
      ...fixture.providerOptions,
      trustRoot: { path: trustPath, identity: contentIdentity(trustBytes) },
    });
    await expect(missingToolAuthority.provide(fixture.request)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      retryable: true,
    });
  });

  it("rejects a reviewed mapping when its human authority is not trusted", async () => {
    const fixture = await makeFixture({
      extractionAuthority: "machine_derived",
      mappingDecision: "reviewed",
      includeReviewerAuthorities: false,
    });

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "POLICY_DENIED",
      retryable: true,
    });
  });

  it("rejects a detached claim added to the snapshot", async () => {
    const fixture = await makeFixture();
    fixture.snapshot.components[0].sourcing.availability = "in_stock";
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects an extraction detached from its raw capture even when the snapshot rebinds it", async () => {
    const fixture = await makeFixture();
    const extractionPath = path.join(fixture.sourceRoot, fixture.firstSourcingExtraction.path);
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    extraction.rawIdentity.digest = "f".repeat(64);
    const changedBytes = jsonBytes(extraction);
    await writeFile(extractionPath, changedBytes);
    fixture.snapshot.components[0].sourcing.extraction.identity = contentIdentity(changedBytes);
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      retryable: true,
    });
  });

  it("rejects a claim locator whose excerpt is absent from the bound raw bytes", async () => {
    const fixture = await makeFixture();
    const extractionPath = path.join(fixture.sourceRoot, fixture.firstSourcingExtraction.path);
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    extraction.locators[0].excerpt = "detached-part-number";
    extraction.locators[0].excerptSha256 = sha256(extraction.locators[0].excerpt);
    const changedBytes = jsonBytes(extraction);
    await writeFile(extractionPath, changedBytes);
    fixture.snapshot.components[0].sourcing.extraction.identity = contentIdentity(changedBytes);
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("uses a trusted PDF page artifact and rejects tampered extracted page text", async () => {
    const fixture = await makeFixture();
    const extractionReference = fixture.snapshot.components[0].datasheet.extraction;
    const extraction = JSON.parse(
      await readFile(path.join(fixture.sourceRoot, extractionReference.path), "utf8"),
    );
    const pageReference = extraction.pdfPageExtractions[0];
    const page = JSON.parse(
      await readFile(path.join(fixture.sourceRoot, pageReference.path), "utf8"),
    );
    const capture = JSON.parse(
      await readFile(
        path.join(fixture.sourceRoot, fixture.snapshot.components[0].datasheet.capture.path),
        "utf8",
      ),
    );
    const compressedPdf = await readFile(path.join(fixture.sourceRoot, capture.raw.path));
    expect(compressedPdf.includes(Buffer.from(fixture.profile.components[0]!.partNumber))).toBe(false);

    await writeFile(path.join(fixture.sourceRoot, page.text.path), "tampered extracted page text\n");
    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      retryable: true,
    });
  });

  it("rejects a raw-value normalization that does not satisfy its allowlisted rule", async () => {
    const fixture = await makeFixture({ sourcingAvailability: "not_available" });
    const extractionPath = path.join(fixture.sourceRoot, fixture.firstSourcingExtraction.path);
    const extraction = JSON.parse(await readFile(extractionPath, "utf8"));
    extraction.normalizations[0].rule = "evleda.availability.in-stock.v1";
    const changedBytes = jsonBytes(extraction);
    await writeFile(extractionPath, changedBytes);
    fixture.snapshot.components[0].sourcing.extraction.identity = contentIdentity(changedBytes);
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects a mapping review detached from the exact mapping document", async () => {
    const fixture = await makeFixture();
    const reviewPath = path.join(fixture.sourceRoot, fixture.firstMappingReview.path);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.mappingIdentity = contentIdentity("different mapping document");
    const changedBytes = jsonBytes(review);
    await writeFile(reviewPath, changedBytes);
    fixture.snapshot.components[0].pinPadMapping.review.identity = contentIdentity(changedBytes);
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      retryable: true,
    });
  });

  it("rejects an incomplete declared pin/pad mapping even when its review is re-bound", async () => {
    const fixture = await makeFixture();
    const mappingReference = fixture.snapshot.components[0].pinPadMapping.mapping;
    const reviewReference = fixture.snapshot.components[0].pinPadMapping.review;
    const mappingPath = path.join(fixture.sourceRoot, mappingReference.path);
    const reviewPath = path.join(fixture.sourceRoot, reviewReference.path);
    const mapping = JSON.parse(await readFile(mappingPath, "utf8"));
    mapping.symbolPins.push("2");
    const mappingBytes = jsonBytes(mapping);
    await writeFile(mappingPath, mappingBytes);
    mappingReference.identity = contentIdentity(mappingBytes);
    const review = JSON.parse(await readFile(reviewPath, "utf8"));
    review.mappingIdentity = mappingReference.identity;
    const reviewBytes = jsonBytes(review);
    await writeFile(reviewPath, reviewBytes);
    reviewReference.identity = contentIdentity(reviewBytes);
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects modified consumed footprint asset bytes", async () => {
    const fixture = await makeFixture();
    await writeFile(
      path.join(fixture.sourceRoot, fixture.firstFootprintAsset.path),
      "tampered footprint asset\n",
    );

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "DIGEST_MISMATCH",
      retryable: true,
    });
  });

  it("enforces observedAt <= now < validUntil and category TTL maxima", async () => {
    const expired = await makeFixture({ now: "2026-09-07T00:00:00Z" });
    await expect(expired.provider.provide(expired.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });

    const future = await makeFixture({ observedAt: "2026-09-05T00:00:00Z" });
    await expect(future.provider.provide(future.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });

    const excessive = await makeFixture({ sourcingValidUntil: "2026-09-09T00:00:00Z" });
    await expect(excessive.provider.provide(excessive.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects missing component coverage", async () => {
    const fixture = await makeFixture();
    fixture.snapshot.components.pop();
    await writeFile(fixture.snapshotPath, jsonBytes(fixture.snapshot));

    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_MISSING",
      retryable: true,
    });
  });

  it("rejects a backend factory that does not return the reference backend identity", async () => {
    const fixture = await makeFixture();
    const provider = new ReferenceStageContextProvider({
      ...fixture.providerOptions,
      createKicadBackend: () => ({
        backendId: "detached-backend",
        execute: async () => {
          throw new Error("unused");
        },
      }),
    });

    await expect(provider.provide(fixture.request)).rejects.toMatchObject({
      code: "TOOLCHAIN_UNSUPPORTED",
      retryable: true,
    });
  });

  it("distinguishes unavailable and validation-mismatched KiCad candidates", async () => {
    const unavailableFixture = await makeFixture();
    const unavailable = new ReferenceStageContextProvider({
      ...unavailableFixture.providerOptions,
      discoverKicadExecutableIdentity: async () => {
        throw new Error("candidate absent");
      },
    });
    await expect(unavailable.provide(unavailableFixture.request)).rejects.toMatchObject({
      code: "TOOLCHAIN_UNAVAILABLE",
      retryable: true,
    });

    const wrongFixture = await makeFixture();
    const wrong = new ReferenceStageContextProvider({
      ...wrongFixture.providerOptions,
      discoverKicadExecutableIdentity: async (candidate) => ({
        ...executableIdentity(candidate),
        version: "9.0.6",
      }),
    });
    await expect(wrong.provide(wrongFixture.request)).rejects.toMatchObject({
      code: "TOOLCHAIN_UNSUPPORTED",
      retryable: true,
    });
  });

  it("defers a missing immutable reference root to a typed provider blocker", async () => {
    const fixture = await makeFixture();
    const provider = new ReferenceStageContextProvider({
      ...fixture.providerOptions,
      referenceDesignRoot: path.join(fixture.root, "missing-reference-root"),
    });

    await expect(provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_MISSING",
      retryable: true,
    });
  });

  it("rejects source roots that overlap writable KiCad work", async () => {
    const fixture = await makeFixture();
    expect(
      () =>
        new ReferenceStageContextProvider({
          ...fixture.providerOptions,
          sourceRoot: fixture.workRoot,
        }),
    ).toThrow(/must not overlap/iu);
  });

  it("checks reference integrity in a backend finally path", async () => {
    const fixture = await makeFixture();
    const provider = new ReferenceStageContextProvider({
      ...fixture.providerOptions,
      createKicadBackend: () => ({
        backendId: REFERENCE_KICAD_BACKEND_ID,
        execute: async () => {
          await writeFile(path.join(fixture.referenceRoot, "source.txt"), "mutated during backend\n");
          throw new Error("backend failed after mutation");
        },
      }),
    });
    const provision = await provider.provide(fixture.request);

    await expect(provision.kicadBackend!.execute({} as never)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });

  it("rejects an oversized snapshot before parsing or allocation", async () => {
    const fixture = await makeFixture();
    await writeFile(
      fixture.snapshotPath,
      Buffer.alloc(REFERENCE_CONTEXT_RESOURCE_LIMITS.snapshotBytes + 1, 0x20),
    );
    await expect(fixture.provider.provide(fixture.request)).rejects.toMatchObject({
      code: "EVIDENCE_STALE",
      retryable: true,
    });
  });
});
