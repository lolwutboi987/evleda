# KiCad transmission-line calculation core

Source-only package for the demonstrated headless helper. It preserves original KiCad 10.0.3 sources and builds one explicitly patched coupled-stripline copy. It is not a new field solver, does not operate KiCad editors, and does not establish manufactured controlled-impedance compliance.

## Provenance and licenses

Upstream commit: `146a4f2a7585c65bc580427a19b6fe2ec4a3f622` (KiCad 10.0.3).

Source: https://github.com/KiCad/kicad-source-mirror/tree/146a4f2a7585c65bc580427a19b6fe2ec4a3f622/common/transline_calculations

The twelve source/header files in `upstream/transline_calculations` are byte-identical to the isolated prototype's pinned downloads. `upstream/LICENSE`, `upstream/LICENSE.README`, and `upstream/LICENSE.GPLv3` were fetched from the same upstream commit. `source-hashes.json` records SHA256 values for all fifteen upstream files. Original copyright and license headers are retained. These calculation files permit GPL-2.0-or-later; this wrapper chooses GPL-3.0-or-later, with the full GPLv3 text included. Preserve the applicable notices and corresponding-source obligations when distributing a derived helper.

`main.cpp` protocol-2 wrapper SHA256 is `A0685E4E9865D60183181D5795B76436A948DF7F5224FFEE0B3E79F8E92C2CAB`. No executable, compiler archive or compiler cache is included in this package. The host executable at `D:/EvlEDA-transmission-line-core-v3-20260909/transline-core.exe` is SHA256 `EA24EFD0A7C1582A54928B33DD5710293674170A20A3E10BDE010038EB15BDBB`; this identifies that artifact, not a promise that another compiler or build path produces identical bytes. The previous protocol-1 prototype and its evidence remain unchanged in their original directory.

## Audited vendor deviation

Implementation revision: `evleda-stripline-corrections-v1`. `patches.json` records the original and patched file hashes. The build uses `patched/coupled_stripline.cpp` instead of its original counterpart, after verifying its SHA256. Original source bytes and `source-hashes.json` remain unchanged.

The first calculation-source change is the STRIPLINE_A assignment inside `COUPLED_STRIPLINE::calcZ0SymmetricStripline`: `H/2` becomes `(H-T)/2`. STRIPLINE_A is upper clearance, so a finite-thickness conductor centered in plane spacing H requires this subtraction. The native single-stripline implementation evaluates distances `2*A+T` and `2*(H-A)-T`; these are equal at `(H-T)/2`, not `H/2`. At T/H=0.07 and S/H=10 the corrected coupled odd/even modes approach 52.90024527996 ohm, the centered single-stripline value. This is a geometry consistency correction, not proof of physical accuracy.

Unmodified file SHA256: `A35C802BDD7289792828D11DE32339AC9F149BBE2AA6E601566DA3613C773745`. Intermediate centered-only file SHA256: `633D22D8284B24A94868010B699E4839E538C0CB3086D144CD0978C0BA78507B`. Final two-correction file SHA256: `683FA25D85758C1335EABFCEB2B4F181A8E491E8BF04D26D8480C74F12F9DF9C`. Both deviations are scoped to coupled stripline; the other three calculation implementations are unchanged.

The second change corrects homogeneous-dielectric normalization in the Eq.22 odd-mode branch. It reads local `er=GetParameter(EPSILONR)`, changes the fringe admittance to `-2*(Cf_t/E0-Cf_0/E0)/(ZF0*sqrt(er))`, and the gap admittance to `2*t*sqrt(er)/(ZF0*s)`. All admittance terms then scale with sqrt(er), preserving the original air formula at er=1. Independent peer review of code, algebra and scaling approved this narrow correction before promotion. This is not a blanket validation of every formula or material geometry.

**Remaining branch limitation:** the original hard selection at S/T=5 between Eq.20 and Eq.22 remains. Their piecewise estimates can be discontinuous there, so the inverse problem can have multiple candidate geometries or a gap in achievable values. Native synthesis may converge to a different branch/geometry or fail; reanalysis and residual checks do not establish uniqueness. Do not claim that every branch-boundary or synthesis-matrix case passes. Preserve this warning for coupled-stripline synthesis and reject results that violate the requested geometry/branch constraints.

## Build with a host-selected compiler

`build.ps1` verifies upstream hashes and compiles the wrapper plus five implementation files. Supply the compiler executable, driver family, and an output directory outside this source package. Nothing is downloaded, installed or added to PATH. The compiler may use its own existing cache. An MSVC invocation requires a caller-configured environment with SDK headers and libraries; the script does not modify that environment.

Example using the already verified isolated Zig compiler:

```powershell
pwsh -NoProfile -File ./build.ps1 -Compiler 'D:/EvlEDA-transmission-line-core-20260909/compiler/zig-x86_64-windows-0.16.0/zig.exe' -Driver zig -OutputDirectory 'D:/EvlEDA-transmission-line-core-package-build-20260909'
```

Supported driver conventions are `zig` (`zig c++`), `gnu` (GCC or clang-style C++ command), and `msvc` (`cl`). Only the isolated Zig 0.16.0 prototype build has been demonstrated; MSVC2019 was present but its Windows SDK/UCRT headers were missing. The required Windows math constants are supplied through `_USE_MATH_DEFINES`, not a source patch. The compiler must provide C++17 and standard libraries. These instructions reproduce the source build procedure, not bit-identical executable output across toolchains.

