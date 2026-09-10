import { describe, expect, it } from "vitest";
import { makeDemoSnapshot } from "./demo";
import type { ArtifactRecord, EvidenceRecord } from "./model";
import { hasCurrentPassingPhysicalV2Evidence } from "./model";

const physicalFixture = (): {
  readonly revisionId: string;
  readonly artifacts: readonly ArtifactRecord[];
  readonly evidence: readonly EvidenceRecord[];
} => {
  const snapshot = makeDemoSnapshot();
  const revisionId = "revision-physical-v2";
  const base = snapshot.artifacts[0]!;
  const tool = {
    name: "human-physical-evidence",
    version: "2",
    adapter: "human"
  };
  const raw: ArtifactRecord = {
    ...base,
    id: "artifact-physical-raw",
    designRevisionId: revisionId,
    stage: "bringup_package",
    logicalName: "physical-sources.zip",
    mediaType: "application/zip",
    validationStatus: "pass",
    lifecycle: "candidate",
    tool
  };
  const parsed: ArtifactRecord = {
    ...raw,
    id: "artifact-physical-parsed",
    logicalName: "physical-record.json",
    mediaType: "application/json"
  };
  const record: EvidenceRecord = {
    ...snapshot.evidence[0]!,
    id: "evidence-physical-v2",
    designRevisionId: revisionId,
    stage: "bringup_package",
    evidenceClass: "human_physical",
    validationStatus: "pass",
    lifecycle: "candidate",
    tool,
    rawArtifactId: raw.id,
    parsedArtifactId: parsed.id,
    validUntil: "2099-01-01T00:00:00.000Z"
  };
  return { revisionId, artifacts: [raw, parsed], evidence: [record] };
};

describe("physical-v2 qualification precheck", () => {
  it("requires the exact current passing v2 evidence and both linked artifacts", () => {
    const fixture = physicalFixture();
    expect(
      hasCurrentPassingPhysicalV2Evidence(
        fixture.evidence,
        fixture.artifacts,
        fixture.revisionId,
        new Date("2026-09-04T00:00:00.000Z")
      )
    ).toBe(true);

    expect(
      hasCurrentPassingPhysicalV2Evidence(
        fixture.evidence,
        fixture.artifacts.slice(1),
        fixture.revisionId,
        new Date("2026-09-04T00:00:00.000Z")
      )
    ).toBe(false);
    expect(
      hasCurrentPassingPhysicalV2Evidence(
        [{ ...fixture.evidence[0]!, validUntil: "2020-01-01T00:00:00.000Z" }],
        fixture.artifacts,
        fixture.revisionId,
        new Date("2026-09-04T00:00:00.000Z")
      )
    ).toBe(false);
    expect(
      hasCurrentPassingPhysicalV2Evidence(
        [{ ...fixture.evidence[0]!, validationStatus: "waived" }],
        fixture.artifacts,
        fixture.revisionId,
        new Date("2026-09-04T00:00:00.000Z")
      )
    ).toBe(false);
  });

  it("fails closed when any physical record for the head is stale or invalid", () => {
    const fixture = physicalFixture();
    expect(
      hasCurrentPassingPhysicalV2Evidence(
        [
          ...fixture.evidence,
          { ...fixture.evidence[0]!, id: "evidence-stale", staleAt: "2026-09-04T00:00:00.000Z" }
        ],
        fixture.artifacts,
        fixture.revisionId,
        new Date("2026-09-04T01:00:00.000Z")
      )
    ).toBe(false);
  });
});
