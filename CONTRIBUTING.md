# Contributing to EvlEDA

EvlEDA welcomes narrowly scoped changes that preserve its evidence and
authority boundaries. Open an issue before a large architecture or file-format
change.

## Setup

```sh
python -m venv .venv
python -m pip install -e .
python -m pytest -q
```

Python 3.12+ is required. Native KiCad tests require a separately installed
KiCad 10; skipped native tests are not passing evidence. The public repository
has no JavaScript workspace, browser application, HTTP service, or network
listener.

## Release-static analysis

Run `python scripts/check_release_static.py` before changing shipped Python
code.  It is the exact bounded static-analysis gate used by pull-request and
tag-release CI: packaged `evleda`, the supported MCP host and its runtime
dependencies, the fixed-reference compiler/manufacturing/evidence paths,
cloud and release/archive scripts, and their focused tests.  The authoritative
path list and rationale live in that script and `pyright.release.json`.
Historical browser/HTTP prototypes are deliberately outside this repository
and distribution. The supported client boundary is a local stdio subprocess
launched by Codex or Claude Code.

## Pull request expectations

- Explain the user-visible behavior and threat/safety impact.
- Add deterministic tests for new behavior and failure paths.
- Preserve exact units, stable ordering, closed schemas, and fail-closed parsing.
- Do not give a model, caller-supplied receipt, or filename implicit authority.
- Bind side effects and evidence to exact project/revision/input identities.
- Keep KiCad operations isolated, bounded, shell-free, and source-preserving.
- Update public status and limitations; do not imply production readiness.
- Include the commands run and distinguish skips from passes.

## Evidence compatibility

Existing `flux-clone-*` hash domains and the `FluxGenerated` library ID are
frozen compatibility identifiers. Do not mechanically rename them. A change
requires a versioned migration, dual-reader tests where appropriate, updated
golden evidence, and a documented invalidation boundary.

Do not edit retained primary-source blobs or their manifest to make a test pass.
Add new provenance explicitly and preserve historical content addressing.

## Hardware changes

For schematic, BOM, footprint, placement, routing, stackup, or CAM changes,
include:

- primary-source component/footprint evidence;
- electrical and geometric rationale with tolerances;
- canonical audit and compiler/reparse results;
- KiCad ERC/DRC on an isolated exact copy;
- updated visual review artifacts;
- an explicit list of remaining qualification blockers.

No pull request may describe a generated CAM candidate as production-ready
without the separate physical qualification and release process.

## Security reports

Do not disclose vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

By contributing, you agree that original software/documentation contributions
are licensed under [Apache-2.0](LICENSE) and hardware/example contributions
under [CERN-OHL-P-2.0](LICENSES/CERN-OHL-P-2.0.txt), as identified by the
repository licenses and notices.
