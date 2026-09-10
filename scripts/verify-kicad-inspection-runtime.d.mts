export interface Doc5Manifest {
  files: { path: string; sha256: string; sizeBytes: number; mode: number }[];
  directories: { path: string; mode: number }[];
  totalBytes: number;
  protocol: { serverVersion: string };
  python: { version: string };
  treeIdentity: { digest: string };
  [key: string]: unknown;
}
export const repositoryRoot: string;
export const doc5ManifestSha256: string;
export const doc5ProvenanceSha256: string;
export const originalRuntimeRoot: string;
export function sha256(bytes: string | Uint8Array): string;
export function pyvenvText(root: string): string;
export function readDoc5Source(): Promise<Doc5Manifest>;
export function assertDoc5Relocation(original: Doc5Manifest, candidate: Doc5Manifest, root: string): void;
export function resolveRuntimeCheckPaths(args?: string[], env?: Record<string, string | undefined>, repo?: string): { root: string; manifest: string };
export function runManifestHelper(mode: "build" | "verify", root: string, manifest: string, finalRoot?: string): Promise<unknown>;
export function verifyRuntime(paths: { root: string; manifest: string }): Promise<unknown>;
