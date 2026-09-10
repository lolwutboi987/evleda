# kicad-mcp-pro sidecar notice

EvlEDA invokes `kicad-mcp-pro` as a pinned stdio subprocess sidecar. This repository records local runtime patches and their provenance; it does not contain a complete upstream package source tree.

- Package: `kicad-mcp-pro==3.33.3`
- Upstream repository: <https://github.com/oaslananka/kicad-mcp-pro>
- Audited repository identity: `R_kgDOStXTag`
- Audited commit: `817969d7e302ad470c2cac3d7c20961419400c47`
- Audited `pyproject.toml` version: `3.33.3`
- Python requirement: `>=3.13`
- MCP dependency lane: `mcp[cli]>=1.27.1,<2.0.0`
- License: MIT
- Copyright: Copyright (c) 2026 Osman Aslan

Official PyPI JSON for version 3.33.3 was checked on 2026-09-03:

- `kicad_mcp_pro-3.33.3-py3-none-any.whl` (905,627 bytes): SHA-256 `c26f4dc6e2360375330056864490aab96f30f1d3f1c7d51bc57e42d4f9e4c26f`
- Wheel core metadata: SHA-256 `6bd08b36cb18b43b2584e37d2c6b344254d16b72472ed9e7b5ee7993865184f2`
- `kicad_mcp_pro-3.33.3.tar.gz` (757,540 bytes): SHA-256 `688e54a1f721ca0318d597564c654257dab98c06469870e8e6bb7af2612d4f76`
- Verification endpoint: <https://pypi.org/pypi/kicad-mcp-pro/3.33.3/json>

These hashes identify the published PyPI files. The Git commit above identifies the separately reviewed source tree. PyPI does not cryptographically attest that either published archive was built from that Git commit, so EvlEDA does not treat the commit hash and distribution hashes as interchangeable evidence.

The published-wheel smoke-test launch is exactly:

```text
uvx --from kicad-mcp-pro==3.33.3 kicad-mcp-pro
```

The EvlEDA controller resolves the launcher to an absolute regular file before spawning, binds its SHA-256 and byte size to the session, defaults the sidecar to `readonly`, passes only an allowlisted environment, confines project path arguments, walks every tool-discovery cursor with hard page/tool limits, maintains its own read/write tool allowlists, treats stderr overflow as fatal, requires an isolated working copy for write mode, and permanently rejects upstream manufacturing and release operations. Native candidate exports are performed separately through the identity-bound KiCad 10 CLI adapter and do not constitute manufacturing release.

## Local manifested runtime overlay

The production manifested runtime additionally carries the recorded
`0001-explicit-junction-connectivity` reader patch. Its original file is
byte-identical to `kicad_mcp/tools/schematic.py` in the pinned published wheel;
the executed patched file is a distinct local derivative. The upstream
version, published wheel, metadata, and lock identities above are unchanged
and must not be treated as hashes of the patched runtime.

The exact diff, original/patched hashes, recorded upstream base identity,
scope, and regression fixture are in
[`sidecars/patches`](../../sidecars/patches/README.md). The complete runtime
manifest and current production profile bind the resulting executed bytes.
The patch retains the upstream MIT license and copyright above.

## Upstream MIT license

MIT License

Copyright (c) 2026 Osman Aslan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
