# Reference source manifest and private cache

`manifest.json` inventories the official source records used by the deterministic reference
design. It is safe to distribute as metadata: it contains URLs, retrieval sizes and digests,
source revisions, subject facts, and component MPN bindings.

The `blobs/` directory is an internal evidence cache of copyrighted vendor documents, so this
repository does not grant redistribution permission. Public distributions must omit `blobs/`;
package builders ship the manifest only. A cache directory may exist locally for a user who has
permission to retrieve the source documents, but it must not be committed or packaged.

USB4105 land geometry has a different boundary: it is sourced solely from the openly accessible
official KiCad footprint at commit `f6d77c54d79275c888daae4c60e4c9869ffa4aa5`, raw-file SHA-256
`3b8d7da3cae5114ec83022a759a78925113bc2eeec100ea447594f6d8687e4b8`, under CC BY-SA 4.0.
The manifest records it as `public-pinned-external`; the project does not bundle the upstream bytes
or depend on any restricted manufacturer drawing. Deterministic tests bind the compiled pad/hole
coordinates to that public footprint. They do not qualify connector fit or mechanical mating.

## Verification

From a source checkout:

```text
python -m backend.evidence.reference_sources
```

The verifier is fail-closed. A wheel or plugin with no private cache reports the missing source
bytes rather than silently treating the manifest as verified. Set
`EVLEDA_REFERENCE_EVIDENCE_ROOT` to the directory containing the manifest's relative
`blobs/<sha256>.<extension>` paths, or pass `content_root=` to `verify_manifest` from Python:

```powershell
$env:EVLEDA_REFERENCE_EVIDENCE_ROOT = 'C:\private\evleda-evidence'
python -c "from backend.evidence.reference_sources import verify_manifest; print(verify_manifest())"
```

An explicit `content_root` argument takes precedence over the environment variable. With neither,
the verifier checks beside the selected manifest, which is the source-checkout layout and produces
an actionable missing-bytes error in a blob-free install.

## Permissioned fetch

Only manifest entries with `retention_status: "verified"` and a non-empty `content_path` are
eligible. `manifest-only-unverified` and `public-pinned-external` entries are never fetched, even
if their URLs are reachable or a modified manifest gives them a path. The command validates the
checked-in SourceEvidence
identity, requires HTTPS, permits only same-host HTTPS redirects (at most three by default),
enforces a bounded response size, checks exact `Content-Length`/stream length and SHA-256, and
uses exclusive content-addressed writes. Existing exact blobs are reused; an existing mismatched
blob is an error and is never overwritten.

From a source checkout:

```text
python scripts/fetch_reference_sources.py --output-dir C:\private\evleda-evidence
```

The installed command name is `evleda-fetch-reference-sources`. Use `--manifest` only to select
the checked-in manifest for the installation, and use `--max-bytes`, `--timeout`, or
`--max-redirects` to tighten (never bypass) the retrieval bounds. The command does not fetch
manifest-only, public-pinned-external, or historical source records.
