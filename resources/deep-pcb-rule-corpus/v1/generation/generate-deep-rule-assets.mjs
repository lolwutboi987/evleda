import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "..");
const researchDir = resolve(workspace, "docs", "pcb-design-guides", "research");

const topics = [
  {
    number: "01", slug: "schematic-quality", topic: "High-quality schematic diagrams",
    articleTitle: "Creating High-Quality Schematic Diagram: A Professional and Simplified Workflow",
    articleUrl: "https://jlcpcb.com/blog/creating-high-quality-schematic-diagram",
    dossier: "01-high-quality-schematic.md",
    scope: "Schematic capture as an electrically complete, reviewable design contract: controlled symbols and libraries, hierarchy, net naming, power intent, ERC, BOM/PCB synchronization, and peer review.",
    inputs: ["Exact parts, packages, and current datasheets", "Schematic, netlist, BOM, and footprint associations", "EDA tool/version and label/power/ERC semantics", "Interface, power, safety, and layout-driving requirements"],
    dependencies: ["gpio-pinouts", "layout-process", "component-placement", "pcb-design-lifecycle"],
    tags: ["schematic", "erc", "libraries", "netlist", "documentation"]
  },
  {
    number: "02", slug: "trace-current", topic: "Trace width versus current capacity",
    articleTitle: "Track Width v/s Current Capacity: PCB Layout Tips for Power Routing",
    articleUrl: "https://jlcpcb.com/blog/track-width-vs-current-capacity-pcb-layout-tips",
    dossier: "02-trace-width-current.md",
    scope: "Power-path sizing from finished copper geometry, RMS/peak/fault current, voltage drop, temperature rise, transient response, vias, interconnects, tolerances, and validation.",
    inputs: ["Complete source and return path", "DC/RMS/peak/pulse/inrush/fault waveform", "Voltage-drop, self-rise, and absolute-temperature limits", "Minimum finished copper/via geometry and environment", "Protection clearing and I-squared-t data"],
    dependencies: ["power-integrity", "dfm", "assembly", "layout-process"],
    tags: ["power", "current", "thermal", "voltage-drop", "vias", "fault"]
  },
  {
    number: "03", slug: "layout-guide", topic: "Ultimate PCB layout design guide",
    articleTitle: "The Ultimate Guide to PCB Layout Design",
    articleUrl: "https://jlcpcb.com/blog/guide-to-pcb-layout-design",
    dossier: "03-ultimate-pcb-layout.md",
    scope: "End-to-end layout requirements, stackup, floorplanning, placement, routing priority, return paths, DFM/DFA/DFT, verification gates, and AI escalation.",
    inputs: ["Verified schematic, BOM, footprints, and datasheets", "Board outline, enclosure, and mechanical constraints", "Selected fabricator/assembler and stackup", "Current, voltage, SI, PI, thermal, safety, and test constraints"],
    dependencies: ["schematic-quality", "stackup-impedance", "signal-integrity", "power-integrity", "dfm", "assembly", "component-placement"],
    tags: ["layout", "floorplan", "routing", "verification", "release"]
  },
  {
    number: "04", slug: "stackup-impedance", topic: "Layer stackup and controlled impedance",
    articleTitle: "Comprehensive Layer Stack-Up Design for High-Speed Controlled Impedance PCBs",
    articleUrl: "https://jlcpcb.com/blog/layer-stackup-design-high-speed-pcbs",
    dossier: "04-layer-stackup-controlled-impedance.md",
    scope: "Controlled-impedance stackup contracts, transmission-line structures, Dk/Df and copper metadata, field solving, tolerance analysis, return continuity, coupons, TDR, and fabricator authority.",
    inputs: ["Interface impedance definition, tolerance, edge/band, and channel limits", "Exact stack ID, materials, pressed dielectrics, copper profile, and mask", "Line structure, layer, references, width/gap, neighboring copper, and transitions", "Fabricator process center/tolerances and coupon acceptance method"],
    dependencies: ["signal-integrity", "impedance-matching", "differential-pairs", "hf-emc-si", "bga"],
    tags: ["stackup", "controlled-impedance", "field-solver", "materials", "tdr", "fabricator"]
  },
  {
    number: "05", slug: "signal-integrity", topic: "Signal integrity",
    articleTitle: "Signal Integrity (SI) in PCB Layout",
    articleUrl: "https://jlcpcb.com/blog/signal-integrity-si-in-pcb-layout",
    dossier: "05-signal-integrity.md",
    scope: "Edge-rate and flight-time screening, reflections, crosstalk, return paths, discontinuities, termination, loss, skew/jitter/eyes, model QA, simulation, measurement, and sign-off boundaries.",
    inputs: ["Exact interface, topology, directions, and receiver acceptance limits", "Fastest/slowest edge and driver/load/package models", "Released stackup, impedance, via, connector, and material data", "Aggressors, routed geometry, simulation corners, and measurement reference planes"],
    dependencies: ["stackup-impedance", "impedance-matching", "differential-pairs", "hf-emc-si", "bga"],
    tags: ["si", "edge-rate", "reflections", "crosstalk", "timing", "simulation"]
  },
  {
    number: "06", slug: "impedance-matching", topic: "Impedance matching",
    articleTitle: "Understanding Impedance Matching for High-Speed PCB Designs",
    articleUrl: "https://jlcpcb.com/blog/understanding-impedance-matching-for-high-speed-pcb-designs",
    dossier: "06-impedance-matching.md",
    scope: "Digital termination, RF matching, impedance vocabulary, reflection metrics, discontinuity and reference design, model fidelity, corner simulation, fabrication control, and measurement.",
    inputs: ["Exact interface/objective, topology, direction, and idle states", "Target impedance/mode/tolerance and edge or RF band", "Driver/receiver/channel models and electrical acceptance limits", "Finished stackup, route geometry, return path, and verification plan"],
    dependencies: ["stackup-impedance", "signal-integrity", "differential-pairs", "hf-emc-si"],
    tags: ["impedance", "termination", "rf", "reflection", "simulation", "measurement"]
  },
  {
    number: "07", slug: "differential-pairs", topic: "Differential pairs",
    articleTitle: "Differential Pairs on PCBs: Best Practices for Routing, Impedance Control, and Signal Integrity",
    articleUrl: "https://jlcpcb.com/blog/differential-pairs-pcb-practices",
    dossier: "07-differential-pairs.md",
    scope: "Differential/common-mode behavior, coupled geometry, return paths, delay/skew, transitions, breakouts, components, glass weave, channel modeling, measurement, automation severities, and waivers.",
    inputs: ["Protocol/device revision, lane role, polarity, topology, and BER/mask target", "Differential/leg/common impedance and delay/skew/loss limits", "Package, connector, cable, ESD/choke, and termination models", "Released stackup, via construction, geometry tolerances, and evidence owners"],
    dependencies: ["stackup-impedance", "signal-integrity", "impedance-matching", "bga", "hf-emc-si"],
    tags: ["differential", "skew", "mode-conversion", "coupled-lines", "glass-weave"]
  },
  {
    number: "08", slug: "power-integrity", topic: "Power integrity",
    articleTitle: "Power Integrity (PI) in PCB Layout",
    articleUrl: "https://jlcpcb.com/blog/power-integrity-pi-in-pcb-layout",
    dossier: "08-power-integrity.md",
    scope: "Rail voltage budgeting, target impedance, load transients, VRM stability, mounted capacitor behavior, anti-resonance, planes, DC/AC analysis, package/die boundaries, probing, and correlation.",
    inputs: ["Rail limits, observation point, bandwidth, and DC/AC budgets", "Load currents, delta-I, edge/pulse/spectrum, and concurrent modes", "Exact VRM and capacitor models under bias/temperature", "Finished PCB/package/die models, ports, fixtures, environment, and acceptance cases"],
    dependencies: ["trace-current", "stackup-impedance", "component-placement", "bga", "hf-emc-si"],
    tags: ["pi", "pdn", "vrm", "decoupling", "target-impedance", "transient"]
  },
  {
    number: "09", slug: "emi-emc", topic: "EMI versus EMC",
    articleTitle: "EMI vs EMC: A Full Guide to Detailed Comparison",
    articleUrl: "https://jlcpcb.com/blog/emivsemc",
    dossier: "09-emi-vs-emc.md",
    scope: "Terminology, source-path-victim analysis, differential/common-mode coupling, PCB/enclosure/cable controls, pre-compliance, debugging, jurisdiction-specific standards, documentation, and prohibited compliance claims.",
    inputs: ["Destination markets, product classification, standards, editions, and environment", "Worst-case functional modes, sources, victims, and recovery criteria", "Stackup, PDN, interfaces, cables, enclosure, safety, and manufacturing constraints", "Raw test setup/data, limits, detector/bandwidth/distance, and configuration"],
    dependencies: ["hf-emc-si", "signal-integrity", "power-integrity", "component-placement", "pcb-design-lifecycle"],
    tags: ["emi", "emc", "compliance", "immunity", "emissions", "debug"]
  },
  {
    number: "10", slug: "hf-emc-si", topic: "High-frequency EMI, EMC, and SI",
    articleTitle: "How to Tackle EMI/EMC and Signal Integrity Issues in HF PCB Design",
    articleUrl: "https://jlcpcb.com/blog/emi-emc-and-signal-integrity-issues-in-hf-pcb",
    dossier: "10-hf-emi-emc-si.md",
    scope: "Field/current-path analysis for fast digital and switch-mode circuits: edge spectra, return loops, transitions, common-mode conversion, partitioning, stackup, filtering, shielding, simulation, and test.",
    inputs: ["Fastest edge, topology, source/load, and interface constraints", "Complete signal/return loops, stackup, transitions, and fabrication tolerances", "Converter modes/loads, enclosure/cables/shields, and isolation/PE architecture", "Destination standards and pre-compliance/final-test plan"],
    dependencies: ["emi-emc", "signal-integrity", "power-integrity", "stackup-impedance", "impedance-matching"],
    tags: ["high-frequency", "emi", "emc", "si", "return-path", "common-mode"]
  },
  {
    number: "11", slug: "dfm", topic: "Design for manufacturability",
    articleTitle: "DFM (Design for Manufacturability) Guidelines",
    articleUrl: "https://jlcpcb.com/blog/dfm-design-for-manufacturability-guidelines",
    dossier: "11-dfm-guidelines.md",
    scope: "Named fabrication profiles, copper/drill/mask/edge/stackup/special-process constraints, panel and data package, CAD DRC, export inspection, supplier review, change discipline, and AI authority limits.",
    inputs: ["Board revision/archive hash and intended fabricator/service", "Quoted stackup, thickness, copper, finish, holes, panel, and special processes", "Assembly scope, controlled-impedance scope, DRC profile, and supplier DFM", "Source URLs/dates, process conditions, owners, and dispositions"],
    dependencies: ["assembly", "layout-process", "stackup-impedance", "trace-current", "bga"],
    tags: ["dfm", "fabrication", "drc", "gerber", "cam", "supplier"]
  },
  {
    number: "12", slug: "assembly", topic: "PCB assembly guidelines",
    articleTitle: "PCB Assembly Guidelines",
    articleUrl: "https://jlcpcb.com/blog/pcb-assembly-guidelines",
    dossier: "12-pcb-assembly-guidelines.md",
    scope: "Exact-package land patterns, courtyards, polarity, mask/paste/stencil, thermal pads/via-in-pad, placement/access, assembly data, process controls, inspection, rework, MSL, ESD, and first article.",
    inputs: ["Exact fitted MPNs, package drawings, footprint provenance, and population states", "Assembler process/capability, spacing/access, panel, stencil, and inspection rules", "Reconciled BOM/CPL/fab/assembly/paste data and rotations", "MSL, ESD, cleaning, reflow/wave/manual/rework/test requirements"],
    dependencies: ["dfm", "component-placement", "bga", "schematic-quality", "pcb-design-lifecycle"],
    tags: ["assembly", "dfa", "footprint", "paste", "stencil", "inspection", "rework"]
  },
  {
    number: "13", slug: "layout-process", topic: "PCB layout process",
    articleTitle: "Mastering PCB Design: A Step-by-Step PCB Layout Process Guide",
    articleUrl: "https://jlcpcb.com/blog/pcb-layout-process-guide-2026-mastering-pcb-design",
    dossier: "13-layout-process.md",
    scope: "A controlled state machine from verified inputs through constraints, stackup, floorplan, placement, critical routing, zones, verification, release, change control, and reuse.",
    inputs: ["Requirements, board class, safety scope, exact parts, and tool revisions", "Schematic/netlist/library identity and current device guidance", "Fabricator/assembler, stackup, mechanical envelope, and constraint sources", "Verification matrix, waivers, change baseline, and release authority"],
    dependencies: ["schematic-quality", "layout-guide", "component-placement", "dfm", "assembly", "pcb-design-lifecycle"],
    tags: ["layout-process", "state-machine", "change-control", "verification", "release"]
  },
  {
    number: "14", slug: "gpio-pinouts", topic: "GPIO pinout basics",
    articleTitle: "GPIO Pinout Basics: A Guide for Beginners",
    articleUrl: "https://jlcpcb.com/blog/critical-role-of-gpio-pinouts-selection-in-embedded-systems",
    dossier: "14-gpio-pinout-basics.md",
    scope: "Package/header/firmware mapping, mux and reset states, logic thresholds, drive/current, pulls, voltage compatibility, boot/debug/power domains, protection, connector boundaries, and hardware/firmware validation.",
    inputs: ["Exact MCU/package/silicon revision, datasheet, manual, and errata", "Per-pad package/net/firmware/mux/domain/reset/electrical matrix", "Connected-device data, ICD, power-state table, and protection path", "Firmware build/configuration and electrical/bring-up/boundary test plan"],
    dependencies: ["schematic-quality", "signal-integrity", "emi-emc", "component-placement", "pcb-design-lifecycle"],
    tags: ["gpio", "pinout", "firmware", "mux", "logic-level", "connector"]
  },
  {
    number: "15", slug: "pcb-design-lifecycle", topic: "How to design a PCB",
    articleTitle: "How to Design a PCB? PCB Layout Engineer Must Know!",
    articleUrl: "https://jlcpcb.com/blog/how-to-design-a-pcb-pcb-layout-engineer-must-know",
    dossier: "15-how-to-design-pcb.md",
    scope: "Requirements-to-release lifecycle: architecture, schematic/library control, constraints, placement/routing, mechanical/thermal/assembly/test readiness, distinct verification gates, output review, prototype iteration, and qualification boundaries.",
    inputs: ["Requirements and acceptance matrix with owners", "Exact architecture, parts, interfaces, sources, and constraints", "Ordered fabrication/assembly process and complete release package", "Independent reviews, waivers, as-built record, and qualification evidence"],
    dependencies: ["schematic-quality", "layout-guide", "layout-process", "dfm", "assembly", "emi-emc"],
    tags: ["design-lifecycle", "requirements", "architecture", "qualification", "release"]
  },
  {
    number: "16", slug: "component-placement", topic: "Component placement",
    articleTitle: "PCB Component Placement: A Practical Guide to Clean, Routable Layout",
    articleUrl: "https://jlcpcb.com/blog/pcb-component-placement-a-practical-guide-to-clean-routable-layout",
    dossier: "16-component-placement.md",
    scope: "Mechanical anchors, functional zoning, interfaces, power hot loops, decoupling, sensitive paths, thermal/return planning, keepouts, DFM/test access, ratsnest metrics, critical-route proofs, and 3D review.",
    inputs: ["Board/enclosure/height/keepout and connector constraints", "Exact parts, package/layout/thermal guidance, and assembly process", "Net/component noise, energy, sensitivity, impedance, safety, and test classifications", "Stackup/reference intent, critical routes, return/current/thermal paths, and 3D access"],
    dependencies: ["layout-process", "power-integrity", "signal-integrity", "assembly", "bga"],
    tags: ["placement", "floorplan", "decoupling", "thermal", "mechanical", "ratsnest"]
  },
  {
    number: "17", slug: "bga", topic: "BGA layout and escape routing",
    articleTitle: "BGA PCB Design Complete Guide: Layout and Routing Guidelines",
    articleUrl: "https://jlcpcb.com/blog/bga-pcb-design-complete-guide-layout-and-routing-guidelines",
    dossier: "17-bga-layout-routing.md",
    scope: "Exact package/ball-map control, land/mask/paste, escape feasibility equations, dogbone/VIPPO/HDI/backdrill structures, layer/channel planning, SI/PI/timing, assembly/inspection/rework/DFT, and hard-stop release logic.",
    inputs: ["Exact MPN/package revision, drawing, ball map, view convention, and every ball disposition", "Numeric electrical groups, impedance/skew/loss/current/PDN/test constraints", "Quoted stackup and job-specific trace/via/mask/HDI/VIPPO/backdrill capability", "Assembler approval for land/paste/reflow/warpage/X-ray/rework/test"],
    dependencies: ["stackup-impedance", "differential-pairs", "power-integrity", "dfm", "assembly", "component-placement"],
    tags: ["bga", "escape", "vippo", "microvia", "ball-map", "dft"]
  }
];

