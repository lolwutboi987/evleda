"""Bounded, duplicate-key-safe parser for the modeled `.kicad_pro` manifest slice."""

from __future__ import annotations

import hashlib
import json
import unicodedata
from decimal import Decimal

from .errors import ProjectInvariantError, ProjectSyntaxError
from .model import (
    BundleLimits,
    DiagnosticDisposition,
    ProjectBoardDesignRules,
    ProjectBoardDesignSettings,
    ProjectDiagnostic,
    ProjectDiagnostics,
    ProjectFileInfo,
    ProjectManifest,
    TopLevelSheet,
    require_stem,
    require_uuid,
)

type JsonScalar = None | bool | int | Decimal | str
type JsonValue = JsonScalar | list["JsonValue"] | dict[str, "JsonValue"]


class _ObjectPairs(list[tuple[str, JsonValue]]):
    pass


def _raise_constant(value: str) -> None:
    raise ProjectSyntaxError(f"non-finite JSON number {value!r} is forbidden")


def _preflight_json_depth(text: str, maximum_depth: int) -> None:
    depth = 0
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in "[{":
            depth += 1
            if depth > maximum_depth:
                raise ProjectSyntaxError(
                    f"project JSON exceeds the {maximum_depth}-level nesting limit"
                )
        elif character in "]}":
            depth -= 1
            if depth < 0:
                break


def _convert_json(
    value: object,
    *,
    maximum_depth: int,
    maximum_nodes: int,
) -> JsonValue:
    nodes = 0

    def visit(item: object, depth: int) -> JsonValue:
        nonlocal nodes
        nodes += 1
        if nodes > maximum_nodes:
            raise ProjectSyntaxError(
                f"project JSON exceeds the {maximum_nodes}-node parser limit"
            )
        if depth > maximum_depth:
            raise ProjectSyntaxError(
                f"project JSON exceeds the {maximum_depth}-level nesting limit"
            )
        if item is None or isinstance(item, (bool, int, Decimal)):
            return item
        if isinstance(item, str):
            try:
                item.encode("utf-8", errors="strict")
            except UnicodeEncodeError as exc:
                raise ProjectSyntaxError("project JSON contains invalid Unicode") from exc
            if unicodedata.normalize("NFC", item) != item:
                raise ProjectInvariantError("project JSON strings must be NFC-normalized")
            return item
        if isinstance(item, _ObjectPairs):
            result: dict[str, JsonValue] = {}
            for key, child in item:
                if key in result:
                    raise ProjectSyntaxError(f"duplicate project JSON key {key!r}")
                result[key] = visit(child, depth + 1)
            return result
        if isinstance(item, list):
            return [visit(child, depth + 1) for child in item]
        raise ProjectSyntaxError(f"unsupported decoded JSON value {type(item).__name__}")

    return visit(value, 1)


def parse_json_document(payload: bytes, *, limits: BundleLimits) -> JsonValue:
    if not isinstance(payload, bytes):
        raise TypeError("project payload must be bytes")
    if len(payload) > limits.maximum_project_bytes:
        raise ProjectSyntaxError(
            f"project JSON exceeds the {limits.maximum_project_bytes}-byte limit"
        )
    if payload.startswith(b"\xef\xbb\xbf"):
        raise ProjectSyntaxError("UTF-8 BOM is not accepted in project JSON")
    try:
        text = payload.decode("utf-8", errors="strict")
    except UnicodeDecodeError as exc:
        raise ProjectSyntaxError("project JSON must be valid UTF-8") from exc
    _preflight_json_depth(text, limits.maximum_json_depth)
    try:
        decoded = json.loads(
            text,
            object_pairs_hook=_ObjectPairs,
            parse_float=Decimal,
            parse_int=int,
            parse_constant=_raise_constant,
        )
    except ProjectSyntaxError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise ProjectSyntaxError("project payload must contain one valid JSON document") from exc
    return _convert_json(
        decoded,
        maximum_depth=limits.maximum_json_depth,
        maximum_nodes=limits.maximum_json_nodes,
    )


def canonical_json(value: JsonValue) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise ProjectSyntaxError("non-finite project JSON number is forbidden")
        if value == 0:
            return "0"
        rendered = format(value, "f")
        if "." in rendered:
            rendered = rendered.rstrip("0").rstrip(".")
        return rendered
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + canonical_json(value[key])
            for key in sorted(value)
        ) + "}"
    raise ProjectSyntaxError(f"cannot canonicalize JSON value {type(value).__name__}")


class _Recorder:
    def __init__(self) -> None:
        self.items: list[ProjectDiagnostic] = []

    def unsupported(self, *, path: str, head: str, value: JsonValue, reason: str) -> None:
        body = canonical_json(value)
        self.items.append(
            ProjectDiagnostic(
                "project",
                path,
                head,
                DiagnosticDisposition.UNSUPPORTED,
                reason,
                body,
                hashlib.sha256(body.encode("utf-8")).hexdigest(),
            )
        )

    def manifest(self) -> ProjectDiagnostics:
        return ProjectDiagnostics(tuple(self.items)).normalized()


