# Design, placement, and routing

Read this reference when selecting an architecture, placing footprints, routing copper, or evaluating an automated candidate.

Apply these checks to a native KiCad project through operations actually
advertised by the local EvlEDA MCP. KiCad remains the editor and native format;
this guidance does not authorize direct raw-file writes or imply that EvlEDA is
a separate CAD application.

## Schematic and part selection

- Derive the power tree, signal domains, return paths, protection, sequencing, and connector behavior from requirement IDs.
- Use exact manufacturer part numbers and primary datasheets. Bind symbol pins, footprint pads, exposed pads, no-connects, polarity, package revision, ratings, and lifecycle evidence.
- Calculate rail/current budgets, loss, dropout/headroom, tolerances, worst-case component stress, pull/termination networks, decoupling, startup/inrush, thermal margin, and interface timing where relevant.
- Treat typical-only values and unmodeled dependencies as uncertainty, not guaranteed limits.
- Define test points and observable bring-up states before layout.

## Placement

Encode hard constraints before optimizing soft objectives:

- board outline, holes, edge/height/courtyard keepouts, connector datum and mating access;
- critical-loop topology, decoupling distance, return continuity, sensitive-node isolation, thermal copper, symmetry, and test access;
- source-backed courtyard/fabrication geometry and assembly orientation;
- locked objects and protected existing routes.

Record solver/version, source revision, constraint digest, seed, objective vector, runtime budget, and candidate hash. Reject a candidate that violates any hard constraint even if its aggregate score is better.

## Routing

Assign deterministic net classes and fabrication-aware widths, clearances, vias, differential constraints, length/skew targets, voltage spacing, current-density limits, and board-edge rules. Then:

1. route critical power, clocks/high-speed pairs, analog/sensitive paths, and return paths in priority order;
2. keep current loops compact and continuous across reference planes;
3. avoid neck-downs unless explicitly enumerated and justified;
4. account for zone fill as geometry only after fill evidence is bound to the source graph;
5. reject same-net duplicate/overlapping copper and unintended via-in-pad or stub geometry;
6. require every mandatory connection to be routed and every intentional no-connect to remain explicit.

Routing acceptance requires hard-constraint satisfaction, zero hard DRC findings, zero required unrouted nets, intact locks/protected routes, and deterministic replay to the same candidate hash. The model may compare alternatives but cannot certify these facts.

## Review output

Present the selected candidate with a readable schematic, top/bottom copper views, 3D or assembly view when available, critical-path annotations, route statistics, margins, and a list of every intentional exception. Preserve rejected candidates and their deterministic rejection reasons when they materially explain the choice.