const inconsistencies = [
  ["03", "The originally supplied `/the-ultimate-guide-to-pcb-layout-design` URL returned 404; the dossier uses JLCPCB's indexed `guide-to-pcb-layout-design` page and preserves that substitution."],
  ["04", "The article's ±10%/optional ±5% impedance-test language conflicts with JLCPCB's current ±20% standard-test help text; no tighter guarantee is inferred without job confirmation."],
  ["05", "The supplied SI article returned 404; a related accessible JLCPCB summary is used only for bounded introductory claims."],
  ["06", "The supplied impedance-matching URL returned 404; the current same-topic successor is not assumed byte-identical."],
  ["07", "The supplied differential-pairs URL returned 404; a current closely matching JLCPCB article is treated as the seed."],
  ["08", "The supplied PI article returned 404; its full text and metadata remain unverified, and only a later indexed summary is used."],
  ["10", "The requested HF article URL returned 404 while a shorter canonical URL was available; the source also has conflicting publication-date metadata and internally contradictory guidance."],
  ["11", "The requested DFM article returned 404. JLCPCB's live capability page is used, but that page itself conflicts on blind/buried-via support."],
  ["12", "The supplied assembly article returned 404; current JLCPCB help pages and primary package/process sources replace it for technical evidence."],
  ["17", "The BGA article recommends microvia/HDI planning at 0.4 mm while JLCPCB's current capability page says blind/buried vias are unsupported; STOP_FAB_PROCESS_CONFLICT remains mandatory until written job-specific approval."],
  ["17", "The BGA article overstates IPC-7095 as an acceptance source; the dossier preserves IPC-7095 as implementation guidance and points assembly acceptance to J-STD-001/IPC-A-610."],
  ["10", "The 20H rule has conflicting simulation and measurement evidence; the dossier intentionally retains it as geometry-dependent rather than averaging the sources." ]
];

