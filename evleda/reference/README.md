# Packaged reference runtime

This directory contains the generated, immutable KiCad project used by the
installed EvlEDA MCP inspection and optional native-verification profile.
It contains no cached vendor PDF, HTML, or drawing source blobs.

`manifest.json` is canonical JSON. Its exact SHA-256 is pinned in
`runtime.py`; it in turn binds the ZIP byte-for-byte and binds every ZIP member
by portable path, media type, byte length, and SHA-256. The loader never
extracts the archive.

The project is a review example, **not a manufacturing release**. Rebuilding it
from raw source evidence is a separate, explicit maintainer operation.
