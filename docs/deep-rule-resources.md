# Packaged deep PCB rule resource

The deep PCB guidance is an application resource, not a workspace lookup. The
source tree is:

`resources/deep-pcb-rule-corpus/v1/`

A server build copies the same tree to:

`dist/resources/deep-pcb-rule-corpus/v1/`

`deep-rule-catalog.ts` resolves that directory relative to its own installed
module. It never searches `process.cwd()`, a parent workspace, or an ancestor
`docs/` directory. This makes source execution and a relocated `dist/` tree
behave the same way and prevents a nearby shadow catalog from being selected.

## Bound corpus

- Resource identity:
  `sha256:e3c7e2b0653c61d56125ce2d8aa7967a77a9446c941a86c8ca4b87d0d9c6698b`
- Raw catalog SHA-256:
  `351a484ddd0914dc1cc7672a9804ad18c1402ec81345df7cab308822ba3b76b9`
- Raw manifest SHA-256:
  `5cab3b1dcca8eaa284bf21dd0d4007aafbecf8c162de723608ef5a8cfc1e2cd9`
- Catalog: 1,773 operational rules
- Evidence records: 17 canonical dossiers
- Manifest-bound files: 22, excluding the manifest itself

The bound files include the exact JSON catalog, every dossier, the guide index,
the Markdown retrieval library, the original catalog generator, and the
resource notice. The dossiers retain the source links, evidence grades,
conflicts, scope limits, and licensed-standard warnings used to derive the
rules. Linked third-party works are not copied into the application; see
`RESOURCE-NOTICE.md` inside the resource.

`resource-manifest.json` binds every resource path, role, byte length, and
SHA-256. Its resource identity is computed from canonical JSON over the catalog
metadata and sorted file records. The application profile binds that identity,
and the current loader separately pins the raw manifest and catalog hashes.
Changing a resource file and rewriting its manifest therefore still fails; a
new reviewed corpus version requires an intentional code-and-profile update.

## Loader API

For the checked-in/source or installed/dist resource:

```ts
const verified = loadDeepRuleResource();
const catalog = verified.catalog;
```

`loadDeepRuleResource()` returns the catalog plus the resource identity, raw
catalog hash, resolved catalog path, manifest path, and immutable profile.
`loadDeepRuleCatalog()` is the convenience form when only the validated catalog
value is needed.

Production composition may instead bind a relocated copy explicitly:

```ts
const profile = createDeepRuleResourceProfile(
  absoluteResourceDirectory,
  PACKAGED_DEEP_RULE_RESOURCE_IDENTITY
);
const catalog = loadDeepRuleCatalog(profile);
```

The explicit directory must be absolute. Passing an arbitrary catalog file or
a CWD-relative directory is not supported. Keep the profile outside provider
prompt data; compilation binds the validated catalog value and its canonical
identity separately.

Loading requires the resource root and every descendant to be an ordinary,
canonical non-link directory or file. Junction, symlink, reparse, and
noncanonical roots or descendants fail closed. The loader compares both the
exact file set and the exact directory closure derived from manifest paths, so
an unmanifested empty or nested directory also fails. It additionally rejects
missing, extra, malformed, or byte-drifted resources and checks the exact rule
and dossier counts, per-dossier hashes and line counts, every rule's exact
source span, every GFM heading anchor, and each dossier's index URL/hash entry.

## Build and verification

Run with the repository-pinned Node 24.19.0 toolchain:

```text
pnpm check:deep-rule-resources
pnpm typecheck
pnpm test
pnpm build
```

The build verifies the source tree before TypeScript compilation, replaces only
the bounded dist resource directory, verifies the copied tree, and runs an
actual relocated-dist smoke test from a clean working directory containing a
malicious shadow catalog. `pnpm start` verifies the dist tree before starting
the server. The ordinary check runner also verifies the source tree.

Tests additionally cover an explicit relocated profile, missing dossier,
catalog/dossier tampering, manifest rewriting, extra in-tree shadow catalog,
unmanifested empty and nested directories, root and descendant junctions, and
source/dist module-relative path resolution. The compiled relocated-dist smoke
test repeats the directory and junction checks against the packaged loader.

## Updating the corpus

A corpus change is a reviewed version change, not an untracked content edit:

1. Update the canonical dossiers while preserving their source ledgers and
   license/access boundaries.
2. Regenerate the catalog, retrieval library, and index with the packaged
   generator.
3. Recalculate every bound file hash/length and the resource identity.
4. Review the catalog/dossier/source-span/anchor diff and vendor-scope gates.
5. Update the manifest and the expected identity constants in both the runtime
   loader and build verifier.
6. Run all verification commands above from a clean checkout and exercise a
   relocated `dist/` tree.

Do not loosen the identity or hash checks to accept drift. Create a new resource
version when source meaning changes.

## Engineering and release boundary

Packaging does not elevate evidence. JLCPCB or other vendor numerical values
remain vendor-, date-, service-, stackup-, and job-scoped. Missing design
inputs remain `UNKNOWN` or blocked, and current datasheets, the selected
fabricator/assembler, licensed standards where applicable, physical testing,
and accountable engineering review retain authority. Loading, selecting, or
rendering these rules never authorizes fabrication, manufacturing, ordering,
compliance, safety, qualification, or release.