const modal = /\b(?:must(?:\s+not)?|shall(?:\s+not)?|should(?:\s+not)?|never|required|require|refuse|unknown|blocked_input|pass|fail|hard\s+stop|halt|escalat\w*|ask|human|do\s+not|cannot|only\s+if|only\s+when|approval|approver|waiver)\b/iu;
const selectedHeading = /(?:\bAI\b|agent|inputs?\b|checklists?|release|verification|review gate|hard rules?|hard stop|stop conditions?|deterministic|prohibited|machine-actionable|decision flow|decision procedure|required outputs?|required documents?|fabrication data package|change protocol|reuse policy|false-completion|non-negotiable|operating procedure|automation contract|implementation specification)/iu;
const operationalHeading = /(?:principles|rules|workflow|procedure|sequence|controls|guidelines|placement|routing|layout|fabrication|assembly|validation|measurement|simulation|model QA|exceptions)/iu;
const selectedTable = /(?:required|verification|check|gate|must|do not|input|condition|resolution|allowed assistance|rule|requirement|evidence to advance|hard stop|status|pass|fail|human disposition)/iu;
const excludedHeading = /(?:claim-to-source|source ledger|source register|search(?:es)? performed|research (?:coverage|limitations|method)|stop rationale|stopping rationale|evidence gaps?|limitations and unresolved|article claim audit|audit of the .*article|status of the required|the required article|what the required article|what .* article contributes|worked (?:examples?|micro-examples)|frequent failure|common failure|gap matrix|reconciled disagreements)/iu;
const narrativeHeading = /(?:direct conclusion|direct answer|executive answer|executive conclusion|executive determination|executive guidance|scope|definitions|terminology)/iu;

