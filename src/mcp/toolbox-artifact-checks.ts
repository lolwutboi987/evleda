import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { FRESH_PLANE_ARTIFACT_CHECKS_VERSION, type FreshPlaneArtifactAssessment } from "../harness/fresh-plane-artifact-checks.js";
import { sanitizePcbDiagnosticText } from "./toolbox-interface-report.js";

const need: (value: unknown, why: string) => asserts value = (value, why) => { if (!value) throw new Error(`Artifact projection: ${why}`); };
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const keys = (value: object, expected: readonly string[]) => need(same(Object.keys(value).sort(), [...expected].sort()), "missing or unexpected fields");
const text = (s: string) => { need(typeof s === "string" && s.length <= 4096, "bounded text required"); return sanitizePcbDiagnosticText(s); };
const canonical = (id: CanonicalIdentity) => {
  keys(id, ["algorithm","digest","schemaVersion","canonicalizationVersion"]);
  need(id.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(id.digest) && id.canonicalizationVersion === "evleda-c14n-json-v1", "canonical identity");
  return { algorithm: id.algorithm, digest: id.digest, schemaVersion: text(id.schemaVersion), canonicalizationVersion: id.canonicalizationVersion };
};
const content = (id: ContentIdentity) => { keys(id,["algorithm","digest","size"]); need(id.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(id.digest) && Number.isSafeInteger(id.size) && id.size >= 0 && id.size <= 16*1024*1024,"content identity");return {algorithm:id.algorithm,digest:id.digest,size:id.size}; };
const count = (n: number) => { need(Number.isSafeInteger(n) && n >= 0 && n <= 512,"bounded count");return n; };
const dimension = (n: number | null) => { need(n === null || Number.isFinite(n) && n >= 0 && n <= 100,"bounded configured dimension");return n; };
const sorted = (a: readonly string[]) => [...a].sort();
export function summarizePlaneArtifactChecks(value: FreshPlaneArtifactAssessment,
  originalRows: readonly { readonly id: string; readonly kind: string; readonly status: string; readonly reasons: readonly string[] }[], nativeClearanceVerified: boolean) {
  keys(value,["schemaVersion","group","bundleIdentity","contractIdentity","libraryBindingIdentity","verificationPlanIdentity","hostScopeIdentity","sourceIdentities","rows","components","netClasses","evidence","accepted","electricalSuitabilityEvaluated","fabricationAuthorized","identity"]);
  const { identity, ...payload } = value;
  need(value.schemaVersion === FRESH_PLANE_ARTIFACT_CHECKS_VERSION && ["components","netclasses"].includes(value.group)
    && value.accepted === false && value.electricalSuitabilityEvaluated === false && value.fabricationAuthorized === false
    && same(identity,canonicalIdentity(payload,value.schemaVersion)),"identity or scope mismatch");
  const expected = originalRows.filter(row => value.group === "components" ? ["library","schematic","pcb_component"].includes(row.kind) : row.id.startsWith("netclass:"));
  need(value.rows.length <= 1024 && new Set(value.rows.map(r=>r.id)).size === value.rows.length && same(sorted(value.rows.map(r=>r.id)),sorted(expected.map(r=>r.id))),"original row inventory differs");
  const rows = value.rows.map(r=>{
    keys(r,["id","kind","status","reasons","requiresNativeClearance"]);
    const original = expected.find(e=>e.id===r.id)!;
    need(original.kind===r.kind && ["pass","fail","unknown"].includes(r.status) && r.requiresNativeClearance===r.id.startsWith("board-feature:"),"row scope differs");
    const effective = r.requiresNativeClearance && r.status === "pass" && !nativeClearanceVerified ? "unknown" : r.status;
    need(original.status===effective,"original verdict differs from qualified artifact scope");
    return {id:text(r.id),kind:r.kind,sourceStatus:r.status,status:original.status,requiresNativeClearance:r.requiresNativeClearance,reasons:original.reasons.map(text)};
  });
  need(value.components.length<=64 && value.netClasses.length<=32,"bounded facts inventory");
  const components = value.components.map(c=>{
    keys(c,["reference","symbolLibraryId","footprintLibraryId","value","pinCount","physicalPadCount","logicalTerminalCount","nonElectricalFeatureCount","libraryPhysicalInventoryIdentity"]);
    for(const n of[c.pinCount,c.physicalPadCount,c.logicalTerminalCount,c.nonElectricalFeatureCount])count(n);
    need(c.physicalPadCount>=c.logicalTerminalCount+c.nonElectricalFeatureCount,"inconsistent physical inventory");
    if(value.rows.find(r=>r.id===`pcb:${c.reference}`)?.status==='pass')need(c.pinCount===c.logicalTerminalCount,"passing PCB lacks every logical terminal");
    return {reference:text(c.reference),symbolLibraryId:text(c.symbolLibraryId),footprintLibraryId:text(c.footprintLibraryId),value:text(c.value),pinCount:c.pinCount,
      physicalPadCount:c.physicalPadCount,logicalTerminalCount:c.logicalTerminalCount,nonElectricalFeatureCount:c.nonElectricalFeatureCount,libraryPhysicalInventoryIdentity:canonical(c.libraryPhysicalInventoryIdentity)};
  });
  const netClasses=value.netClasses.map(c=>{
    keys(c,["id","nativeName","assignedNets","traceWidthMm","classClearanceMm","boardMinimumClearanceMm","effectiveMinimumClearanceMm"]);
    need(c.assignedNets.length<=128&&new Set(c.assignedNets).size===c.assignedNets.length,"class assignment inventory");
    if(value.rows.find(r=>r.id===`netclass:${c.id}`)?.status==='pass')need(c.nativeName!==null&&c.traceWidthMm!==null&&c.classClearanceMm!==null
      && c.effectiveMinimumClearanceMm===Math.max(c.boardMinimumClearanceMm,c.classClearanceMm),"passing class lacks configured dimensions");
    return {id:text(c.id),nativeName:c.nativeName===null?null:text(c.nativeName),assignedNets:c.assignedNets.map(text),traceWidthMm:dimension(c.traceWidthMm),
      classClearanceMm:dimension(c.classClearanceMm),boardMinimumClearanceMm:dimension(c.boardMinimumClearanceMm),effectiveMinimumClearanceMm:dimension(c.effectiveMinimumClearanceMm)};
  });
  need(value.group==='components'?netClasses.length===0&&same(sorted(components.map(c=>`library:${c.reference}`)),sorted(value.rows.filter(r=>r.kind==='library').map(r=>r.id)))
    :components.length===0&&same(sorted(netClasses.map(c=>`netclass:${c.id}`)),sorted(value.rows.map(r=>r.id))),"facts omit or add required components/classes");
  const sources=value.sourceIdentities;keys(sources,["pcb","schematic","project","rules","symbolLibraryTable","footprintLibraryTable"]);
  const e=value.evidence;keys(e,["nativePadObservationIdentity","nativeNetlistBindingIdentity","schematicLibraryGeometryIdentity","netClassAuthorityIdentity","powerAnnotationCount","derivedPowerPathCount"]);
  const evidence={nativePadObservationIdentity:e.nativePadObservationIdentity===null?null:content(e.nativePadObservationIdentity),
    nativeNetlistBindingIdentity:e.nativeNetlistBindingIdentity===null?null:canonical(e.nativeNetlistBindingIdentity),
    schematicLibraryGeometryIdentity:e.schematicLibraryGeometryIdentity===null?null:canonical(e.schematicLibraryGeometryIdentity),
    netClassAuthorityIdentity:e.netClassAuthorityIdentity===null?null:canonical(e.netClassAuthorityIdentity),powerAnnotationCount:count(e.powerAnnotationCount),derivedPowerPathCount:count(e.derivedPowerPathCount)};
  need(value.group==='components'?evidence.nativePadObservationIdentity!==null&&evidence.nativeNetlistBindingIdentity!==null&&evidence.schematicLibraryGeometryIdentity!==null&&evidence.netClassAuthorityIdentity===null
    :evidence.nativePadObservationIdentity===null&&evidence.nativeNetlistBindingIdentity===null&&evidence.schematicLibraryGeometryIdentity===null&&evidence.netClassAuthorityIdentity!==null,"evidence scope differs");
  return {schemaVersion:value.schemaVersion,group:value.group,identity:canonical(identity),bundleIdentity:canonical(value.bundleIdentity),contractIdentity:canonical(value.contractIdentity),
    libraryBindingIdentity:canonical(value.libraryBindingIdentity),verificationPlanIdentity:canonical(value.verificationPlanIdentity),hostScopeIdentity:canonical(value.hostScopeIdentity),
    sourceIdentities:{pcb:content(sources.pcb),schematic:content(sources.schematic),project:content(sources.project),rules:content(sources.rules),symbolLibraryTable:content(sources.symbolLibraryTable),footprintLibraryTable:content(sources.footprintLibraryTable)},
    rows,components,netClasses,evidence,accepted:false,electricalSuitabilityEvaluated:false,fabricationAuthorized:false};
}
