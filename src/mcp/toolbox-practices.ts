import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalIdentity, sha256 } from "../core/canonical.js";
import { analyzeKicadPcbPractices, extractKicadPcbTurnGeometry, validateAndSnapshotPcbPracticeAnalysisProfile,
  type PcbPracticeAnalysisProfile } from "../integrations/pcb-practice-analyzer.js";

/** Floating-point comparison only; not an engineering allowance for non-45-degree routing. */
export const TOOLBOX_TURN_NUMERICAL_TOLERANCE_DEG = 1e-7;

/** Bind once from owning-host state. The returned callback accepts no model-selected path or policy. */
export async function createToolboxPracticeAnalyzer(input: {
  readonly pcbPath: string;
  readonly profile?: PcbPracticeAnalysisProfile;
}) {
  const requested = path.resolve(input.pcbPath);
  const boundPath = await realpath(requested);
  const profile = input.profile === undefined ? undefined : validateAndSnapshotPcbPracticeAnalysisProfile(input.profile);
  if (profile !== undefined && profile.sourceValidation.mode !== "production") throw new Error("Toolbox practice profile must validate production PCB source.");
  const inspect = async () => {
    const metadata = await lstat(requested);
    if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(requested) !== boundPath
        || path.extname(boundPath).toLowerCase() !== ".kicad_pcb") throw new Error("Bound PCB source is no longer the exact ordinary host-selected file.");
    if (metadata.size > 64 * 1024 * 1024) throw new Error("Bound PCB source exceeds the practice analysis byte boundary.");
  };
  await inspect();
  return async () => {
    await inspect();
    const bytes = await readFile(boundPath);
    const sourceIdentity = { algorithm: "sha256" as const, digest: sha256(bytes), size: bytes.length };
    const geometry = extractKicadPcbTurnGeometry(bytes, boundPath);
    const analysis = profile === undefined ? null : analyzeKicadPcbPractices(bytes, profile, { sourcePath: boundPath });
    const violations = geometry.turns.filter(turn => ![0, 45].some(allowed => Math.abs(turn.directionChangeDeg - allowed) <= TOOLBOX_TURN_NUMERICAL_TOLERANCE_DEG));
    const unresolvedFindings = geometry.findings.filter(finding => !["RIGHT_ANGLE_TURN_ADVISORY", "CONNECTED_REVERSAL_CANDIDATE"].includes(finding.code));
    await inspect();
    if (!bytes.equals(await readFile(boundPath))) throw new Error("Bound PCB source changed during practice analysis; discard this result and retry.");
    return {
      schemaVersion: "evleda.toolbox-practices.v1", sourcePath: boundPath, sourceIdentity,
      reviewedProfileIdentity: profile === undefined ? null : canonicalIdentity(profile, profile.schemaVersion),
      analysis, geometry,
      turnPolicy: { allowedDirectionChangesDeg: [0, 45], numericalToleranceDeg: TOOLBOX_TURN_NUMERICAL_TOLERANCE_DEG,
        measuredTurnCount: geometry.turns.length, violations, unresolvedFindings,
        coverage: "Recognized degree-two same-net same-layer straight-segment endpoints only; other geometry is not proven compliant.",
        unresolvedNetSegmentCount: geometry.unresolvedNetSegmentCount },
      checks: { literalTurnGeometry: "measured-subset", reviewedProfileConstraints: profile === undefined ? "unverified-no-profile" : "see-original-analysis-findings",
        widthAndNetClass: profile === undefined ? "unverified-no-profile" : "bound-profile-only; unbound nets remain unverified",
        vias: profile === undefined ? "unverified-no-profile" : "bound-profile-only; unbound via rules remain unverified",
        electricalSuitability: "unverified", manufacturingReadiness: "unverified" },
      limitations: [...geometry.limitations, ...(analysis?.limitations ?? []),
        "Zero direction change means a straight continuation; 180 degrees means reversal and is not permitted. Overlaps may prevent sequential-turn inference.",
        "No automatic design acceptance: original findings and incomplete coverage remain authoritative.",
        "Reviewed numerical width/via/net-class constraints do not supply current, voltage, temperature rise, impedance or fabricator qualification evidence."],
    };
  };
}