## Scope and parameters

Invocation: `transline-core.exe --model MODEL --operation analyze|synthesize [--fix width|spacing] NAME=value ...`.

The four models are `microstrip`, `coupled_microstrip`, `stripline`, `coupled_stripline`. Required scalar parameters:

| Applies to | Required parameters |
|---|---|
| All four | EPSILONR, H, T, PHYS_WIDTH, PHYS_LEN, FREQUENCY, SIGMA, MURC |
| Microstrip variants | H_T, ROUGH, TAND |
| Single microstrip | MUR |
| Coupled variants | PHYS_S |
| Single stripline | STRIPLINE_A, TAND |
| Single synthesis | Z0 target; single microstrip also ANG_L |
| Coupled synthesis | Z0_O target and --fix width or spacing |

Dimensions are SI meters, frequency Hz, conductivity SIGMA S/m, angular length ANG_L radians, relative permittivity/permeability dimensionless, impedance ohms. Native output delays are ps/cm and losses dB. H is microstrip substrate height or stripline plane separation. STRIPLINE_A is the distance from upper reference plane to conductor upper surface. PHYS_S is edge spacing. H_T is the native cover-height input, not a solder-mask definition.

`--fix width` holds width and synthesizes gap. `--fix spacing` holds gap and synthesizes width. Both width and gap are provided as starting geometry. The coupled target is **odd-mode impedance**: to target frequency-dependent 90 ohm differential impedance, supply Z0_O=45. No physical defaults are inserted. All required inputs are positive except ROUGH, TAND, PHYS_LEN and ANG_L may be zero; EPSILONR must be at least one. This wrapper deliberately rejects zero copper thickness.

Example single-line analysis (explicit prototype inputs, not an approved fabrication stackup):

```powershell
./transline-core.exe --model microstrip --operation analyze EPSILONR=4.2 H=0.0002 T=0.000035 PHYS_WIDTH=0.0003 PHYS_LEN=0.01 FREQUENCY=1000000000 SIGMA=58000000 MURC=1 H_T=1 ROUGH=0 TAND=0.02 MUR=1
```

## Output and synthesis verification

Calculation stdout is one JSON object with `schemaVersion:2`, `implementationRevision:"evleda-stripline-corrections-v1"`, `sourceCommit`, `model`, `operation`, `converged`, `valid`, `inputs` and `results`. Inputs map parameter names to `{value,unit}`; results map names to `{value,status,unit}`. Status is `ok`, `warning` or `error`. Nonfinite results are encoded as null/error. Results include analyzed or synthesized PHYS_WIDTH and coupled PHYS_S. Input exceptions produce only stderr and exit 1.

After native synthesis the wrapper always calls Analyse again: some native synthesis paths restore requested impedance fields, so reporting those directly could confuse the requested target with the achieved result. The actual odd/single impedance residual must be <=1e-4 ohm for a valid synthesized result. Exit 0 means valid; exit 2 means nonconvergence, nonfinite/error result or excessive synthesis residual; exit 1 means input/calculation exception, with diagnostic stderr. Warnings remain visible but do not force exit 2. Analysis reports converged=true because synthesis was not requested.

**Native differential distinction:** coupled_microstrip's native Z_DIFF uses twice its static odd-mode impedance, while returned Z0_O includes frequency dispersion. Preserve that native result as quasistatic. Derive frequency-dependent differential impedance explicitly as `2 * Z0_O`. At the demonstrated 1 GHz odd-target45 case, returned Z0_O was 45.00000005739253 and native Z_DIFF was 90.0824971611539. They are not interchangeable fields.

**Native delay approximation retained:** the shared `UnitPropagationDelay` implementation uses 2.99e8 m/s, while native phase calculations use C0=299792458 m/s. Consequently native UNIT_PROP_DELAY outputs retain an approximately +0.265036% difference from an otherwise identical exact-C0 calculation. This revision does not change that constant or relabel those outputs as exact phase-derived delay.

## Evidence and limitations

The original isolated protocol-1 executable completed fourteen analysis/synthesis calls across all models: four analysis cases, four width roundtrips, two gap roundtrips, and four 50-ohm single/45-ohm odd target syntheses. Missing-input rejection also passed. That evidence remains in `D:/EvlEDA-transmission-line-core-20260909/verification-results.json`; it is historical evidence for the unpatched implementation, not a substitute for separate protocol-2 validation.

No dedicated numerical reference fixtures were located in the pinned official KiCad tree. Roundtrip consistency proves inversion for those inputs, not external absolute accuracy or manufactured tolerance. Independent numerical review is separate from these package identity checks. Positive-domain validation is not a complete applicability-range guard; the analytical models have published geometry/frequency/material limits. Callers must apply those limits and bound execution.

The models describe uniform transmission lines. Coupled stripline is symmetric; single stripline includes a conductor offset. Arbitrary multilayer/mask-coated dielectrics, finite/discontinuous grounds and via launches are not covered. Supply verified cross-section/material data, restrict models to applicable geometry, and reanalyze after rounding dimensions to fabrication limits. Do not infer these inputs from unqualified DOC3 stackup defaults.
