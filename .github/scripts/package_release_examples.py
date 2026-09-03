"""Fail-closed assembly of the two curated, non-release hardware ZIPs.

This is intentionally not a directory walker.  A tag build may only attach
the two files named and hash-bound by examples/reference_usb_c_3v3_r2/
release-assets.json; generated outputs and private evidence are unreachable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path
from typing import NoReturn, cast

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE = ROOT / "examples" / "reference_usb_c_3v3_r2"
MANIFEST_NAME = "release-assets.json"
EXPECTED = {
    "evleda-reference-usb-c-3v3-r2-source.zip": "deterministic-kicad-source-package",
    "evleda-reference-usb-c-3v3-r2-cam-candidate.zip": "non-release-cam-candidate",
}
PREVIEW = "preview.png"
README = "README.md"
OUTPUT_DIRECTORY = ROOT / "release-assets"


def fail(message: str) -> NoReturn:
    raise SystemExit(f"release asset packaging failed: {message}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_manifest() -> list[object]:
    path = EXAMPLE / MANIFEST_NAME
    if not path.is_file():
        fail(f"missing curated manifest: {path.relative_to(ROOT)}")
    try:
        payload: object = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"invalid JSON in {path.relative_to(ROOT)}: {exc}")
    required = {"schema_version", "project", "manufacturing_release_eligible", "assets"}
    if not isinstance(payload, dict):
        fail("manifest has an unexpected shape")
    manifest = cast(dict[str, object], payload)
    if set(manifest) != required:
        fail("manifest has an unexpected shape")
    assets = manifest["assets"]
    if (
        manifest["schema_version"] != 1
        or manifest["project"] != "reference-usb-c-3v3-r2"
        or manifest["manufacturing_release_eligible"] is not False
        or not isinstance(assets, list)
    ):
        fail("manifest has an invalid release-boundary declaration")
    # JSON starts as an untrusted object.  Preserve that boundary until each
    # individual asset is validated by ``validate_asset`` below.
    return list(assets)


def validate_asset(asset: object) -> tuple[str, Path]:
    if not isinstance(asset, dict):
        fail("each asset declaration must be an object")
    required = {"filename", "byte_length", "sha256", "kind"}
    if set(asset) != required:
        fail(f"asset declaration must contain exactly: {', '.join(sorted(required))}")
    filename = asset["filename"]
    kind = asset["kind"]
    size = asset["byte_length"]
    digest = asset["sha256"]
    allowed = set(EXPECTED) | {PREVIEW}
    if not isinstance(filename, str) or filename not in allowed:
        fail("asset filename is not an approved curated example file")
    expected_kind = "review-preview" if filename == PREVIEW else EXPECTED[filename]
    if kind != expected_kind:
        fail(f"asset {filename} has the wrong kind")
    if type(size) is not int or size <= 0:
        fail(f"asset {filename} has an invalid size")
    invalid_digest = (
        not isinstance(digest, str)
        or len(digest) != 64
        or any(ch not in "0123456789abcdef" for ch in digest)
    )
    if invalid_digest:
        fail(f"asset {filename} has an invalid SHA-256")
    path = EXAMPLE / filename
    if path.is_symlink() or not path.is_file() or path.resolve().parent != EXAMPLE.resolve():
        fail(f"asset {filename} must be a regular file directly in the curated example directory")
    if path.stat().st_size != size:
        fail(f"asset {filename} size does not match its manifest")
    if sha256(path) != digest:
        fail(f"asset {filename} SHA-256 does not match its manifest")
    return filename, path


def prepare_output(output: Path) -> None:
    """Prepare only the one dedicated, disposable release directory.

    Refusing arbitrary children prevents a command-line typo from deleting a
    checkout, a source directory, or Git metadata. Existing output may contain
    only files this script itself owns; even those are unlinked individually.
    """

    if output != OUTPUT_DIRECTORY or output.is_symlink():
        fail("--out must be exactly the repository release-assets directory")
    if not output.exists():
        output.mkdir()
        return
    if not output.is_dir():
        fail("release-assets exists but is not a directory")
    allowed = set(EXPECTED) | {PREVIEW, README, MANIFEST_NAME}
    present = {child.name for child in output.iterdir()}
    if not present <= allowed:
        fail("refusing to clean release-assets with unexpected contents")
    for child in output.iterdir():
        if child.is_dir() or child.is_symlink():
            fail("release-assets must contain regular files only")
        child.unlink()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()
    assets = load_manifest()
    if len(assets) != len(EXPECTED) + 1:
        fail("manifest must declare exactly two ZIPs and one preview")
    validated = [validate_asset(asset) for asset in assets]
    if {name for name, _ in validated} != set(EXPECTED) | {PREVIEW}:
        fail("manifest files do not match the fixed curated release contract")
    output = arguments.out.absolute()
    prepare_output(output)
    by_name = dict(validated)
    for filename in sorted(EXPECTED) + [PREVIEW]:
        shutil.copyfile(by_name[filename], output / filename)
    readme = EXAMPLE / README
    if readme.is_symlink() or not readme.is_file():
        fail("curated example README must be a regular file")
    shutil.copyfile(readme, output / README)
    shutil.copyfile(EXAMPLE / MANIFEST_NAME, output / MANIFEST_NAME)
    print("packaged exactly two curated non-release release assets")


if __name__ == "__main__":
    main()
