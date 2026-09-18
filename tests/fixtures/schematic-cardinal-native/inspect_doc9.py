"""Read-only frozen-source comparison to the independently captured native oracle.

Only two pure function ASTs are copied into a temporary in-memory namespace.
This is not a public MCP/runtime invocation and imports no frozen runtime module.
"""
import argparse
import ast
import hashlib
import json
import math
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--runtime", required=True)
p.add_argument("--oracle", required=True)
p.add_argument("--output", required=True)
a = p.parse_args()
root, oracle_path, output = Path(a.runtime), Path(a.oracle), Path(a.output)
oracle = json.loads(oracle_path.read_text(encoding="utf-8"))
pins = {(case["reference"], pin["number"]): (case, pin) for case in oracle["cases"] for pin in case["pins"]}
reports = []
for relative, name, invert in [("tools/schematic.py", "rotate_point", True), ("models/visual_qa.py", "_rotate_local", False)]:
    file = root / relative
    before = file.read_bytes()
    tree = ast.parse(before.decode("utf-8"), filename=str(file))
    node = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == name)
    namespace = {"math": math}
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(file), "exec"), namespace)
    compare = []
    for observed in oracle["observations"]:
        case, pin = pins[(observed["reference"], observed["pin"])]
        rotation, at = case["placement"]["rotationDeg"], case["placement"]["at"]
        x, y = pin["at"]["xMm"], pin["at"]["yMm"]
        dx, dy = namespace[name](x, -y if invert else y, rotation)
        actual = {"xMm": round(at["xMm"] + dx, 4), "yMm": round(at["yMm"] + dy, 4)}
        compare.append({"reference": observed["reference"], "pin": observed["pin"], "rotation": rotation,
                        "frozenSourceFunction": actual, "independentNative": observed["at"], "matches": actual == observed["at"]})
    if file.read_bytes() != before:
        raise RuntimeError("Frozen source changed during read-only comparison")
    reports.append({"file": relative, "sha256": hashlib.sha256(before).hexdigest(), "function": name,
                    "functionLine": node.lineno, "mismatchCount": sum(not item["matches"] for item in compare), "comparisons": compare})
result = {"classification": "copied pure frozen-source AST comparison, not public MCP/native-runtime evidence",
          "nativeOracleSha256": hashlib.sha256(oracle_path.read_bytes()).hexdigest(), "runtimeFilesUnchanged": True, "reports": reports}
with output.open("x", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(result, indent=2) + "\n")
print(json.dumps({"output": str(output), "runtimeFilesUnchanged": True,
                  "mismatches": {r["function"]: r["mismatchCount"] for r in reports}}))
