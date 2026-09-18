"""Independent KiCad CLI cardinal oracle. Creates only a NEW isolated output.

Every possible local grid location gets a spatially named label, not a label
chosen for an expected pin. Native netlisting identifies each pin's location.
A separate unlabelled native SVG identifies the pin stroke's inward direction.
No EvlEDA or sidecar transform is imported or used to construct this oracle.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import uuid
import xml.etree.ElementTree as ET


def identity(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return {"algorithm": "sha256", "digest": hashlib.sha256(data).hexdigest(), "size": len(data)}


def block_at(text, start):
    depth, quoted, escaped = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if quoted:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
        elif c == '"':
            quoted = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise ValueError("Unbalanced symbol source")


def uid(name):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "evleda-native-cardinal:" + name))


def point(node, name):
    m = re.search(r"\(" + name + r"\s+([-+.\d]+)\s+([-+.\d]+)(?:\s+([-+.\d]+))?\)", node)
    if not m:
        raise ValueError("Missing exact " + name)
    return [float(m.group(1)), float(m.group(2)), float(m.group(3) or 0)]


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--cli", required=True)
    p.add_argument("--symbols", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()
    cli, symbol_root, out = Path(args.cli).resolve(), Path(args.symbols).resolve(), Path(args.output).resolve()
    out.mkdir(parents=True, exist_ok=False)
    config = out / "isolated-config"
    config.mkdir()
    env = {**os.environ, "KICAD_CONFIG_HOME": str(config), "KICAD10_SYMBOL_DIR": str(symbol_root), "PYTHONDONTWRITEBYTECODE": "1"}
    invocations = []

    def run(argv):
        done = subprocess.run([str(cli), *argv], cwd=out, env=env, capture_output=True, text=True, timeout=60)
        invocations.append({"args": argv, "exitCode": done.returncode, "stdout": done.stdout, "stderr": done.stderr})
        if done.returncode:
            raise RuntimeError(json.dumps(invocations[-1]))
        return done.stdout.strip()

    version = run(["version"])
    if version != "10.0.3":
        raise RuntimeError("This capture is qualified for KiCad 10.0.3 only")
    inputs, definitions, cases = [], [], []
    specs = [("Device", "R", "R"), ("Transistor_FET", "Q_NMOS_GSD", "Q"), ("Device", "Crystal_GND24", "Y")]
    for column, (lib, leaf, prefix) in enumerate(specs):
        original = (symbol_root / (lib + ".kicad_sym")).read_bytes()
        text = original.decode("utf-8")
        matches = list(re.finditer(r'\(symbol "' + re.escape(leaf) + r'"\s', text))
        if len(matches) != 1:
            raise ValueError("Missing/ambiguous stock symbol " + leaf)
        definition = block_at(text, matches[0].start())
        if "(extends " in definition:
            raise ValueError("Inherited symbols are outside this capture")
        qualified = definition.replace('(symbol "' + leaf + '"', '(symbol "' + lib + ':' + leaf + '"', 1)
        definitions.append(qualified)
        pins = []
        for m in re.finditer(r"\(pin\s+\w+\s+\w+\s", definition):
            pin = block_at(definition, m.start())
            x, y, angle = point(pin, "at")
            number = re.search(r'\(number "([^\"]+)"', pin).group(1)
            length = float(re.search(r"\(length\s+([-+.\d]+)\)", pin).group(1))
            pins.append({"number": number, "at": {"xMm": x, "yMm": y}, "angleDeg": int(angle), "lengthMm": length})
        if len(pins) != len({pin["number"] for pin in pins}):
            raise ValueError("Duplicate source pin number")
        inputs.append({"libraryId": lib + ":" + leaf, "installedSourceIdentity": identity(original), "definitionIdentity": identity(qualified), "pins": pins})
        for row, rotation in enumerate([0, 90, 180, 270]):
            cases.append({"reference": prefix + str(rotation), "symbolLibId": lib + ":" + leaf, "value": "DMG1012T" if prefix == "Q" else leaf,
                          "placement": {"at": {"xMm": 50.8 + 110 * column, "yMm": 40.64 + 60 * row}, "rotationDeg": rotation}, "pins": pins})
    library = '(kicad_symbol_lib (version 20250316) (generator "fixture")\n' + "\n".join(definitions) + '\n)\n'
    (out / "source-symbols.kicad_sym").write_text(library, encoding="utf-8", newline="\n")
    labels = {}

    def schematic(name, labelled):
        forms = [f'(kicad_sch (version 20250316) (generator "eeschema") (generator_version "10.0") (uuid "{uid("sheet")}") (paper "A3")',
                 '(lib_symbols\n' + "\n".join(definitions) + ')']
        for case in cases:
            ref, libid, pose = case["reference"], case["symbolLibId"], case["placement"]
            x, y, r = pose["at"]["xMm"], pose["at"]["yMm"], pose["rotationDeg"]
            forms.append(f'(symbol (lib_id "{libid}") (at {x:g} {y:g} {r}) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "{uid(ref)}")'
                         f' (property "Reference" "{ref}" (at {x:g} {y:g} 0) (effects (font (size 1.27 1.27)) (hide yes)))'
                         f' (property "Value" "{case["value"]}" (at {x:g} {y:g} 0) (effects (font (size 1.27 1.27)) (hide yes)))'
                         + ''.join(f' (pin "{pin["number"]}" (uuid "{uid(ref + ":" + pin["number"])}"))' for pin in case["pins"])
                         + f' (instances (project "{name}" (path "/{uid("sheet")}" (reference "{ref}") (unit 1)))))')
            if labelled:
                # Rotation-independent Cartesian probe grid. Labels encode only
                # spatial offsets; KiCad supplies the association to pin numbers.
                axis = sorted({0.0, *(sign * coordinate for pin in case["pins"] for coordinate in pin["at"].values() for sign in [-1, 1])})
                for ix, dx in enumerate(axis):
                    for iy, dy in enumerate(axis):
                        net = f'GRID_{ref}_X{ix}_Y{iy}'
                        px, py = round(x + dx, 6), round(y + dy, 6)
                        labels[net] = {"reference": ref, "at": {"xMm": px, "yMm": py}}
                        forms.append(f'(global_label "{net}" (shape passive) (at {px:g} {py:g} 0)'
                                     f' (effects (font (size 1.27 1.27)) (justify left)) (uuid "{uid(net)}"))')
        forms.append('(embedded_fonts no))\n')
        return "\n".join(forms)

    for name, labelled in [("cardinal-labelled", True), ("cardinal-unlabelled", False)]:
        (out / (name + ".kicad_sch")).write_text(schematic(name, labelled), encoding="utf-8", newline="\n")
        (out / (name + ".kicad_pro")).write_text('{}\n', encoding="utf-8", newline="\n")
    before = {file.name: identity(file.read_bytes()) for file in out.glob("*.kicad_sch")}
    run(["sch", "export", "netlist", "--format", "kicadxml", "--output", str(out / "native.net"), str(out / "cardinal-labelled.kicad_sch")])
    run(["sch", "export", "svg", "--black-and-white", "--exclude-drawing-sheet", "--no-background-color", "--output", str(out / "svg"), str(out / "cardinal-unlabelled.kicad_sch")])
    svg_files = list((out / "svg").glob("*.svg"))
    if len(svg_files) != 1:
        raise ValueError("Incomplete SVG page inventory")
    svg_bytes = svg_files[0].read_bytes()
    (out / "native.svg").write_bytes(svg_bytes)
    svg = ET.fromstring(svg_bytes)
    segments = []
    skipped_transforms = []

    def untransformed_nodes(node):
        transform = node.get("transform")
        if transform is not None and transform != "translate(0 0) scale(1 1)":
            # Native rotated glyph groups are not pin-stroke evidence. Retain
            # them in the raw SVG, but never guess their geometry. Every pin
            # must still have its own unique untransformed full-length stroke.
            skipped_transforms.append(transform)
            return
        yield node
        for child in node:
            yield from untransformed_nodes(child)

    for node in untransformed_nodes(svg):
        if node.tag.endswith("path"):
            m = re.fullmatch(r"\s*M\s*([-+.\d]+)[, ]+([-+.\d]+)\s*L\s*([-+.\d]+)[, ]+([-+.\d]+)\s*", node.get("d", ""))
            if m:
                segments.append(tuple(float(v) for v in m.groups()))
    observed = {}
    for net in ET.parse(out / "native.net").findall("./nets/net"):
        name = net.get("name")
        for node in net.findall("node"):
            ref, pin = node.get("ref"), node.get("pin")
            if name not in labels or labels[name]["reference"] != ref:
                raise ValueError("Native pin does not connect to its own spatial grid: " + str((ref, pin, name)))
            if (ref, pin) in observed:
                raise ValueError("Duplicate native endpoint")
            observed[(ref, pin)] = {"net": name, "at": labels[name]["at"]}
    observations = []
    for case in cases:
        for pin in case["pins"]:
            native = observed[(case["reference"], pin["number"])]
            at, length = native["at"], pin["lengthMm"]
            directions = set()
            matched = []
            for x1, y1, x2, y2 in segments:
                for x, y, end_x, end_y in [(x1,y1,x2,y2),(x2,y2,x1,y1)]:
                    if math.hypot(x - at["xMm"], y - at["yMm"]) > 0.000_002 or abs(math.hypot(end_x-x, end_y-y) - length) > 0.000_002:
                        continue
                    dx, dy = end_x-x, end_y-y
                    if abs(dx) < 0.000_002:
                        angle = 90 if dy < 0 else 270
                    elif abs(dy) < 0.000_002:
                        angle = 0 if dx > 0 else 180
                    else:
                        continue
                    directions.add(angle)
                    matched.append([x,y,end_x,end_y])
            if len(directions) != 1:
                raise ValueError("Native pin stroke direction missing/ambiguous: " + str((case["reference"], pin, native, matched)))
            observations.append({"reference": case["reference"], "pin": pin["number"], **native, "angleDeg": next(iter(directions)), "nativeStrokeSegments": matched})
    if len(observed) != len(observations):
        raise ValueError("Native endpoint inventory is not exact")
    after = {file.name: identity(file.read_bytes()) for file in out.glob("*.kicad_sch")}
    if before != after:
        raise ValueError("Native export modified its source")
    artifacts = {file.name: identity(file.read_bytes()) for file in out.iterdir() if file.is_file()}
    result = {"schemaVersion": "evleda.native-schematic-cardinal-oracle.v1", "nativeExecution": True,
              "classification": "isolated CLI geometry qualification; not managed-board evidence", "version": version,
              "cliIdentity": identity(cli.read_bytes()), "captureScriptIdentity": identity(Path(__file__).read_bytes()),
              "gridConstruction": "rotation-independent Cartesian spatial labels; no pin-number prediction", "svgExcludedTransformGroups": skipped_transforms,
              "angleOracle": "native SVG straight pin stroke anchored by independent native XML netlist", "inputs": inputs, "cases": cases,
              "observations": observations, "sourcesUnchanged": before == after, "artifacts": artifacts, "invocations": invocations}
    (out / "oracle.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"output": str(out), "logicalPins": len(observations), "rotations": [0,90,180,270], "symbols": [s[1] for s in specs], "sourcesUnchanged": True}))


if __name__ == "__main__":
    main()
