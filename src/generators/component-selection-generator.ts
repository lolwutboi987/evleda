import type { ContentIdentity } from "../domain/types.js";
import { canonicalJson } from "../core/canonical.js";
import type { ComponentLifecycle, PinPadMappingReview, ReferenceComponent, ReferenceComponentKey, ReferenceControllerProfile } from "../knowledge/reference-controller-v0.js";
import {
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT,
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
} from "../knowledge/reference-controller-native-contract.js";
import type { ComponentLifecycleObservation, CuratedDatasheetIdentity, PinPadMappingObservation, SourcingObservation, StageExecutor } from "../workflow/contracts.js";
import {
  artifactDraft,
  blockerDraft,
  evidenceDraft,
  finalizeStageResult,
  isIsoDate,
  isSha256Identity,
  jsonArtifactDraft,
  prerequisiteBlockers,
  profileFor,
  profileIntegrityBlockers,
  referenceEnvelopeBlockers,
  requirementsApprovalBlockers,
  stageExactInputs
} from "./draft-utils.js";

const legacyReferenceDesignators = (component: ReferenceComponentKey): string =>
  REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT.componentDesignators[component].join(",");

interface ResolvedDatasheet {
  readonly component: ReferenceComponentKey;
  readonly url: string;
  readonly retrievedAt: string | null;
  readonly identity: ContentIdentity | null;
  readonly provenance: "built_in_curated" | "injected_curated" | "missing";
}

const resolvedDatasheet = (
  component: ReferenceComponent,
  injected: readonly CuratedDatasheetIdentity[]
): ResolvedDatasheet => {
  const suppliedMatches = injected.filter((entry) => entry.component === component.key);
  const supplied = suppliedMatches.length === 1 ? suppliedMatches[0] : undefined;
  if (supplied !== undefined) {
    return {
      component: component.key,
      url: supplied.url,
      retrievedAt: supplied.retrievedAt,
      identity: supplied.identity,
      provenance: "injected_curated"
    };
  }
  if (component.datasheet.identity !== undefined && component.datasheet.retrievedAt !== null) {
    return {
      component: component.key,
      url: component.datasheet.url,
      retrievedAt: component.datasheet.retrievedAt,
      identity: component.datasheet.identity,
      provenance: "built_in_curated"
    };
  }
  return {
    component: component.key,
    url: component.datasheet.url,
    retrievedAt: component.datasheet.retrievedAt,
    identity: null,
    provenance: "missing"
  };
};

const findSourcing = (
  component: ReferenceComponent,
  sourcing: readonly SourcingObservation[]
): SourcingObservation | undefined =>
  sourcing.filter((entry) => entry.component === component.key).length === 1
    ? sourcing.find((entry) => entry.component === component.key)
    : undefined;

const selectedPartNumber = (
  component: ReferenceComponent,
  sourcing: readonly SourcingObservation[]
): string => {
  const observation = findSourcing(component, sourcing);
  return observation?.manufacturerPartNumber === component.partNumber
    ? observation.manufacturerPartNumber
    : component.partNumber;
};

const resolvedLifecycle = (
  component: ReferenceComponent,
  injected: readonly ComponentLifecycleObservation[]
): ComponentLifecycle =>
  injected.filter((entry) => entry.component === component.key).length === 1
    ? injected.find((entry) => entry.component === component.key)!
    : component.lifecycle;

const resolvedPinPadMapping = (
  component: ReferenceComponent,
  injected: readonly PinPadMappingObservation[]
): PinPadMappingReview =>
  injected.filter((entry) => entry.component === component.key).length === 1
    ? injected.find((entry) => entry.component === component.key)!
    : component.pinPadMappingReview;

