import { loadDeepRuleCatalog } from "../../src/harness/deep-rule-catalog.js";
import { PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION, type PcbInterfaceConstruction } from "../../src/harness/pcb-interface-requirements.js";
import { compilePcbPlaneDesignIntentDraft } from "../../src/harness/pcb-design-plane-compiler.js";
import { createPcbPlaneCompilationBundle } from "../../src/harness/pcb-design-plane-bundle.js";
import { genericDividerLibraryResolver } from "./generic-divider-bundle.js";
import { planeDividerDraft } from "./plane-divider-draft.js";

export const constructionAssertion = () => ({ kind: "caller_assertion" as const, reference: "fixture specification rev 1", description: "Synthetic software fixture; no physical verification." });
export const interfaceConstruction = (): PcbInterfaceConstruction => ({ mode: "two_layer", id: "STACK", boardThicknessMm: 1.57,
  frontCopperThicknessMm: 0.035, backCopperThicknessMm: 0.035,
  dielectric: { thicknessMm: 1.5, material: "fixture laminate", relativePermittivity: 4, lossTangent: 0.02, frequencyHz: 100_000_000,
    substrateRelativePermeability: 1, source: constructionAssertion() },
  conductor: { conductivitySiemensPerMetre: 58_000_000, relativePermeability: 1, roughnessNm: 0, source: constructionAssertion() },
  solderMask: { front: { kind: "absent" }, back: { kind: "absent" } }, exterior: { front: "air", back: "air" },
  surfaceFinish: "fixture bare copper", source: constructionAssertion() });

/** Fictional connectivity and values exercise software boundaries, not fabricated hardware. */
export const interfaceConstructionDraft = (): Record<string, any> => {
  const base = planeDividerDraft();
  const point = (reference: string, pin: string) => ({ reference, pin });
  const component = (reference: string) => ({ ...structuredClone(base.components[0]!), reference,
    pins: ["DP", "DN", "GND"].map((net, index) => ({ pin: String(index + 1), assignment: { kind: "net", net } })) });
  const net = (name: string, role: string, pin: string) => ({ name, role,
    electrical: name === "GND" ? base.nets[2]!.electrical : structuredClone(base.nets[0]!.electrical),
    netClassId: name === "GND" ? "POWER" : "SIGNAL", endpoints: [point("J1", pin), point("J2", pin)] });
  const route = (net: string, pin: string) => ({ net, topology: "point_to_point", preferredLayer: "F.Cu", maxVias: 0,
    routeLength: { mode: "unbounded" }, referencePath: { mode: "continuous_plane", planeId: "GND_PLANE", signalLayer: "F.Cu",
      coverageMarginMm: 0.5, layerTransitions: "forbidden", terminalReferences: ["J1", "J2"].map(reference => ({ signalEndpoint: point(reference, pin), referenceEndpoint: point(reference, "3") })) } });
  return { ...base, components: [component("J1"), component("J2")], nets: [net("DP", "interface", "1"), net("DN", "interface", "2"), net("GND", "ground", "3")],
    netClasses: [base.netClasses[0], { ...base.netClasses[0], id: "SIGNAL" }],
    placementConstraints: [base.placementConstraints[0], { ...base.placementConstraints[0], reference: "J2", edgePreference: "right" }],
    routingConstraints: { ...base.routingConstraints, nets: [base.routingConstraints.nets.find(route => route.net === "GND"), route("DP", "1"), route("DN", "2")] },
    interfaceRequirements: { schemaVersion: PCB_INTERFACE_REQUIREMENTS_SCHEMA_VERSION, construction: interfaceConstruction(), interfaces: [{
      id: "LINK", kind: "differential_pair", nets: { positive: "DP", negative: "DN" },
      endpoints: { source: { positive: point("J1", "1"), negative: point("J1", "2") }, receiver: { positive: point("J2", "1"), negative: point("J2", "2") } },
      geometry: { traceWidthMm: { minimumMm: 0.4, maximumMm: 0.6 }, edgeGapMm: { minimumMm: 0.25, maximumMm: 0.5 }, maxEtchLengthMm: 100, maxEtchSkewMm: 2, maxUncoupledLengthMm: 5 },
      routing: { allowedLayers: ["F.Cu"], layerTransitions: "forbidden", stubs: "forbidden", referencePlaneId: "GND_PLANE", polarityInversion: { policy: "forbidden", receiverMapping: "normal" } },
      terminations: { source: { kind: "none", source: constructionAssertion() }, receiver: { kind: "none", source: constructionAssertion() } },
      impedance: { mode: "none" }, source: constructionAssertion(),
    }] },
  };
};
export const constructionDependencies = { libraryResolver: genericDividerLibraryResolver, deepRuleCatalog: loadDeepRuleCatalog() };
export function interfaceConstructionBundle(draft: unknown = interfaceConstructionDraft()) {
  const compilation = compilePcbPlaneDesignIntentDraft(draft, constructionDependencies);
  if (compilation.disposition !== "ready") throw new Error(JSON.stringify(compilation.issues));
  return createPcbPlaneCompilationBundle({ originalPrompt: "Synthetic native construction preparation fixture.", compilation }, constructionDependencies);
}
