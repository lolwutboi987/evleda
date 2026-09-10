export interface VerifyBundleOptions {
  readonly allowLegacyV1?: boolean;
  readonly allowLegacyV2?: boolean;
  readonly expectedRevisionManifest?: string;
  readonly expectedEvidenceRoot?: string;
}

export interface VerifiedBundle {
  readonly assurance:
    | "byte_integrity_only"
    | "provenance_roots"
    | "provenance_roots_without_live_policy";
  readonly bundleKind: "candidate" | "prototype";
  readonly lifecycle: "candidate" | "qualified";
  readonly projectId: string;
  readonly runId: string;
  readonly designRevisionId: string;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly revisionManifestDigest?: string;
  readonly evidenceRootDigest?: string;
}

export function canonicalJsonV1(value: unknown): string;
export function deterministicIdV1(prefix: string, value: unknown): string;
export function verifyBundle(
  inputPath: string,
  options?: VerifyBundleOptions
): Promise<VerifiedBundle>;
