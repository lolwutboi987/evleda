"""Closed canonical serialization for sealed approval-ledger records."""

from __future__ import annotations

import json
import re
from dataclasses import fields
from datetime import UTC, datetime
from typing import Any, cast

from backend.canonical_import import CanonicalImportTransactionInput
from backend.design_kernel import CommandKind, DesignCommand
from backend.design_kernel.model import canonical_json

from .models import (
    AuthorizedImportStagingInput,
    HumanMappingApproval,
    ImportApprovalIntegrityError,
    ImportApprovalScope,
    MappingApprovalRequest,
    MappingDecision,
    ReviewManifest,
    ReviewQuestionAnswer,
)

_TYPES: dict[str, type[Any]] = {
    cls.__name__: cls
    for cls in (
        DesignCommand,
        CanonicalImportTransactionInput,
        ReviewQuestionAnswer,
        ReviewManifest,
        MappingApprovalRequest,
        HumanMappingApproval,
        AuthorizedImportStagingInput,
    )
}
_ENUMS: dict[str, type[Any]] = {
    cls.__name__: cls
    for cls in (
        CommandKind,
        MappingDecision,
        ImportApprovalScope,
    )
}
_TYPE_NAMES: dict[type[Any], str] = {cls: name for name, cls in _TYPES.items()}
_ENUM_NAMES: dict[type[Any], str] = {cls: name for name, cls in _ENUMS.items()}
_FIELD_DESCRIPTORS: dict[tuple[type[Any], str], Any] = {
    (cls, field.name): cls.__dict__[field.name]
    for cls in _TYPE_NAMES
    for field in fields(cls)
}
_UTC_TEXT = re.compile(
    r"[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z"
)


def _field_value(value: object, cls: type[Any], name: str) -> object:
    """Read a captured slot descriptor without caller-controlled dispatch."""

    descriptor = _FIELD_DESCRIPTORS[(cls, name)]
    return descriptor.__get__(value, cls)


def _encode(value: Any) -> Any:
    value_type: type[object] = type(cast(object, value))
    if value_type is datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ImportApprovalIntegrityError("cannot persist a naive approval timestamp")
        return {
            "$datetime": value.astimezone(UTC)
            .isoformat(timespec="microseconds")
            .replace("+00:00", "Z")
        }
    if value_type in _ENUM_NAMES:
        name = _ENUM_NAMES[value_type]
        if name not in _ENUMS:
            raise ImportApprovalIntegrityError("approval record contains an unknown enum")
        return {"$enum": name, "value": object.__getattribute__(value, "_value_")}
    if value is None or value_type in {bool, int, str}:
        return value
    if value_type is tuple:
        return {"$tuple": [_encode(item) for item in value]}
    if value_type in _TYPE_NAMES:
        name = _TYPE_NAMES[value_type]
        return {
            "$type": name,
            "fields": {
                field.name: _encode(_field_value(value, value_type, field.name))
                for field in fields(cast(Any, value_type))
            },
        }
    if value_type is dict and all(type(key) is str for key in value):
        return {key: _encode(item) for key, item in value.items()}
    raise ImportApprovalIntegrityError(
        f"approval record contains unsupported value {type(value).__name__}"
    )


def _decode(value: Any) -> Any:
    value_type: type[object] = type(cast(object, value))
    if value is None or value_type in {bool, int, str}:
        return value
    if value_type is list:
        raise ImportApprovalIntegrityError("approval record contains an untagged array")
    if value_type is not dict:
        raise ImportApprovalIntegrityError("approval record contains an invalid value")
    if not all(type(key) is str for key in value):
        raise ImportApprovalIntegrityError("approval record keys are not exact strings")
    mapping = cast(dict[str, Any], value)
    if set(mapping) == {"$datetime"}:
        raw = mapping["$datetime"]
        if type(raw) is not str or _UTC_TEXT.fullmatch(raw) is None:
            raise ImportApprovalIntegrityError("approval timestamp is invalid")
        try:
            parsed = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=UTC
            )
        except ValueError as exc:
            raise ImportApprovalIntegrityError("approval timestamp is invalid") from exc
        if (
            parsed.isoformat(timespec="microseconds").replace("+00:00", "Z")
            != raw
        ):
            raise ImportApprovalIntegrityError("approval timestamp is not canonical UTC")
        return parsed
    if set(mapping) == {"$tuple"}:
        items = mapping["$tuple"]
        if type(items) is not list:
            raise ImportApprovalIntegrityError("approval tuple encoding is invalid")
        return tuple(_decode(item) for item in cast(list[Any], items))
    if set(mapping) == {"$enum", "value"}:
        enum_name = mapping["$enum"]
        if type(enum_name) is not str or enum_name not in _ENUMS:
            raise ImportApprovalIntegrityError("approval enum type is invalid")
        try:
            return _ENUMS[enum_name](mapping["value"])
        except (TypeError, ValueError) as exc:
            raise ImportApprovalIntegrityError("approval enum value is invalid") from exc
    if set(mapping) == {"$type", "fields"}:
        type_name = mapping["$type"]
        encoded_fields = mapping["fields"]
        if (
            type(type_name) is not str
            or type_name not in _TYPES
            or type(encoded_fields) is not dict
        ):
            raise ImportApprovalIntegrityError("approval record type is invalid")
        encoded_fields = cast(dict[str, Any], encoded_fields)
        cls = _TYPES[type_name]
        expected_fields = {field.name for field in fields(cls)}
        if set(encoded_fields) != expected_fields:
            raise ImportApprovalIntegrityError(
                f"approval record fields for {type_name} are not exact"
            )
        try:
            return cls(
                **{
                    name: _decode(encoded_fields[name])
                    for name in expected_fields
                }
            )
        except Exception as exc:
            if type(exc) is ImportApprovalIntegrityError:
                raise
            raise ImportApprovalIntegrityError(
                f"approval record body for {type_name} is invalid"
            ) from exc
    return {key: _decode(item) for key, item in mapping.items()}


def record_json(payload: dict[str, Any]) -> str:
    return canonical_json(_encode(payload))


def decode_record_json(source: str) -> dict[str, Any]:
    if type(source) is not str:
        raise ImportApprovalIntegrityError(
            "approval ledger record source must be an exact string"
        )
    try:
        raw = json.loads(source)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise ImportApprovalIntegrityError("approval ledger record is invalid JSON") from exc
    if canonical_json(raw) != source:
        raise ImportApprovalIntegrityError("approval ledger record is not canonical JSON")
    decoded = _decode(raw)
    if type(decoded) is not dict:
        raise ImportApprovalIntegrityError("approval ledger record is not an object")
    return cast(dict[str, Any], decoded)


__all__ = ("decode_record_json", "record_json")
