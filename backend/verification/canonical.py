"""Canonical serialization and domain-separated evidence hashing.

Authoritative verification data deliberately excludes timestamps, random IDs,
floating-point values, and unordered containers. This makes a verification run
reproducible on every supported host for the same normalized inputs.
"""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from enum import Enum
import hashlib
import json
from typing import Any, Mapping


class CanonicalizationError(ValueError):
    """Raised when a value cannot be represented deterministically."""


def canonical_data(value: Any) -> Any:
    """Convert *value* into the deterministic JSON value subset.

    Floats and sets are intentionally rejected. PCB geometry is represented in
    integer nanometres, so accepting floats here would silently weaken the
    cross-platform reproducibility contract.
    """

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        raise CanonicalizationError("floating-point values are not canonical")
    if isinstance(value, Enum):
        return canonical_data(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: canonical_data(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, Mapping):
        converted: dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str):
                raise CanonicalizationError("canonical mapping keys must be strings")
            converted[key] = canonical_data(value[key])
        return converted
    if isinstance(value, (tuple, list)):
        return [canonical_data(item) for item in value]
    if isinstance(value, (set, frozenset)):
        raise CanonicalizationError("sets are not canonical; sort into a tuple first")
    raise CanonicalizationError(f"unsupported canonical value: {type(value).__name__}")


def canonical_json_bytes(value: Any) -> bytes:
    """Serialize *value* as minimal UTF-8 canonical JSON."""

    return json.dumps(
        canonical_data(value),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def stable_hash(value: Any, *, domain: str) -> str:
    """Return a SHA-256 hash isolated to the supplied schema domain."""

    if not domain or "\x00" in domain:
        raise ValueError("hash domain must be a non-empty NUL-free string")
    digest = hashlib.sha256()
    digest.update(domain.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(canonical_json_bytes(value))
    return digest.hexdigest()

