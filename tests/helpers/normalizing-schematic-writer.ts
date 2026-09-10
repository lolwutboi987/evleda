import { parseFreshSchematicSource, type FreshPoint, type FreshSchematicWire } from "../../src/harness/fresh-kicad-parser.js";

type Geometry = { readonly wires: readonly FreshSchematicWire[]; readonly junctions: readonly FreshPoint[] };

export function replaceFakeSchematicGeometry(source: string, geometry: Geometry): string {
  let result = "";
  let from = 0;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let geometryStart = -1;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "(") {
      if (depth === 1 && /^\((?:wire|junction)\s/u.test(source.slice(index))) geometryStart = index;
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 1 && geometryStart >= 0) {
        result += source.slice(from, geometryStart);
        from = index + 1;
        geometryStart = -1;
      }
    }
  }
  result += source.slice(from);
  const forms = [
    ...geometry.wires.map(({ start, end }) => `(wire (pts (xy ${start.x} ${start.y}) (xy ${end.x} ${end.y})))`),
    ...geometry.junctions.map(({ x, y }) => `(junction (at ${x} ${y}) (diameter 0))`),
  ].join("\n  ");
  const close = result.lastIndexOf(")");
  return `${result.slice(0, close)}\n  ${forms}\n${result.slice(close)}`;
}

/**
 * Independent test writer for the orthogonal captured/fake plans. It unions
 * parsed intervals pairwise and retains previously inserted T junctions on
 * every operation. It deliberately does not call the production canonicalizer.
 * Python's boundary rounding is covered separately by captured oracle tests.
 */
export function normalizeFakeSchematicWriterSource(source: string): string {
  const parsed = parseFreshSchematicSource(source);
  const segments = parsed.wires.map(({ start, end }) => [start.x, start.y, end.x, end.y].map((value) => Number(value.toFixed(4))));
  const wires: number[][] = [];
  for (const segment of segments) {
    let [x1, y1, x2, y2] = segment as [number, number, number, number];
    if (x1 === x2 && y1 === y2) continue;
    if (x1 > x2 || (x1 === x2 && y1 > y2)) [x1, y1, x2, y2] = [x2, y2, x1, y1];
    let candidate = [x1, y1, x2, y2];
    for (let index = 0; index < wires.length;) {
      const [a, b, c, d] = wires[index]! as [number, number, number, number];
      const [p, q, r, s] = candidate as [number, number, number, number];
      const horizontal = q === s && b === d && q === b && Math.max(p, a) <= Math.min(r, c) + 1e-6;
      const vertical = p === r && a === c && p === a && Math.max(q, b) <= Math.min(s, d) + 1e-6;
      if (horizontal || vertical || JSON.stringify(candidate) === JSON.stringify(wires[index])) {
        candidate = horizontal ? [Math.min(p, a), q, Math.max(r, c), q]
          : vertical ? [p, Math.min(q, b), p, Math.max(s, d)] : candidate;
        wires.splice(index, 1);
        index = 0;
      } else index += 1;
    }
    wires.push(candidate);
  }
  if (wires.length === 0) return source;
  const junctions = new Map(parsed.junctions.map((point) => [JSON.stringify([point.x, point.y]), point]));
  for (const wire of wires) for (const [x, y] of [[wire[0]!, wire[1]!], [wire[2]!, wire[3]!]]) {
    if (wires.some(([a, b, c, d]) => (a === c && x === a && y! > b! + 1e-6 && y! < d! - 1e-6)
      || (b === d && y === b && x! > a! + 1e-6 && x! < c! - 1e-6))) {
      junctions.set(JSON.stringify([x, y]), { x: x!, y: y! });
    }
  }
  return replaceFakeSchematicGeometry(source, {
    wires: wires.map(([x, y, endX, endY]) => ({ start: { x: x!, y: y! }, end: { x: endX!, y: endY! } })),
    junctions: [...junctions.values()],
  });
}
