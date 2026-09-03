"""Small JSON Schema 2020-12 subset used by the dependency-free MCP host."""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import cast

from backend.mcp_gateway import InvalidRequest


def validate_json(
    value: object,
    schema: Mapping[str, object],
    path: str = "$arguments",
) -> None:
    """Fail closed on every schema keyword emitted by this project's manifests."""

    alternatives_value = schema.get("anyOf")
    if alternatives_value is not None:
        if not isinstance(alternatives_value, list):
            raise InvalidRequest(f"{path} has an invalid server schema")
        alternatives = cast(list[object], alternatives_value)
        for alternative_value in alternatives:
            if not isinstance(alternative_value, Mapping):
                raise InvalidRequest(f"{path} has an invalid server schema")
            alternative = cast(Mapping[str, object], alternative_value)
            try:
                validate_json(value, alternative, path)
                break
            except InvalidRequest:
                continue
        else:
            raise InvalidRequest(f"{path} does not match any allowed shape")
        return

    expected_value = schema.get("type")
    if expected_value is not None:
        expected_types = (
            cast(list[object], expected_value)
            if isinstance(expected_value, list)
            else [expected_value]
        )
        if not any(_matches_type(value, item) for item in expected_types):
            rendered = ", ".join(str(item) for item in expected_types)
            raise InvalidRequest(f"{path} must have JSON type {rendered}")

    if "enum" in schema:
        enum_value = schema["enum"]
        if not isinstance(enum_value, list):
            raise InvalidRequest(f"{path} has an invalid server schema")
        if not any(_json_equal(value, item) for item in cast(list[object], enum_value)):
            raise InvalidRequest(f"{path} must be one of the declared enum values")

    if isinstance(value, dict):
        raw_value = cast(dict[object, object], value)
        if any(not isinstance(key, str) for key in raw_value):
            raise InvalidRequest(f"{path} object keys must be strings")
        exact_value = cast(dict[str, object], raw_value)
        properties_value = schema.get("properties", {})
        required_value = schema.get("required", [])
        if not isinstance(properties_value, dict) or not isinstance(required_value, list):
            raise InvalidRequest(f"{path} has an invalid server schema")
        raw_required = cast(list[object], required_value)
        raw_properties = cast(dict[object, object], properties_value)
        if any(not isinstance(name, str) for name in raw_required) or any(
            not isinstance(name, str) for name in raw_properties
        ):
            raise InvalidRequest(f"{path} has an invalid server schema")
        properties = cast(dict[str, object], raw_properties)
        required = cast(list[str], raw_required)
        missing = [name for name in required if name not in exact_value]
        if missing:
            raise InvalidRequest(f"{path} is missing fields: {', '.join(sorted(missing))}")
        if schema.get("additionalProperties") is False:
            extra = exact_value.keys() - properties.keys()
            if extra:
                raise InvalidRequest(f"{path} has unknown fields: {', '.join(sorted(extra))}")
        for name, child_value in properties.items():
            if name in exact_value:
                if not isinstance(child_value, Mapping):
                    raise InvalidRequest(f"{path} has an invalid server schema")
                child = cast(Mapping[str, object], child_value)
                validate_json(exact_value[name], child, f"{path}.{name}")

    if isinstance(value, list):
        exact_array = cast(list[object], value)
        minimum_items = schema.get("minItems")
        if isinstance(minimum_items, int) and len(exact_array) < minimum_items:
            raise InvalidRequest(f"{path} must contain at least {minimum_items} items")
        maximum_items = schema.get("maxItems")
        if isinstance(maximum_items, int) and len(exact_array) > maximum_items:
            raise InvalidRequest(f"{path} must contain at most {maximum_items} items")
        if schema.get("uniqueItems") is True and any(
            _json_equal(exact_array[left], exact_array[right])
            for left in range(len(exact_array))
            for right in range(left + 1, len(exact_array))
        ):
            raise InvalidRequest(f"{path} items must be unique")
        item_schema_value = schema.get("items")
        if item_schema_value is not None:
            if not isinstance(item_schema_value, Mapping):
                raise InvalidRequest(f"{path} has an invalid server schema")
            item_schema = cast(Mapping[str, object], item_schema_value)
            for index, item in enumerate(exact_array):
                validate_json(item, item_schema, f"{path}[{index}]")

    if isinstance(value, str):
        minimum_length = schema.get("minLength")
        if isinstance(minimum_length, int) and len(value) < minimum_length:
            raise InvalidRequest(f"{path} is shorter than {minimum_length} characters")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            raise InvalidRequest(f"{path} does not match the required pattern")

    if isinstance(value, int) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, int) and value < minimum:
            raise InvalidRequest(f"{path} must be at least {minimum}")


def _matches_type(value: object, expected: object) -> bool:
    if not isinstance(expected, str):
        return False
    by_name: dict[str, bool] = {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }
    return by_name.get(expected, False)


def _json_equal(left: object, right: object) -> bool:
    """Avoid Python's surprising ``True == 1`` when validating JSON enums."""

    return type(left) is type(right) and left == right