const cleanUrl = (value) => value.replace(/^[<(\[]+|[>`)\],.;:]+$/gu, "");
const urlsIn = (text) => {
  const found = text.match(/https:\/\/[^\s)>\]`]+/gu) ?? [];
  return [...new Set(found.map(cleanUrl).filter((url) => {
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  }))];
};
const stripMarkdown = (value) => value
  .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?/u, "")
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/gu, "$1 ($2)")
  .replace(/\*\*([^*]+)\*\*/gu, "$1")
  .replace(/^\s*\|\s*|\s*\|\s*$/gu, "")
  .replace(/\s+/gu, " ").trim();
const stripHeadingMarkdown = (value) => value
  .replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/gu, "$1 ($2)")
  .replace(/\*\*([^*]+)\*\*/gu, "$1")
  .replace(/\s+/gu, " ").trim();
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const normalize = (text) => stripMarkdown(text).toLocaleLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
const gfmAnchorBase = (heading) => stripHeadingMarkdown(heading)
  .toLocaleLowerCase()
  .replace(/<[^>]*>/gu, "")
  .replace(/[^\p{L}\p{N}\s_-]/gu, "")
  .replace(/\s/gu, "-");

function categoryFor(section, instruction) {
  const text = `${section} ${instruction}`.toLocaleLowerCase();
  if (/prohibited|must not|shall not|never|do not|refuse/.test(text)) return "prohibited-inference";
  if (/hard stop|stop condition|blocked_input|\bhalt\b|\bescalat/.test(text)) return "hard-stop";
  if (/required input|minimum input|mandatory input|input contract|before .* may/.test(text)) return "required-input";
  if (/required output|finding format|output schema|review packet/.test(text)) return "required-output";
  if (/unknown|missing input/.test(text)) return "unknown-handling";
  if (/release|sign-off|qualification|fabrication-ready|production-ready/.test(text)) return "release-gate";
  if (/checklist|verification|review|drc|erc|test|measure|inspect|validate/.test(text)) return "verification";
  if (/equation|calculate|compute|solver|model|simulation|tolerance|sweep/.test(text)) return "analysis";
  if (/source|provenance|revision|datasheet|specification/.test(text)) return "source-governance";
  return "design-action";
}

function severityFor(section, instruction, severityCell = "") {
  const text = `${section} ${instruction} ${severityCell}`.toLocaleLowerCase();
  if (/release blocker|hard stop|\bblock\b|must not|shall not|never|refuse|do not claim|do not allow/.test(text)) return "critical";
  if (/\berror\b|\bmust\b|\bshall\b|required|checklist|\bfail\b/.test(text)) return "error";
  if (/\bwarn|\bshould\b|recommended|provisional|unknown/.test(text)) return "warning";
  return "advisory";
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => stripMarkdown(cell));
}

