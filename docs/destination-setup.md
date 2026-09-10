# Windows destination setup

The September 9 transfer was restored at `C:\Users\kidch\Documents\EvlEDA-Transfer-2026-09-09`. Work from its `evleda` repository. The old OneDrive checkout is a separate copy.

## Active destination profile

The qualified workspace runs use `C:\EvlEDA-DOC5-20260910` with private sessions/IPC under `C:\EvlEDA-Native-20260910`. This is an ordinary directory, not an alias. Its profile is `../working-profiles/toolbox-native-doc5-destination-short.json`, SHA-256 `d3a5576455655f563bce4539ccf3779cf9f0ce13e75c158b9af2047895488f09`, **5,294 bytes**. The short-path manifest is `../working-profiles/kicad-inspection-runtime-manifest-doc5-short.json`.

Set the explicit runtime pair when checking this active installation:

```powershell
$env:EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT = 'C:\EvlEDA-DOC5-20260910'
$env:EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST = 'C:\Users\kidch\Documents\EvlEDA-Transfer-2026-09-09\working-profiles\kicad-inspection-runtime-manifest-doc5-short.json'
```

The short copy retains 8,467 files / 1,159 directories / 150,420,772 bytes and differs from DOC5 only in `pyvenv.cfg` home. Source-pin and full closure verification passed; both production profile loaders completed in 20.013 seconds, compared with 44.151 seconds for the initial longer path. No integrity check or deadline changed. Relocation evidence is `../working-profiles/doc5-short-relocation.json`; the new loader result is `../working-runtime/load-check-TYJBVT/result.json`.

The Windows session host now creates, binds and rechecks its declared private `AppData/Local` and `AppData/Roaming` directories. Without them, the real CLI version probe tried to create configuration beneath Program Files and emitted warnings; the same isolated probe became silent after those directories existed. The strict empty-stderr policy remains enforced.

The V2 workspace create/author/sync/place/checkpoint/resume flow and a fresh-process read-only resume with native previews passed on this configuration. See [destination verification](destination-verification.md) for exact reports, retained failures and remaining limits. The following longer-path records are preserved relocation history.

## Preserved evidence and active artifacts

The original `runtime/`, `profiles/`, proof directories, and historical `sidecars/*manifest*.json` remain evidence. The destination copy is under `working-runtime/inspection-runtime-3.33.3-doc5`; its new manifest and installation profiles are under `working-profiles/`. Generated session and IPC directories are siblings of the runtime bundle, outside its immutable closure.

The original runtime passed the existing full manifest verifier before copying. The relocated closure has 8,467 files, 1,159 directories and 150,420,847 bytes. Only `environment/pyvenv.cfg` changed, replacing its Python home with this destination's copied `python/`. Python remains 3.13.12, kicad-mcp-pro remains 3.33.3, and KiPy remains 0.7.1. The launcher, terminator and DOC5 transaction repair are unchanged.

The new manifest's file SHA-256 is `d6ffafaa56787ff466de3e6ebe6a851ca96e2854022392f307b82176468924ea`. Its canonical manifest identity is `7a86bbd21e304a8590887f30980b8f1cdf391291871b674e0a5fa19f591855e6`; its tree identity is `fcc95a26fc56ce0a64d931b262de7b1a21f75b9ba0dd0524b49a50e0595ebe97`.

The installed `C:\Program Files\KiCad\10.0\bin\kicad-cli.exe` and `pcbnew.exe` match the original approved file hashes, PE versions, KiCad 10.0.3 and commit `146a4f2a7585c65bc580427a19b6fe2ec4a3f622`. Library roots use that installation's `share/kicad/symbols` and `share/kicad/footprints`. The copied profile's exact symbol/footprint allowlists and deep-rule identities are retained.

## Install and verify

Use Node 24.19.0 and pnpm 11.19.0. The transfer omitted `pnpm-workspace.yaml` and `vitest.config.ts`; both were restored in this destination repository. The workspace file explicitly allows the pinned esbuild install script. The Vitest configuration restores the repository test boundaries and timeouts, including exclusion of Playwright test collection. The actual-KiPy nanometre regression now resolves the destination runtime instead of silently skipping an unavailable old `D:` path.

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

On a **new, not-yet-restored copy** of this transfer, run `pnpm setup:destination` before tests/build. The setup script verifies the original profile, DOC5 manifest, transaction source and lock pins; checks installed KiCad bytes/version/commit; refuses existing destination artifacts; copies and relocates the runtime; then generates and verifies new manifest/profile files. It checks destination ancestors and the 128-byte IPC endpoint limit before copying. A failed setup retains its partial artifacts for inspection; it does not delete or overwrite them. The current destination is already set up, so do not rerun setup against its existing artifacts.

