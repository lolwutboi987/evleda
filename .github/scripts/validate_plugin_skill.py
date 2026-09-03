"""Validate the public Codex plugin and skill without a Codex runtime."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PLUGIN = ROOT / "plugins" / "evleda"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"plugin/skill validation failed: {message}")


def main() -> None:
    manifest_path = PLUGIN / ".codex-plugin" / "plugin.json"
    mcp_path = PLUGIN / ".mcp.json"
    skill_path = PLUGIN / "skills" / "evleda" / "SKILL.md"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    mcp = json.loads(mcp_path.read_text(encoding="utf-8"))
    require(manifest["name"] == "evleda", "plugin name must be evleda")
    require(manifest["interface"]["displayName"] == "EvlEDA", "display name mismatch")
    require(manifest["skills"] == "./skills/", "skills directory must be explicit")
    require(manifest["mcpServers"] == "./.mcp.json", "MCP config must be explicit")
    require(isinstance(mcp.get("mcpServers"), dict), "mcpServers must be an object")
    require(set(mcp["mcpServers"]) == {"evleda"}, "exactly one local MCP is expected")
    server = mcp["mcpServers"]["evleda"]
    require(server.get("command") == "evleda-mcp", "MCP must launch installed command")
    require(
        server.get("args") == ["serve", "--require-kicad"],
        "MCP must use the local KiCad-required stdio profile",
    )
    require("url" not in server and "type" not in server, "network MCP transport is forbidden")
    require(
        set(manifest["interface"]["capabilities"]) == {"Interactive", "Read"},
        "plugin must not advertise an unconditional editor/write capability",
    )
    skill = skill_path.read_text(encoding="utf-8")
    require(skill.startswith("---\n"), "skill must begin with YAML front matter")
    closing = skill.find("\n---\n", 4)
    require(closing != -1, "skill front matter must be closed")
    front_matter = skill[4:closing]
    require("name: evleda" in front_matter, "skill name must be evleda")
    require("description:" in front_matter, "skill description is required")
    require("local stdio MCP" in skill, "skill must state the local stdio boundary")
    require("KiCad remains the authoritative editor" in skill, "KiCad authority is unclear")
    require("no canvas" in skill, "skill must reject replacement-CAD behavior")

    required_doc_markers = {
        "README.md": ("not a CAD application", "listening socket"),
        "STATUS.md": ("not standalone CAD software", "no browser/editor UI"),
        "docs/INSTALLATION.md": ("has no browser", "There is no URL, port"),
        "docs/ARCHITECTURE.md": ("KiCad is authoritative", "opens no listening socket"),
        "docs/WHY_EVLEDA.md": ("does **not** compete by building another CAD editor",),
    }
    for relative, markers in required_doc_markers.items():
        content = (ROOT / relative).read_text(encoding="utf-8")
        for marker in markers:
            require(marker in content, f"{relative} is missing public-boundary marker: {marker}")
    print("plugin/skill validation passed")


if __name__ == "__main__":
    main()
