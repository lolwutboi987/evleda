import { describe, expect, it } from "vitest";
import { canonicalIdentity } from "../../src/core/canonical.js";
import {
  ENGINEERING_CONSTRAINT_BINDING_SCHEMA,
  ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
  ENGINEERING_CONSTRAINT_SET_SCHEMA,
  compileEngineeringConstraintBinding,
  compileEngineeringConstraintSet,
  validateAndSnapshotEngineeringConstraintBinding,
  validateAndSnapshotEngineeringConstraintContext,
  validateAndSnapshotEngineeringConstraintSet,
  type EngineeringCheckerResult,
  type EngineeringConstraintContext,
  type EngineeringInputBinding,
  type EngineeringScopeFact
} from "../../src/engineering/constraint-compiler.js";
import {
  PCB_ENGINEERING_PRACTICE_CATALOG,
  PCB_ENGINEERING_REQUIRED_INPUTS,
  PCB_ENGINEERING_SCOPE_PREDICATES,
  type PcbEngineeringPracticeCatalog,
  type PcbEngineeringRequiredInput,
  type PcbEngineeringScopePredicate
} from "../../src/knowledge/pcb-engineering-practices.js";

const testIdentity = (kind: string, value: unknown) =>
  canonicalIdentity({ kind, value }, `test.${kind}.v1`);

const scopeFact = (
  predicate: PcbEngineeringScopePredicate,
  value: boolean
): EngineeringScopeFact => ({
  predicate,
  value,
  identity: testIdentity("scope-fact", { predicate, value })
});

const completeScope = (overrides: Partial<Record<PcbEngineeringScopePredicate, boolean>> = {}) =>
  PCB_ENGINEERING_SCOPE_PREDICATES.map((predicate) =>
    scopeFact(predicate, overrides[predicate] ?? true)
  );

const inputBinding = (
  inputId: PcbEngineeringRequiredInput,
  discriminator: string = "primary"
): EngineeringInputBinding => ({
  inputId,
  identity: testIdentity("engineering-input", { inputId, discriminator })
});

const completeInputs = (): readonly EngineeringInputBinding[] =>
  PCB_ENGINEERING_REQUIRED_INPUTS.map((inputId) => inputBinding(inputId));

const compilationContext = (
  scopeFacts: readonly EngineeringScopeFact[] = [],
  inputBindings: readonly EngineeringInputBinding[] = [],
  checkerResults: readonly EngineeringCheckerResult[] = []
): EngineeringConstraintContext => ({
  schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
  scopeFacts,
  inputBindings,
  checkerResults
});

const checkerResultsFor = (
  catalog: PcbEngineeringPracticeCatalog,
  bindings: readonly EngineeringInputBinding[],
  status: EngineeringCheckerResult["status"] = "pass"
): readonly EngineeringCheckerResult[] =>
  catalog.rules.flatMap((rule) => {
    const exactInputIdentities = rule.requiredInputs.map((inputId) => {
      const matches = bindings.filter((binding) => binding.inputId === inputId);
      if (matches.length !== 1) throw new Error(`Test fixture input ${inputId} is not unique`);
      return matches[0]!.identity;
    });
    return rule.checkerIds.map(
      (checkerId): EngineeringCheckerResult => ({
        ruleId: rule.id,
        checkerId,
        status,
        resultIdentity: testIdentity("checker-result", { ruleId: rule.id, checkerId, status }),
        exactInputIdentities,
        sourceIds: rule.sourceIds,
        numericClaimIds: rule.numericClaims.map((claim) => claim.id),
        modelIds: rule.modelIds
      })
    );
  });

const cloneCatalog = (): PcbEngineeringPracticeCatalog =>
  structuredClone(PCB_ENGINEERING_PRACTICE_CATALOG);

const rehashConstraintSet = (candidate: any): void => {
  const { identity: _identity, ...payload } = candidate;
  candidate.identity = canonicalIdentity(payload, ENGINEERING_CONSTRAINT_SET_SCHEMA);
};

const forgeAllRulesNotApplicable = (source: unknown): any => {
  const forged = structuredClone(source) as any;
  for (const evaluation of forged.evaluations) {
    evaluation.applicability = "not_applicable";
    evaluation.unresolvedScopePredicates = [];
    for (const gate of evaluation.gateResults) {
      gate.status = "not_applicable";
      gate.code = "ENGINEERING_GATE_NOT_APPLICABLE";
      gate.subjectIds = [];
      gate.checkerResultIdentities = [];
    }
  }
  forged.coverage.applicableCount = 0;
  forged.coverage.notApplicableCount = forged.evaluations.length;
  forged.coverage.unresolvedCount = 0;
  forged.blockers = [];
  rehashConstraintSet(forged);
  return forged;
};

