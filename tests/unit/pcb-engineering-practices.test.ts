import { describe, expect, it } from "vitest";
import * as practiceModule from "../../src/knowledge/pcb-engineering-practices.js";
import {
  PCB_ENGINEERING_CLAIM_FAMILIES,
  PCB_ENGINEERING_ENFORCEMENT_CLASSES,
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_PRACTICE_SCHEMA,
  assertWorstCaseGeometryEvidence,
  assertValidPcbEngineeringPracticeCatalog,
  calculateCopperI2RLoss,
  calculateCopperVoltageDrop,
  calculateHotCopperResistance,
  calculateViaBarrelResistance,
  validateAndSnapshotPcbEngineeringPracticeCatalog,
  validateAndSnapshotWorstCaseGeometryEvidence,
  type WorstCaseGeometryEvidence
} from "../../src/knowledge/pcb-engineering-practices.js";
import { canonicalIdentity, canonicalJson, contentIdentity } from "../../src/core/canonical.js";

const capabilityDocument = {
  schemaVersion: "evleda.fabricator-capability-snapshot.v1" as const,
  sourceId: "jlcpcb-manufacturing-capabilities-2026" as const,
  sourcePublisher: "JLCPCB",
  sourceUrl: "https://jlcpcb.com/capabilities/Capabilities",
  fabricatorName: "JLCPCB",
  fabricationService: "rigid multilayer quoted service",
  capturedAt: "2026-09-04T12:00:00.000Z",
  capabilityData: {
    selectedOrderOptions: ["rigid multilayer quoted service", "minimum geometry confirmed"],
    traceGeometry: [
      {
        conductorLayer: "outer" as const,
        unit: "mm" as const,
        minimumFinishedWidthMm: 1,
        maximumFinishedWidthMm: 10,
        minimumFinishedCopperThicknessMm: 0.035,
        maximumFinishedCopperThicknessMm: 0.07,
        widthToleranceMinusPercent: 20,
        widthTolerancePlusPercent: 20,
        thicknessToleranceMinusPercent: 10,
        thicknessTolerancePlusPercent: 10,
        valuesAreMinimumAfterTolerance: true as const
      },
      {
        conductorLayer: "inner" as const,
        unit: "mm" as const,
        minimumFinishedWidthMm: 0.5,
        maximumFinishedWidthMm: 10,
        minimumFinishedCopperThicknessMm: 0.0175,
        maximumFinishedCopperThicknessMm: 0.035,
        widthToleranceMinusPercent: 20,
        widthTolerancePlusPercent: 20,
        thicknessToleranceMinusPercent: 10,
        thicknessTolerancePlusPercent: 10,
        valuesAreMinimumAfterTolerance: true as const
      }
    ],
    viaBarrelGeometry: [
      {
        viaType: "through" as const,
        unit: "mm" as const,
        minimumFinishedHoleDiameterMm: 0.3,
        maximumFinishedHoleDiameterMm: 1,
        minimumBarrelPlatingThicknessMm: 0.018,
        maximumBarrelPlatingThicknessMm: 0.035,
        holeDepthMm: 1.6,
        holeDiameterToleranceMinusMm: 0.08,
        holeDiameterTolerancePlusMm: 0.13,
        platingThicknessToleranceMinusMm: 0.002,
        platingThicknessTolerancePlusMm: 0.005,
        valuesAreMinimumAfterTolerance: true as const
      }
    ]
  }
};
const capabilityBytes = Buffer.from(`${canonicalJson(capabilityDocument)}\n`, "utf8");
const capabilitySnapshotIdentity = contentIdentity(capabilityBytes);
const stackupDefinition = {
  schemaVersion: "evleda.fabricator-stackup.v1" as const,
  fabricatorName: "JLCPCB",
  fabricationService: "rigid multilayer quoted service",
  capabilitySnapshotIdentity,
  stackupName: "quoted-four-layer-stackup",
  finishedBoardThicknessMm: 1.6,
  layers: [
    {
      name: "F.Cu",
      role: "outer" as const,
      unit: "mm" as const,
      minimumFinishedCopperThicknessMm: 0.035,
      maximumFinishedCopperThicknessMm: 0.07
    },
    {
      name: "In1.Cu",
      role: "inner" as const,
      unit: "mm" as const,
      minimumFinishedCopperThicknessMm: 0.0175,
      maximumFinishedCopperThicknessMm: 0.035
    },
    {
      name: "In2.Cu",
      role: "inner" as const,
      unit: "mm" as const,
      minimumFinishedCopperThicknessMm: 0.0175,
      maximumFinishedCopperThicknessMm: 0.035
    },
    {
      name: "B.Cu",
      role: "outer" as const,
      unit: "mm" as const,
      minimumFinishedCopperThicknessMm: 0.035,
      maximumFinishedCopperThicknessMm: 0.07
    }
  ]
};
const geometryEvidence: WorstCaseGeometryEvidence = {
  fabricatorName: "JLCPCB",
  fabricationService: "rigid multilayer quoted service",
  capabilitySourceId: "jlcpcb-manufacturing-capabilities-2026",
  capabilitySnapshotIdentity,
  capabilitySnapshotBytesBase64: capabilityBytes.toString("base64"),
  stackupIdentity: canonicalIdentity(stackupDefinition, "evleda.fabricator-stackup.v1"),
  stackupDefinition,
  minimumValuesIncludeManufacturingTolerance: true,
  evaluatedAt: "2026-09-05T12:00:00.000Z"
};