function parseRules(topic, text) {
  const lines = text.split(/\r?\n/u);
  const headings = [];
  const headingSlugCounts = new Map();
  const extracted = [];
  let hasLevelTwoHeading = false;

  const currentHeading = () => headings.filter(Boolean).at(-1);
  const add = ({ instruction, lineStart, lineEnd = lineStart, rationale, exception, severity }) => {
    const cleaned = stripMarkdown(instruction);
    const heading = currentHeading();
    if (!heading || !hasLevelTwoHeading || !cleaned || cleaned.length < 4) return;
    const sourceText = lines.slice(lineStart - 1, lineEnd).join("\n");
    if (!sourceText.trim()) return;
    extracted.push({
      instruction: cleaned,
      sourceText,
      lineStart,
      lineEnd,
      heading: heading.text,
      headingAnchor: heading.anchor,
      rationale,
      exception,
      severity
    });
  };

  const headingIsExcluded = () => excludedHeading.test(currentHeading()?.text ?? "");
  const headingIsNarrative = () => narrativeHeading.test(currentHeading()?.text ?? "");
  const headingIsSelected = () => selectedHeading.test(currentHeading()?.text ?? "");
  const headingIsOperational = () => operationalHeading.test(currentHeading()?.text ?? "");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/u);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const headingText = stripHeadingMarkdown(headingMatch[2]);
      const base = gfmAnchorBase(headingMatch[2]);
      const duplicateIndex = headingSlugCounts.get(base) ?? 0;
      headingSlugCounts.set(base, duplicateIndex + 1);
      const anchor = duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`;
      headings.length = level - 1;
      headings[level - 1] = { level, text: headingText, anchor };
      if (level === 2) hasLevelTwoHeading = true;
      i += 1;
      continue;
    }

    if (!hasLevelTwoHeading) {
      i += 1;
      continue;
    }

    if (/^```/u.test(line.trim())) {
      const fenceStart = i;
      const block = [];
      i += 1;
      while (i < lines.length && !/^```/u.test((lines[i] ?? "").trim())) {
        block.push({ raw: lines[i] ?? "", absoluteIndex: i });
        i += 1;
      }
      i += 1;
      if (headingIsExcluded()) continue;

      if (/input/iu.test(currentHeading()?.text ?? "")) {
        const stack = [];
        for (let j = 0; j < block.length; j += 1) {
          const entry = block[j];
          if (!entry || !entry.raw.trim() || /^#/u.test(entry.raw.trim())) continue;
          const indent = entry.raw.match(/^\s*/u)?.[0].length ?? 0;
          const yaml = entry.raw.match(/^\s*([A-Za-z0-9_/-]+):\s*(.*)$/u);
          if (yaml) {
            while (stack.length && stack.at(-1).indent >= indent) stack.pop();
            const key = yaml[1];
            const value = yaml[2].replace(/\s+#.*$/u, "").trim();
            const next = block[j + 1]?.raw ?? "";
            const nextIndent = next.match(/^\s*/u)?.[0].length ?? 0;
            const isContainer = value.length === 0 && next.trim().length > 0 && nextIndent > indent;
            if (isContainer) {
              stack.push({ indent, key, absoluteIndex: entry.absoluteIndex });
              continue;
            }
            const path = [...stack.map((item) => item.key), key].join(".");
            add({
              instruction: `Provide required input \`${path}\`${value ? `: ${value}` : "."}`,
              lineStart: (stack[0]?.absoluteIndex ?? entry.absoluteIndex) + 1,
              lineEnd: entry.absoluteIndex + 1
            });
            continue;
          }
          const group = entry.raw.match(/^\s{0,2}([A-Z][A-Z0-9_/ -]+)$/u);
          if (group) {
            stack.length = 0;
            stack.push({ indent: 0, key: group[1].trim(), absoluteIndex: entry.absoluteIndex });
            continue;
          }
          if (/^\s+\S/u.test(entry.raw)) {
            add({
              instruction: `Provide required input for ${stack.map((item) => item.key).join(" / ") || topic.topic}: ${entry.raw.trim()}.`,
              lineStart: (stack[0]?.absoluteIndex ?? entry.absoluteIndex) + 1,
              lineEnd: entry.absoluteIndex + 1
            });
          }
        }
      } else if (/decision flow|stage machine/iu.test(currentHeading()?.text ?? "")) {
        let current = null;
        for (const entry of block) {
          const step = entry.raw.match(/\+--\s*(\d+)\.\s*(.+)$/u);
          if (step) {
            if (current) add(current);
            current = { instruction: step[2], lineStart: entry.absoluteIndex + 1, lineEnd: entry.absoluteIndex + 1 };
          } else if (current && entry.raw.trim() && !/^\||START$/u.test(entry.raw.trim())) {
            current.instruction += ` ${entry.raw.replace(/^[\s|+\-]+/u, "").trim()}`;
            current.lineEnd = entry.absoluteIndex + 1;
          }
        }
        if (current) add(current);
      }
      continue;
    }

    if (/^\s*\|/u.test(line) && /^\s*\|?\s*:?-{3,}/u.test(lines[i + 1] ?? "")) {
      const headers = splitTableRow(line);
      const tableSelected = !headingIsExcluded() && !headingIsNarrative()
        && (headingIsSelected() || selectedTable.test(headers.join(" ")));
      i += 2;
      while (i < lines.length && /^\s*\|/u.test(lines[i] ?? "")) {
        const raw = lines[i] ?? "";
        const cells = splitTableRow(raw);
        if (tableSelected && cells.some(Boolean)) {
          const named = headers.map((header, index) => [header || `field-${index + 1}`, cells[index] ?? ""]);
          const get = (pattern) => named.find(([header]) => pattern.test(header))?.[1] ?? "";
          const primary = get(/requirement|machine-checkable rule|rule$|required fields|required content|condition|check$|permitted work|allowed assistance|evidence to advance/i);
          const label = cells[0] ?? "";
          const instruction = primary && primary !== label
            ? `${label}: ${primary}`
            : named.filter(([, value]) => value).map(([header, value]) => `${header}: ${value}`).join("; ");
          add({
            instruction,
            lineStart: i + 1,
            rationale: get(/reason|rationale|why|risk|does not prove|review implication/i),
            exception: get(/exception|allowed|resolution|hard stop|human disposition/i),
            severity: get(/severity/i)
          });
        }
        i += 1;
      }
      continue;
    }

    const list = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.+)$/u);
    if (list) {
      const start = i;
      let content = list[1];
      let j = i + 1;
      while (j < lines.length) {
        const continuation = lines[j] ?? "";
        if (!continuation.trim() || /^(?:#{1,6}\s|```|\s*\||\s*(?:[-*+]|\d+\.)\s+)/u.test(continuation)) break;
        content += ` ${continuation.trim()}`;
        j += 1;
      }
      const context = lines.slice(Math.max(0, start - 4), start).join(" ");
      const contextualRequirement = /(?:the (?:AI|agent) shall|the following .* normative|(?:requires?|needs|must include).{0,40}(?:the following|all of the following|these)|at minimum|minimum package|release-ready|answer “yes”|answer "yes")/iu.test(context);
      const include = !headingIsExcluded() && (
        headingIsSelected()
        || (!headingIsNarrative() && headingIsOperational())
        || modal.test(content)
        || contextualRequirement
        || /^\s*[-*+]\s+\[[ xX]\]/u.test(line)
      );
      if (include) add({ instruction: content, lineStart: start + 1, lineEnd: j });
      i = j;
      continue;
    }

    if (line.trim() && !/^\s*>/u.test(line)) {
      const start = i;
      let paragraph = line.trim();
      i += 1;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (!next.trim() || /^(?:#{1,6}\s|```|\s*\||\s*(?:[-*+]|\d+\.)\s+)/u.test(next)) break;
        paragraph += ` ${next.trim()}`;
        i += 1;
      }
      if (!headingIsExcluded() && !headingIsNarrative() && modal.test(paragraph)) {
        add({ instruction: paragraph, lineStart: start + 1, lineEnd: i });
      }
      continue;
    }
    i += 1;
  }

  const deduped = [];
  const seen = new Set();
  for (const item of extracted) {
    const key = normalize(item.instruction);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

const dossierFiles = readdirSync(researchDir).filter((name) => /^\d{2}-.*\.md$/u.test(name)).sort();
if (dossierFiles.length !== 17) throw new Error(`Expected 17 dossiers, found ${dossierFiles.length}`);

const sourceDossiers = [];
const rules = [];
for (const topic of topics) {
  const path = resolve(researchDir, topic.dossier);
  const text = readFileSync(path, "utf8");
  const relativePath = `docs/pcb-design-guides/research/${topic.dossier}`;
  const dossierUrls = urlsIn(text).filter((url) => url !== topic.articleUrl);
  const authoritativeUrls = dossierUrls.filter((url) => !new URL(url).hostname.endsWith("jlcpcb.com"));
  const primaryUrls = [...new Set((authoritativeUrls.length > 0 ? authoritativeUrls : dossierUrls).slice(0, 3))];
  const extracted = parseRules(topic, text);
  sourceDossiers.push({
    number: topic.number,
    slug: topic.slug,
    topic: topic.topic,
    dossierPath: relativePath,
    articleTitle: topic.articleTitle,
    articleUrl: topic.articleUrl,
    scope: topic.scope,
    majorDecisionInputs: topic.inputs,
    dependencies: topic.dependencies,
    tags: topic.tags,
    sha256: hash(text),
    lineCount: text.split(/\r?\n/u).length,
    ruleCount: extracted.length
  });
  extracted.forEach((item, index) => {
    const instructionUrls = urlsIn(`${item.instruction} ${item.sourceText}`);
    const category = categoryFor(item.heading, item.instruction);
    const severity = severityFor(item.heading, item.instruction, item.severity);
    const requiredInputs = category === "required-input"
      ? [item.instruction]
      : [`Use the ${topic.slug} topic-level majorDecisionInputs and the object-specific facts named by this instruction.`];
    const checks = category === "verification"
      ? [item.instruction]
      : category === "prohibited-inference"
        ? [`Confirm the prohibited action or inference is absent: ${item.instruction}`]
        : category === "hard-stop"
          ? ["Evaluate the stated stop condition and require its documented resolution before proceeding."]
          : ["Verify this instruction against the cited dossier location and current governing evidence."];
    const exceptions = item.exception
      ? [item.exception]
      : ["No implicit exception. Any exception must be source-scoped, evidence-backed, owned, approved by the responsible human or supplier when applicable, and assigned a recheck trigger."];
    const preferredSources = [...new Set([
      ...instructionUrls.filter((url) => url !== topic.articleUrl),
      ...primaryUrls
    ])].slice(0, 4);
    rules.push({
      id: `PCB${topic.number}-R${String(index + 1).padStart(3, "0")}`,
      category,
      topic: topic.slug,
      tags: [...new Set([...topic.tags, category])],
      instruction: item.instruction,
      rationale: item.rationale || `Operationalizes the ${item.heading} requirement while preserving the dossier's evidence and authority boundary.`,
      applicability: `Apply only when topic \`${topic.slug}\` and the affected object, net, interface, or process are explicitly selected.`,
      requiredInputs,
      checks,
      missingInputAction: "Return UNKNOWN or the dossier-specific blocked/stop status for the affected conclusion; identify the missing fact and owner, ask for current evidence or human/supplier disposition, and do not imply manufacturing, compliance, safety, qualification, or release approval.",
      exceptions,
      severity,
      vendorScope: /jlcpcb/iu.test(`${item.instruction} ${item.heading}`)
        ? "JLCPCB-specific where stated; reverify in the live service, quote, order, and written job confirmation."
        : "Vendor-neutral principle; numeric/process application remains scoped to the selected device, interface, fabricator, assembler, and current revisions.",
      dossierPath: relativePath,
      dossierHeading: item.heading,
      headingAnchor: item.headingAnchor,
      dossierLineStart: item.lineStart,
      dossierLineEnd: item.lineEnd,
      sourceText: item.sourceText,
      articleUrl: topic.articleUrl,
      primarySourceUrls: preferredSources.length > 0 ? preferredSources : [topic.articleUrl]
    });
  });
}

const catalog = {
  schemaVersion: 1,
  generatedFrom: "The 17 canonical dossiers in docs/pcb-design-guides/research; dossiers are not modified or replaced by this derivative catalog.",
  disclaimer: "This catalog is engineering review support. Selection or rendering does not authorize fabrication, manufacturing, ordering, compliance, safety, qualification, or release. PASS means only the explicitly configured and evidenced check passed; consequential missing inputs remain UNKNOWN or blocked.",
  sourceDossiers,
  rules
};

const counts = new Map(sourceDossiers.map((item) => [item.slug, item.ruleCount]));
const readme = `# PCB design guide index\n\n> **This document is an index, not a substitute summary.** The 17 research dossiers are the canonical evidence records. Follow the dossier links for equations, units, exceptions, worked examples, evidence grading, and the complete source ledger. The derivative [agent rule library](./agent-rule-library.md) and [JSON catalog](./rule-catalog.json) support retrieval; neither replaces the dossiers or authorizes fabrication/release.\n\n## How to navigate the collection\n\n1. Start with **15** for lifecycle gates and **13** for the layout state machine.\n2. Use **01** and **14** before trusting schematic or firmware pin intent.\n3. Select physics-specific dossiers (**02**, **04–10**, **17**) only when their required inputs are available.\n4. Use **16** before routing, then **11–12** against the selected supplier/process.\n5. Treat every PASS as scoped to its named check. Missing consequential inputs remain UNKNOWN/BLOCKED, and humans/suppliers retain approval authority.\n\n## Exact article and dossier map\n\n${sourceDossiers.map((item) => `### ${item.number}. ${item.topic}\n\n- **Exact article/topic:** [${item.articleTitle}](${item.articleUrl})\n- **Canonical dossier:** [${item.dossierPath.replace("docs/pcb-design-guides/", "")}](${item.dossierPath.replace("docs/pcb-design-guides/", "")})\n- **Scope:** ${item.scope}\n- **Major decision inputs:** ${item.majorDecisionInputs.join("; ")}.\n- **Cross-topic dependencies:** ${item.dependencies.map((dep) => `\`${dep}\``).join(", ") || "None"}.\n- **Catalog coverage:** ${item.ruleCount} operational rules; SHA-256 \`${item.sha256}\`.\n`).join("\n")}\n## Cross-topic dependency routes\n\n| Design question | Start here | Then cross-check |\n|---|---|---|\n| Can the schematic/netlist be trusted? | 01 schematic quality; 14 GPIO | 15 lifecycle; 13 layout process |\n| Can a power path carry its waveform? | 02 trace/current | 08 PI; 16 placement; 11 DFM; 12 assembly |\n| Is a fast channel routable and verifiable? | 05 SI or 06 matching | 04 stackup; 07 differential; 10 HF; 17 BGA |\n| Is the board likely to meet emissions/immunity obligations? | 09 EMI/EMC | 10 HF; 05 SI; 08 PI; enclosure/cable/system evidence |\n| Is placement ready for routing? | 16 placement | 13 process; device-specific 02/05/08/17 rules |\n| Can the selected supplier build and assemble it? | 11 DFM; 12 assembly | 04 stackup; 17 BGA; current written quote/DFM |\n| Can the design be released? | 15 lifecycle; 13 process | All selected risk dossiers, independent artifact inspection, accountable sign-off |\n\n## Source inconsistencies intentionally preserved\n\nThese are not silently resolved in the catalog:\n\n${inconsistencies.map(([number, text]) => `- **${number}:** ${text}`).join("\n")}\n\n## Integrity snapshot\n\n- Canonical dossier count: **${sourceDossiers.length}**\n- Extracted operational rule count: **${rules.length}**\n- Per-topic counts: ${sourceDossiers.map((item) => `${item.number}=${item.ruleCount}`).join(", ")}\n- Catalog-generation policy: only operational rule-bearing structures and explicit modal conditions are extracted; metadata and research/source-ledger narrative are excluded. Exact dossier path, heading anchor, line span, joined source text, article URL, and dossier hash are retained.\n`;

const library = `# Deep PCB agent rule library\n\n> This is a verbose operational extraction of the 17 canonical dossiers. It is **not** a substitute summary, standard, supplier contract, manufacturing approval, compliance assessment, or release authorization. Each rule keeps a stable ID and source location. Retrieve only explicitly selected topics/tags; do not inject this entire library into every model call.\n\n## Rule semantics\n\n- **critical**: prohibited inference, hard stop, or authority/release boundary.\n- **error**: a required input, check, or mandatory action whose failure blocks the affected conclusion.\n- **warning**: an UNKNOWN/provisional condition or contextual rule requiring bounded evidence.\n- **advisory**: a design action that remains subject to the named applicability and sources.\n- **Missing input:** return UNKNOWN/BLOCKED for the affected conclusion, request the fact/owner/evidence, and never convert absence to zero, false, typical, safe, compliant, manufacturable, or released.\n- **Exceptions:** only explicit, source-scoped, evidence-backed exceptions with an accountable owner/approver and recheck trigger are allowed.\n\n${sourceDossiers.map((dossier) => {
  const topicRules = rules.filter((rule) => rule.topic === dossier.slug);
  return `## ${dossier.number}. ${dossier.topic}\n\n- Dossier: [${dossier.dossierPath}](${dossier.dossierPath.replace("docs/pcb-design-guides/", "")})\n- Article: [${dossier.articleTitle}](${dossier.articleUrl})\n- Applicability: ${dossier.scope}\n- Required decision inputs: ${dossier.majorDecisionInputs.join("; ")}.\n- Missing-input policy: return UNKNOWN/BLOCKED for the affected conclusion, identify the missing fact and owner, and do not imply approval or release.\n- Rules extracted: ${topicRules.length}.\n\n${topicRules.map((rule) => `### ${rule.id} — ${rule.category} / ${rule.severity}\n\n- **Instruction:** ${rule.instruction}\n- **Attribution:** [${rule.dossierHeading}](${rule.dossierPath.replace("docs/pcb-design-guides/", "")}#${rule.headingAnchor}); source lines ${rule.dossierLineStart}–${rule.dossierLineEnd}; exact span: \`${rule.sourceText.replace(/`/gu, "\\`").replace(/\n/gu, " ⏎ ")}\`\n- **Rationale/check:** ${rule.rationale} ${rule.checks.join("; ")}\n- **Exception:** ${rule.exceptions[0].startsWith("No implicit exception") ? "Global evidence, owner, approval, and recheck policy applies." : rule.exceptions.join("; ")}\n- **Scope/evidence:** ${rule.vendorScope} ${rule.primarySourceUrls.map((url) => `[source](${url})`).join("; ")}\n`).join("\n")}`;
}).join("\n")}\n`;

const files = [
  ["docs/pcb-design-guides/README.md", readme],
  ["docs/pcb-design-guides/agent-rule-library.md", library],
  ["docs/pcb-design-guides/rule-catalog.json", `${JSON.stringify(catalog, null, 2)}\n`]
];

const patchEscape = (content) => content.split("\n").map((line) => `+${line}`).join("\n");
const chunksFor = (content, maximumCharacters = 28_000) => {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of content.split("\n")) {
    if (current.length > 0 && size + line.length + 1 > maximumCharacters) {
      chunks.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length > 0) chunks.push(current.join("\n"));
  return chunks;
};

const [mode, fileId, chunkIndexText] = process.argv.slice(2);
if (mode === "--manifest") {
  process.stdout.write(JSON.stringify({
    ruleCount: rules.length,
    topics: sourceDossiers.map((item) => ({ number: item.number, slug: item.slug, ruleCount: item.ruleCount })),
    samples: sourceDossiers.map((dossier) => ({
      number: dossier.number,
      rules: rules.filter((rule) => rule.topic === dossier.slug).slice(0, 2).map((rule) => ({
        id: rule.id,
        heading: rule.dossierHeading,
        lines: `${rule.dossierLineStart}-${rule.dossierLineEnd}`,
        instruction: rule.instruction
      }))
    })),
    files: files.map(([path, content], index) => ({ id: String(index), path, bytes: Buffer.byteLength(content), chunks: chunksFor(content).length }))
  }));
} else if (mode === "--init") {
  process.stdout.write(`*** Begin Patch\n${files.map(([path], index) => `*** Add File: ${path}\n+@@DEEP_RULE_GENERATOR_${index}@@`).join("\n")}\n*** End Patch\n`);
} else if (mode === "--fill") {
  process.stdout.write(`*** Begin Patch\n${files.map(([path, content], index) => {
    const marker = `@@DEEP_RULE_GENERATOR_${index}@@`;
    return `*** Update File: ${path}\n@@\n-${marker}\n${patchEscape(content)}`;
  }).join("\n")}\n*** End Patch\n`);
} else if (mode === "--apply-chunks") {
  const codexExecutable = fileId;
  if (!codexExecutable) throw new Error("--apply-chunks requires the Codex executable path");
  let appliedCount = 0;
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const [path, content] = files[fileIndex];
    const chunks = chunksFor(content);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const marker = `@@DEEP_RULE_GENERATOR_${fileIndex}@@`;
      const replacement = `${patchEscape(chunks[chunkIndex])}${chunkIndex + 1 < chunks.length ? `\n+${marker}` : ""}`;
      const patch = `*** Begin Patch\n*** Update File: ${path}\n@@\n-${marker}\n${replacement}\n*** End Patch`;
      const result = spawnSync(codexExecutable, ["--codex-run-as-apply-patch", patch], { cwd: workspace, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`Patch ${fileIndex}/${chunkIndex} failed: ${result.stderr || result.stdout}`);
      appliedCount += 1;
      if (appliedCount % 25 === 0) process.stderr.write(`Applied ${appliedCount} chunks\n`);
    }
  }
  process.stdout.write(`Applied ${appliedCount} generated chunks with apply_patch.\n`);
} else if (mode === "--chunk") {
  const fileIndex = Number(fileId);
  const chunkIndex = Number(chunkIndexText);
  const selected = files[fileIndex];
  if (!selected) throw new Error(`Unknown file id ${fileId}`);
  const [path, content] = selected;
  const chunks = chunksFor(content);
  const chunk = chunks[chunkIndex];
  if (chunk === undefined) throw new Error(`Unknown chunk ${chunkIndexText} for ${path}`);
  const marker = `@@DEEP_RULE_GENERATOR_${fileIndex}@@`;
  const replacement = `${patchEscape(chunk)}${chunkIndex + 1 < chunks.length ? `\n+${marker}` : ""}`;
  process.stdout.write(`*** Begin Patch\n*** Update File: ${path}\n@@\n-${marker}\n${replacement}\n*** End Patch\n`);
} else {
  process.stdout.write(`*** Begin Patch\n${files.map(([path, content]) => `*** Add File: ${path}\n${patchEscape(content)}`).join("\n")}\n*** End Patch\n`);
}
