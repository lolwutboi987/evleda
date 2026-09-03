"""Worker-owned, policy-bound runtime support files for pinned KiCad 10.0.6."""

from __future__ import annotations

import hashlib
import json
import re

from backend.mcp_gateway import stable_digest

_STEM = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
RUNTIME_SUPPORT_POLICY_VERSION = "kicad-10.0.6-runtime-support-v1"


def _preferences_document(filename: str) -> dict[str, object]:
    return {
        "board": {
            "active_layer": 0,
            "active_layer_preset": "",
            "auto_track_width": True,
            "hidden_netclasses": [],
            "hidden_nets": [],
            "high_contrast_mode": 0,
            "net_color_mode": 1,
            "opacity": {
                "images": 0.6,
                "pads": 1.0,
                "shapes": 1.0,
                "tracks": 1.0,
                "vias": 1.0,
                "zones": 0.6,
            },
            "prototype_zone_fills": False,
            "selection_filter": {
                "dimensions": True,
                "footprints": True,
                "graphics": True,
                "keepouts": True,
                "lockedItems": False,
                "otherItems": True,
                "pads": True,
                "text": True,
                "tracks": True,
                "vias": True,
                "zones": True,
            },
            "visible_items": [
                "vias",
                "footprint_text",
                "footprint_anchors",
                "ratsnest",
                "grid",
                "footprints_front",
                "footprints_back",
                "footprint_values",
                "footprint_references",
                "tracks",
                "drc_errors",
                "drawing_sheet",
                "bitmaps",
                "pads",
                "zones",
                "drc_warnings",
                "drc_exclusions",
                "locked_item_shadows",
                "conflict_shadows",
                "shapes",
                "board_outline_area",
                "ly_points",
            ],
            "visible_layers": "ffffffff_ffffffff_ffffffff_ffffffff",
            "zone_display_mode": 0,
        },
        "git": {
            "integration_disabled": False,
            "repo_type": "",
            "repo_username": "",
            "ssh_key": "",
        },
        "meta": {"filename": filename, "version": 5},
        "net_inspector_panel": {
            "col_hidden": [],
            "col_order": [],
            "col_widths": [],
            "custom_group_rules": [],
            "expanded_rows": [],
            "filter_by_net_name": True,
            "filter_by_netclass": True,
            "filter_text": "",
            "group_by_constraint": False,
            "group_by_netclass": False,
            "show_time_domain_details": False,
            "show_unconnected_nets": False,
            "show_zero_pad_nets": False,
            "sort_ascending": True,
            "sorting_column": -1,
        },
        "open_jobsets": [],
        "project": {"files": []},
        "schematic": {
            "hierarchy_collapsed": [],
            "selection_filter": {
                "graphics": True,
                "images": True,
                "labels": True,
                "lockedItems": False,
                "otherItems": True,
                "pins": True,
                "ruleAreas": True,
                "symbols": True,
                "text": True,
                "wires": True,
            },
        },
    }


def project_preferences_payload(stem: str) -> bytes:
    """Return the exact LF-only PRL bytes that KiCad 10.0.6 preserves."""

    if type(stem) is not str or _STEM.fullmatch(stem) is None:
        raise ValueError("runtime-support project stem is invalid")
    document = _preferences_document(f"{stem}.kicad_prl")
    return (
        json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    ).encode("utf-8")


def runtime_support_manifest(stem: str) -> dict[str, object]:
    payload = project_preferences_payload(stem)
    return {
        "policy_version": RUNTIME_SUPPORT_POLICY_VERSION,
        "files": [
            {
                "relative_name": f"{stem}.kicad_prl",
                "byte_length": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
        ],
    }


def runtime_support_manifest_sha256(stem: str) -> str:
    return stable_digest(runtime_support_manifest(stem))


RUNTIME_SUPPORT_TEMPLATE_SHA256 = hashlib.sha256(
    (
        json.dumps(
            _preferences_document("<stem>.kicad_prl"),
            indent=2,
            sort_keys=True,
            ensure_ascii=False,
        )
        + "\n"
    ).encode("utf-8")
).hexdigest()


__all__ = (
    "RUNTIME_SUPPORT_POLICY_VERSION",
    "RUNTIME_SUPPORT_TEMPLATE_SHA256",
    "project_preferences_payload",
    "runtime_support_manifest",
    "runtime_support_manifest_sha256",
)