def _object(value: JsonValue, label: str) -> dict[str, JsonValue]:
    if not isinstance(value, dict):
        raise ProjectInvariantError(f"{label} must be a JSON object")
    return value


def _array(value: JsonValue, label: str) -> list[JsonValue]:
    if not isinstance(value, list):
        raise ProjectInvariantError(f"{label} must be a JSON array")
    return value


def _text(value: JsonValue, label: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value):
        qualifier = "possibly-empty " if allow_empty else "non-empty "
        raise ProjectInvariantError(f"{label} must be a {qualifier}string")
    return value


def _integer(value: JsonValue, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProjectInvariantError(f"{label} must be an integer")
    return value


def _file_infos(value: JsonValue, label: str) -> tuple[ProjectFileInfo, ...]:
    result: list[ProjectFileInfo] = []
    for index, entry in enumerate(_array(value, label)):
        pair = _array(entry, f"{label}[{index}]")
        if len(pair) != 2:
            raise ProjectInvariantError(f"{label}[{index}] must contain [UUID, display-name]")
        file_id = _text(pair[0], f"{label}[{index}] UUID")
        require_uuid(file_id, f"{label}[{index}] UUID")
        display_name = _text(
            pair[1], f"{label}[{index}] display name", allow_empty=True
        )
        result.append(ProjectFileInfo(file_id, display_name))
    return tuple(result)


def _millimetres_to_nanometres(value: JsonValue, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise ProjectInvariantError(f"{label} must be an exact JSON number in millimetres")
    scaled = Decimal(value) * Decimal(1_000_000)
    if scaled != scaled.to_integral_value():
        raise ProjectInvariantError(f"{label} must resolve to an exact integer nanometre value")
    return int(scaled)


def _parse_board_design_settings(
    value: JsonValue, *, recorder: _Recorder
) -> ProjectBoardDesignSettings:
    board = _object(value, "board project settings")
    if "design_settings" not in board:
        raise ProjectInvariantError("board project settings require design_settings")
    for key in sorted(board.keys() - {"design_settings"}):
        recorder.unsupported(
            path=f"$.board.{key}",
            head=key,
            value=board[key],
            reason="unmodeled board project settings can affect PCB behavior or output",
        )

    settings = _object(board["design_settings"], "board design settings")
    required_settings = {"drc_exclusions", "meta", "rules"}
    missing_settings = sorted(required_settings - settings.keys())
    if missing_settings:
        raise ProjectInvariantError(
            "board design settings are missing: " + ", ".join(missing_settings)
        )
    for key in sorted(settings.keys() - required_settings):
        recorder.unsupported(
            path=f"$.board.design_settings.{key}",
            head=key,
            value=settings[key],
            reason="unmodeled board design setting can alter DRC or fabrication behavior",
        )

    exclusions = _array(settings["drc_exclusions"], "board DRC exclusions")
    if exclusions:
        recorder.unsupported(
            path="$.board.design_settings.drc_exclusions",
            head="drc_exclusions",
            value=settings["drc_exclusions"],
            reason="DRC exclusions suppress findings and cannot be accepted implicitly",
        )

    metadata = _object(settings["meta"], "board design-settings metadata")
    required_metadata = {"filename", "version"}
    missing_metadata = sorted(required_metadata - metadata.keys())
    if missing_metadata:
        raise ProjectInvariantError(
            "board design-settings metadata is missing: " + ", ".join(missing_metadata)
        )
    for key in sorted(metadata.keys() - required_metadata):
        recorder.unsupported(
            path=f"$.board.design_settings.meta.{key}",
            head=key,
            value=metadata[key],
            reason="unmodeled board design-settings metadata is not interpreted",
        )
    metadata_filename = _text(
        metadata["filename"], "board design-settings metadata filename"
    )
    metadata_version = _integer(
        metadata["version"], "board design-settings metadata version"
    )

    rules = _object(settings["rules"], "board design rules")
    required_rules = {"min_clearance", "min_hole_clearance"}
    missing_rules = sorted(required_rules - rules.keys())
    if missing_rules:
        raise ProjectInvariantError(
            "board design rules are missing: " + ", ".join(missing_rules)
        )
    for key in sorted(rules.keys() - required_rules):
        recorder.unsupported(
            path=f"$.board.design_settings.rules.{key}",
            head=key,
            value=rules[key],
            reason="unmodeled board design rule can alter DRC or fabrication behavior",
        )
    typed_rules = ProjectBoardDesignRules(
        _millimetres_to_nanometres(
            rules["min_clearance"], "minimum board clearance"
        ),
        _millimetres_to_nanometres(
            rules["min_hole_clearance"], "minimum board hole clearance"
        ),
    )
    return ProjectBoardDesignSettings(
        metadata_filename,
        metadata_version,
        (),
        typed_rules,
    )


def parse_project_manifest(
    payload: bytes,
    *,
    stem: str,
    limits: BundleLimits,
) -> ProjectManifest:
    """Parse only the project membership fields needed to bind one root schematic.

    KiCad project configuration fields can alter ERC, DRC, net classes, library
    resolution, and output behavior.  This slice never silently treats those
    settings as modeled: every extra field is a release-blocking diagnostic.
    """

    require_stem(stem)
    document = parse_json_document(payload, limits=limits)
    root = _object(document, "project root")
    recorder = _Recorder()
    required_root = {"meta", "boards", "sheets", "schematic"}
    supported_root = required_root | {"board"}
    missing = sorted(required_root - root.keys())
    if missing:
        raise ProjectInvariantError(
            "project manifest is missing required field(s): " + ", ".join(missing)
        )
    for key in sorted(root.keys() - supported_root):
        recorder.unsupported(
            path=f"$.{key}",
            head=key,
            value=root[key],
            reason=(
                "project settings outside the modeled membership manifest can affect "
                "library resolution, ERC/DRC, text expansion, or fabrication behavior"
            ),
        )

    meta = _object(root["meta"], "project meta")
    for key in sorted(meta.keys() - {"filename", "version"}):
        recorder.unsupported(
            path=f"$.meta.{key}",
            head=key,
            value=meta[key],
            reason="unmodeled project metadata is retained but not interpreted",
        )
    if "filename" not in meta or "version" not in meta:
        raise ProjectInvariantError("project meta requires filename and version")
    filename = _text(meta["filename"], "project meta filename")
    expected_filename = f"{stem}.kicad_pro"
    if filename != expected_filename:
        raise ProjectInvariantError(
            f"project meta filename must be exactly {expected_filename!r}"
        )
    schema_version = _integer(meta["version"], "project meta version")
    if schema_version != 3:
        raise ProjectInvariantError(
            "supported KiCad 10 project manifest schema is exactly meta.version 3"
        )

    board_design_settings = (
        _parse_board_design_settings(root["board"], recorder=recorder)
        if "board" in root
        else None
    )

    boards = _file_infos(root["boards"], "boards")
    if len(boards) > 1:
        raise ProjectInvariantError("supported bundle permits at most one project board entry")
    sheets = _file_infos(root["sheets"], "sheets")
    if len(sheets) != 1:
        raise ProjectInvariantError("supported bundle requires exactly one root sheet entry")

    schematic_settings = _object(root["schematic"], "schematic project settings")
    if "top_level_sheets" not in schematic_settings:
        raise ProjectInvariantError("schematic settings require top_level_sheets")
    for key in sorted(schematic_settings.keys() - {"top_level_sheets"}):
        recorder.unsupported(
            path=f"$.schematic.{key}",
            head=key,
            value=schematic_settings[key],
            reason=(
                "unmodeled schematic project settings can affect ERC, annotation, "
                "simulation, plotting, or text expansion"
            ),
        )

    top_entries = _array(
        schematic_settings["top_level_sheets"], "schematic top_level_sheets"
    )
    if len(top_entries) != 1:
        raise ProjectInvariantError("supported bundle requires exactly one top-level sheet")
    top_level: list[TopLevelSheet] = []
    for index, entry in enumerate(top_entries):
        item = _object(entry, f"top_level_sheets[{index}]")
        required = {"uuid", "name", "filename"}
        missing_top = sorted(required - item.keys())
        if missing_top:
            raise ProjectInvariantError(
                f"top_level_sheets[{index}] is missing: " + ", ".join(missing_top)
            )
        for key in sorted(item.keys() - required):
            recorder.unsupported(
                path=f"$.schematic.top_level_sheets[{index}].{key}",
                head=key,
                value=item[key],
                reason="unmodeled top-level sheet metadata is retained but not interpreted",
            )
        top_level.append(
            TopLevelSheet(
                _text(item["uuid"], f"top_level_sheets[{index}] UUID"),
                _text(item["name"], f"top_level_sheets[{index}] name", allow_empty=True),
                _text(item["filename"], f"top_level_sheets[{index}] filename"),
            )
        )

    if sheets[0].file_id != top_level[0].sheet_id:
        raise ProjectInvariantError("root sheet and top-level sheet UUIDs must match")
    if top_level[0].filename != f"{stem}.kicad_sch":
        raise ProjectInvariantError("top-level sheet must name the stem-derived schematic file")

    return ProjectManifest(
        schema_version,
        filename,
        boards,
        sheets,
        tuple(top_level),
        board_design_settings,
        canonical_json(document),
        recorder.manifest(),
    )


def render_project_manifest(manifest: ProjectManifest) -> bytes:
    """Emit the duplicate-free canonical JSON snapshot retained by the typed manifest."""

    if not isinstance(manifest, ProjectManifest):
        raise TypeError("manifest must be ProjectManifest")
    return (manifest.canonical_source_json + "\n").encode("utf-8")
