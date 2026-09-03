"""Canonical encoding used by requests, evidence, manifests, and revisions."""

from __future__ import annotations

from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from enum import Enum
import hashlib
import json
from typing import Any, Mapping

from .errors import InvalidRequest


def canonical_data(value: Any) -> Any:
    """Convert supported values into deterministic JSON data.

    Floats and arbitrary object serialization are deliberately rejected. PCB
    geometry must use integer nanometres and callers cannot smuggle executable
    objects through an outcome-level contract.
    """

    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        raise InvalidRequest("floating-point values are forbidden; use integer units")
    if isinstance(value, Enum):
        return canonical_data(value.value)
    if isinstance(value, datetime):
        if value.tzinfo is None or value.utcoffset() is None:
            raise InvalidRequest("timestamps must be timezone-aware")
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: canonical_data(getattr(value, field.name))
            for field in fields(value)
        }
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise InvalidRequest("canonical object keys must be strings")
        return {key: canonical_data(value[key]) for key in sorted(value)}
    if isinstance(value, (tuple, list)):
        return [canonical_data(item) for item in value]
    raise InvalidRequest(f"unsupported canonical value type: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        canonical_data(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def stable_digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def revision_digest(value: Any) -> str:
    return f"rev_{stable_digest(value)}"
