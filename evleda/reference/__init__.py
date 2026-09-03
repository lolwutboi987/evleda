"""Verified, immutable reference-project resources shipped with EvlEDA."""

from .runtime import (
    PACKAGED_REFERENCE_MANIFEST_SHA256,
    PackagedReference,
    PackagedReferenceError,
    load_packaged_reference,
    validate_packaged_reference_payloads,
)

__all__ = (
    "PACKAGED_REFERENCE_MANIFEST_SHA256",
    "PackagedReference",
    "PackagedReferenceError",
    "load_packaged_reference",
    "validate_packaged_reference_payloads",
)