const evidenceForCapabilityDocument = (
  document: typeof capabilityDocument,
  evaluatedAt = geometryEvidence.evaluatedAt
): WorstCaseGeometryEvidence => {
  const bytes = Buffer.from(`${canonicalJson(document)}\n`, "utf8");
  const capabilityIdentity = contentIdentity(bytes);
  const definition = {
    ...structuredClone(stackupDefinition),
    capabilitySnapshotIdentity: capabilityIdentity
  };
  return {
    ...structuredClone(geometryEvidence),
    capabilitySnapshotIdentity: capabilityIdentity,
    capabilitySnapshotBytesBase64: bytes.toString("base64"),
    stackupIdentity: canonicalIdentity(definition, "evleda.fabricator-stackup.v1"),
    stackupDefinition: definition,
    evaluatedAt
  };
};

const expectInvalidArgument = (work: () => unknown, field: string): void => {
  expect(work).toThrow(
    expect.objectContaining({ code: "INVALID_ARGUMENT", details: expect.objectContaining({ field }) })
  );
};

const expectUnresolved = (work: () => unknown, field: string): void => {
  expect(work).toThrow(
    expect.objectContaining({
      code: "GATE_FAILED",
      details: expect.objectContaining({ status: "unresolved", field })
    })
  );
};

