"""Canonical encoding used by layout-validation evidence.

The validator accepts only integer engineering quantities.  Rejecting floats,
sets, bytes, and implicit object stringification is intentional: a replay proof
must hash identically on every supported host.
"""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from enum import Enum
import hashlib
import json
from typing import Any, Mapping


class CanonicalizationError(ValueError):
    """Raised when a value has no deterministic JSON representation."""


def canonical_data(value: Any) -> Any:
    """Return *value* in the deterministic JSON value subset."""

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        raise CanonicalizationError("floating-point values are forbidden")
    if isinstance(value, Enum):
        return canonical_data(value.value)
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: canonical_data(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, Mapping):
        output: dict[str, Any] = {}
        for key in sorted(value):
            if not isinstance(key, str):
                raise CanonicalizationError("mapping keys must be strings")
            output[key] = canonical_data(value[key])
        return output
    if isinstance(value, (tuple, list)):
        return [canonical_data(item) for item in value]
    if isinstance(value, (set, frozenset)):
        raise CanonicalizationError("sets are forbidden; use a sorted tuple")
    raise CanonicalizationError(f"unsupported value: {type(value).__name__}")


def canonical_json_bytes(value: Any) -> bytes:
    """Encode *value* as minimal canonical UTF-8 JSON."""

    return json.dumps(
        canonical_data(value),
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def stable_hash(value: Any, *, domain: str) -> str:
    """Return a domain-separated SHA-256 digest for *value*."""

    if not domain or "\x00" in domain:
        raise ValueError("domain must be non-empty and NUL-free")
    digest = hashlib.sha256()
    digest.update(domain.encode("utf-8"))
    digest.update(b"\x00")
    digest.update(canonical_json_bytes(value))
    return digest.hexdigest()