The old package precheck used a hardcoded DOC2 path. `check:kicad-inspection-runtime` now runs `scripts/verify-kicad-inspection-runtime.mjs`. Its defaults are relative to this repository:

- Runtime: `../working-runtime/inspection-runtime-3.33.3-doc5`
- Manifest: `../working-profiles/kicad-inspection-runtime-manifest-doc5.json`

For another approved location, set **both** `EVLEDA_KICAD_INSPECTION_RUNTIME_ROOT` and `EVLEDA_KICAD_INSPECTION_RUNTIME_MANIFEST`, or pass both paths to the verification script. A missing manifest or partial configuration fails. Verification checks the published DOC5 source pins, permits exactly the pyvenv home delta, and invokes the existing full tree/PE/import/.pth/bytecode verifier. Generating a manifest for arbitrary changed runtime files does not satisfy this check. This does not waive the separately pinned profile required for native work.

## Load the profile after building

`deepRules.resourceRoot` points to `dist/resources/deep-pcb-rule-corpus/v1`. Build first, then run both real production profile loaders:

The selected destination profile includes both rebuilt helpers: `../working-profiles/toolbox-native-doc5-destination-helpers.json`, SHA-256 `8444ed17b52e9c9d424df7bef1b63e76177a4d8ecafde8aa0dcc11b4b39e002f`, 5,540 bytes. The original helper-free destination profile remains preserved.

```powershell
node scripts/verify-destination-profile.mjs ../working-profiles/toolbox-native-doc5-destination-helpers.json 8444ed17b52e9c9d424df7bef1b63e76177a4d8ecafde8aa0dcc11b4b39e002f 5540
```

The script requires an explicit profile pin. It verifies approved libraries, the full deep-rule corpus/catalog, runtime closure, CLI identity and any configured helper bindings. It records the result under a new `working-runtime/load-check-*/result.json`. It launches CLI version probes, but no editor, sidecar, model, server or native board session. Load readiness alone does not establish native workflow success.

That initial longer-path profile passed both production loaders on September 10 at 05:09:02 UTC in 44.151 seconds. Evidence: `working-runtime/load-check-D2tWnY/result.json`. Each closure pass retains its existing 30-second absolute deadline. An earlier concurrent-test attempt exceeded a deadline, and later native connection also exposed insufficient headroom. Those failures remain preserved; the active short-path installation above supersedes this profile for destination native work. Keep heavy tests/builds/scans idle during native preflight.

Do not rebuild `dist`, edit a bound profile, or change its native resources while a profile-backed session is active. New native proofs use new project/output directories. Original complete-board artifacts remain unchanged; their old absolute-path checkpoints are not silently rebound.

## Optional analytical helpers

Helper executables were absent from the transfer. The base destination profile deliberately omits their dead old paths. The transmission-line helper can be rebuilt with the included `third_party/kicad-transline-core/build.ps1` and installed MSVC C++17 environment. Reference coverage needs a compiler supporting signed `__int128`; MSVC is unsuitable. Rebuilds belong under `working-helpers/`, and each verified executable receives a new actual hash/size binding in a separate profile. Retain the source-hash checks and native-oracle verification supplied with the helpers.

Both helpers were restored on this destination using the unchanged build scripts:

- `working-helpers/transline-core-msvc/transline-core.exe`: MSVC build; SHA-256 `22367056f1fb5dd98ae929728a2e83e19534f0a471c0ed424b0dde05cec916a1`, 382,976 bytes. Nine bounded protocol/analysis/synthesis/rejection cases passed across all four models. Evidence: `working-helpers/transline-verification/results.json`.
- `working-helpers/reference-coverage-zig/reference-coverage.exe`: vendor-checksummed Zig 0.16.0 build; SHA-256 `11f52b6031a30f0e5a7a4a3a0b4479774df829dc85caf845d97127b2b49c7b62`, 980,480 bytes. All 34 supplied cases and both recorded native-oracle comparisons passed. Evidence: `working-helpers/reference-coverage-verification/identity-summary.json`.

`working-profiles/bind-helpers.mjs` records the exact destination binding procedure, checks the original sidecar lock pin again, and refuses to overwrite its new profile/evidence. `destination-helper-profile.json` records both helper pins and their verification evidence identities. These are installation artifacts outside the source repository and contain machine-specific paths.

This setup does not install a global Codex MCP entry, restore credentials, publish Git changes, qualify a PCB electrically, or authorize manufacturing. Client connection instructions are in [toolbox-client-setup.md](toolbox-client-setup.md).
