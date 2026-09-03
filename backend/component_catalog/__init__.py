"""Digest-pinned trusted component catalog boundary."""

from .resolver import (
    AmbiguousCatalogMatch,
    CatalogDigestMismatch,
    CatalogError,
    CatalogPin,
    CatalogRecord,
    CatalogSnapshot,
    InvalidCatalog,
    PinnedCatalogResolver,
    catalog_pin_map_sha256,
)

__all__ = [
    "AmbiguousCatalogMatch",
    "CatalogDigestMismatch",
    "CatalogError",
    "CatalogPin",
    "CatalogRecord",
    "CatalogSnapshot",
    "InvalidCatalog",
    "PinnedCatalogResolver",
    "catalog_pin_map_sha256",
]