const bomCsv = (
  profile: ReferenceControllerProfile,
  sourcing: readonly SourcingObservation[],
  lifecycle: readonly ComponentLifecycleObservation[],
  pinPadMappings: readonly PinPadMappingObservation[]
): string => {
  const quote = (value: string | number): string => `"${String(value).replaceAll('"', '""')}"`;
  const rows = profile.components.map((component) => {
    const observation = findSourcing(component, sourcing);
    return [
      legacyReferenceDesignators(component.key),
      component.quantity,
      component.manufacturer,
      selectedPartNumber(component, sourcing),
      component.role,
      component.footprint,
      observation?.supplier ?? "UNVERIFIED",
      observation?.availability ?? "unknown",
      resolvedLifecycle(component, lifecycle).status,
      resolvedPinPadMapping(component, pinPadMappings).status
    ]
      .map(quote)
      .join(",");
  });
  return [
    "reference,quantity,manufacturer,manufacturer_part_number,role,footprint,supplier,availability,lifecycle_status,pin_pad_mapping_status",
    ...rows,
    ""
  ].join("\n");
};

export const componentSelectionStageExecutor: StageExecutor<"component_selection"> = {
  stage: "component_selection",
  async execute(context) {
    const profile = profileFor(context);
    const injected = context.curatedDatasheets ?? [];
    const sourcing = context.sourcing ?? [];
    const lifecycleObservations = context.lifecycleObservations ?? [];
    const pinPadMappingReviews = context.pinPadMappingReviews ?? [];
    const orderedSourcing = [...sourcing].sort((left, right) => {
      const leftKey = canonicalJson(left);
      const rightKey = canonicalJson(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const resolved = profile.components.map((component) => resolvedDatasheet(component, injected));
    const capturedIdentities = resolved
      .map((entry) => entry.identity)
      .filter((identity): identity is ContentIdentity => identity !== null && isSha256Identity(identity));
    const sourcingIdentities = sourcing
      .map((entry) => entry.identity)
      .filter((identity) => isSha256Identity(identity));
    const lifecycleIdentities = profile.components
      .map((component) => resolvedLifecycle(component, lifecycleObservations).sourceIdentity)
      .filter(
        (identity): identity is ContentIdentity =>
          identity !== undefined && isSha256Identity(identity)
      );
    const pinPadMappingIdentities = profile.components
      .flatMap((component) => {
        const mapping = resolvedPinPadMapping(component, pinPadMappingReviews);
        return [mapping.mappingIdentity, mapping.reviewIdentity];
      })
      .filter(
        (identity): identity is ContentIdentity =>
          identity !== undefined && isSha256Identity(identity)
      );
    const referenceCircuitIdentities = profile.components.flatMap((component) =>
      component.referenceCircuits.map((circuit) => circuit.sourceIdentity)
    );
    const footprintIdentities =
      context.footprintLibrary === undefined ? [] : [context.footprintLibrary.identity];
    const exactInputs = stageExactInputs(context, [
      ...capturedIdentities,
      ...sourcingIdentities,
      ...lifecycleIdentities,
      ...pinPadMappingIdentities,
      ...referenceCircuitIdentities,
      ...footprintIdentities,
      REFERENCE_CONTROLLER_REV_A_NATIVE_CONTRACT_CONTENT_IDENTITY
    ]);
    const blockers = [
      ...prerequisiteBlockers("component_selection", context),
      ...requirementsApprovalBlockers(context),
      ...referenceEnvelopeBlockers(context, profile),
      ...profileIntegrityBlockers(profile, exactInputs)
    ];
    const availableLayoutConstraints = new Set(
      profile.layoutConstraints.map((constraint) => constraint.id)
    );

    for (const component of profile.components) {
      const duplicateDatasheets = injected.filter((entry) => entry.component === component.key);
      if (duplicateDatasheets.length > 1) {
        blockers.push(
          blockerDraft(
            "DATASHEET_SOURCE_DUPLICATE",
            `${component.partNumber} has multiple injected datasheet sources for one attempt.`,
            exactInputs,
            `Supply exactly one authoritative curated datasheet source for ${component.key}.`
          )
        );
      }
      const duplicateSourcing = sourcing.filter((entry) => entry.component === component.key);
      if (duplicateSourcing.length > 1) {
        blockers.push(
          blockerDraft(
            "SOURCING_EVIDENCE_DUPLICATE",
            `${component.partNumber} has multiple sourcing observations for one attempt.`,
            exactInputs,
            `Supply exactly one authoritative sourcing observation for ${component.key}.`
          )
        );
      }
    }

    for (const component of profile.components) {
      const source = resolved.find((entry) => entry.component === component.key);
      if (source?.identity === null || source === undefined) {
        blockers.push(
          blockerDraft(
            "DATASHEET_SOURCE_BYTES_MISSING",
            `${component.partNumber} has URL ${component.datasheet.url} but no exact captured source-byte identity; retrievedAt is explicitly ${component.datasheet.retrievedAt === null ? "null" : component.datasheet.retrievedAt}.`,
            exactInputs,
            `Inject curated bytes for ${component.key} with URL, retrieval date, SHA-256 digest, and byte size.`
          )
        );
      } else {
        if (!isSha256Identity(source.identity)) {
          blockers.push(
            blockerDraft(
              "DATASHEET_IDENTITY_INVALID",
              `${component.partNumber} has an invalid SHA-256 content identity.`,
              exactInputs,
              `Re-capture the exact ${component.partNumber} datasheet bytes and provide a valid digest and size.`
            )
          );
        }
        if (source.url !== component.datasheet.url) {
          blockers.push(
            blockerDraft(
              "DATASHEET_URL_MISMATCH",
              `${component.partNumber} source URL does not match the pinned catalog URL.`,
              exactInputs,
              "Review the source change and update the curated catalog explicitly; do not silently substitute documents."
            )
          );
        }
        if (source.retrievedAt === null || !isIsoDate(source.retrievedAt)) {
          blockers.push(
            blockerDraft(
              "DATASHEET_RETRIEVAL_DATE_MISSING",
              `${component.partNumber} does not have a valid explicit retrieval date.`,
              exactInputs,
              "Provide the actual UTC timestamp or calendar date when the exact source bytes were retrieved."
            )
          );
        }
      }

      const observation = findSourcing(component, sourcing);
      if (observation === undefined) {
        blockers.push(
          blockerDraft(
            "SOURCING_EVIDENCE_MISSING",
            `${component.partNumber} has no captured supplier observation.`,
            exactInputs,
            `Capture availability for ${component.key} with supplier URL, retrieval date, and exact response identity.`
          )
        );
      } else {
        if (
          observation.manufacturerPartNumber !== component.partNumber
        ) {
          blockers.push(
            blockerDraft(
              "SOURCING_PART_MISMATCH",
              `${observation.manufacturerPartNumber} does not exactly match selected OPN ${component.partNumber}.`,
              [observation.identity],
              "Supply sourcing evidence for the selected orderable manufacturer part number."
            )
          );
        }
        if (!isIsoDate(observation.retrievedAt) || !isSha256Identity(observation.identity)) {
          blockers.push(
            blockerDraft(
              "SOURCING_IDENTITY_INVALID",
              `${component.partNumber} sourcing evidence lacks a valid retrieval date or exact source identity.`,
              exactInputs,
              "Re-capture the supplier response with its URL, date, SHA-256 digest, and byte size."
            )
          );
        }
        if (observation.availability !== "in_stock") {
          blockers.push(
            blockerDraft(
              "PART_UNAVAILABLE",
              `${observation.manufacturerPartNumber} availability is ${observation.availability}.`,
              [observation.identity],
              "Capture current in-stock evidence or explicitly select and revalidate a replacement part."
            )
          );
        }
      }

      const matchingLifecycle = lifecycleObservations.filter(
        (entry) => entry.component === component.key
      );
      if (matchingLifecycle.length > 1) {
        blockers.push(
          blockerDraft(
            "LIFECYCLE_EVIDENCE_DUPLICATE",
            `${component.partNumber} has multiple lifecycle observations for one attempt.`,
            matchingLifecycle.map((entry) => entry.sourceIdentity),
            "Supply exactly one authoritative manufacturer lifecycle observation."
          )
        );
      }
      const lifecycle = resolvedLifecycle(component, lifecycleObservations);
      if (
        lifecycle.sourceIdentity === undefined ||
        !isSha256Identity(lifecycle.sourceIdentity)
      ) {
        blockers.push(
          blockerDraft(
            "LIFECYCLE_EVIDENCE_MISSING",
            `${component.partNumber} lifecycle is ${lifecycle.status} and has no valid exact manufacturer-source identity.`,
            exactInputs,
            `Capture ${component.lifecycle.sourceUrl} bytes and inject one dated lifecycle observation for ${component.key}.`
          )
        );
      } else {
        if (
          !isIsoDate(lifecycle.checkedAt) ||
          lifecycle.sourceUrl !== component.lifecycle.sourceUrl
        ) {
          blockers.push(
            blockerDraft(
              "LIFECYCLE_EVIDENCE_INVALID",
              `${component.partNumber} lifecycle evidence has an invalid date or does not bind the pinned manufacturer URL.`,
              [lifecycle.sourceIdentity],
              "Re-capture the pinned manufacturer product page and record its exact URL, retrieval date, digest, and byte size."
            )
          );
        }
        if (lifecycle.status !== "active") {
          blockers.push(
            blockerDraft(
              "COMPONENT_LIFECYCLE_UNACCEPTABLE",
              `${component.partNumber} lifecycle status is ${lifecycle.status}, not active.`,
              [lifecycle.sourceIdentity],
              "Select an active part or complete an explicit reviewed replacement and regenerate the design."
            )
          );
        }
        if (lifecycle.requiresReview) {
          blockers.push(
            blockerDraft(
              "LIFECYCLE_REVIEW_REQUIRED",
              `${component.partNumber} lifecycle observation remains marked requiresReview.`,
              [lifecycle.sourceIdentity],
              "Complete the lifecycle review and inject an active observation with requiresReview false."
            )
          );
        }
      }

      if (component.referenceCircuits.length === 0) {
        blockers.push(
          blockerDraft(
            "REFERENCE_CIRCUIT_MISSING",
            `${component.partNumber} has no source-bound reference-circuit record.`,
            exactInputs,
            "Add a starting-point record bound to an exact source document, locator, limits, and mandatory review."
          )
        );
      }
      for (const circuit of component.referenceCircuits) {
        const bindsSelectedSource =
          source?.identity !== null &&
          source?.identity !== undefined &&
          circuit.sourceIdentity.digest === source.identity.digest &&
          circuit.sourceIdentity.size === source.identity.size &&
          circuit.sourceUrl === source.url;
        if (
          !isSha256Identity(circuit.sourceIdentity) ||
          !bindsSelectedSource ||
          circuit.sectionLocator.trim().length === 0 ||
          circuit.pageLocator.printedPages.length === 0 ||
          circuit.pageLocator.printedPages.length !==
            circuit.pageLocator.pdfPageIndexes.length ||
          circuit.pageLocator.printedPages.some(
            (page) => !Number.isSafeInteger(page) || page < 1
          ) ||
          circuit.pageLocator.pdfPageIndexes.some(
            (index) => !Number.isSafeInteger(index) || index < 0
          ) ||
          circuit.applicabilityLimits.length === 0
        ) {
          blockers.push(
            blockerDraft(
              "REFERENCE_CIRCUIT_TRACEABILITY_INVALID",
              `${component.partNumber} reference circuit ${circuit.id} is missing an exact source binding, section/page locator, or applicability limit.`,
              [circuit.sourceIdentity],
              "Bind the reference-circuit record to the selected exact datasheet bytes and complete its locators and limits."
            )
          );
        }
        if (circuit.status !== "starting_point_only" || !circuit.reviewRequired) {
          blockers.push(
            blockerDraft(
              "REFERENCE_CIRCUIT_POLICY_INVALID",
              `${component.partNumber} reference circuit ${circuit.id} is not labeled as a review-required starting point.`,
              [circuit.sourceIdentity],
              "Restore starting_point_only and reviewRequired; a datasheet diagram is never implementation proof."
            )
          );
        }
      }

      if (
        component.layoutConstraintIds.length === 0 ||
        component.layoutConstraintIds.some((id) => !availableLayoutConstraints.has(id))
      ) {
        blockers.push(
          blockerDraft(
            "COMPONENT_LAYOUT_CONSTRAINT_INVALID",
            `${component.partNumber} has missing or unknown layout-constraint references.`,
            exactInputs,
            "Bind every selected component to one or more defined layout constraints."
          )
        );
      }

      const matchingMappings = pinPadMappingReviews.filter(
        (entry) => entry.component === component.key
      );
      if (matchingMappings.length > 1) {
        blockers.push(
          blockerDraft(
            "PIN_PAD_MAPPING_REVIEW_DUPLICATE",
            `${component.partNumber} has multiple pin-pad mapping reviews for one attempt.`,
            matchingMappings.flatMap((entry) => [entry.mappingIdentity, entry.reviewIdentity]),
            "Supply exactly one authoritative pin-pad mapping review."
          )
        );
      }
      const injectedMapping = matchingMappings[0];
      const mapping = resolvedPinPadMapping(component, pinPadMappingReviews);
      if (
        mapping.mappingIdentity === undefined ||
        mapping.reviewIdentity === undefined ||
        !isSha256Identity(mapping.mappingIdentity) ||
        !isSha256Identity(mapping.reviewIdentity)
      ) {
        blockers.push(
          blockerDraft(
            "PIN_PAD_MAPPING_REVIEW_MISSING",
            `${component.partNumber} symbol ${component.symbol} to footprint ${component.footprint} has no exact reviewed pin-pad mapping identity.`,
            exactInputs,
            `Review every symbol pin against every footprint pad for ${component.key}, then inject mapping and review identities.`
          )
        );
      } else {
        const mappingMatchesSelection =
          injectedMapping === undefined ||
          (injectedMapping.symbol === component.symbol &&
            injectedMapping.footprint === component.footprint);
        if (
          !mappingMatchesSelection ||
          mapping.status !== "reviewed" ||
          mapping.requiresReview ||
          !isIsoDate(mapping.checkedAt)
        ) {
          blockers.push(
            blockerDraft(
              "PIN_PAD_MAPPING_MISMATCH",
              `${component.partNumber} pin-pad mapping review does not match the selected symbol/footprint or remains unresolved.`,
              [mapping.mappingIdentity, mapping.reviewIdentity],
              "Correct and re-review the exact selected symbol-to-footprint pin-pad mapping before schematic generation."
            )
          );
        }
      }
    }

    if (context.footprintLibrary === undefined) {
      blockers.push(
        blockerDraft(
          "FOOTPRINT_LIBRARY_SNAPSHOT_MISSING",
          "No exact footprint-library snapshot was supplied.",
          exactInputs,
          "Supply a pinned footprint-library identity and its available footprint names."
        )
      );
    } else {
      for (const component of profile.components) {
        if (!context.footprintLibrary.footprints.includes(component.footprint)) {
          blockers.push(
            blockerDraft(
              "FOOTPRINT_UNAVAILABLE",
              `${component.partNumber} requires unavailable footprint ${component.footprint}.`,
              [context.footprintLibrary.identity],
              "Add and review the exact footprint in a new pinned library snapshot, then rerun component selection."
            )
          );
        }
      }
    }

    const status = blockers.length === 0 ? "pass" : "fail";
    const selectionValue = {
      schemaVersion: "evleda.component-selection.v1",
      profileId: profile.profileId,
      boardRevision: profile.boardRevision,
      lifecycle: "candidate",
      components: profile.components.map((component) => ({
        key: component.key,
        referenceDesignators: legacyReferenceDesignators(component.key),
        quantity: component.quantity,
        manufacturer: component.manufacturer,
        selectedPartNumber: selectedPartNumber(component, sourcing),
        role: component.role,
        package: component.package,
        symbol: component.symbol,
        footprint: component.footprint,
        datasheet: resolved.find((entry) => entry.component === component.key),
        sourcing: findSourcing(component, sourcing) ?? null,
        lifecycle: resolvedLifecycle(component, lifecycleObservations),
        referenceCircuits: component.referenceCircuits,
        layoutConstraintIds: component.layoutConstraintIds,
        pinPadMappingReview: resolvedPinPadMapping(component, pinPadMappingReviews),
        declaredConstraints: component.declaredConstraints,
        designUse: component.designUse
      })),
      footprintLibrary: context.footprintLibrary ?? null,
      caveats: [
        "Captured identity proves exact bytes, not datasheet authenticity or correct interpretation.",
        "Supplier availability is a dated observation and must be refreshed before procurement.",
        "A complete KiCad BOM must include reviewed passives, protection, connectors, test points, and mechanical items."
      ]
    };
    const artifacts = [
      jsonArtifactDraft({
        logicalName: "components/selection.json",
        value: selectionValue,
        exactInputs,
        validationStatus: status
      }),
      artifactDraft({
        logicalName: "components/core-bom.csv",
        mediaType: "text/csv",
        content: bomCsv(profile, sourcing, lifecycleObservations, pinPadMappingReviews),
        exactInputs,
        derivedFrom: ["components/selection.json"],
        validationStatus: status
      }),
      jsonArtifactDraft({
        logicalName: "components/sourcing-evidence.json",
        value: {
          schemaVersion: "evleda.sourcing-evidence.v1",
          retrievedObservations: orderedSourcing,
          lifecycleObservations: profile.components.map((component) => ({
            component: component.key,
            lifecycle: resolvedLifecycle(component, lifecycleObservations)
          })),
          referenceCircuitSources: profile.components.map((component) => ({
            component: component.key,
            circuits: component.referenceCircuits
          })),
          selectedComponents: profile.components.map((component) => component.key)
        },
        exactInputs,
        derivedFrom: ["components/selection.json"],
        validationStatus: status
      }),
      jsonArtifactDraft({
        logicalName: "components/footprint-map.json",
        value: {
          schemaVersion: "evleda.footprint-map.v1",
          library: context.footprintLibrary ?? null,
          mappings: profile.components.map((component) => ({
            component: component.key,
            partNumber: component.partNumber,
            symbol: component.symbol,
            footprint: component.footprint,
            layoutConstraintIds: component.layoutConstraintIds,
            libraryContainsFootprint:
              context.footprintLibrary?.footprints.includes(component.footprint) ?? false,
            pinPadMappingReview: resolvedPinPadMapping(
              component,
              pinPadMappingReviews
            )
          }))
        },
        exactInputs,
        derivedFrom: ["components/selection.json"],
        validationStatus: status
      })
    ];
    const evidence = [
      evidenceDraft({
        evidenceClass: "evleda_check",
        claim:
          status === "pass"
            ? "All eight selections bind exact datasheet and lifecycle evidence, dated in-stock observations, available footprints, reviewed pin-pad mappings, and source-traceable reference-circuit starting points."
            : "Component selection lacks one or more exact sources, active lifecycle observations, in-stock observations, available footprints, or reviewed pin-pad mappings.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        parsedArtifactLogicalName: "components/selection.json",
        exactInputs,
        validationStatus: status
      }),
      evidenceDraft({
        evidenceClass: "agent_claim",
        claim: "Electrical suitability, thermal performance, layout, lifecycle, and physical availability remain candidate claims pending independent checks.",
        subjectDigests: artifacts.map((artifact) => artifact.identity.digest),
        exactInputs,
        validationStatus: "not_run"
      })
    ];
    return finalizeStageResult("component_selection", artifacts, evidence, blockers);
  }
};
