import { canonicalIdentity, canonicalJson } from "../core/canonical.js";
import type { FreshPlanePlacementAssessment } from "../harness/fresh-plane-placement-checks.js";
import { sanitizePcbDiagnosticText } from "./toolbox-interface-report.js";

const check = (v: unknown, why: string): void => { if (!v) throw new Error(`Placement projection: ${why}`); };
const integer = (n: number) => { check(Number.isSafeInteger(n), "integer geometry"); return n; };
const text = (s: string) => { check(typeof s === "string", "text"); return sanitizePcbDiagnosticText(s); };
const box = (b: NonNullable<FreshPlanePlacementAssessment["rows"][number]["observations"]["courtyardNm"]>) => {
  const value = { minX: integer(b.minX), minY: integer(b.minY), maxX: integer(b.maxX), maxY: integer(b.maxY) };
  check(value.minX < value.maxX && value.minY < value.maxY, "positive box area"); return value;
};
export function summarizePlanePlacementChecks(value: FreshPlanePlacementAssessment,
  expectedRows: readonly { readonly id: string; readonly kind: string; readonly status: string; readonly reasons: readonly string[] }[]) {
  const { identity, ...payload } = value;
  check(value.schemaVersion === "evleda.fresh-plane-placement-checks.v1" && value.scope === "exact-cardinal-front-placement-with-approved-courtyard-enclosures"
    && value.assemblyClearanceClaimed === false && value.accepted === false && canonicalJson(identity) === canonicalJson(canonicalIdentity(payload, value.schemaVersion)), "identity or scope");
  check(value.rows.length <= 64 && new Set(value.rows.map(r => r.reference)).size === value.rows.length
    && canonicalJson(value.rows.map(r => r.id).sort()) === canonicalJson(expectedRows.filter(r => r.kind === "placement").map(r => r.id).sort()), "complete placement inventory");
  const refs = value.rows.map(r => r.reference);
  const rows = value.rows.map(r => {
    const expected = expectedRows.find(e => e.id === r.id), o = r.observations;
    check(r.id === `placement:${r.reference}` && r.kind === "placement" && ["pass","fail","unknown"].includes(r.status)
      && expected?.status === r.status && canonicalJson(expected.reasons) === canonicalJson(r.reasons), "original row status differs");
    check(typeof o.libraryCourtyardMatched === "boolean" && [true,false,null].includes(o.rectangularCourtyard)
      && [o.sideMatches,o.regionMatches,o.rotationMatches,o.edgePreferenceMatches].every(v => [true,false,null].includes(v)), "placement facts");
    check(["none","left","right","top","bottom"].includes(o.edgePreference), "edge preference");
    check(integer(o.minimumEdgeClearanceNm) >= 0, "edge floor");
    const poseNm = o.poseNm === null ? null : { x: integer(o.poseNm.x), y: integer(o.poseNm.y), rotationDeg: integer(o.poseNm.rotationDeg) };
    if (poseNm !== null) check([0,90,180,270].includes(poseNm.rotationDeg), "cardinal angle");
    const courtyardNm = o.courtyardNm === null ? null : box(o.courtyardNm);
    const edgeClearancesNm = o.edgeClearancesNm === null ? null : { left: integer(o.edgeClearancesNm.left), right: integer(o.edgeClearancesNm.right),
      top: integer(o.edgeClearancesNm.top), bottom: integer(o.edgeClearancesNm.bottom) };
    check(canonicalJson(o.pairs.map(p => p.reference).sort()) === canonicalJson(refs.filter(x => x !== r.reference).sort()), "pair inventory");
    const pairs = o.pairs.map(p => {
      check(["pass","fail","unknown"].includes(p.status) && integer(p.requiredNm) >= 0 && [true,false,null].includes(p.interiorsOverlap), "pair facts");
      if (p.distanceSquaredNm2 === null) check(p.distanceBasis === null && p.status === "unknown" && p.interiorsOverlap === null, "unmeasured pair claim");
      else {
        check(/^(?:0|[1-9][0-9]{0,63})$/u.test(p.distanceSquaredNm2) && ["exact-rectangles","conservative-enclosures"].includes(p.distanceBasis!), "distance evidence");
        const d = BigInt(p.distanceSquaredNm2), required = BigInt(p.requiredNm) ** 2n;
        if (p.status === "pass") check(p.interiorsOverlap === false && d >= required, "false pair pass");
        if (p.status === "fail") check(p.distanceBasis === "exact-rectangles" && (p.interiorsOverlap === true || d < required), "conservative bounds cannot invent a failure");
      }
      const reverse = value.rows.find(r => r.reference === p.reference)?.observations.pairs.find(x => x.reference === r.reference);
      check(reverse !== undefined && canonicalJson({ ...reverse, reference: p.reference }) === canonicalJson(p), "asymmetric pair evidence");
      return { reference: text(p.reference), requiredNm: p.requiredNm, distanceSquaredNm2: p.distanceSquaredNm2,
        distanceBasis: p.distanceBasis, interiorsOverlap: p.interiorsOverlap, status: p.status };
    });
    if (r.status === "pass") check(poseNm !== null && courtyardNm !== null && o.libraryCourtyardMatched && o.sideMatches && o.regionMatches && o.rotationMatches
      && o.edgePreferenceMatches && edgeClearancesNm !== null && Object.values(edgeClearancesNm).every(n => n >= o.minimumEdgeClearanceNm)
      && pairs.every(p => p.status === "pass"), "incomplete placement pass");
    return { id: text(r.id), kind: r.kind, reference: text(r.reference), status: r.status, reasons: r.reasons.map(text),
      observations: { poseNm, courtyardNm, libraryCourtyardMatched: o.libraryCourtyardMatched, rectangularCourtyard: o.rectangularCourtyard,
        sideMatches: o.sideMatches, regionMatches: o.regionMatches, rotationMatches: o.rotationMatches, edgeClearancesNm,
        minimumEdgeClearanceNm: o.minimumEdgeClearanceNm, edgePreference: o.edgePreference, edgePreferenceMatches: o.edgePreferenceMatches, pairs } };
  });
  const canonical = (v: typeof identity) => ({ algorithm: v.algorithm, digest: v.digest, schemaVersion: v.schemaVersion, canonicalizationVersion: v.canonicalizationVersion });
  return { schemaVersion: value.schemaVersion, identity: canonical(identity), bundleIdentity: canonical(value.bundleIdentity), contractIdentity: canonical(value.contractIdentity),
    verificationPlanIdentity: canonical(value.verificationPlanIdentity), libraryBindingIdentity: canonical(value.libraryBindingIdentity),
    pcbIdentity: { algorithm: value.pcbIdentity.algorithm, digest: value.pcbIdentity.digest, size: value.pcbIdentity.size }, rows,
    scope: value.scope, assemblyClearanceClaimed: false, accepted: false };
}