describe("PCB engineering practice catalog", () => {
  it("is canonical, source-bound, and covers every researched claim family and enforcement class", () => {
    expect(() => assertValidPcbEngineeringPracticeCatalog(PCB_ENGINEERING_PRACTICE_CATALOG)).not.toThrow();
    const { identity, ...payload } = PCB_ENGINEERING_PRACTICE_CATALOG;
    expect(identity).toEqual(canonicalIdentity(payload, PCB_ENGINEERING_PRACTICE_SCHEMA));

    const coveredFamilies = new Set(
      PCB_ENGINEERING_PRACTICE_CATALOG.rules.flatMap((rule) => rule.claimFamilies)
    );
    expect(coveredFamilies).toEqual(new Set(PCB_ENGINEERING_CLAIM_FAMILIES));
    expect(
      new Set(PCB_ENGINEERING_PRACTICE_CATALOG.rules.flatMap((rule) => rule.enforcementClasses))
    ).toEqual(new Set(PCB_ENGINEERING_ENFORCEMENT_CLASSES));

    const sources = new Map(
      PCB_ENGINEERING_PRACTICE_CATALOG.sources.map((source) => [source.id, source])
    );
    for (const rule of PCB_ENGINEERING_PRACTICE_CATALOG.rules) {
      expect(rule.sourceIds.length, rule.id).toBeGreaterThan(0);
      expect(rule.scopePredicates.length, rule.id).toBeGreaterThan(0);
      expect(rule.requiredInputs.length, rule.id).toBeGreaterThan(0);
      expect(rule.sourceIds.every((sourceId) => sources.has(sourceId)), rule.id).toBe(true);
    }
    for (const source of sources.values()) {
      expect(source.title).not.toBe("");
      expect(source.publisher).not.toBe("");
      expect(source.revision).not.toBe("");
      expect(source.date.value).toMatch(/^\d{4}(?:-\d{2})?(?:-\d{2})?$/u);
      expect(new URL(source.url).protocol).toBe("https:");
    }
  });

  it("rejects unsourced rules, universal numeric folklore, and prose current-per-via limits", () => {
    const unsourced = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    unsourced.rules[0].sourceIds = [];
    expect(() => assertValidPcbEngineeringPracticeCatalog(unsourced)).toThrow(
      /cite at least one source/iu
    );

    const universal = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    universal.rules[1].numericClaims[0].applicability = "universal";
    expect(() => assertValidPcbEngineeringPracticeCatalog(universal)).toThrow(
      /universal numeric pcb folklore/iu
    );

    const folklore = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    folklore.rules[3].machineCheck = "Assume 1 A per via without geometry or evidence.";
    expect(() => assertValidPcbEngineeringPracticeCatalog(folklore)).toThrow(
      /structured, source-bound claims/iu
    );
  });

  it("contains no ampacity helper or universal trace/via current result", () => {
    expect("calculateViaCurrentCapacity" in practiceModule).toBe(false);
    expect("calculateTraceCurrentCapacity" in practiceModule).toBe(false);
    expect(PCB_ENGINEERING_PRACTICE_CATALOG.limitations).toContain(
      "It contains no IPC-2152 lookup curves and produces no universal trace or via ampacity."
    );
  });

  it("rejects unknown fields, invalid dates/enums/units, and structured current-per-via folklore", () => {
    const catalogExtra = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    catalogExtra.formula = "execute arbitrary formula";
    expect(() => assertValidPcbEngineeringPracticeCatalog(catalogExtra)).toThrow(/unknown fields/iu);

    const sourceExtra = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    sourceExtra.sources[0].code = "return true";
    expect(() => assertValidPcbEngineeringPracticeCatalog(sourceExtra)).toThrow(/unknown fields/iu);

    const invalidDate = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    invalidDate.sources[0].date.value = "2026-99-99";
    expect(() => assertValidPcbEngineeringPracticeCatalog(invalidDate)).toThrow(/date is invalid/iu);

    const ruleFormula = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    ruleFormula.rules[0].formula = "current = width";
    expect(() => assertValidPcbEngineeringPracticeCatalog(ruleFormula)).toThrow(/unknown fields/iu);

    const unknownChecker = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    unknownChecker.rules[0].checkerIds = ["eval_prose_v1"];
    expect(() => assertValidPcbEngineeringPracticeCatalog(unknownChecker)).toThrow(
      /unknown checker or model/iu
    );

    const ampsPerVia = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    ampsPerVia.rules[1].numericClaims[0].unit = "A_per_via";
    ampsPerVia.rules[1].numericClaims[0].applicability = "universal";
    expect(() => assertValidPcbEngineeringPracticeCatalog(ampsPerVia)).toThrow(
      /universal numeric pcb folklore/iu
    );

    const envelopeExtra = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    envelopeExtra.supportedEnvelope.unreviewedVoltageV = 48;
    expect(() => assertValidPcbEngineeringPracticeCatalog(envelopeExtra)).toThrow(/unknown fields/iu);

    const blankLimitation = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG) as any;
    blankLimitation.limitations.push("");
    expect(() => assertValidPcbEngineeringPracticeCatalog(blankLimitation)).toThrow(
      /limitations/iu
    );
  });

  it("binds the via model to the copper model and keeps IEC base and amendment metadata distinct", () => {
    const viaRule = PCB_ENGINEERING_PRACTICE_CATALOG.rules.find(
      (rule) => rule.id === "pcb.via.barrel-resistance-only"
    );
    expect(viaRule?.sourceIds).toContain("ti-analog-engineers-pocket-reference-rev-c");
    expect(viaRule?.modelIds).toEqual([
      "ti-linear-copper-resistance-v1",
      "cylindrical-copper-annulus-v1"
    ]);

    const base = PCB_ENGINEERING_PRACTICE_CATALOG.sources.find(
      (source) => source.id === "iec-60664-1-2020-base"
    );
    const amendment = PCB_ENGINEERING_PRACTICE_CATALOG.sources.find(
      (source) => source.id === "iec-60664-1-amd1-2025"
    );
    expect(base).toMatchObject({
      url: "https://webstore.iec.ch/en/publication/59671",
      date: { kind: "published", value: "2020-05-26" },
      accessScope: "public_scope_or_toc"
    });
    expect(amendment).toMatchObject({
      url: "https://webstore.iec.ch/en/publication/80714",
      date: { kind: "published", value: "2025-05-06" },
      accessScope: "public_scope_or_toc"
    });
  });

  it("rejects live catalog getters and proxies before reading them", () => {
    const liveCatalog: any = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG);
    const trustedRules = liveCatalog.rules;
    const forgedRules = structuredClone(trustedRules);
    forgedRules[0].enforcementClasses = ["advisory"];
    let getterReads = 0;
    Object.defineProperty(liveCatalog, "rules", {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return getterReads <= 3 ? trustedRules : forgedRules;
      }
    });
    expect(() => validateAndSnapshotPcbEngineeringPracticeCatalog(liveCatalog)).toThrow(
      /must not contain accessors/iu
    );
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxied = new Proxy(structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG), {
      get: (target, property, receiver) => {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => validateAndSnapshotPcbEngineeringPracticeCatalog(proxied)).toThrow(
      /non-proxy plain data/iu
    );
    expect(proxyReads).toBe(0);
  });

  it("returns the detached deeply frozen catalog that downstream consumers must use", () => {
    const mutable: any = structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG);
    const snapshot = validateAndSnapshotPcbEngineeringPracticeCatalog(mutable);
    const originalClasses = [...snapshot.rules[0]!.enforcementClasses];
    const originalPublisher = snapshot.sources[0]!.publisher;

    mutable.rules[0].enforcementClasses = ["advisory"];
    mutable.sources[0].publisher = "forged publisher";
    expect(snapshot.rules[0]!.enforcementClasses).toEqual(originalClasses);
    expect(snapshot.sources[0]!.publisher).toBe(originalPublisher);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rules)).toBe(true);
    expect(Object.isFrozen(snapshot.rules[0]!.enforcementClasses)).toBe(true);
    expect(Object.isFrozen(snapshot.sources[0]!.date)).toBe(true);
    expect(() =>
      assertValidPcbEngineeringPracticeCatalog(
        structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG)
      )
    ).toThrow(/mutable catalog assertions are forbidden/iu);
  });
});

