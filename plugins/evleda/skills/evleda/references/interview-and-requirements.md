# Interview and requirements

Read this reference before planning a new board or making a material design change.

The resulting requirements guide supported work on native KiCad projects. They
do not authorize EvlEDA to substitute its demo fixture, invent an unavailable
MCP tool, or behave as a replacement CAD editor.

## Establish the design contract

Ask focused questions until the answers needed for a safe candidate are explicit. Do not overwhelm the user with every possible question at once; ask the highest-impact unresolved items first and continue as answers change the design.

Capture:

- purpose, operating modes, success criteria, prototype quantity, and intended lifecycle;
- every input/output rail, nominal and absolute voltage, continuous/peak current, source impedance, startup order, back-power behavior, and fault expectation;
- interfaces, protocol versions, speed, direction, connector gender/keying, cable assumptions, pull networks, termination, ESD/surge environment, and hot-plug behavior;
- mechanical envelope, keepouts, mounting, connector locations, height limits, enclosure, test access, and serviceability;
- layer count, stackup or impedance target, copper weight, minimum trace/space, drill/annular-ring limits, via policy, finish, assembly side(s), and nominated fabricator capabilities;
- ambient/board temperature range, airflow, altitude, contamination, vibration, moisture, lifetime, and derating policy;
- regulatory, isolation, creepage/clearance, safety class, EMC, USB/PCIe/other compliance, and hazardous-energy constraints;
- sourcing region, lifecycle/availability expectations, alternates policy, cost targets, assembly process, and exact-MPN evidence requirements;
- programming, debug, test, calibration, labeling, and production-test requirements.

## Classify every statement

Maintain a compact requirements record. Mark each item as one of:

- `REQUIRED`: user-confirmed and testable;
- `ASSUMED`: reasonable but not confirmed;
- `UNKNOWN`: missing information with stated impact;
- `OPTION`: a decision the user has not selected;
- `RELEASE_BLOCKER`: cannot be closed by model reasoning or digital checks alone.

Give requirements stable IDs and units. Express acceptance as measurable predicates, not adjectives. Bind calculations and later evidence to the exact requirement IDs and source revision.

## Approval checkpoint

Before staging, show:

- the chosen architecture and rejected alternatives;
- exact parts and footprints, including evidence gaps;
- the requirement/assumption delta since the previous preview;
- predicted electrical, thermal, mechanical, and manufacturing margins;
- the semantic and visual diff plus exact preview digest/revision;
- all unresolved warnings, unknowns, and release blockers.

Ask the user to approve that exact preview. If anything material changes, ask again with a new preview identity.
