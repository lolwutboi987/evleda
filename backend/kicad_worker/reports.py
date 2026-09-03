"""Closed KiCad 10 ERC/DRC JSON parsing and deterministic normalization."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import cast

from backend.mcp_gateway import canonical_json

_ERC_SCHEMA = "https://schemas.kicad.org/erc.v1.json"
_DRC_SCHEMA = "https://schemas.kicad.org/drc.v1.json"
_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?$")
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
_UUID_PATH = re.compile(
    r"^/(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
    r"(?:/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})*$"
)
_TYPE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_SEVERITIES = frozenset({"error", "warning", "exclusion"})


class KiCadReportError(ValueError):
    """A KiCad output did not match the pinned closed report contract."""


@dataclass(frozen=True, slots=True)
class ParsedCheckReport:
    check: str
    findings: tuple[dict[str, object], ...]
    ignored_checks: tuple[dict[str, object], ...]
    normalized_report: dict[str, object]
    raw_sha256: str

    def __post_init__(self) -> None:
        if type(self) is not ParsedCheckReport:
            raise TypeError("parsed reports must use the exact ParsedCheckReport type")
        if self.check not in {"erc", "drc"}:
            raise ValueError("parsed report check is invalid")
        if type(self.findings) is not tuple or any(
            type(item) is not dict for item in self.findings
        ):
            raise TypeError("parsed findings must be an exact dictionary tuple")
        if type(self.ignored_checks) is not tuple or any(
            type(item) is not dict for item in self.ignored_checks
        ):
            raise TypeError("parsed ignored checks must be an exact dictionary tuple")
        if type(self.normalized_report) is not dict:
            raise TypeError("normalized report must be an exact dictionary")
        if not re.fullmatch(r"[0-9a-f]{64}", self.raw_sha256):
            raise ValueError("raw report digest is invalid")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise KiCadReportError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> object:
    raise KiCadReportError(f"non-finite JSON constant: {value}")


def _closed(value: object, *, label: str, keys: frozenset[str]) -> dict[str, object]:
    if type(value) is not dict:
        raise KiCadReportError(f"{label} must be an object")
    result = cast(dict[str, object], value)
    if frozenset(result) != keys:
        missing = ", ".join(sorted(keys - frozenset(result))) or "none"
        unknown = ", ".join(sorted(frozenset(result) - keys)) or "none"
        raise KiCadReportError(
            f"{label} has invalid keys; missing: {missing}; unknown: {unknown}"
        )
    return result


def _array(value: object, label: str) -> list[object]:
    if type(value) is not list:
        raise KiCadReportError(f"{label} must be an array")
    return cast(list[object], value)


def _text(value: object, label: str, *, allow_empty: bool = False) -> str:
    if type(value) is not str:
        raise KiCadReportError(f"{label} must be text")
    if value != value.strip() or (not value and not allow_empty):
        raise KiCadReportError(f"{label} must be trimmed and non-empty")
    if any(ord(character) < 32 for character in value):
        raise KiCadReportError(f"{label} contains a control character")
    return value


def _position_nm(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise KiCadReportError(f"{label} must be a finite JSON number")
    try:
        scaled = Decimal(value) * Decimal(1_000_000)
    except InvalidOperation as exc:
        raise KiCadReportError(f"{label} cannot be converted to integer nanometres") from exc
    integral = scaled.to_integral_value()
    if scaled != integral:
        raise KiCadReportError(f"{label} has sub-nanometre precision")
    result = int(integral)
    if not -(1 << 63) <= result < (1 << 63):
        raise KiCadReportError(f"{label} exceeds signed 64-bit nanometres")
    return result


def _ignored(value: object, label: str) -> tuple[dict[str, object], ...]:
    result: list[dict[str, object]] = []
    for index, item in enumerate(_array(value, label)):
        record = _closed(
            item,
            label=f"{label}[{index}]",
            keys=frozenset({"description", "key"}),
        )
        key = _text(record["key"], f"{label}[{index}].key")
        if _TYPE.fullmatch(key) is None:
            raise KiCadReportError(f"{label}[{index}].key is not stable syntax")
        result.append(
            {
                "description": _text(
                    record["description"], f"{label}[{index}].description"
                ),
                "key": key,
            }
        )
    if len({cast(str, item["key"]) for item in result}) != len(result):
        raise KiCadReportError(f"{label} contains duplicate keys")
    return tuple(sorted(result, key=canonical_json))


def _items(value: object, label: str) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for index, item in enumerate(_array(value, label)):
        record = _closed(
            item,
            label=f"{label}[{index}]",
            keys=frozenset({"description", "pos", "uuid"}),
        )
        position = _closed(
            record["pos"],
            label=f"{label}[{index}].pos",
            keys=frozenset({"x", "y"}),
        )
        uuid = _text(record["uuid"], f"{label}[{index}].uuid")
        if _UUID.fullmatch(uuid) is None:
            raise KiCadReportError(f"{label}[{index}].uuid is not canonical")
        result.append(
            {
                "description": _text(
                    record["description"], f"{label}[{index}].description"
                ),
                "position_nm": {
                    "x": _position_nm(position["x"], f"{label}[{index}].pos.x"),
                    "y": _position_nm(position["y"], f"{label}[{index}].pos.y"),
                },
                "uuid": uuid,
            }
        )
    return sorted(result, key=canonical_json)


def _violations(
    value: object,
    *,
    check: str,
    category: str,
    context: str,
    label: str,
) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for index, item in enumerate(_array(value, label)):
        record = _closed(
            item,
            label=f"{label}[{index}]",
            keys=frozenset({"description", "items", "severity", "type"}),
        )
        severity = _text(record["severity"], f"{label}[{index}].severity")
        if severity not in _SEVERITIES:
            raise KiCadReportError(f"{label}[{index}].severity is unsupported")
        finding_type = _text(record["type"], f"{label}[{index}].type")
        if _TYPE.fullmatch(finding_type) is None:
            raise KiCadReportError(f"{label}[{index}].type is not stable syntax")
        result.append(
            {
                "category": category,
                "check": check,
                "context": context,
                "description": _text(
                    record["description"], f"{label}[{index}].description"
                ),
                "items": _items(record["items"], f"{label}[{index}].items"),
                "severity": severity,
                "type": finding_type,
            }
        )
    return sorted(result, key=canonical_json)


def _common(
    root: dict[str, object],
    *,
    schema: str,
    source: str,
    version: str,
    label: str,
) -> tuple[tuple[dict[str, object], ...], dict[str, object]]:
    if root["$schema"] != schema:
        raise KiCadReportError(f"{label} schema URI is not pinned v1")
    if root["coordinate_units"] != "mm":
        raise KiCadReportError(f"{label} coordinate units must be mm")
    if root["kicad_version"] != version:
        raise KiCadReportError(f"{label} KiCad version does not match the worker pin")
    if root["source"] != source:
        raise KiCadReportError(f"{label} source does not match the opened managed file")
    date = _text(root["date"], f"{label}.date")
    if _DATE.fullmatch(date) is None:
        raise KiCadReportError(f"{label} date is not KiCad timestamp syntax")
    severities = _array(root["included_severities"], f"{label}.included_severities")
    if any(type(item) is not str for item in severities) or (
        frozenset(cast(list[str], severities)) != _SEVERITIES
        or len(severities) != len(_SEVERITIES)
    ):
        raise KiCadReportError(f"{label} does not include every pinned severity")
    ignored = _ignored(root["ignored_checks"], f"{label}.ignored_checks")
    common: dict[str, object] = {
        "$schema": schema,
        "coordinate_units": "mm",
        "ignored_checks": list(ignored),
        "included_severities": sorted(_SEVERITIES),
        "kicad_version": version,
        "source": source,
    }
    return ignored, common


def parse_kicad_report(
    check: str,
    payload: bytes,
    *,
    expected_source: str,
    expected_version: str,
) -> ParsedCheckReport:
    """Parse exactly KiCad ERC v1 or DRC v1 and remove wall-clock metadata."""

    if check not in {"erc", "drc"}:
        raise KiCadReportError("check must be erc or drc")
    if type(payload) is not bytes or not payload:
        raise KiCadReportError("KiCad report must be non-empty exact bytes")
    try:
        decoded = json.loads(
            payload.decode("utf-8", errors="strict"),
            parse_float=Decimal,
            parse_int=int,
            parse_constant=_reject_constant,
            object_pairs_hook=_unique_object,
        )
    except KiCadReportError:
        raise
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise KiCadReportError("KiCad report is not strict UTF-8 JSON") from exc

    if check == "erc":
        keys = frozenset(
            {
                "$schema",
                "coordinate_units",
                "date",
                "ignored_checks",
                "included_severities",
                "kicad_version",
                "sheets",
                "source",
            }
        )
        root = _closed(decoded, label="ERC report", keys=keys)
        ignored, normalized = _common(
            root,
            schema=_ERC_SCHEMA,
            source=expected_source,
            version=expected_version,
            label="ERC report",
        )
        sheets: list[dict[str, object]] = []
        findings: list[dict[str, object]] = []
        for index, value in enumerate(_array(root["sheets"], "ERC report.sheets")):
            sheet = _closed(
                value,
                label=f"ERC report.sheets[{index}]",
                keys=frozenset({"path", "uuid_path", "violations"}),
            )
            path = _text(sheet["path"], f"ERC report.sheets[{index}].path")
            uuid_path = _text(
                sheet["uuid_path"], f"ERC report.sheets[{index}].uuid_path"
            )
            if _UUID_PATH.fullmatch(uuid_path) is None:
                raise KiCadReportError(
                    f"ERC report.sheets[{index}].uuid_path is not canonical"
                )
            violations = _violations(
                sheet["violations"],
                check="erc",
                category="violations",
                context=f"{path}|{uuid_path}",
                label=f"ERC report.sheets[{index}].violations",
            )
            findings.extend(violations)
            sheets.append(
                {"path": path, "uuid_path": uuid_path, "violations": violations}
            )
        normalized["sheets"] = sorted(sheets, key=canonical_json)
    else:
        keys = frozenset(
            {
                "$schema",
                "coordinate_units",
                "date",
                "ignored_checks",
                "included_severities",
                "kicad_version",
                "schematic_parity",
                "source",
                "unconnected_items",
                "violations",
            }
        )
        root = _closed(decoded, label="DRC report", keys=keys)
        ignored, normalized = _common(
            root,
            schema=_DRC_SCHEMA,
            source=expected_source,
            version=expected_version,
            label="DRC report",
        )
        findings = []
        for category in ("schematic_parity", "unconnected_items", "violations"):
            violations = _violations(
                root[category],
                check="drc",
                category=category,
                context="/",
                label=f"DRC report.{category}",
            )
            normalized[category] = violations
            findings.extend(violations)

    sorted_findings = tuple(sorted(findings, key=canonical_json))
    normalized["finding_count"] = len(sorted_findings)
    return ParsedCheckReport(
        check=check,
        findings=sorted_findings,
        ignored_checks=ignored,
        normalized_report=normalized,
        raw_sha256=hashlib.sha256(payload).hexdigest(),
    )


__all__ = ("KiCadReportError", "ParsedCheckReport", "parse_kicad_report")