describe("evidence-bound PCB electrical calculations", () => {
  it("returns the detached frozen geometry-evidence snapshot that consumers must use", () => {
    const mutable: any = structuredClone(geometryEvidence);
    const snapshot = validateAndSnapshotWorstCaseGeometryEvidence(mutable);
    const originalService = snapshot.fabricationService;
    const originalLayer = snapshot.stackupDefinition.layers[0]!.name;

    mutable.fabricationService = "forged service";
    mutable.stackupDefinition.layers[0].name = "forged layer";
    expect(snapshot.fabricationService).toBe(originalService);
    expect(snapshot.stackupDefinition.layers[0]!.name).toBe(originalLayer);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.stackupDefinition)).toBe(true);
    expect(Object.isFrozen(snapshot.stackupDefinition.layers)).toBe(true);
    expect(() =>
      assertWorstCaseGeometryEvidence(structuredClone(geometryEvidence))
    ).toThrow(/mutable geometry evidence assertions are forbidden/iu);
  });

  it("calculates hot trace resistance, voltage drop, and RMS I-squared-R loss", () => {
    const result = calculateHotCopperResistance({
      geometry: {
        conductorLayer: "outer",
        lengthMm: 100,
        minimumFinishedWidthMm: 1,
        minimumFinishedCopperThicknessMm: 0.035,
        evidence: geometryEvidence
      },
      copperTemperatureC: 85
    });

    const expectedRho = 17e-6 * (1 + 3.9e-3 * (85 - 25));
    const expectedResistance = (expectedRho * 100) / (1 * 0.035);
    expect(result.status).toBe("calculated_unverified_non_gating");
    expect(result.evidenceAuthority).toBe("self_attested_unverified");
    expect(result.resistivityOhmMmAtTemperature).toBeCloseTo(expectedRho, 15);
    expect(result.resistanceOhm).toBeCloseTo(expectedResistance, 15);
    const voltageDrop = calculateCopperVoltageDrop({
      currentA: 2,
      resistanceOhm: result.resistanceOhm
    });
    const loss = calculateCopperI2RLoss({
      rmsCurrentA: 1.5,
      resistanceOhm: result.resistanceOhm
    });
    expect(voltageDrop.status).toBe("arithmetic_only_non_gating");
    expect(voltageDrop.voltageDropV).toBeCloseTo(2 * expectedResistance, 15);
    expect(loss.status).toBe("arithmetic_only_non_gating");
    expect(loss.lossW).toBeCloseTo(1.5 ** 2 * expectedResistance, 15);
  });

  it("calculates via barrel resistance from the exact annular copper cross-section only", () => {
    const result = calculateViaBarrelResistance({
      geometry: {
        holeDepthMm: 1.6,
        minimumFinishedHoleDiameterMm: 0.3,
        minimumBarrelPlatingThicknessMm: 0.018,
        evidence: geometryEvidence
      },
      copperTemperatureC: 85
    });

    const area = Math.PI * 0.018 * (0.3 + 0.018);
    const rho = 17e-6 * (1 + 3.9e-3 * (85 - 25));
    expect(result.status).toBe("calculated_unverified_non_gating");
    expect(result.evidenceAuthority).toBe("self_attested_unverified");
    expect(result.conductiveCrossSectionMm2).toBeCloseTo(area, 15);
    expect(result.resistanceOhm).toBeCloseTo((rho * 1.6) / area, 15);
    expect(result.ampacity).toEqual({
      status: "not_evaluated",
      requiredGate: "licensed_or_qualified_current_temperature_model"
    });
  });

  it("returns deeply detached, frozen, canonical calculation records", () => {
    const mutableInput: any = {
      geometry: {
        conductorLayer: "outer" as const,
        lengthMm: 50,
        minimumFinishedWidthMm: 1,
        minimumFinishedCopperThicknessMm: 0.035,
        evidence: structuredClone(geometryEvidence)
      },
      copperTemperatureC: 70
    };
    const result = calculateHotCopperResistance(mutableInput);
    const originalLength = result.geometry.lengthMm;
    const originalLayer = result.geometry.evidence.stackupDefinition.layers[0]!.name;

    mutableInput.geometry.lengthMm = 500;
    mutableInput.geometry.evidence.stackupDefinition.layers[0].name = "tampered";
    expect(result.geometry.lengthMm).toBe(originalLength);
    expect(result.geometry.evidence.stackupDefinition.layers[0]!.name).toBe(originalLayer);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.geometry)).toBe(true);
    expect(Object.isFrozen(result.geometry.evidence.stackupDefinition.layers)).toBe(true);
    const { identity, ...payload } = result;
    expect(identity).toEqual(canonicalIdentity(payload, "evleda.hot-copper-resistance-result.v1"));
  });

  it("blocks absent or inconsistent exact fabrication evidence", () => {
    const calculate = (evidence: unknown) =>
      calculateHotCopperResistance({
        geometry: {
          conductorLayer: "outer",
          lengthMm: 10,
          minimumFinishedWidthMm: 1,
          minimumFinishedCopperThicknessMm: 0.035,
          evidence
        },
        copperTemperatureC: 60
      } as any);

    const noBytes = structuredClone(geometryEvidence) as any;
    delete noBytes.capabilitySnapshotBytesBase64;
    expectUnresolved(() => calculate(noBytes), "evidence");

    const wrongBytes: any = structuredClone(geometryEvidence);
    wrongBytes.capabilitySnapshotBytesBase64 = Buffer.from("{}\n").toString("base64");
    expectUnresolved(() => calculate(wrongBytes), "evidence.capabilitySnapshotIdentity");

    const wrongFabricator: any = structuredClone(geometryEvidence);
    wrongFabricator.fabricatorName = "Different Fabricator";
    expectUnresolved(() => calculate(wrongFabricator), "evidence.capabilitySnapshotBytesBase64");

    const wrongStackup: any = structuredClone(geometryEvidence);
    wrongStackup.stackupDefinition.stackupName = "mutated-stackup";
    expectUnresolved(() => calculate(wrongStackup), "evidence.stackupIdentity");
  });

  it("does not elevate self-minted or non-substantiating capability evidence to a gate pass", () => {
    const mismatchedGeometry = () =>
      calculateHotCopperResistance({
        geometry: {
          conductorLayer: "outer",
          lengthMm: 10,
          minimumFinishedWidthMm: 0.5,
          minimumFinishedCopperThicknessMm: 0.035,
          evidence: geometryEvidence
        },
        copperTemperatureC: 60
      });
    expectUnresolved(mismatchedGeometry, "geometry");

    const nonSubstantiating = {
      ...structuredClone(capabilityDocument),
      capabilityData: { nothingAboutGeometry: true }
    } as any;
    const nonSubstantiatingEvidence = evidenceForCapabilityDocument(nonSubstantiating);
    expectUnresolved(
      () =>
        calculateHotCopperResistance({
          geometry: {
            conductorLayer: "outer",
            lengthMm: 10,
            minimumFinishedWidthMm: 1,
            minimumFinishedCopperThicknessMm: 0.035,
            evidence: nonSubstantiatingEvidence
          },
          copperTemperatureC: 60
        }),
      "evidence.capabilityData"
    );

    const selfMintedDocument = structuredClone(capabilityDocument);
    selfMintedDocument.capabilityData.traceGeometry[0]!.minimumFinishedWidthMm = 0.25;
    const selfMintedEvidence = evidenceForCapabilityDocument(selfMintedDocument);
    const result = calculateHotCopperResistance({
      geometry: {
        conductorLayer: "outer",
        lengthMm: 10,
        minimumFinishedWidthMm: 0.25,
        minimumFinishedCopperThicknessMm: 0.035,
        evidence: selfMintedEvidence
      },
      copperTemperatureC: 60
    });
    expect(result.status).toBe("calculated_unverified_non_gating");
    expect(result.evidenceAuthority).toBe("self_attested_unverified");
  });

  it("rejects stale and future-dated capability captures relative to explicit evaluation time", () => {
    const calculate = (evidence: WorstCaseGeometryEvidence) =>
      calculateHotCopperResistance({
        geometry: {
          conductorLayer: "outer",
          lengthMm: 10,
          minimumFinishedWidthMm: 1,
          minimumFinishedCopperThicknessMm: 0.035,
          evidence
        },
        copperTemperatureC: 60
      });

    const futureDocument = {
      ...structuredClone(capabilityDocument),
      capturedAt: "2026-09-06T12:00:00.000Z"
    };
    expectUnresolved(
      () => calculate(evidenceForCapabilityDocument(futureDocument)),
      "evidence.evaluatedAt"
    );

    const staleDocument = {
      ...structuredClone(capabilityDocument),
      capturedAt: "2026-07-01T12:00:00.000Z"
    };
    expectUnresolved(
      () => calculate(evidenceForCapabilityDocument(staleDocument)),
      "evidence.evaluatedAt"
    );
  });

  it("rejects accessors and proxies before reading any trace or via calculation value", () => {
    const traceInput: any = {
      geometry: {
        conductorLayer: "outer",
        lengthMm: 10,
        minimumFinishedWidthMm: 1,
        minimumFinishedCopperThicknessMm: 0.035,
        evidence: structuredClone(geometryEvidence)
      },
      copperTemperatureC: 60
    };
    let traceReads = 0;
    Object.defineProperty(traceInput.geometry, "minimumFinishedWidthMm", {
      enumerable: true,
      configurable: true,
      get: () => {
        traceReads += 1;
        return traceReads === 1 ? 1_000 : 0.01;
      }
    });
    expectInvalidArgument(
      () => calculateHotCopperResistance(traceInput),
      "input.geometry.minimumFinishedWidthMm"
    );
    expect(traceReads).toBe(0);

    const toleranceInput: any = {
      geometry: {
        conductorLayer: "outer",
        lengthMm: 10,
        minimumFinishedWidthMm: 1,
        minimumFinishedCopperThicknessMm: 0.035,
        evidence: structuredClone(geometryEvidence)
      },
      copperTemperatureC: 60
    };
    let toleranceReads = 0;
    Object.defineProperty(
      toleranceInput.geometry.evidence,
      "minimumValuesIncludeManufacturingTolerance",
      {
        enumerable: true,
        configurable: true,
        get: () => {
          toleranceReads += 1;
          return toleranceReads === 1;
        }
      }
    );
    expectInvalidArgument(
      () => calculateHotCopperResistance(toleranceInput),
      "input.geometry.evidence.minimumValuesIncludeManufacturingTolerance"
    );
    expect(toleranceReads).toBe(0);

    for (const field of [
      "minimumFinishedHoleDiameterMm",
      "minimumBarrelPlatingThicknessMm"
    ] as const) {
      const viaInput: any = {
        geometry: {
          holeDepthMm: 1.6,
          minimumFinishedHoleDiameterMm: 0.3,
          minimumBarrelPlatingThicknessMm: 0.018,
          evidence: structuredClone(geometryEvidence)
        },
        copperTemperatureC: 60
      };
      let reads = 0;
      Object.defineProperty(viaInput.geometry, field, {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          return reads === 1 ? 1 : 0.001;
        }
      });
      expectInvalidArgument(() => calculateViaBarrelResistance(viaInput), `input.geometry.${field}`);
      expect(reads).toBe(0);
    }

    let proxyReads = 0;
    const proxied = new Proxy(traceInput, {
      get: (target, property, receiver) => {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expectInvalidArgument(() => calculateHotCopperResistance(proxied), "input");
    expect(proxyReads).toBe(0);
  });

  it("rejects zero, non-finite, underflow-scale, overflow-scale, and out-of-model inputs", () => {
    const trace = (overrides: Record<string, unknown>) =>
      calculateHotCopperResistance({
        geometry: {
          conductorLayer: "outer",
          lengthMm: 10,
          minimumFinishedWidthMm: 1,
          minimumFinishedCopperThicknessMm: 0.035,
          evidence: geometryEvidence,
          ...overrides
        },
        copperTemperatureC: 60
      } as any);

    expectInvalidArgument(() => trace({ lengthMm: Number.MAX_VALUE }), "geometry.lengthMm");
    expectInvalidArgument(
      () => trace({ minimumFinishedWidthMm: Number.MIN_VALUE }),
      "geometry.minimumFinishedWidthMm"
    );
    expectInvalidArgument(
      () => calculateHotCopperResistance({
        geometry: {
          conductorLayer: "outer",
          lengthMm: 10,
          minimumFinishedWidthMm: 1,
          minimumFinishedCopperThicknessMm: 0.035,
          evidence: geometryEvidence
        },
        copperTemperatureC: 1_000
      }),
      "copperTemperatureC"
    );
    expectInvalidArgument(
      () => calculateCopperVoltageDrop({ currentA: 0, resistanceOhm: 1 }),
      "currentA"
    );
    expectInvalidArgument(
      () => calculateCopperVoltageDrop({ currentA: 1, resistanceOhm: Number.POSITIVE_INFINITY }),
      "resistanceOhm"
    );
    expectInvalidArgument(
      () => calculateCopperI2RLoss({ rmsCurrentA: Number.MAX_VALUE, resistanceOhm: 1 }),
      "rmsCurrentA"
    );
    expectInvalidArgument(
      () => calculateCopperI2RLoss({ rmsCurrentA: 1, resistanceOhm: 0 }),
      "resistanceOhm"
    );
    expectInvalidArgument(
      () => calculateViaBarrelResistance({
        geometry: {
          holeDepthMm: 1.6,
          minimumFinishedHoleDiameterMm: 0.3,
          minimumBarrelPlatingThicknessMm: Number.MIN_VALUE,
          evidence: geometryEvidence
        },
        copperTemperatureC: 60
      }),
      "geometry.minimumBarrelPlatingThicknessMm"
    );
  });

  it("fails closed when worst-case geometry, evidence, temperature, or current is missing", () => {
    const validTraceInput = {
      geometry: {
        conductorLayer: "inner" as const,
        lengthMm: 25,
        minimumFinishedWidthMm: 0.5,
        minimumFinishedCopperThicknessMm: 0.0175,
        evidence: geometryEvidence
      },
      copperTemperatureC: 60
    };

    expectInvalidArgument(
      () =>
        calculateHotCopperResistance({
          ...validTraceInput,
          geometry: { ...validTraceInput.geometry, minimumFinishedWidthMm: undefined }
        } as any),
      "geometry.minimumFinishedWidthMm"
    );
    expectInvalidArgument(
      () => calculateHotCopperResistance({ ...validTraceInput, copperTemperatureC: undefined } as any),
      "copperTemperatureC"
    );
    expectUnresolved(
      () =>
        calculateHotCopperResistance({
          ...validTraceInput,
          geometry: {
            ...validTraceInput.geometry,
            evidence: {
              ...geometryEvidence,
              minimumValuesIncludeManufacturingTolerance: false
            }
          }
        } as any),
      "evidence.minimumValuesIncludeManufacturingTolerance"
    );
    expectUnresolved(
      () =>
        calculateHotCopperResistance({
          ...validTraceInput,
          geometry: {
            ...validTraceInput.geometry,
            evidence: {
              ...geometryEvidence,
              capabilitySourceId: "ipc-2152-2009"
            }
          }
        } as any),
      "evidence.capabilitySourceId"
    );
    expectInvalidArgument(
      () => calculateCopperVoltageDrop({ currentA: undefined, resistanceOhm: 0.01 } as any),
      "currentA"
    );
    expectInvalidArgument(
      () => calculateCopperI2RLoss({ rmsCurrentA: 1, resistanceOhm: 0 } as any),
      "resistanceOhm"
    );
    expectInvalidArgument(
      () =>
        calculateViaBarrelResistance({
          geometry: {
            holeDepthMm: 1.6,
            minimumFinishedHoleDiameterMm: 0.3,
            minimumBarrelPlatingThicknessMm: undefined,
            evidence: geometryEvidence
          },
          copperTemperatureC: 60
        } as any),
      "geometry.minimumBarrelPlatingThicknessMm"
    );
  });
});