describe("engineering practice constraint compiler", () => {
  it("emits a canonical, deterministically sorted evaluation for every catalog rule", () => {
    const inputs = completeInputs();
    const context = compilationContext(
      completeScope(),
      inputs,
      checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)
    );
    const compiled = compileEngineeringConstraintSet(context);
    const reversed = compileEngineeringConstraintSet(
      compilationContext(
        [...context.scopeFacts].reverse(),
        [...context.inputBindings].reverse(),
        [...context.checkerResults].reverse()
      )
    );

    expect(reversed).toEqual(compiled);
    expect(compiled.schemaVersion).toBe(ENGINEERING_CONSTRAINT_SET_SCHEMA);
    expect(compiled.catalogIdentity).toEqual(PCB_ENGINEERING_PRACTICE_CATALOG.identity);
    expect(compiled.coverage).toMatchObject({
      catalogRuleCount: PCB_ENGINEERING_PRACTICE_CATALOG.rules.length,
      evaluationCount: PCB_ENGINEERING_PRACTICE_CATALOG.rules.length,
      missingRuleIds: [],
      unexpectedRuleIds: [],
      complete: true
    });
    expect(compiled.evaluations.map((entry) => entry.ruleId)).toEqual(
      [...PCB_ENGINEERING_PRACTICE_CATALOG.rules.map((rule) => rule.id)].sort()
    );
    expect(compiled.evaluations.every((entry) => entry.applicability === "applicable")).toBe(true);
    expect(
      validateAndSnapshotEngineeringConstraintSet(
        compiled,
        context,
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toEqual(compiled);
    const { identity, ...payload } = compiled;
    expect(identity).toEqual(canonicalIdentity(payload, ENGINEERING_CONSTRAINT_SET_SCHEMA));

    const mutated = structuredClone(compiled) as any;
    mutated.coverage.applicableCount -= 1;
    expect(() =>
      validateAndSnapshotEngineeringConstraintSet(
        mutated,
        context,
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toThrow(/identity does not reproduce/iu);
  });

  it("uses one detached catalog snapshot and rejects accessor or proxy reread attacks", () => {
    const mutableCatalog = cloneCatalog() as any;
    const validatedIdentity = structuredClone(mutableCatalog.identity);
    const compiled = compileEngineeringConstraintSet(
      compilationContext(completeScope()),
      mutableCatalog
    );
    mutableCatalog.rules[0].id = "forged.rule.injected-after-snapshot";
    mutableCatalog.rules[0].checkerIds = ["dfm_confirmation_evidence_v1"];

    expect(mutableCatalog.rules[0].id).toBe("forged.rule.injected-after-snapshot");
    expect(compiled.catalogIdentity).toEqual(validatedIdentity);
    expect(compiled.evaluations).toHaveLength(PCB_ENGINEERING_PRACTICE_CATALOG.rules.length);
    expect(
      compiled.evaluations.some((entry) => entry.ruleId === "forged.rule.injected-after-snapshot")
    ).toBe(false);

    let proxyReads = 0;
    const proxiedCatalog = new Proxy(cloneCatalog(), {
      get(target, property, receiver) {
        proxyReads += 1;
        if (property === "rules" && proxyReads > 1) {
          return [{ id: "forged.proxy.rule" }];
        }
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() =>
      compileEngineeringConstraintSet(
        compilationContext(completeScope()),
        proxiedCatalog
      )
    ).toThrow(/non-proxy plain data/iu);
    expect(proxyReads).toBe(0);

    const accessorCatalog = cloneCatalog() as any;
    let getterReads = 0;
    Object.defineProperty(accessorCatalog, "rules", {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return [{ id: "forged.getter.rule" }];
      }
    });
    expect(() =>
      compileEngineeringConstraintSet(
        compilationContext(completeScope()),
        accessorCatalog
      )
    ).toThrow(/must not contain accessors/iu);
    expect(getterReads).toBe(0);
  });

  it("records missing required inputs and gives every unresolved hard/calculation gate a stable blocker", () => {
    const compiled = compileEngineeringConstraintSet(compilationContext(completeScope()));
    const trace = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.trace.hot-resistance-voltage-drop-i2r"
    )!;

    expect(trace.applicability).toBe("applicable");
    expect(trace.requiredInputs.every((entry) => entry.status === "missing")).toBe(true);
    expect(trace.requiredInputs.every((entry) => entry.identities.length === 0)).toBe(true);
    for (const evaluation of compiled.evaluations) {
      for (const gate of evaluation.gateResults) {
        if (
          gate.status === "unresolved" &&
          (gate.enforcementClass === "hard_gate" ||
            gate.enforcementClass === "calculation_gate")
        ) {
          expect(
            compiled.blockers.some(
              (blocker) =>
                blocker.ruleId === evaluation.ruleId &&
                blocker.enforcementClass === gate.enforcementClass &&
                blocker.owner === gate.owner &&
                blocker.code === gate.code
            ),
            `${evaluation.ruleId}:${gate.enforcementClass}:${gate.owner}`
          ).toBe(true);
        }
      }
    }
    expect(
      trace.gateResults.filter(
        (gate) => gate.owner === "machine" && gate.status === "unresolved"
      )
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ENGINEERING_REQUIRED_INPUT_MISSING" })
      ])
    );
  });

  it("does not choose between contradictory runtime limits or contradictory scope evidence", () => {
    const inputs = completeInputs();
    const conflictingInput: EngineeringInputBinding = inputBinding("rms_current_a", "conflict");
    const conflictingFact = scopeFact("current_carrying_conductor_present", false);
    const compiled = compileEngineeringConstraintSet(
      compilationContext([...completeScope(), conflictingFact], [
        ...inputs,
        conflictingInput
      ])
    );
    const trace = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.trace.hot-resistance-voltage-drop-i2r"
    )!;

    expect(trace.applicability).toBe("unresolved");
    expect(trace.unresolvedScopePredicates).toContain("current_carrying_conductor_present");
    expect(trace.matchedScopeFacts).toEqual(
      expect.arrayContaining([
        scopeFact("current_carrying_conductor_present", true),
        conflictingFact
      ])
    );
    expect(trace.requiredInputs).toContainEqual({
      inputId: "rms_current_a",
      status: "conflicting",
      identities: expect.arrayContaining([
        inputBinding("rms_current_a").identity,
        conflictingInput.identity
      ])
    });
    expect(trace.gateResults.filter((gate) => gate.owner === "machine")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unresolved",
          code: "ENGINEERING_SCOPE_UNRESOLVED"
        })
      ])
    );

    const limitConflict = compileEngineeringConstraintSet(
      compilationContext(completeScope(), [...inputs, conflictingInput])
    );
    const limitConflictTrace = limitConflict.evaluations.find(
      (entry) => entry.ruleId === "pcb.trace.hot-resistance-voltage-drop-i2r"
    )!;
    expect(limitConflictTrace.applicability).toBe("applicable");
    expect(limitConflictTrace.gateResults.filter((gate) => gate.owner === "machine")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unresolved",
          code: "ENGINEERING_REQUIRED_INPUT_CONFLICT",
          subjectIds: ["rms_current_a"]
        })
      ])
    );
    expect(
      limitConflict.blockers.some(
        (blocker) =>
          blocker.ruleId === limitConflictTrace.ruleId &&
          blocker.code === "ENGINEERING_REQUIRED_INPUT_CONFLICT"
      )
    ).toBe(true);
  });

  it("requires complete, consistent scope evidence before declaring a rule non-applicable", () => {
    const incomplete = compileEngineeringConstraintSet(
      compilationContext([scopeFact("supported_low_voltage_rigid_pcb", false)])
    );
    expect(incomplete.evaluations.every((entry) => entry.applicability === "unresolved")).toBe(
      true
    );

    const complete = compileEngineeringConstraintSet(
      compilationContext(completeScope({ via_carries_current_or_heat: false }))
    );
    const via = complete.evaluations.find(
      (entry) => entry.ruleId === "pcb.via.barrel-resistance-only"
    )!;
    expect(via.applicability).toBe("not_applicable");
    expect(via.falseScopePredicates).toEqual(["via_carries_current_or_heat"]);
    expect(via.gateResults.every((gate) => gate.status === "not_applicable")).toBe(true);
    expect(complete.blockers.some((blocker) => blocker.ruleId === via.ruleId)).toBe(false);
  });

  it("keeps simultaneous fabricator, human, and physical owners external and calculations non-gating", () => {
    const inputs = completeInputs();
    const compiled = compileEngineeringConstraintSet(
      compilationContext(
        completeScope(),
        inputs,
        checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)
      )
    );
    const via = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.via.barrel-resistance-only"
    )!;
    expect(new Set(via.gateResults.map((gate) => gate.owner))).toEqual(
      new Set(["machine", "fabricator", "human", "physical"])
    );
    for (const ruleId of [
      "pcb.trace.hot-resistance-voltage-drop-i2r",
      "pcb.via.barrel-resistance-only"
    ]) {
      const calculation = compiled.evaluations.find((entry) => entry.ruleId === ruleId)!;
      expect(calculation.gateResults.filter((gate) => gate.owner === "machine")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "unresolved",
            code: "ENGINEERING_CHECKER_NON_GATING_EVIDENCE"
          })
        ])
      );
    }
    expect(
      via.gateResults
        .filter((gate) => gate.owner !== "machine")
        .every((gate) => gate.status === "unresolved")
    ).toBe(true);
    expect(
      compiled.evaluations
        .flatMap((entry) => entry.gateResults)
        .some((gate) => gate.owner !== "machine" && gate.status === "pass")
    ).toBe(false);

    const finishedGeometry = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.copper.finished-geometry-fabricator-binding"
    )!;
    expect(finishedGeometry.gateResults).toContainEqual(
      expect.objectContaining({ owner: "machine", status: "pass" })
    );
  });

  it("never accepts a claimed pass for the unavailable licensed IPC-2152 checker", () => {
    const inputs = completeInputs();
    const compiled = compileEngineeringConstraintSet(
      compilationContext(
        completeScope(),
        inputs,
        checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)
      )
    );
    const ampacity = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.trace.ampacity.ipc2152-input-gate"
    )!;
    expect(ampacity.gateResults.filter((gate) => gate.owner === "machine")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unresolved",
          code: "ENGINEERING_CHECKER_UNAVAILABLE"
        })
      ])
    );
  });

  it("rejects unknown checker dispatch IDs before compilation", () => {
    const catalog = cloneCatalog() as any;
    catalog.rules[0].checkerIds = ["parse-machine-check-prose-and-run-it"];
    expect(() =>
      compileEngineeringConstraintSet(compilationContext(), catalog)
    ).toThrow(/unknown checker or model id/iu);

    const inputs = completeInputs();
    const result = checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)[0]!;
    expect(() =>
      compileEngineeringConstraintSet(
        compilationContext(completeScope(), inputs, [
          { ...result, checkerId: "dynamic-eval-v1" } as any
        ])
      )
    ).toThrow(/not allowlisted/iu);
  });

  it("rejects unsourced and contradictory catalog thresholds as integrity errors", () => {
    const unsourced = cloneCatalog() as any;
    const numericRule = unsourced.rules.find(
      (rule: any) => rule.id === "pcb.trace.hot-resistance-voltage-drop-i2r"
    );
    numericRule.numericClaims[0].sourceIds = [];
    expect(() =>
      compileEngineeringConstraintSet(compilationContext(), unsourced)
    ).toThrow(/incomplete or unsourced/iu);

    const contradictory = cloneCatalog() as any;
    const contradictoryRule = contradictory.rules.find(
      (rule: any) => rule.id === "pcb.trace.hot-resistance-voltage-drop-i2r"
    );
    contradictoryRule.numericClaims.push({
      ...contradictoryRule.numericClaims[0],
      value: contradictoryRule.numericClaims[0].value * 2
    });
    expect(() =>
      compileEngineeringConstraintSet(compilationContext(), contradictory)
    ).toThrow(/claim ids must be unique/iu);
  });

  it("fails closed on checker results bound to a different source, limit, model, or input set", () => {
    const inputs = completeInputs();
    const checkerResults = checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs).map(
      (result) =>
        result.ruleId === "pcb.trace.hot-resistance-voltage-drop-i2r"
          ? { ...result, sourceIds: [] }
          : result
    );
    const compiled = compileEngineeringConstraintSet(
      compilationContext(completeScope(), inputs, checkerResults)
    );
    const trace = compiled.evaluations.find(
      (entry) => entry.ruleId === "pcb.trace.hot-resistance-voltage-drop-i2r"
    )!;
    expect(trace.gateResults.filter((gate) => gate.owner === "machine")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "unresolved",
          code: "ENGINEERING_CHECKER_CONTEXT_MISMATCH"
        })
      ])
    );
  });

  it("snapshots an exact closed context before reads and rejects active or non-plain inputs", () => {
    const mutableContext = structuredClone(
      compilationContext(completeScope(), completeInputs())
    ) as any;
    const snapshot = validateAndSnapshotEngineeringConstraintContext(
      mutableContext,
      PCB_ENGINEERING_PRACTICE_CATALOG
    );
    const originalDigest = snapshot.scopeFacts[0]!.identity.digest;
    mutableContext.scopeFacts[0].identity.digest = "0".repeat(64);

    expect(snapshot.scopeFacts[0]!.identity.digest).toBe(originalDigest);
    expect(snapshot).not.toBe(mutableContext);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scopeFacts)).toBe(true);
    expect(Object.isFrozen(snapshot.scopeFacts[0]!.identity)).toBe(true);

    expect(() =>
      validateAndSnapshotEngineeringConstraintContext(
        { ...compilationContext(), unexpected: true },
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toThrow(/unknown fields/iu);
    expect(() =>
      validateAndSnapshotEngineeringConstraintContext(
        compilationContext([
          { ...scopeFact("supported_low_voltage_rigid_pcb", true), unexpected: true } as any
        ]),
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toThrow(/unknown fields/iu);

    let getterReads = 0;
    const accessorContext = {
      schemaVersion: ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA,
      get scopeFacts() {
        getterReads += 1;
        return completeScope();
      },
      inputBindings: [],
      checkerResults: []
    };
    expect(() =>
      compileEngineeringConstraintSet(accessorContext)
    ).toThrow(/must not contain accessors/iu);
    expect(getterReads).toBe(0);

    let proxyReads = 0;
    const proxyContext = new Proxy(compilationContext(), {
      get(target, property, receiver) {
        proxyReads += 1;
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => compileEngineeringConstraintSet(proxyContext)).toThrow(/non-proxy plain/iu);
    expect(proxyReads).toBe(0);

    class NonPlainContext {
      public readonly schemaVersion = ENGINEERING_CONSTRAINT_CONTEXT_SCHEMA;
      public readonly scopeFacts: readonly EngineeringScopeFact[] = [];
      public readonly inputBindings: readonly EngineeringInputBinding[] = [];
      public readonly checkerResults: readonly EngineeringCheckerResult[] = [];
    }
    expect(() => compileEngineeringConstraintSet(new NonPlainContext())).toThrow(
      /plain object or array prototype/iu
    );

    const namedArrayField: any[] = [];
    (namedArrayField as any).unknown = true;
    expect(() =>
      compileEngineeringConstraintSet(
        compilationContext(namedArrayField as EngineeringScopeFact[])
      )
    ).toThrow(/only canonical index fields/iu);

    const noncanonicalIndex: any[] = [];
    Object.defineProperty(noncanonicalIndex, "01", {
      value: scopeFact("supported_low_voltage_rigid_pcb", true),
      enumerable: true,
      configurable: true,
      writable: true
    });
    expect(() =>
      compileEngineeringConstraintSet(
        compilationContext(noncanonicalIndex as EngineeringScopeFact[])
      )
    ).toThrow(/only canonical index fields/iu);
  });

  it("returns a detached deeply frozen constraint set including every identity binding", () => {
    const mutableContext = structuredClone(
      compilationContext(completeScope(), completeInputs())
    ) as any;
    const compiled = compileEngineeringConstraintSet(mutableContext);
    const matched = compiled.evaluations
      .flatMap((evaluation) => evaluation.matchedScopeFacts)
      .find((fact) => fact.predicate === "supported_low_voltage_rigid_pcb")!;
    const originalDigest = matched.identity.digest;
    mutableContext.scopeFacts.find(
      (fact: EngineeringScopeFact) => fact.predicate === "supported_low_voltage_rigid_pcb"
    ).identity.digest = "f".repeat(64);

    expect(matched.identity.digest).toBe(originalDigest);
    expect(Object.isFrozen(compiled)).toBe(true);
    expect(Object.isFrozen(compiled.identity)).toBe(true);
    expect(Object.isFrozen(compiled.scopeFacts)).toBe(true);
    expect(Object.isFrozen(compiled.inputBindings[0]!.identity)).toBe(true);
    expect(Object.isFrozen(compiled.evaluations[0]!.gateResults)).toBe(true);
    expect(Object.isFrozen(compiled.blockers)).toBe(true);
    expect(() => (compiled.blockers as any).pop()).toThrow(TypeError);
  });

  it("trusts a constraint set only when exact catalog and context recompilation byte-match", () => {
    const inputs = completeInputs();
    const context = compilationContext(
      completeScope(),
      inputs,
      checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)
    );
    const compiled = compileEngineeringConstraintSet(context);

    expect(
      validateAndSnapshotEngineeringConstraintSet(
        compiled,
        context,
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toEqual(compiled);
    expect(() =>
      (validateAndSnapshotEngineeringConstraintSet as any)(compiled)
    ).toThrow();

    const forgedNotApplicable = forgeAllRulesNotApplicable(compiled);
    expect(forgedNotApplicable.blockers).toEqual([]);
    expect(() =>
      validateAndSnapshotEngineeringConstraintSet(
        forgedNotApplicable,
        context,
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toThrow(/does not reproduce/iu);

    const forgedAmpacityPass = structuredClone(compiled) as any;
    const ampacity = forgedAmpacityPass.evaluations.find(
      (evaluation: any) => evaluation.ruleId === "pcb.trace.ampacity.ipc2152-input-gate"
    );
    for (const gate of ampacity.gateResults.filter((entry: any) => entry.owner === "machine")) {
      gate.status = "pass";
      gate.code = "ENGINEERING_CHECK_PASSED";
      gate.subjectIds = ["licensed_ipc2152_lookup_required_v1"];
      gate.checkerResultIdentities = context.checkerResults
        .filter((result) => result.ruleId === ampacity.ruleId)
        .map((result) => result.resultIdentity);
    }
    forgedAmpacityPass.blockers = forgedAmpacityPass.blockers.filter(
      (blocker: any) => !(blocker.ruleId === ampacity.ruleId && blocker.owner === "machine")
    );
    rehashConstraintSet(forgedAmpacityPass);
    expect(() =>
      validateAndSnapshotEngineeringConstraintSet(
        forgedAmpacityPass,
        context,
        PCB_ENGINEERING_PRACTICE_CATALOG
      )
    ).toThrow(/does not reproduce/iu);
  });

  it("builds and validates a strict frozen binding carrying every recompilation input", () => {
    const inputs = completeInputs();
    const context = compilationContext(
      completeScope(),
      inputs,
      checkerResultsFor(PCB_ENGINEERING_PRACTICE_CATALOG, inputs)
    );
    const binding = compileEngineeringConstraintBinding(
      context,
      PCB_ENGINEERING_PRACTICE_CATALOG
    );

    expect(binding.schemaVersion).toBe(ENGINEERING_CONSTRAINT_BINDING_SCHEMA);
    expect(binding.catalogSnapshot).not.toBe(PCB_ENGINEERING_PRACTICE_CATALOG);
    expect(binding.contextSnapshot).not.toBe(context);
    expect(binding.catalogIdentity).toEqual(binding.catalogSnapshot.identity);
    expect(binding.contextIdentity).toEqual(binding.compiledConstraintSet.contextIdentity);
    expect(binding.compiledConstraintSetIdentity).toEqual(binding.compiledConstraintSet.identity);
    expect(binding.checkerEvidence.map((entry) => entry.identity)).toEqual(
      binding.contextSnapshot.checkerResults.map((entry) => entry.resultIdentity)
    );
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.catalogSnapshot.rules[0])).toBe(true);
    expect(Object.isFrozen(binding.contextSnapshot.checkerResults)).toBe(true);
    expect(Object.isFrozen(binding.checkerEvidence[0]!.snapshot)).toBe(true);
    expect(validateAndSnapshotEngineeringConstraintBinding(binding)).toEqual(binding);

    const forgedBinding = structuredClone(binding) as any;
    forgedBinding.compiledConstraintSet = forgeAllRulesNotApplicable(
      forgedBinding.compiledConstraintSet
    );
    forgedBinding.compiledConstraintSetIdentity = forgedBinding.compiledConstraintSet.identity;
    const { identity: _identity, ...payload } = forgedBinding;
    forgedBinding.identity = canonicalIdentity(payload, ENGINEERING_CONSTRAINT_BINDING_SCHEMA);
    expect(() => validateAndSnapshotEngineeringConstraintBinding(forgedBinding)).toThrow(
      /does not reproduce/iu
    );
  });
});
