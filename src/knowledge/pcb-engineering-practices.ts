import { canonicalIdentity, canonicalJson, contentIdentity } from "../core/canonical.js";
import { DomainError } from "../domain/errors.js";
import type { CanonicalIdentity, ContentIdentity } from "../domain/types.js";
import { types as nodeTypes } from "node:util";

export const PCB_ENGINEERING_PRACTICE_SCHEMA =
  "evleda.pcb-engineering-practices.v1" as const;

export const PCB_ENGINEERING_ENFORCEMENT_CLASSES = Object.freeze([
  "hard_gate",
  "calculation_gate",
  "advisory",
  "fabricator_confirmation",
  "human_physical_gate"
] as const);

export type PcbEngineeringEnforcementClass =
  (typeof PCB_ENGINEERING_ENFORCEMENT_CLASSES)[number];

export const PCB_ENGINEERING_CHECKER_IDS = Object.freeze([
  "licensed_ipc2152_lookup_required_v1",
  "hot_copper_resistance_v1",
  "copper_voltage_drop_v1",
  "copper_i2r_loss_v1",
  "finished_geometry_evidence_v1",
  "via_barrel_resistance_v1",
  "component_thermal_evidence_v1",
  "thermal_relief_source_review_v1",
  "protection_coordination_evidence_v1",
  "insulation_classification_evidence_v1",
  "stackup_capability_evidence_v1",
  "interconnect_manufacturability_evidence_v1",
  "land_pattern_source_evidence_v1",
  "dfm_confirmation_evidence_v1"
] as const);

export type PcbEngineeringCheckerId = (typeof PCB_ENGINEERING_CHECKER_IDS)[number];

export const PCB_ENGINEERING_MODEL_IDS = Object.freeze([
  "ti-linear-copper-resistance-v1",
  "cylindrical-copper-annulus-v1"
] as const);

export type PcbEngineeringModelId = (typeof PCB_ENGINEERING_MODEL_IDS)[number];

export const PCB_ENGINEERING_CLAIM_FAMILIES = Object.freeze([
  "trace_ampacity",
  "voltage_drop_and_i2r",
  "via_current_and_thermal",
  "copper_weight_and_finished_geometry",
  "component_thermal_path",
  "thermal_relief_and_via_treatment",
  "connector_fuse_current_limit_coordination",
  "creepage_and_clearance",
  "stackup_and_fabricator_binding",
  "annular_ring_drill_aspect_ratio_microvia",
  "land_pattern_and_package_source",
  "dfm_and_assembly_constraints"
] as const);

export type PcbEngineeringClaimFamily =
  (typeof PCB_ENGINEERING_CLAIM_FAMILIES)[number];

export const PCB_ENGINEERING_SCOPE_PREDICATES = Object.freeze([
  "supported_low_voltage_rigid_pcb",
  "current_carrying_conductor_present",
  "via_carries_current_or_heat",
  "power_dissipating_component_present",
  "thermal_or_exposed_pad_present",
  "power_connector_or_protection_present",
  "distinct_conductive_domains_present",
  "multilayer_or_controlled_impedance_present",
  "plated_or_hdi_interconnect_present",
  "surface_mount_component_present",
  "fabrication_or_assembly_candidate"
] as const);

export type PcbEngineeringScopePredicate =
  (typeof PCB_ENGINEERING_SCOPE_PREDICATES)[number];

export const PCB_ENGINEERING_REQUIRED_INPUTS = Object.freeze([
  "maximum_continuous_current_a",
  "rms_current_a",
  "peak_current_a",
  "peak_duration_and_duty_cycle",
  "maximum_ambient_temperature_c",
  "allowable_conductor_temperature_rise_c",
  "estimated_copper_temperature_c",
  "conductor_length_mm",
  "minimum_finished_trace_width_mm",
  "minimum_finished_copper_thickness_mm",
  "conductor_layer_and_thermal_context",
  "fabricator_capability_snapshot_identity",
  "fabricator_service_and_order_options",
  "stackup_identity",
  "minimum_finished_via_hole_diameter_mm",
  "minimum_via_barrel_plating_thickness_mm",
  "via_hole_depth_mm",
  "via_count_placement_and_current_entry_geometry",
  "component_loss_model_and_operating_corner",
  "component_package_and_layout_source",
  "assembly_process_and_via_treatment",
  "connector_contact_wire_and_loaded_circuit_configuration",
  "connector_temperature_rise_curve",
  "fuse_voltage_interrupt_time_current_and_i2t_data",
  "current_limit_tolerance_soa_and_fault_response",
  "prospective_fault_current_and_source_impedance",
  "working_and_transient_voltage_by_net_pair",
  "insulation_class_and_end_product_standard",
  "pollution_degree_material_group_cti_and_altitude",
  "controlled_impedance_targets_and_tolerances",
  "drill_registration_and_finished_hole_tolerances",
  "microvia_structure_and_acceptance_test_plan",
  "exact_orderable_part_and_package_suffix",
  "manufacturer_package_drawing_revision",
  "assembler_stencil_mask_and_placement_capabilities",
  "fabricator_cam_dfm_confirmation",
  "worst_case_hot_soak_measurements"
] as const);

export type PcbEngineeringRequiredInput =
  (typeof PCB_ENGINEERING_REQUIRED_INPUTS)[number];

export const PCB_ENGINEERING_SOURCE_IDS = Object.freeze([
  "ipc-2152-2009",
  "ipc-document-revision-table",
  "ti-analog-engineers-pocket-reference-rev-c",
  "jlcpcb-manufacturing-capabilities-2026",
  "jlcpcb-copper-weight-2025",
  "ti-motor-driver-layout-slva959b",
  "ti-led-driver-layout-snva766",
  "adi-an-1109",
  "ti-package-thermal-metrics-spra953d",
  "ti-powerpad-slma002h",
  "ti-tps1hc30-q1-datasheet",
  "molex-micro-fit-plus-206460-spec",
  "littelfuse-fuseology-selection-guide",
  "ti-current-limit-versus-circuit-breaker",
  "iec-60664-1-2020-base",
  "iec-60664-1-amd1-2025",
  "ti-clearance-creepage-sdaa268",
  "adi-an-7625",
  "jlcpcb-impedance-calculator-guide-2026",
  "wurth-basic-design-guide-2025",
  "pcbway-advanced-capabilities-2026",
  "ipc-microvia-reliability-warning-2019",
  "ipc-7352-2023",
  "ipc-7093a-2020",
  "nxp-an1902-rev9",
  "jlcpcb-smd-pad-ordering-2025",
  "ipc-2231-2019"
] as const);

export type PcbEngineeringSourceId = (typeof PCB_ENGINEERING_SOURCE_IDS)[number];

export interface PcbEngineeringSource {
  readonly id: PcbEngineeringSourceId;
  readonly title: string;
  readonly publisher: string;
  readonly revision: string;
  readonly date: {
    readonly kind: "published" | "revised" | "accessed";
    readonly value: string;
  };
  readonly url: string;
  readonly authority:
    | "standards_body"
    | "component_manufacturer"
    | "connector_manufacturer"
    | "protection_manufacturer"
    | "fabricator";
  readonly accessScope: "public_full_text" | "public_scope_or_toc" | "live_capability_page";
  readonly normativeStatus:
    | "current"
    | "unmaintained_reference"
    | "manufacturer_guidance"
    | "fabricator_specific";
}

export interface PcbEngineeringNumericClaim {
  readonly id: string;
  readonly value: number;
  readonly unit: string;
  readonly applicability: "calculation_model" | "source_specific" | "fabricator_specific";
  readonly sourceIds: readonly PcbEngineeringSourceId[];
  readonly scope: string;
}

export interface PcbEngineeringPracticeRule {
  readonly id: string;
  readonly claimFamilies: readonly PcbEngineeringClaimFamily[];
  readonly sourceIds: readonly PcbEngineeringSourceId[];
  readonly scopePredicates: readonly PcbEngineeringScopePredicate[];
  readonly requiredInputs: readonly PcbEngineeringRequiredInput[];
  readonly enforcementClasses: readonly PcbEngineeringEnforcementClass[];
  readonly checkerIds: readonly PcbEngineeringCheckerId[];
  readonly modelIds: readonly PcbEngineeringModelId[];
  readonly rationale: string;
  readonly machineCheck: string;
  readonly humanGate: string;
  readonly caveats: readonly string[];
  readonly numericClaims: readonly PcbEngineeringNumericClaim[];
}

export interface PcbEngineeringPracticeCatalogPayload {
  readonly schemaVersion: typeof PCB_ENGINEERING_PRACTICE_SCHEMA;
  readonly supportedEnvelope: {
    readonly maximumNominalDcVoltageMv: 30_000;
    readonly lifecycle: "candidate";
    readonly boardTechnology: "rigid_organic_pcb";
  };
  readonly sources: readonly PcbEngineeringSource[];
  readonly rules: readonly PcbEngineeringPracticeRule[];
  readonly limitations: readonly string[];
}

export interface PcbEngineeringPracticeCatalog extends PcbEngineeringPracticeCatalogPayload {
  readonly identity: CanonicalIdentity;
}

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const detachedFrozen = <Value>(value: Value): Value => deepFreeze(structuredClone(value));

const source = (value: PcbEngineeringSource): PcbEngineeringSource => detachedFrozen(value);

export const PCB_ENGINEERING_PRACTICE_SOURCES: readonly PcbEngineeringSource[] = deepFreeze([
  source({
    id: "ipc-2152-2009",
    title: "IPC-2152 Standard for Determining Current Carrying Capacity in Printed Board Design",
    publisher: "IPC International",
    revision: "Original publication",
    date: { kind: "published", value: "2009-08" },
    url: "https://www.ipc.org/TOC/IPC-2152.pdf",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "unmaintained_reference"
  }),
  source({
    id: "ipc-document-revision-table",
    title: "IPC Document Revision Table",
    publisher: "IPC International",
    revision: "Live revision registry",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.ipc.org/ipc-document-revision-table",
    authority: "standards_body",
    accessScope: "live_capability_page",
    normativeStatus: "current"
  }),
  source({
    id: "ti-analog-engineers-pocket-reference-rev-c",
    title: "Analog Engineer's Pocket Reference",
    publisher: "Texas Instruments",
    revision: "SLYW038C, Revision C",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.ti.com/seclit/eb/slyw038c/slyw038c.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "jlcpcb-manufacturing-capabilities-2026",
    title: "PCB Manufacturing Capabilities",
    publisher: "JLCPCB",
    revision: "Live capabilities page",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://jlcpcb.com/capabilities/Capabilities",
    authority: "fabricator",
    accessScope: "live_capability_page",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "jlcpcb-copper-weight-2025",
    title: "JLCPCB Copper Weight (Thickness) Guide",
    publisher: "JLCPCB",
    revision: "Web revision dated 2025-12-15",
    date: { kind: "revised", value: "2025-12-15" },
    url: "https://jlcpcb.com/help/article/jlcpcb-copper-weight",
    authority: "fabricator",
    accessScope: "live_capability_page",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "ti-motor-driver-layout-slva959b",
    title: "Best Practices for Board Layout of Motor Drivers",
    publisher: "Texas Instruments",
    revision: "SLVA959B",
    date: { kind: "revised", value: "2021-10" },
    url: "https://www.ti.com/lit/an/slva959b/slva959b.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "ti-led-driver-layout-snva766",
    title: "PCB Layout Guideline for Automotive LED Drivers",
    publisher: "Texas Instruments",
    revision: "SNVA766",
    date: { kind: "published", value: "2017-04" },
    url: "https://www.ti.com/lit/an/snva766/snva766.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "adi-an-1109",
    title: "AN-1109 Application Note",
    publisher: "Analog Devices",
    revision: "AN-1109",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://wcm-cce.cldnet.analog.com/media/en/technical-documentation/application-notes/AN-1109.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "ti-package-thermal-metrics-spra953d",
    title: "Semiconductor and IC Package Thermal Metrics",
    publisher: "Texas Instruments",
    revision: "SPRA953D",
    date: { kind: "revised", value: "2024-03" },
    url: "https://www.ti.com/lit/an/spra953d/spra953d.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "ti-powerpad-slma002h",
    title: "PowerPAD Thermally Enhanced Package",
    publisher: "Texas Instruments",
    revision: "SLMA002H",
    date: { kind: "revised", value: "2018-07" },
    url: "https://www.ti.com/lit/an/slma002h/slma002h.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "ti-tps1hc30-q1-datasheet",
    title: "TPS1HC30-Q1 Automotive Smart High-Side Switch Datasheet",
    publisher: "Texas Instruments",
    revision: "SLVSGL6A",
    date: { kind: "revised", value: "2022-12" },
    url: "https://www.ti.com/lit/gpn/tps1hc30-q1",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "molex-micro-fit-plus-206460-spec",
    title: "Micro-Fit+ Wire-to-Board Connector System Product Specification",
    publisher: "Molex",
    revision: "2064600000-PS, Revision E5",
    date: { kind: "revised", value: "2026-01" },
    url: "https://www.molex.com/content/dam/molex/molex-dot-com/products/automated/en-us/productspecificationpdf/206/206460/2064600000-PS-000.pdf",
    authority: "connector_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "littelfuse-fuseology-selection-guide",
    title: "Fuseology Selection Guide",
    publisher: "Littelfuse",
    revision: "Fuseology design guide",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.littelfuse.com/assetdocs/fuseology-selection-guide?assetguid=fa4aa360-f6c4-4eec-88a6-3d7ec3fe57d5",
    authority: "protection_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "ti-current-limit-versus-circuit-breaker",
    title: "The Benefits of Current Limiting versus Circuit Breaking",
    publisher: "Texas Instruments",
    revision: "Technical article SSZTB96",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.ti.com/document-viewer/lit/html/SSZTB96/GUID-D18B50A7-22CC-4A4E-8B48-5F2605B5C1B9",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "iec-60664-1-2020-base",
    title: "IEC 60664-1 Insulation Coordination for Equipment Within Low-Voltage Supply Systems",
    publisher: "International Electrotechnical Commission",
    revision: "IEC 60664-1:2020, Edition 3.0 base publication",
    date: { kind: "published", value: "2020-05-26" },
    url: "https://webstore.iec.ch/en/publication/59671",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "current"
  }),
  source({
    id: "iec-60664-1-amd1-2025",
    title: "Amendment 1 to IEC 60664-1:2020",
    publisher: "International Electrotechnical Commission",
    revision: "IEC 60664-1:2020/AMD1:2025",
    date: { kind: "published", value: "2025-05-06" },
    url: "https://webstore.iec.ch/en/publication/80714",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "current"
  }),
  source({
    id: "ti-clearance-creepage-sdaa268",
    title: "Key Considerations to Select ISO Devices and Demystify Clearance and Creepage Distance",
    publisher: "Texas Instruments",
    revision: "SDAA268",
    date: { kind: "published", value: "2026-06" },
    url: "https://www.ti.com/lit/an/sdaa268/sdaa268.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "adi-an-7625",
    title: "Layout Considerations for Using the MAXM22510/MAXM22511 in Space-Constrained Applications",
    publisher: "Analog Devices",
    revision: "AN-7625",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.analog.com/en/resources/app-notes/an-7625.html",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "jlcpcb-impedance-calculator-guide-2026",
    title: "User Guide to the JLCPCB Impedance Calculator",
    publisher: "JLCPCB",
    revision: "Web revision dated 2026-06-15",
    date: { kind: "revised", value: "2026-06-15" },
    url: "https://jlcpcb.com/help/article/user-guide-to-the-jlcpcb-impedance-calculator",
    authority: "fabricator",
    accessScope: "live_capability_page",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "wurth-basic-design-guide-2025",
    title: "WEdirekt Basic Design Guide",
    publisher: "Würth Elektronik",
    revision: "Design Guide 03/25",
    date: { kind: "revised", value: "2025-03" },
    url: "https://www.we-online.com/files/pdf1/basic_design-guide_110325_en_web.pdf",
    authority: "fabricator",
    accessScope: "public_full_text",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "pcbway-advanced-capabilities-2026",
    title: "Advanced PCB Manufacturing Capabilities",
    publisher: "PCBWay",
    revision: "Live capabilities page",
    date: { kind: "accessed", value: "2026-09-04" },
    url: "https://www.pcbway.com/advanced-pcb-capabilities.html",
    authority: "fabricator",
    accessScope: "live_capability_page",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "ipc-microvia-reliability-warning-2019",
    title: "IPC Issues Electronics Industry Warning on Printed Board Microvia Reliability",
    publisher: "IPC International",
    revision: "Industry warning referencing IPC-WP-023",
    date: { kind: "published", value: "2019-03-06" },
    url: "https://www.ipc.org/news-release/ipc-issues-electronics-industry-warning-printed-board-microvia-reliability-high",
    authority: "standards_body",
    accessScope: "public_full_text",
    normativeStatus: "current"
  }),
  source({
    id: "ipc-7352-2023",
    title: "IPC-7352 Generic Guideline for Land Pattern Design",
    publisher: "IPC International",
    revision: "May 2023",
    date: { kind: "published", value: "2023-05" },
    url: "https://www.ipc.org/TOC/IPC-7352-TOC.pdf",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "current"
  }),
  source({
    id: "ipc-7093a-2020",
    title: "IPC-7093A Design and Assembly Process Implementation for Bottom Termination Components",
    publisher: "IPC International",
    revision: "Revision A",
    date: { kind: "published", value: "2020-10" },
    url: "https://www.ipc.org/TOC/IPC-7093A-toc.pdf",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "current"
  }),
  source({
    id: "nxp-an1902-rev9",
    title: "Assembly Guidelines for QFN and SON Packages",
    publisher: "NXP Semiconductors",
    revision: "AN1902 Revision 9",
    date: { kind: "revised", value: "2021-04-28" },
    url: "https://www.nxp.com/docs/en/application-note/AN1902.pdf",
    authority: "component_manufacturer",
    accessScope: "public_full_text",
    normativeStatus: "manufacturer_guidance"
  }),
  source({
    id: "jlcpcb-smd-pad-ordering-2025",
    title: "How to Order Boards with Solder Mask Defined Pads",
    publisher: "JLCPCB",
    revision: "Web revision dated 2025-04-24",
    date: { kind: "revised", value: "2025-04-24" },
    url: "https://jlcpcb.com/help/article/how-to-order-boards-with-solder-mask-defined-pads",
    authority: "fabricator",
    accessScope: "live_capability_page",
    normativeStatus: "fabricator_specific"
  }),
  source({
    id: "ipc-2231-2019",
    title: "IPC-2231 DFX Guidelines",
    publisher: "IPC International",
    revision: "Original publication",
    date: { kind: "published", value: "2019-04" },
    url: "https://www.ipc.org/TOC/IPC-2231-toc.pdf",
    authority: "standards_body",
    accessScope: "public_scope_or_toc",
    normativeStatus: "current"
  })
] satisfies readonly PcbEngineeringSource[]);

const rule = (value: PcbEngineeringPracticeRule): PcbEngineeringPracticeRule =>
  detachedFrozen(value);

export const PCB_ENGINEERING_PRACTICE_RULES: readonly PcbEngineeringPracticeRule[] =
  deepFreeze([
    rule({
      id: "pcb.trace.ampacity.ipc2152-input-gate",
      claimFamilies: ["trace_ampacity"],
      sourceIds: ["ipc-2152-2009", "ipc-document-revision-table"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "current_carrying_conductor_present"],
      requiredInputs: [
        "maximum_continuous_current_a",
        "rms_current_a",
        "peak_current_a",
        "peak_duration_and_duty_cycle",
        "maximum_ambient_temperature_c",
        "allowable_conductor_temperature_rise_c",
        "minimum_finished_trace_width_mm",
        "minimum_finished_copper_thickness_mm",
        "conductor_layer_and_thermal_context",
        "fabricator_capability_snapshot_identity",
        "stackup_identity"
      ],
      enforcementClasses: ["calculation_gate", "human_physical_gate"],
      checkerIds: ["licensed_ipc2152_lookup_required_v1"],
      modelIds: [],
      rationale:
        "Conductor current capability is a temperature-rise problem on the finished board, not a universal width-per-current ratio.",
      machineCheck:
        "Require every declared input and a revision-pinned licensed lookup or validated thermal model; evaluate every neck-down and preserve the lookup provenance.",
      humanGate:
        "A reviewer selects the allowable conductor rise and accepts model applicability; worst-load board temperature remains physical evidence.",
      caveats: [
        "This catalog intentionally contains no licensed IPC-2152 lookup tables.",
        "IPC currently marks IPC-2152 as no longer maintained even though it remains widely referenced."
      ],
      numericClaims: []
    }),
    rule({
      id: "pcb.trace.hot-resistance-voltage-drop-i2r",
      claimFamilies: ["voltage_drop_and_i2r"],
      sourceIds: ["ti-analog-engineers-pocket-reference-rev-c"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "current_carrying_conductor_present"],
      requiredInputs: [
        "rms_current_a",
        "peak_current_a",
        "estimated_copper_temperature_c",
        "conductor_length_mm",
        "minimum_finished_trace_width_mm",
        "minimum_finished_copper_thickness_mm",
        "fabricator_capability_snapshot_identity",
        "stackup_identity"
      ],
      enforcementClasses: ["calculation_gate", "human_physical_gate"],
      checkerIds: ["hot_copper_resistance_v1", "copper_voltage_drop_v1", "copper_i2r_loss_v1"],
      modelIds: ["ti-linear-copper-resistance-v1"],
      rationale:
        "A trace can satisfy a temperature-rise screen yet violate delivered-voltage or loss budgets, so resistance, drop, and heating require separate calculations.",
      machineCheck:
        "Calculate hot resistance from bound minimum geometry, then calculate peak and RMS voltage drop and RMS resistive loss without rounding intermediate values.",
      humanGate:
        "A reviewer approves rail-drop and loss budgets and compares the calculation with guarded-load measurements.",
      caveats: [
        "The linear copper temperature model is a deterministic engineering approximation, not an ampacity model.",
        "Copper temperature is an input to this calculation and must not be inferred from ambient temperature."
      ],
      numericClaims: [
        {
          id: "ti.copper.resistivity-at-reference-temperature",
          value: 17e-6,
          unit: "ohm_mm",
          applicability: "calculation_model",
          sourceIds: ["ti-analog-engineers-pocket-reference-rev-c"],
          scope: "Linear copper trace resistance model at its stated reference temperature."
        },
        {
          id: "ti.copper.linear-temperature-coefficient",
          value: 3.9e-3,
          unit: "per_deg_c",
          applicability: "calculation_model",
          sourceIds: ["ti-analog-engineers-pocket-reference-rev-c"],
          scope: "Linear copper trace resistance model used with an explicit copper temperature."
        },
        {
          id: "ti.copper.model-reference-temperature",
          value: 25,
          unit: "deg_c",
          applicability: "calculation_model",
          sourceIds: ["ti-analog-engineers-pocket-reference-rev-c"],
          scope: "Reference temperature for the cited linear material model."
        }
      ]
    }),
    rule({
      id: "pcb.copper.finished-geometry-fabricator-binding",
      claimFamilies: ["copper_weight_and_finished_geometry"],
      sourceIds: [
        "jlcpcb-manufacturing-capabilities-2026",
        "jlcpcb-copper-weight-2025",
        "wurth-basic-design-guide-2025"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "fabrication_or_assembly_candidate"],
      requiredInputs: [
        "fabricator_capability_snapshot_identity",
        "fabricator_service_and_order_options",
        "stackup_identity",
        "minimum_finished_trace_width_mm",
        "minimum_finished_copper_thickness_mm"
      ],
      enforcementClasses: ["hard_gate", "fabricator_confirmation"],
      checkerIds: ["finished_geometry_evidence_v1"],
      modelIds: [],
      rationale:
        "Nominal copper weight does not bind finished layer copper, etch tolerance, or the geometry limits of a selected process.",
      machineCheck:
        "Use only minimum finished geometry tied to a capability snapshot, selected service, order options, and exact stackup identity.",
      humanGate:
        "The fabricator confirms finished copper and width tolerances in the quote or production stackup before release.",
      caveats: ["Published minimums and recommended production margins are not interchangeable."],
      numericClaims: []
    }),
    rule({
      id: "pcb.via.barrel-resistance-only",
      claimFamilies: ["via_current_and_thermal", "voltage_drop_and_i2r"],
      sourceIds: [
        "ti-analog-engineers-pocket-reference-rev-c",
        "ti-motor-driver-layout-slva959b",
        "ti-led-driver-layout-snva766",
        "adi-an-1109",
        "wurth-basic-design-guide-2025"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "via_carries_current_or_heat"],
      requiredInputs: [
        "rms_current_a",
        "peak_current_a",
        "estimated_copper_temperature_c",
        "minimum_finished_via_hole_diameter_mm",
        "minimum_via_barrel_plating_thickness_mm",
        "via_hole_depth_mm",
        "via_count_placement_and_current_entry_geometry",
        "fabricator_capability_snapshot_identity",
        "stackup_identity"
      ],
      enforcementClasses: [
        "calculation_gate",
        "fabricator_confirmation",
        "human_physical_gate"
      ],
      checkerIds: ["via_barrel_resistance_v1"],
      modelIds: ["ti-linear-copper-resistance-v1", "cylindrical-copper-annulus-v1"],
      rationale:
        "Via tables vary by assumptions and current does not necessarily divide equally among nominally parallel vias.",
      machineCheck:
        "Calculate only barrel resistance, drop, and resistive loss from minimum plated geometry; require a separate qualified current-temperature model for ampacity.",
      humanGate:
        "A reviewer evaluates current entry geometry and validates critical via fields by measurement or a qualified field model.",
      caveats: [
        "No universal current-per-via value is permitted.",
        "Multiplying a single-via rating by via count is not accepted as proof of uniform sharing."
      ],
      numericClaims: []
    }),
    rule({
      id: "pcb.component.thermal-model-and-hot-soak",
      claimFamilies: ["component_thermal_path"],
      sourceIds: ["ti-package-thermal-metrics-spra953d"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "power_dissipating_component_present"],
      requiredInputs: [
        "component_loss_model_and_operating_corner",
        "component_package_and_layout_source",
        "maximum_ambient_temperature_c",
        "stackup_identity",
        "worst_case_hot_soak_measurements"
      ],
      enforcementClasses: ["calculation_gate", "human_physical_gate"],
      checkerIds: ["component_thermal_evidence_v1"],
      modelIds: [],
      rationale:
        "Junction-to-ambient thermal resistance is strongly test-board dependent and is not a package-only constant for predicting a different system board.",
      machineCheck:
        "Calculate device losses and record the exact thermal model, package, stackup, airflow, enclosure, neighboring dissipation, and operating corner.",
      humanGate:
        "Release requires instrumented steady-state measurements on the actual assembly at the worst declared load and environment.",
      caveats: ["A datasheet junction-to-ambient value alone cannot produce a physical-pass verdict."],
      numericClaims: []
    }),
    rule({
      id: "pcb.thermal-relief.package-and-process-specific",
      claimFamilies: ["thermal_relief_and_via_treatment"],
      sourceIds: ["ti-powerpad-slma002h", "ti-tps1hc30-q1-datasheet"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "thermal_or_exposed_pad_present"],
      requiredInputs: [
        "component_package_and_layout_source",
        "assembly_process_and_via_treatment",
        "fabricator_service_and_order_options"
      ],
      enforcementClasses: ["advisory", "fabricator_confirmation"],
      checkerIds: ["thermal_relief_source_review_v1"],
      modelIds: [],
      rationale:
        "Thermal relief improves solderability but increases thermal and electrical impedance; exposed-pad via treatment differs by package and assembly process.",
      machineCheck:
        "Flag generic relief or via-treatment defaults whenever an exact package source specifies solid connection, tenting, filling, capping, or paste controls.",
      humanGate:
        "The component manufacturer, assembler, and fabricator guidance jointly determine spokes, direct connection, paste apertures, and via treatment.",
      caveats: ["Generic PowerPAD guidance must not override a later exact-device requirement."],
      numericClaims: []
    }),
    rule({
      id: "pcb.protection.connector-fuse-current-limit-coordination",
      claimFamilies: ["connector_fuse_current_limit_coordination"],
      sourceIds: [
        "molex-micro-fit-plus-206460-spec",
        "littelfuse-fuseology-selection-guide",
        "ti-current-limit-versus-circuit-breaker"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "power_connector_or_protection_present"],
      requiredInputs: [
        "rms_current_a",
        "peak_current_a",
        "peak_duration_and_duty_cycle",
        "maximum_ambient_temperature_c",
        "connector_contact_wire_and_loaded_circuit_configuration",
        "connector_temperature_rise_curve",
        "fuse_voltage_interrupt_time_current_and_i2t_data",
        "current_limit_tolerance_soa_and_fault_response",
        "prospective_fault_current_and_source_impedance"
      ],
      enforcementClasses: ["hard_gate", "calculation_gate", "human_physical_gate"],
      checkerIds: ["protection_coordination_evidence_v1"],
      modelIds: [],
      rationale:
        "Connector current is configuration- and temperature-dependent, while a current limiter, circuit breaker, and melting fuse have different fault behavior.",
      machineCheck:
        "Evaluate normal, inrush, stall, overload, and short-circuit profiles against exact connector and protection curves, tolerances, interrupt ratings, and weakest-path energy limits.",
      humanGate:
        "A reviewer chooses the protection objective and witnesses overload and short-circuit tests; no result is represented as certified protection.",
      caveats: [
        "A limiting device can continue dissipating power into a fault until thermal shutdown.",
        "A current limit can prevent an upstream fuse from clearing and therefore requires explicit coordination."
      ],
      numericClaims: []
    }),
    rule({
      id: "pcb.spacing.insulation-classification-before-distance",
      claimFamilies: ["creepage_and_clearance"],
      sourceIds: [
        "iec-60664-1-2020-base",
        "iec-60664-1-amd1-2025",
        "ti-clearance-creepage-sdaa268",
        "adi-an-7625"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "distinct_conductive_domains_present"],
      requiredInputs: [
        "working_and_transient_voltage_by_net_pair",
        "insulation_class_and_end_product_standard",
        "pollution_degree_material_group_cti_and_altitude",
        "fabricator_capability_snapshot_identity"
      ],
      enforcementClasses: ["hard_gate", "human_physical_gate"],
      checkerIds: ["insulation_classification_evidence_v1"],
      modelIds: [],
      rationale:
        "Nominal bus voltage alone does not determine creepage or clearance; insulation purpose, transients, pollution, material tracking group, altitude, and the end-product standard matter.",
      machineCheck:
        "Classify every net pair before applying a revision-pinned standard table; treat fabricator spacing as manufacturability only and never count solder mask as safety insulation.",
      humanGate:
        "A qualified reviewer determines the end-product standard and any accessible, isolation, or SELV/PELV claim before safety spacing can pass.",
      caveats: [
        "The supported low-voltage envelope does not itself establish a universal safe spacing.",
        "Only public IEC Webstore metadata and scope were reviewed; no licensed base tables or amendment text are embedded, so a normative spacing lookup remains unresolved without captured authorized content."
      ],
      numericClaims: []
    }),
    rule({
      id: "pcb.stackup.exact-fabricator-capability-binding",
      claimFamilies: ["stackup_and_fabricator_binding"],
      sourceIds: ["jlcpcb-impedance-calculator-guide-2026", "wurth-basic-design-guide-2025"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "multilayer_or_controlled_impedance_present"],
      requiredInputs: [
        "fabricator_capability_snapshot_identity",
        "fabricator_service_and_order_options",
        "stackup_identity",
        "controlled_impedance_targets_and_tolerances",
        "fabricator_cam_dfm_confirmation"
      ],
      enforcementClasses: ["hard_gate", "fabricator_confirmation"],
      checkerIds: ["stackup_capability_evidence_v1"],
      modelIds: [],
      rationale:
        "Impedance and fine-feature feasibility depend on the selected process, layer geometry, dielectric system, finished copper, and order options.",
      machineCheck:
        "Reject controlled-impedance or fine-feature signoff unless the design binds an exact fabricator, service, capability snapshot, stackup, and tolerance set.",
      humanGate:
        "The fabricator confirms calculated geometry, material substitution policy, coupons, and production files.",
      caveats: ["Capabilities from another service tier or a generic stackup are not transferable evidence."],
      numericClaims: []
    }),
    rule({
      id: "pcb.interconnect.drill-ring-aspect-and-microvia",
      claimFamilies: ["annular_ring_drill_aspect_ratio_microvia"],
      sourceIds: [
        "jlcpcb-manufacturing-capabilities-2026",
        "wurth-basic-design-guide-2025",
        "pcbway-advanced-capabilities-2026",
        "ipc-microvia-reliability-warning-2019"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "plated_or_hdi_interconnect_present"],
      requiredInputs: [
        "stackup_identity",
        "fabricator_capability_snapshot_identity",
        "fabricator_service_and_order_options",
        "minimum_finished_via_hole_diameter_mm",
        "minimum_via_barrel_plating_thickness_mm",
        "via_hole_depth_mm",
        "drill_registration_and_finished_hole_tolerances",
        "microvia_structure_and_acceptance_test_plan"
      ],
      enforcementClasses: ["calculation_gate", "fabricator_confirmation", "human_physical_gate"],
      checkerIds: ["interconnect_manufacturability_evidence_v1"],
      modelIds: [],
      rationale:
        "Drill, annular ring, aspect ratio, and microvia limits are process-specific, and stacked microvia defects can remain latent after traditional inspection.",
      machineCheck:
        "Use the selected fabricator's definition to calculate worst-case annular ring and aspect ratio, and reject any unbound via type, tolerance, plating, or HDI construction.",
      humanGate:
        "The fabricator and reliability reviewer approve advanced via structures and a coupon or performance-acceptance plan.",
      caveats: [
        "Fabricator sources do not consistently define aspect ratio against finished hole versus drill-tool diameter.",
        "Published absolute limits are not evidence of production margin or reliability."
      ],
      numericClaims: []
    }),
    rule({
      id: "pcb.land-pattern.exact-orderable-package-source",
      claimFamilies: ["land_pattern_and_package_source"],
      sourceIds: ["ipc-7352-2023", "ipc-7093a-2020", "nxp-an1902-rev9"],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "surface_mount_component_present"],
      requiredInputs: [
        "exact_orderable_part_and_package_suffix",
        "manufacturer_package_drawing_revision",
        "component_package_and_layout_source",
        "assembler_stencil_mask_and_placement_capabilities"
      ],
      enforcementClasses: ["hard_gate", "fabricator_confirmation"],
      checkerIds: ["land_pattern_source_evidence_v1"],
      modelIds: [],
      rationale:
        "A generic library name does not prove the exact package outline, land pattern, mask, paste, exposed-pad, or assembly requirements of an orderable part.",
      machineCheck:
        "Bind the exact orderable suffix to a manufacturer package drawing and reproduce pad, mask, paste, courtyard, orientation, thermal-pad, and tolerance data.",
      humanGate:
        "The assembler reviews manufacturer deviations, stencil design, inspectability, rework, and package-specific process constraints.",
      caveats: ["IPC-7352 is generic guidance and explicitly permits adjustment for company or board technology requirements."],
      numericClaims: []
    }),
    rule({
      id: "pcb.dfm.parameterized-fab-and-assembly-review",
      claimFamilies: ["dfm_and_assembly_constraints"],
      sourceIds: [
        "ipc-2231-2019",
        "jlcpcb-manufacturing-capabilities-2026",
        "jlcpcb-smd-pad-ordering-2025",
        "wurth-basic-design-guide-2025"
      ],
      scopePredicates: ["supported_low_voltage_rigid_pcb", "fabrication_or_assembly_candidate"],
      requiredInputs: [
        "fabricator_capability_snapshot_identity",
        "fabricator_service_and_order_options",
        "stackup_identity",
        "assembler_stencil_mask_and_placement_capabilities",
        "fabricator_cam_dfm_confirmation"
      ],
      enforcementClasses: ["advisory", "fabricator_confirmation"],
      checkerIds: ["dfm_confirmation_evidence_v1"],
      modelIds: [],
      rationale:
        "Manufacturability combines bare-board fabrication, assembly, testability, reliability, and process-specific CAM interpretation.",
      machineCheck:
        "Parameterize DRC for copper-dependent trace and spacing, drill and ring, hole-to-copper, solder-mask web and expansion, paste, board edge and slots, component spacing, fiducials, and panelization.",
      humanGate:
        "Fabricator and assembler review processed production files; the agent must not silently resize features or authorize manufacturing.",
      caveats: ["Automated DFM is evidence of checked rules, not proof that every process interaction is manufacturable."],
      numericClaims: []
    })
  ] satisfies readonly PcbEngineeringPracticeRule[]);

const catalogPayload: PcbEngineeringPracticeCatalogPayload = deepFreeze({
  schemaVersion: PCB_ENGINEERING_PRACTICE_SCHEMA,
  supportedEnvelope: {
    maximumNominalDcVoltageMv: 30_000,
    lifecycle: "candidate",
    boardTechnology: "rigid_organic_pcb"
  },
  sources: PCB_ENGINEERING_PRACTICE_SOURCES,
  rules: PCB_ENGINEERING_PRACTICE_RULES,
  limitations: [
    "The catalog stores public source metadata and URLs, not captured licensed standard bytes.",
    "It contains no IPC-2152 lookup curves and produces no universal trace or via ampacity.",
    "Fabricator web capabilities are volatile and must be captured and identity-bound at use time.",
    "Calculation results remain candidate engineering evidence until fabricator confirmation and physical validation.",
    "Exported calculation domains are software model bounds, not component ratings, safety limits, or manufacturing capabilities."
  ]
});

export const PCB_ENGINEERING_PRACTICE_CATALOG: PcbEngineeringPracticeCatalog = deepFreeze({
  ...catalogPayload,
  identity: canonicalIdentity(catalogPayload, PCB_ENGINEERING_PRACTICE_SCHEMA)
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function rejectCatalog(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): never {
  throw new DomainError("ARTIFACT_INTEGRITY_ERROR", message, details);
}

const MEASUREMENT_LITERAL =
  /\b\d+(?:\.\d+)?\s*(?:a(?:\s*(?:per|\/)\s*via)?|ma|v|mv|degc|°c|mil|mm|um|µm|oz|%)\b/iu;

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string
): void => {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    rejectCatalog(`${label} contains missing or unknown fields`, { expected: wanted, actual });
  }
};

const hasUniqueStrings = (value: unknown[]): boolean =>
  value.every((entry) => typeof entry === "string") && new Set(value).size === value.length;

const validSourceDate = (value: string): boolean => {
  const match = /^(?<year>\d{4})(?:-(?<month>\d{2})(?:-(?<day>\d{2}))?)?$/u.exec(value);
  if (match?.groups?.year === undefined) return false;
  const year = Number(match.groups.year);
  const month = match.groups.month === undefined ? undefined : Number(match.groups.month);
  const day = match.groups.day === undefined ? undefined : Number(match.groups.day);
  if (year < 1900 || year > 2100) return false;
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const EXPECTED_NUMERIC_CLAIMS = {
  "ti.copper.resistivity-at-reference-temperature": {
    value: 17e-6,
    unit: "ohm_mm",
    applicability: "calculation_model"
  },
  "ti.copper.linear-temperature-coefficient": {
    value: 3.9e-3,
    unit: "per_deg_c",
    applicability: "calculation_model"
  },
  "ti.copper.model-reference-temperature": {
    value: 25,
    unit: "deg_c",
    applicability: "calculation_model"
  }
} as const;

const assertPlainCatalogGraph = (
  value: unknown,
  field: string,
  seen = new Set<object>()
): void => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    rejectCatalog("PCB engineering catalog input must be non-proxy plain data", { field });
  }
  if (seen.has(value)) {
    rejectCatalog("PCB engineering catalog input must not contain cycles", { field });
  }
  seen.add(value);
  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) {
    rejectCatalog("PCB engineering catalog input must have a plain object or array prototype", {
      field
    });
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      rejectCatalog("PCB engineering catalog input must not contain symbol keys", { field });
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      rejectCatalog("PCB engineering catalog input must not contain accessors", {
        field: `${field}.${key}`
      });
    }
    if (Array.isArray(value) && key === "length") continue;
    assertPlainCatalogGraph(descriptor.value, `${field}.${key}`, seen);
  }
  seen.delete(value);
};

function assertCatalogSnapshotValid(
  value: unknown
): asserts value is PcbEngineeringPracticeCatalog {
  if (!isRecord(value) || value.schemaVersion !== PCB_ENGINEERING_PRACTICE_SCHEMA) {
    rejectCatalog("PCB engineering practice catalog has an invalid schema version");
  }
  exactKeys(
    value,
    ["schemaVersion", "supportedEnvelope", "sources", "rules", "limitations", "identity"],
    "PCB engineering practice catalog"
  );
  if (
    !isRecord(value.supportedEnvelope) ||
    !Array.isArray(value.sources) ||
    !Array.isArray(value.rules) ||
    !Array.isArray(value.limitations)
  ) {
    rejectCatalog("PCB engineering practice catalog must contain source and rule arrays");
  }
  exactKeys(
    value.supportedEnvelope,
    ["maximumNominalDcVoltageMv", "lifecycle", "boardTechnology"],
    "PCB engineering supported envelope"
  );
  if (
    value.supportedEnvelope.maximumNominalDcVoltageMv !== 30_000 ||
    value.supportedEnvelope.lifecycle !== "candidate" ||
    value.supportedEnvelope.boardTechnology !== "rigid_organic_pcb"
  ) {
    rejectCatalog("PCB engineering supported envelope is invalid");
  }
  if (
    value.limitations.length === 0 ||
    !hasUniqueStrings(value.limitations) ||
    value.limitations.some((entry) => (entry as string).trim().length === 0) ||
    canonicalJson(value.limitations) !== canonicalJson(catalogPayload.limitations)
  ) {
    rejectCatalog("PCB engineering catalog limitations must be unique non-empty strings");
  }

  const sources = value.sources as unknown[];
  const sourceIds = new Set<string>();
  for (const candidate of sources) {
    if (!isRecord(candidate)) rejectCatalog("PCB engineering source must be an object");
    exactKeys(
      candidate,
      [
        "id",
        "title",
        "publisher",
        "revision",
        "date",
        "url",
        "authority",
        "accessScope",
        "normativeStatus"
      ],
      "PCB engineering source"
    );
    for (const field of ["id", "title", "publisher", "revision", "url"] as const) {
      if (typeof candidate[field] !== "string" || candidate[field].trim().length === 0) {
        rejectCatalog("PCB engineering source metadata is incomplete", { field });
      }
    }
    if (!(PCB_ENGINEERING_SOURCE_IDS as readonly string[]).includes(candidate.id as string)) {
      rejectCatalog("PCB engineering source ID is outside the closed catalog", {
        sourceId: candidate.id
      });
    }
    if (sourceIds.has(candidate.id as string)) {
      rejectCatalog("PCB engineering source IDs must be unique", { sourceId: candidate.id });
    }
    sourceIds.add(candidate.id as string);
    if (!isRecord(candidate.date)) {
      rejectCatalog("PCB engineering source date is missing", { sourceId: candidate.id });
    }
    exactKeys(candidate.date, ["kind", "value"], "PCB engineering source date");
    if (
      !["published", "revised", "accessed"].includes(String(candidate.date.kind)) ||
      typeof candidate.date.value !== "string" ||
      !validSourceDate(candidate.date.value) ||
      (candidate.date.kind === "accessed" && !/^\d{4}-\d{2}-\d{2}$/u.test(candidate.date.value))
    ) {
      rejectCatalog("PCB engineering source date is invalid", { sourceId: candidate.id });
    }
    if (
      ![
        "standards_body",
        "component_manufacturer",
        "connector_manufacturer",
        "protection_manufacturer",
        "fabricator"
      ].includes(String(candidate.authority)) ||
      !["public_full_text", "public_scope_or_toc", "live_capability_page"].includes(
        String(candidate.accessScope)
      ) ||
      ![
        "current",
        "unmaintained_reference",
        "manufacturer_guidance",
        "fabricator_specific"
      ].includes(String(candidate.normativeStatus))
    ) {
      rejectCatalog("PCB engineering source has an invalid closed enum", {
        sourceId: candidate.id
      });
    }
    try {
      const parsed = new URL(candidate.url as string);
      if (parsed.protocol !== "https:") throw new Error("Expected HTTPS");
    } catch {
      rejectCatalog("PCB engineering source URL must be an absolute HTTPS URL", {
        sourceId: candidate.id
      });
    }
    const expectedSource = PCB_ENGINEERING_PRACTICE_SOURCES.find(
      (entry) => entry.id === candidate.id
    );
    if (expectedSource === undefined || canonicalJson(candidate) !== canonicalJson(expectedSource)) {
      rejectCatalog("PCB engineering source metadata differs from the closed catalog", {
        sourceId: candidate.id
      });
    }
  }
  if (
    sourceIds.size !== PCB_ENGINEERING_SOURCE_IDS.length ||
    PCB_ENGINEERING_SOURCE_IDS.some((sourceId) => !sourceIds.has(sourceId))
  ) {
    rejectCatalog("PCB engineering catalog source inventory is incomplete");
  }

  const ruleIds = new Set<string>();
  for (const candidate of value.rules as unknown[]) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0) {
      rejectCatalog("PCB engineering rule must have an ID");
    }
    exactKeys(
      candidate,
      [
        "id",
        "claimFamilies",
        "sourceIds",
        "scopePredicates",
        "requiredInputs",
        "enforcementClasses",
        "checkerIds",
        "modelIds",
        "rationale",
        "machineCheck",
        "humanGate",
        "caveats",
        "numericClaims"
      ],
      "PCB engineering rule"
    );
    if (!PCB_ENGINEERING_PRACTICE_RULES.some((rule) => rule.id === candidate.id)) {
      rejectCatalog("PCB engineering rule ID is outside the closed catalog", {
        ruleId: candidate.id
      });
    }
    if (ruleIds.has(candidate.id)) {
      rejectCatalog("PCB engineering rule IDs must be unique", { ruleId: candidate.id });
    }
    ruleIds.add(candidate.id);
    if (!Array.isArray(candidate.sourceIds) || candidate.sourceIds.length === 0) {
      rejectCatalog("Every PCB engineering rule must cite at least one source", {
        ruleId: candidate.id
      });
    }
    if (!hasUniqueStrings(candidate.sourceIds)) {
      rejectCatalog("PCB engineering rule source IDs must be unique", {
        ruleId: candidate.id
      });
    }
    for (const sourceId of candidate.sourceIds) {
      if (typeof sourceId !== "string" || !sourceIds.has(sourceId)) {
        rejectCatalog("PCB engineering rule cites an unknown source", {
          ruleId: candidate.id,
          sourceId
        });
      }
    }
    if (
      !Array.isArray(candidate.claimFamilies) ||
      candidate.claimFamilies.length === 0 ||
      !hasUniqueStrings(candidate.claimFamilies) ||
      candidate.claimFamilies.some(
        (family) =>
          typeof family !== "string" ||
          !(PCB_ENGINEERING_CLAIM_FAMILIES as readonly string[]).includes(family)
      )
    ) {
      rejectCatalog("PCB engineering rule has an invalid claim family", { ruleId: candidate.id });
    }
    if (
      !Array.isArray(candidate.scopePredicates) ||
      candidate.scopePredicates.length === 0 ||
      !hasUniqueStrings(candidate.scopePredicates) ||
      candidate.scopePredicates.some(
        (predicate) =>
          typeof predicate !== "string" ||
          !(PCB_ENGINEERING_SCOPE_PREDICATES as readonly string[]).includes(predicate)
      )
    ) {
      rejectCatalog("PCB engineering rule has an invalid scope predicate", {
        ruleId: candidate.id
      });
    }
    if (
      !Array.isArray(candidate.requiredInputs) ||
      candidate.requiredInputs.length === 0 ||
      !hasUniqueStrings(candidate.requiredInputs) ||
      candidate.requiredInputs.some(
        (input) =>
          typeof input !== "string" ||
          !(PCB_ENGINEERING_REQUIRED_INPUTS as readonly string[]).includes(input)
      )
    ) {
      rejectCatalog("PCB engineering rule has an invalid required input", {
        ruleId: candidate.id
      });
    }
    if (
      !Array.isArray(candidate.enforcementClasses) ||
      candidate.enforcementClasses.length === 0 ||
      !hasUniqueStrings(candidate.enforcementClasses) ||
      candidate.enforcementClasses.some(
        (entry) =>
          !(PCB_ENGINEERING_ENFORCEMENT_CLASSES as readonly string[]).includes(entry as string)
      )
    ) {
      rejectCatalog("PCB engineering rule has invalid enforcement classes", {
        ruleId: candidate.id
      });
    }
    if (
      !Array.isArray(candidate.checkerIds) ||
      candidate.checkerIds.length === 0 ||
      !hasUniqueStrings(candidate.checkerIds) ||
      candidate.checkerIds.some(
        (entry) => !(PCB_ENGINEERING_CHECKER_IDS as readonly string[]).includes(entry as string)
      ) ||
      !Array.isArray(candidate.modelIds) ||
      !hasUniqueStrings(candidate.modelIds) ||
      candidate.modelIds.some(
        (entry) => !(PCB_ENGINEERING_MODEL_IDS as readonly string[]).includes(entry as string)
      )
    ) {
      rejectCatalog("PCB engineering rule has an unknown checker or model ID", {
        ruleId: candidate.id
      });
    }
    for (const field of ["rationale", "machineCheck", "humanGate"] as const) {
      const text = candidate[field];
      if (typeof text !== "string" || text.trim().length === 0) {
        rejectCatalog("PCB engineering rule description is incomplete", {
          ruleId: candidate.id,
          field
        });
      }
      if (MEASUREMENT_LITERAL.test(text)) {
        rejectCatalog(
          "Numeric engineering limits must be structured, source-bound claims rather than prose folklore",
          { ruleId: candidate.id, field }
        );
      }
    }
    if (!Array.isArray(candidate.numericClaims)) {
      rejectCatalog("PCB engineering rule numeric claims must be an array", {
        ruleId: candidate.id
      });
    }
    const numericClaimIds = new Set<string>();
    for (const claim of candidate.numericClaims) {
      if (!isRecord(claim)) {
        rejectCatalog("PCB engineering numeric claim must be an object", {
          ruleId: candidate.id
        });
      }
      exactKeys(
        claim,
        ["id", "value", "unit", "applicability", "sourceIds", "scope"],
        "PCB engineering numeric claim"
      );
      if (typeof claim.id !== "string" || numericClaimIds.has(claim.id)) {
        rejectCatalog("PCB engineering numeric claim IDs must be unique", {
          ruleId: candidate.id,
          claimId: claim.id
        });
      }
      numericClaimIds.add(claim.id);
      const expectedClaim = EXPECTED_NUMERIC_CLAIMS[
        claim.id as keyof typeof EXPECTED_NUMERIC_CLAIMS
      ];
      if (
        claim.applicability === "universal" ||
        !["calculation_model", "source_specific", "fabricator_specific"].includes(
          String(claim.applicability)
        )
      ) {
        rejectCatalog("Universal numeric PCB folklore is forbidden", {
          ruleId: candidate.id,
          claimId: claim.id
        });
      }
      if (
        expectedClaim === undefined ||
        typeof claim.value !== "number" ||
        !Number.isFinite(claim.value) ||
        typeof claim.unit !== "string" ||
        !["ohm_mm", "per_deg_c", "deg_c"].includes(claim.unit) ||
        claim.value !== expectedClaim?.value ||
        claim.unit !== expectedClaim?.unit ||
        claim.applicability !== expectedClaim?.applicability ||
        typeof claim.scope !== "string" ||
        claim.scope.trim().length === 0 ||
        !Array.isArray(claim.sourceIds) ||
        claim.sourceIds.length === 0 ||
        !hasUniqueStrings(claim.sourceIds)
      ) {
        rejectCatalog("Numeric PCB claim is incomplete or unsourced", {
          ruleId: candidate.id,
          claimId: claim.id
        });
      }
      for (const sourceId of claim.sourceIds) {
        if (
          typeof sourceId !== "string" ||
          !sourceIds.has(sourceId) ||
          !(candidate.sourceIds as unknown[]).includes(sourceId)
        ) {
          rejectCatalog("Numeric PCB claim source is not bound to its rule", {
            ruleId: candidate.id,
            claimId: claim.id,
            sourceId
          });
        }
      }
    }
    if (
      !Array.isArray(candidate.caveats) ||
      !hasUniqueStrings(candidate.caveats) ||
      candidate.caveats.some((entry) => (entry as string).trim().length === 0)
    ) {
      rejectCatalog("PCB engineering rule caveats must be unique strings", {
        ruleId: candidate.id
      });
    }
    const expectedRule = PCB_ENGINEERING_PRACTICE_RULES.find(
      (entry) => entry.id === candidate.id
    );
    if (expectedRule === undefined || canonicalJson(candidate) !== canonicalJson(expectedRule)) {
      rejectCatalog("PCB engineering rule differs from the closed catalog", {
        ruleId: candidate.id
      });
    }
  }
  if (
    ruleIds.size !== PCB_ENGINEERING_PRACTICE_RULES.length ||
    PCB_ENGINEERING_PRACTICE_RULES.some((rule) => !ruleIds.has(rule.id))
  ) {
    rejectCatalog("PCB engineering rule inventory is incomplete");
  }

  if (!isRecord(value.identity)) {
    rejectCatalog("PCB engineering practice catalog identity is missing");
  }
  exactKeys(
    value.identity,
    ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"],
    "PCB engineering catalog identity"
  );
  if (
    value.identity.algorithm !== "sha256" ||
    typeof value.identity.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.identity.digest) ||
    value.identity.schemaVersion !== PCB_ENGINEERING_PRACTICE_SCHEMA ||
    value.identity.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    rejectCatalog("PCB engineering practice catalog identity fields are invalid");
  }
  const { identity, ...payload } = value;
  const recomputed = canonicalIdentity(payload, PCB_ENGINEERING_PRACTICE_SCHEMA);
  if (canonicalJson(identity) !== canonicalJson(recomputed)) {
    rejectCatalog("PCB engineering practice catalog identity does not reproduce", {
      expected: identity,
      actual: recomputed
    });
  }
}

export function validateAndSnapshotPcbEngineeringPracticeCatalog(
  value: unknown
): PcbEngineeringPracticeCatalog {
  assertPlainCatalogGraph(value, "catalog");
  const snapshot = detachedFrozen(value);
  assertCatalogSnapshotValid(snapshot);
  return snapshot;
}

const isDeeplyFrozen = (value: unknown, seen = new Set<object>()): boolean => {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value) || !Object.isFrozen(value)) return false;
  seen.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor) || !isDeeplyFrozen(descriptor.value, seen)) return false;
  }
  seen.delete(value);
  return true;
};

/**
 * @deprecated Use validateAndSnapshotPcbEngineeringPracticeCatalog and consume its return value.
 * This compatibility assertion accepts only an already deeply frozen original, so callers cannot
 * validate mutable live data and then continue reading it.
 */
export function assertValidPcbEngineeringPracticeCatalog(
  value: unknown
): asserts value is PcbEngineeringPracticeCatalog {
  validateAndSnapshotPcbEngineeringPracticeCatalog(value);
  if (!isDeeplyFrozen(value)) {
    rejectCatalog(
      "Mutable catalog assertions are forbidden; consume the validated frozen snapshot instead"
    );
  }
}

export const FABRICATOR_CAPABILITY_SNAPSHOT_SCHEMA =
  "evleda.fabricator-capability-snapshot.v1" as const;
export const FABRICATOR_STACKUP_SCHEMA = "evleda.fabricator-stackup.v1" as const;

export interface FabricatorTraceGeometryCapability {
  readonly conductorLayer: "outer" | "inner";
  readonly unit: "mm";
  readonly minimumFinishedWidthMm: number;
  readonly maximumFinishedWidthMm: number;
  readonly minimumFinishedCopperThicknessMm: number;
  readonly maximumFinishedCopperThicknessMm: number;
  readonly widthToleranceMinusPercent: number;
  readonly widthTolerancePlusPercent: number;
  readonly thicknessToleranceMinusPercent: number;
  readonly thicknessTolerancePlusPercent: number;
  readonly valuesAreMinimumAfterTolerance: true;
}

export interface FabricatorViaBarrelGeometryCapability {
  readonly viaType: "through";
  readonly unit: "mm";
  readonly minimumFinishedHoleDiameterMm: number;
  readonly maximumFinishedHoleDiameterMm: number;
  readonly minimumBarrelPlatingThicknessMm: number;
  readonly maximumBarrelPlatingThicknessMm: number;
  readonly holeDepthMm: number;
  readonly holeDiameterToleranceMinusMm: number;
  readonly holeDiameterTolerancePlusMm: number;
  readonly platingThicknessToleranceMinusMm: number;
  readonly platingThicknessTolerancePlusMm: number;
  readonly valuesAreMinimumAfterTolerance: true;
}

export interface FabricatorCapabilityData {
  readonly selectedOrderOptions: readonly string[];
  readonly traceGeometry: readonly FabricatorTraceGeometryCapability[];
  readonly viaBarrelGeometry: readonly FabricatorViaBarrelGeometryCapability[];
}

export interface FabricatorCapabilitySnapshotDocument {
  readonly schemaVersion: typeof FABRICATOR_CAPABILITY_SNAPSHOT_SCHEMA;
  readonly sourceId: PcbEngineeringSourceId;
  readonly sourcePublisher: string;
  readonly sourceUrl: string;
  readonly fabricatorName: string;
  readonly fabricationService: string;
  readonly capturedAt: string;
  readonly capabilityData: FabricatorCapabilityData;
}

export interface FabricatorStackupLayer {
  readonly name: string;
  readonly role: "outer" | "inner";
  readonly unit: "mm";
  readonly minimumFinishedCopperThicknessMm: number;
  readonly maximumFinishedCopperThicknessMm: number;
}

export interface FabricatorStackupDefinition {
  readonly schemaVersion: typeof FABRICATOR_STACKUP_SCHEMA;
  readonly fabricatorName: string;
  readonly fabricationService: string;
  readonly capabilitySnapshotIdentity: ContentIdentity;
  readonly stackupName: string;
  readonly finishedBoardThicknessMm: number;
  readonly layers: readonly FabricatorStackupLayer[];
}

export interface WorstCaseGeometryEvidence {
  readonly fabricatorName: string;
  readonly fabricationService: string;
  readonly capabilitySourceId: PcbEngineeringSourceId;
  readonly capabilitySnapshotIdentity: ContentIdentity;
  readonly capabilitySnapshotBytesBase64: string;
  readonly stackupIdentity: CanonicalIdentity;
  readonly stackupDefinition: FabricatorStackupDefinition;
  readonly minimumValuesIncludeManufacturingTolerance: true;
  readonly evaluatedAt: string;
}

export const FABRICATOR_CAPABILITY_EVIDENCE_POLICY = deepFreeze({
  schemaVersion: "evleda.fabricator-capability-evidence-policy.v1" as const,
  maximumSnapshotAgeMs: 30 * 24 * 60 * 60 * 1_000,
  authority: "self_attested_unverified" as const,
  gateEffect: "non_gating_until_trusted_capture_is_supplied" as const
});

export interface WorstCaseCopperGeometryInput {
  readonly conductorLayer: "outer" | "inner";
  readonly lengthMm: number;
  readonly minimumFinishedWidthMm: number;
  readonly minimumFinishedCopperThicknessMm: number;
  readonly evidence: WorstCaseGeometryEvidence;
}

export interface HotCopperResistanceInput {
  readonly geometry: WorstCaseCopperGeometryInput;
  readonly copperTemperatureC: number;
}

export interface HotCopperResistanceResult {
  readonly status: "calculated_unverified_non_gating";
  readonly evidenceAuthority: "self_attested_unverified";
  readonly modelId: "ti-linear-copper-resistance-v1";
  readonly modelIdentity: CanonicalIdentity;
  readonly exactInputs: readonly [ContentIdentity, CanonicalIdentity, CanonicalIdentity];
  readonly resistanceOhm: number;
  readonly resistivityOhmMmAtTemperature: number;
  readonly copperTemperatureC: number;
  readonly geometry: WorstCaseCopperGeometryInput;
  readonly identity: CanonicalIdentity;
}

export interface CopperVoltageDropInput {
  readonly currentA: number;
  readonly resistanceOhm: number;
}

export interface CopperVoltageDropResult {
  readonly status: "arithmetic_only_non_gating";
  readonly checkerId: "copper_voltage_drop_v1";
  readonly currentA: number;
  readonly resistanceOhm: number;
  readonly voltageDropV: number;
  readonly identity: CanonicalIdentity;
}

export interface CopperI2RLossInput {
  readonly rmsCurrentA: number;
  readonly resistanceOhm: number;
}

export interface CopperI2RLossResult {
  readonly status: "arithmetic_only_non_gating";
  readonly checkerId: "copper_i2r_loss_v1";
  readonly rmsCurrentA: number;
  readonly resistanceOhm: number;
  readonly lossW: number;
  readonly identity: CanonicalIdentity;
}

export interface WorstCaseViaBarrelGeometryInput {
  readonly holeDepthMm: number;
  readonly minimumFinishedHoleDiameterMm: number;
  readonly minimumBarrelPlatingThicknessMm: number;
  readonly evidence: WorstCaseGeometryEvidence;
}

export interface ViaBarrelResistanceInput {
  readonly geometry: WorstCaseViaBarrelGeometryInput;
  readonly copperTemperatureC: number;
}

export interface ViaBarrelResistanceResult {
  readonly status: "calculated_unverified_non_gating";
  readonly evidenceAuthority: "self_attested_unverified";
  readonly modelId: "cylindrical-copper-annulus-v1";
  readonly modelIdentity: CanonicalIdentity;
  readonly materialModelId: "ti-linear-copper-resistance-v1";
  readonly materialModelIdentity: CanonicalIdentity;
  readonly exactInputs: readonly [ContentIdentity, CanonicalIdentity, CanonicalIdentity, CanonicalIdentity];
  readonly resistanceOhm: number;
  readonly conductiveCrossSectionMm2: number;
  readonly resistivityOhmMmAtTemperature: number;
  readonly copperTemperatureC: number;
  readonly geometry: WorstCaseViaBarrelGeometryInput;
  readonly ampacity: {
    readonly status: "not_evaluated";
    readonly requiredGate: "licensed_or_qualified_current_temperature_model";
  };
  readonly identity: CanonicalIdentity;
}

export const PCB_ENGINEERING_CALCULATION_DOMAINS = deepFreeze({
  copperTemperatureC: { minimumInclusive: -55, maximumInclusive: 200 },
  traceLengthMm: { minimumInclusive: 0.01, maximumInclusive: 10_000 },
  traceWidthMm: { minimumInclusive: 0.01, maximumInclusive: 1_000 },
  copperThicknessMm: { minimumInclusive: 0.001, maximumInclusive: 1 },
  viaDepthMm: { minimumInclusive: 0.01, maximumInclusive: 100 },
  viaFinishedDiameterMm: { minimumInclusive: 0.01, maximumInclusive: 10 },
  viaPlatingThicknessMm: { minimumInclusive: 0.001, maximumInclusive: 1 },
  currentA: { minimumExclusive: 0, maximumInclusive: 100_000 },
  resistanceOhm: { minimumExclusive: 0, maximumInclusive: 1_000_000 }
});

export const COPPER_LINEAR_MATERIAL_MODEL = deepFreeze({
  modelId: "ti-linear-copper-resistance-v1" as const,
  sourceId: "ti-analog-engineers-pocket-reference-rev-c" as const,
  referenceTemperatureC: 25,
  resistivityOhmMmAtReferenceTemperature: 17e-6,
  linearTemperatureCoefficientPerC: 3.9e-3,
  temperatureDomainC: PCB_ENGINEERING_CALCULATION_DOMAINS.copperTemperatureC,
  purpose: "deterministic_resistance_calculation_only" as const
});

export const COPPER_LINEAR_MATERIAL_MODEL_IDENTITY = deepFreeze(
  canonicalIdentity(COPPER_LINEAR_MATERIAL_MODEL, "evleda.pcb-copper-material-model.v1")
);

const VIA_BARREL_MODEL = deepFreeze({
  modelId: "cylindrical-copper-annulus-v1" as const,
  materialModelId: COPPER_LINEAR_MATERIAL_MODEL.modelId,
  materialModel: COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,
  crossSectionModel: "exact_cylindrical_annulus" as const,
  purpose: "deterministic_barrel_resistance_only" as const,
  ampacity: "not_evaluated" as const
});

export const VIA_BARREL_MODEL_IDENTITY = deepFreeze(
  canonicalIdentity(VIA_BARREL_MODEL, "evleda.pcb-via-barrel-model.v1")
);

function rejectInput(message: string, field: string, value: unknown): never {
  throw new DomainError("INVALID_ARGUMENT", message, { field, value });
}

function rejectUnresolvedEvidence(message: string, field: string, value: unknown): never {
  throw new DomainError("GATE_FAILED", message, {
    status: "unresolved",
    field,
    value
  });
}

const assertPlainDataGraph = (
  value: unknown,
  field: string,
  seen = new Set<object>()
): void => {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    rejectInput("PCB engineering inputs must be non-proxy plain data", field, value);
  }
  if (seen.has(value)) {
    rejectInput("PCB engineering inputs must not contain cycles or aliases", field, value);
  }
  seen.add(value);
  const expectedPrototype = Array.isArray(value) ? Array.prototype : Object.prototype;
  if (Object.getPrototypeOf(value) !== expectedPrototype) {
    rejectInput("PCB engineering inputs must have a plain object or array prototype", field, value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      rejectInput("PCB engineering inputs must not contain symbol keys", field, key.toString());
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      rejectInput("PCB engineering inputs must not contain accessors", `${field}.${key}`, value);
    }
    if (Array.isArray(value) && key === "length") continue;
    assertPlainDataGraph(descriptor.value, `${field}.${key}`, seen);
  }
  seen.delete(value);
};

const snapshotPlainInput = <Value>(value: Value, field: string): Value => {
  assertPlainDataGraph(value, field);
  return detachedFrozen(value);
};

const exactInputKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string
): void => {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right, "en"));
  const wanted = [...expected].sort((left, right) => left.localeCompare(right, "en"));
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    rejectInput("PCB engineering calculation input contains missing or unknown fields", field, {
      expected: wanted,
      actual
    });
  }
};

const bounded = (
  value: unknown,
  field: string,
  bounds: {
    readonly minimumInclusive?: number;
    readonly minimumExclusive?: number;
    readonly maximumInclusive: number;
  }
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (bounds.minimumInclusive !== undefined && value < bounds.minimumInclusive) ||
    (bounds.minimumExclusive !== undefined && value <= bounds.minimumExclusive) ||
    value > bounds.maximumInclusive
  ) {
    rejectInput("PCB engineering calculation input is outside its model domain", field, {
      value,
      bounds
    });
  }
  return value;
};

const finitePositiveResult = (value: number, field: string): number => {
  if (!Number.isFinite(value) || value <= 0) {
    rejectInput("PCB engineering calculation produced a non-finite or non-positive result", field, value);
  }
  return value;
};

function assertContentIdentity(value: unknown, field: string): asserts value is ContentIdentity {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(["algorithm", "digest", "size"].sort()) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    rejectUnresolvedEvidence(
      "Worst-case geometry requires a valid capability snapshot identity",
      field,
      value
    );
  }
}

function assertCanonicalIdentity(value: unknown, field: string): asserts value is CanonicalIdentity {
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort()) !==
      canonicalJson(
        ["algorithm", "digest", "schemaVersion", "canonicalizationVersion"].sort()
      ) ||
    value.algorithm !== "sha256" ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest) ||
    typeof value.schemaVersion !== "string" ||
    value.schemaVersion.length === 0 ||
    value.canonicalizationVersion !== "evleda-c14n-json-v1"
  ) {
    rejectUnresolvedEvidence("Worst-case geometry requires a valid stackup identity", field, value);
  }
}

const evidenceNumber = (
  value: unknown,
  field: string,
  bounds: { readonly minimumInclusive: number; readonly maximumInclusive: number }
): number => {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < bounds.minimumInclusive ||
    value > bounds.maximumInclusive
  ) {
    rejectUnresolvedEvidence("Capability evidence numeric field is outside its typed domain", field, {
      value,
      bounds
    });
  }
  return value;
};

function assertCapabilityData(value: unknown): asserts value is FabricatorCapabilityData {
  if (!isRecord(value)) {
    rejectUnresolvedEvidence("Typed fabricator capability data is unavailable", "evidence.capabilityData", value);
  }
  const keys = ["selectedOrderOptions", "traceGeometry", "viaBarrelGeometry"];
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(keys.sort())) {
    rejectUnresolvedEvidence(
      "Fabricator capability data contains missing or unknown fields",
      "evidence.capabilityData",
      value
    );
  }
  if (
    !Array.isArray(value.selectedOrderOptions) ||
    value.selectedOrderOptions.length === 0 ||
    !hasUniqueStrings(value.selectedOrderOptions) ||
    value.selectedOrderOptions.some((option) => (option as string).trim().length === 0) ||
    !Array.isArray(value.traceGeometry) ||
    value.traceGeometry.length === 0 ||
    !Array.isArray(value.viaBarrelGeometry) ||
    value.viaBarrelGeometry.length === 0
  ) {
    rejectUnresolvedEvidence(
      "Fabricator capability data must bind order options and typed feature arrays",
      "evidence.capabilityData",
      value
    );
  }

  const traceLayers = new Set<string>();
  for (const candidate of value.traceGeometry) {
    if (!isRecord(candidate)) {
      rejectUnresolvedEvidence("Trace capability must be an object", "evidence.capabilityData.traceGeometry", candidate);
    }
    const traceKeys = [
      "conductorLayer",
      "unit",
      "minimumFinishedWidthMm",
      "maximumFinishedWidthMm",
      "minimumFinishedCopperThicknessMm",
      "maximumFinishedCopperThicknessMm",
      "widthToleranceMinusPercent",
      "widthTolerancePlusPercent",
      "thicknessToleranceMinusPercent",
      "thicknessTolerancePlusPercent",
      "valuesAreMinimumAfterTolerance"
    ];
    if (
      canonicalJson(Object.keys(candidate).sort()) !== canonicalJson(traceKeys.sort()) ||
      (candidate.conductorLayer !== "outer" && candidate.conductorLayer !== "inner") ||
      candidate.unit !== "mm" ||
      candidate.valuesAreMinimumAfterTolerance !== true ||
      traceLayers.has(candidate.conductorLayer)
    ) {
      rejectUnresolvedEvidence(
        "Trace capability is not closed, unit-bound, tolerance-derived, and unique by layer",
        "evidence.capabilityData.traceGeometry",
        candidate
      );
    }
    traceLayers.add(candidate.conductorLayer);
    const minimumWidth = evidenceNumber(
      candidate.minimumFinishedWidthMm,
      "evidence.capabilityData.traceGeometry.minimumFinishedWidthMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.traceWidthMm
    );
    const maximumWidth = evidenceNumber(
      candidate.maximumFinishedWidthMm,
      "evidence.capabilityData.traceGeometry.maximumFinishedWidthMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.traceWidthMm
    );
    const minimumThickness = evidenceNumber(
      candidate.minimumFinishedCopperThicknessMm,
      "evidence.capabilityData.traceGeometry.minimumFinishedCopperThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.copperThicknessMm
    );
    const maximumThickness = evidenceNumber(
      candidate.maximumFinishedCopperThicknessMm,
      "evidence.capabilityData.traceGeometry.maximumFinishedCopperThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.copperThicknessMm
    );
    for (const field of [
      "widthToleranceMinusPercent",
      "widthTolerancePlusPercent",
      "thicknessToleranceMinusPercent",
      "thicknessTolerancePlusPercent"
    ] as const) {
      evidenceNumber(candidate[field], `evidence.capabilityData.traceGeometry.${field}`, {
        minimumInclusive: 0,
        maximumInclusive: 100
      });
    }
    if (minimumWidth > maximumWidth || minimumThickness > maximumThickness) {
      rejectUnresolvedEvidence(
        "Trace capability minimum exceeds maximum",
        "evidence.capabilityData.traceGeometry",
        candidate
      );
    }
  }

  const viaTypes = new Set<string>();
  for (const candidate of value.viaBarrelGeometry) {
    if (!isRecord(candidate)) {
      rejectUnresolvedEvidence("Via capability must be an object", "evidence.capabilityData.viaBarrelGeometry", candidate);
    }
    const viaKeys = [
      "viaType",
      "unit",
      "minimumFinishedHoleDiameterMm",
      "maximumFinishedHoleDiameterMm",
      "minimumBarrelPlatingThicknessMm",
      "maximumBarrelPlatingThicknessMm",
      "holeDepthMm",
      "holeDiameterToleranceMinusMm",
      "holeDiameterTolerancePlusMm",
      "platingThicknessToleranceMinusMm",
      "platingThicknessTolerancePlusMm",
      "valuesAreMinimumAfterTolerance"
    ];
    if (
      canonicalJson(Object.keys(candidate).sort()) !== canonicalJson(viaKeys.sort()) ||
      candidate.viaType !== "through" ||
      candidate.unit !== "mm" ||
      candidate.valuesAreMinimumAfterTolerance !== true ||
      viaTypes.has(candidate.viaType)
    ) {
      rejectUnresolvedEvidence(
        "Via capability is not closed, unit-bound, tolerance-derived, and unique by type",
        "evidence.capabilityData.viaBarrelGeometry",
        candidate
      );
    }
    viaTypes.add(candidate.viaType);
    const minimumHole = evidenceNumber(
      candidate.minimumFinishedHoleDiameterMm,
      "evidence.capabilityData.viaBarrelGeometry.minimumFinishedHoleDiameterMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaFinishedDiameterMm
    );
    const maximumHole = evidenceNumber(
      candidate.maximumFinishedHoleDiameterMm,
      "evidence.capabilityData.viaBarrelGeometry.maximumFinishedHoleDiameterMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaFinishedDiameterMm
    );
    const minimumPlating = evidenceNumber(
      candidate.minimumBarrelPlatingThicknessMm,
      "evidence.capabilityData.viaBarrelGeometry.minimumBarrelPlatingThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaPlatingThicknessMm
    );
    const maximumPlating = evidenceNumber(
      candidate.maximumBarrelPlatingThicknessMm,
      "evidence.capabilityData.viaBarrelGeometry.maximumBarrelPlatingThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaPlatingThicknessMm
    );
    evidenceNumber(
      candidate.holeDepthMm,
      "evidence.capabilityData.viaBarrelGeometry.holeDepthMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaDepthMm
    );
    for (const field of [
      "holeDiameterToleranceMinusMm",
      "holeDiameterTolerancePlusMm",
      "platingThicknessToleranceMinusMm",
      "platingThicknessTolerancePlusMm"
    ] as const) {
      evidenceNumber(candidate[field], `evidence.capabilityData.viaBarrelGeometry.${field}`, {
        minimumInclusive: 0,
        maximumInclusive: 10
      });
    }
    if (minimumHole > maximumHole || minimumPlating > maximumPlating) {
      rejectUnresolvedEvidence(
        "Via capability minimum exceeds maximum",
        "evidence.capabilityData.viaBarrelGeometry",
        candidate
      );
    }
  }
}

function assertWorstCaseGeometryEvidenceSnapshotValid(
  value: unknown
): asserts value is WorstCaseGeometryEvidence {
  assertPlainDataGraph(value, "evidence");
  if (!isRecord(value)) {
    rejectUnresolvedEvidence("Worst-case geometry evidence is required", "evidence", value);
  }
  const expectedEvidenceKeys = [
    "fabricatorName",
    "fabricationService",
    "capabilitySourceId",
    "capabilitySnapshotIdentity",
    "capabilitySnapshotBytesBase64",
    "stackupIdentity",
    "stackupDefinition",
    "minimumValuesIncludeManufacturingTolerance",
    "evaluatedAt"
  ];
  if (
    canonicalJson(Object.keys(value).sort()) !== canonicalJson(expectedEvidenceKeys.sort())
  ) {
    rejectUnresolvedEvidence(
      "Worst-case geometry evidence contains missing or unknown fields",
      "evidence",
      value
    );
  }
  if (typeof value.fabricatorName !== "string" || value.fabricatorName.trim().length === 0) {
    rejectUnresolvedEvidence(
      "Fabricator name is required",
      "evidence.fabricatorName",
      value.fabricatorName
    );
  }
  if (
    typeof value.fabricationService !== "string" ||
    value.fabricationService.trim().length === 0
  ) {
    rejectUnresolvedEvidence(
      "Fabrication service and order option binding is required",
      "evidence.fabricationService",
      value.fabricationService
    );
  }
  if (typeof value.capabilitySourceId !== "string") {
    rejectUnresolvedEvidence(
      "Fabricator capability source ID is required",
      "evidence.capabilitySourceId",
      value.capabilitySourceId
    );
  }
  if (
    typeof value.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.evaluatedAt)) ||
    new Date(value.evaluatedAt).toISOString() !== value.evaluatedAt
  ) {
    rejectUnresolvedEvidence(
      "Capability evidence evaluation time is missing or invalid",
      "evidence.evaluatedAt",
      value.evaluatedAt
    );
  }
  const sourceRecord = PCB_ENGINEERING_PRACTICE_SOURCES.find(
    (candidate) => candidate.id === value.capabilitySourceId
  );
  if (
    sourceRecord?.authority !== "fabricator" ||
    sourceRecord.normativeStatus !== "fabricator_specific"
  ) {
    rejectUnresolvedEvidence(
      "Worst-case geometry must cite a cataloged fabricator capability source",
      "evidence.capabilitySourceId",
      value.capabilitySourceId
    );
  }
  if (
    sourceRecord.publisher !== value.fabricatorName ||
    typeof value.capabilitySnapshotBytesBase64 !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value.capabilitySnapshotBytesBase64
    )
  ) {
    rejectUnresolvedEvidence(
      "Fabricator identity or exact capability snapshot bytes are unavailable",
      "evidence.capabilitySnapshotBytesBase64",
      value.capabilitySnapshotBytesBase64
    );
  }
  const capabilityBytes = Buffer.from(value.capabilitySnapshotBytesBase64, "base64");
  if (
    capabilityBytes.length === 0 ||
    capabilityBytes.length > 1_048_576 ||
    capabilityBytes.toString("base64") !== value.capabilitySnapshotBytesBase64
  ) {
    rejectUnresolvedEvidence(
      "Capability snapshot bytes are empty, non-canonical, or outside the bounded evidence size",
      "evidence.capabilitySnapshotBytesBase64",
      value.capabilitySnapshotBytesBase64
    );
  }
  assertContentIdentity(value.capabilitySnapshotIdentity, "evidence.capabilitySnapshotIdentity");
  if (canonicalJson(contentIdentity(capabilityBytes)) !== canonicalJson(value.capabilitySnapshotIdentity)) {
    rejectUnresolvedEvidence(
      "Capability snapshot bytes do not reproduce their identity",
      "evidence.capabilitySnapshotIdentity",
      value.capabilitySnapshotIdentity
    );
  }
  let capabilityDocument: unknown;
  try {
    capabilityDocument = JSON.parse(capabilityBytes.toString("utf8"));
  } catch {
    rejectUnresolvedEvidence(
      "Capability snapshot is not canonical JSON evidence",
      "evidence.capabilitySnapshotBytesBase64",
      value.capabilitySnapshotBytesBase64
    );
  }
  if (!isRecord(capabilityDocument)) {
    rejectUnresolvedEvidence(
      "Capability snapshot document is not an object",
      "evidence.capabilitySnapshotBytesBase64",
      capabilityDocument
    );
  }
  const capabilityKeys = [
    "schemaVersion",
    "sourceId",
    "sourcePublisher",
    "sourceUrl",
    "fabricatorName",
    "fabricationService",
    "capturedAt",
    "capabilityData"
  ];
  if (
    canonicalJson(Object.keys(capabilityDocument).sort()) !== canonicalJson(capabilityKeys.sort()) ||
    capabilityDocument.schemaVersion !== FABRICATOR_CAPABILITY_SNAPSHOT_SCHEMA ||
    capabilityDocument.sourceId !== value.capabilitySourceId ||
    capabilityDocument.sourcePublisher !== sourceRecord.publisher ||
    capabilityDocument.sourceUrl !== sourceRecord.url ||
    capabilityDocument.fabricatorName !== value.fabricatorName ||
    capabilityDocument.fabricationService !== value.fabricationService ||
    typeof capabilityDocument.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(capabilityDocument.capturedAt)) ||
    new Date(capabilityDocument.capturedAt).toISOString() !== capabilityDocument.capturedAt ||
    !isRecord(capabilityDocument.capabilityData) ||
    capabilityBytes.toString("utf8") !== `${canonicalJson(capabilityDocument)}\n`
  ) {
    rejectUnresolvedEvidence(
      "Capability snapshot metadata is not canonical or consistent with its source and service",
      "evidence.capabilitySnapshotBytesBase64",
      capabilityDocument
    );
  }
  const capturedAtMs = Date.parse(capabilityDocument.capturedAt as string);
  const evaluatedAtMs = Date.parse(value.evaluatedAt);
  if (capturedAtMs > evaluatedAtMs) {
    rejectUnresolvedEvidence(
      "Capability snapshot is future-dated relative to evaluation time",
      "evidence.evaluatedAt",
      { capturedAt: capabilityDocument.capturedAt, evaluatedAt: value.evaluatedAt }
    );
  }
  if (
    evaluatedAtMs - capturedAtMs >
    FABRICATOR_CAPABILITY_EVIDENCE_POLICY.maximumSnapshotAgeMs
  ) {
    rejectUnresolvedEvidence(
      "Capability snapshot is stale under the bounded evidence policy",
      "evidence.evaluatedAt",
      { capturedAt: capabilityDocument.capturedAt, evaluatedAt: value.evaluatedAt }
    );
  }
  assertCapabilityData(capabilityDocument.capabilityData);
  if (!capabilityDocument.capabilityData.selectedOrderOptions.includes(value.fabricationService)) {
    rejectUnresolvedEvidence(
      "Capability snapshot selected order options do not bind the declared fabrication service",
      "evidence.fabricationService",
      value.fabricationService
    );
  }
  if (!isRecord(value.stackupDefinition)) {
    rejectUnresolvedEvidence(
      "Exact stackup definition is unavailable",
      "evidence.stackupDefinition",
      value.stackupDefinition
    );
  }
  const stackupKeys = [
    "schemaVersion",
    "fabricatorName",
    "fabricationService",
    "capabilitySnapshotIdentity",
    "stackupName",
    "finishedBoardThicknessMm",
    "layers"
  ];
  if (
    canonicalJson(Object.keys(value.stackupDefinition).sort()) !== canonicalJson(stackupKeys.sort()) ||
    value.stackupDefinition.schemaVersion !== FABRICATOR_STACKUP_SCHEMA ||
    value.stackupDefinition.fabricatorName !== value.fabricatorName ||
    value.stackupDefinition.fabricationService !== value.fabricationService ||
    canonicalJson(value.stackupDefinition.capabilitySnapshotIdentity) !==
      canonicalJson(value.capabilitySnapshotIdentity) ||
    typeof value.stackupDefinition.stackupName !== "string" ||
    value.stackupDefinition.stackupName.trim().length === 0 ||
    typeof value.stackupDefinition.finishedBoardThicknessMm !== "number" ||
    !Number.isFinite(value.stackupDefinition.finishedBoardThicknessMm) ||
    value.stackupDefinition.finishedBoardThicknessMm <
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaDepthMm.minimumInclusive ||
    value.stackupDefinition.finishedBoardThicknessMm >
      PCB_ENGINEERING_CALCULATION_DOMAINS.viaDepthMm.maximumInclusive ||
    !Array.isArray(value.stackupDefinition.layers) ||
    value.stackupDefinition.layers.length === 0
  ) {
    rejectUnresolvedEvidence(
      "Stackup definition is incomplete or inconsistent with the captured capability",
      "evidence.stackupDefinition",
      value.stackupDefinition
    );
  }
  const layerNames = new Set<string>();
  for (const layer of value.stackupDefinition.layers) {
    if (!isRecord(layer)) {
      rejectUnresolvedEvidence("Stackup layer must be an object", "evidence.stackupDefinition.layers", layer);
    }
    const layerKeys = [
      "name",
      "role",
      "unit",
      "minimumFinishedCopperThicknessMm",
      "maximumFinishedCopperThicknessMm"
    ];
    if (
      canonicalJson(Object.keys(layer).sort()) !== canonicalJson(layerKeys.sort()) ||
      typeof layer.name !== "string" ||
      layer.name.trim().length === 0 ||
      layerNames.has(layer.name) ||
      (layer.role !== "outer" && layer.role !== "inner") ||
      layer.unit !== "mm"
    ) {
      rejectUnresolvedEvidence(
        "Stackup layer is not closed, unique, and unit-bound",
        "evidence.stackupDefinition.layers",
        layer
      );
    }
    layerNames.add(layer.name);
    const minimumThickness = evidenceNumber(
      layer.minimumFinishedCopperThicknessMm,
      "evidence.stackupDefinition.layers.minimumFinishedCopperThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.copperThicknessMm
    );
    const maximumThickness = evidenceNumber(
      layer.maximumFinishedCopperThicknessMm,
      "evidence.stackupDefinition.layers.maximumFinishedCopperThicknessMm",
      PCB_ENGINEERING_CALCULATION_DOMAINS.copperThicknessMm
    );
    if (minimumThickness > maximumThickness) {
      rejectUnresolvedEvidence(
        "Stackup layer minimum copper thickness exceeds maximum",
        "evidence.stackupDefinition.layers",
        layer
      );
    }
  }
  assertCanonicalIdentity(value.stackupIdentity, "evidence.stackupIdentity");
  const recomputedStackup = canonicalIdentity(value.stackupDefinition, FABRICATOR_STACKUP_SCHEMA);
  if (canonicalJson(recomputedStackup) !== canonicalJson(value.stackupIdentity)) {
    rejectUnresolvedEvidence(
      "Stackup definition does not reproduce its identity",
      "evidence.stackupIdentity",
      value.stackupIdentity
    );
  }
  if (value.minimumValuesIncludeManufacturingTolerance !== true) {
    rejectUnresolvedEvidence(
      "Geometry values must include manufacturing tolerance before calculation",
      "evidence.minimumValuesIncludeManufacturingTolerance",
      value.minimumValuesIncludeManufacturingTolerance
    );
  }
}

export function validateAndSnapshotWorstCaseGeometryEvidence(
  value: unknown
): WorstCaseGeometryEvidence {
  const snapshot = snapshotPlainInput(value, "evidence");
  assertWorstCaseGeometryEvidenceSnapshotValid(snapshot);
  return snapshot;
}

/**
 * @deprecated Use validateAndSnapshotWorstCaseGeometryEvidence and consume its return value.
 * This compatibility assertion accepts only an already deeply frozen original.
 */
export function assertWorstCaseGeometryEvidence(
  value: unknown
): asserts value is WorstCaseGeometryEvidence {
  validateAndSnapshotWorstCaseGeometryEvidence(value);
  if (!isDeeplyFrozen(value)) {
    rejectUnresolvedEvidence(
      "Mutable geometry evidence assertions are forbidden; consume the validated frozen snapshot instead",
      "evidence",
      value
    );
  }
}

const capabilityDocumentFor = (
  evidence: WorstCaseGeometryEvidence
): FabricatorCapabilitySnapshotDocument =>
  JSON.parse(
    Buffer.from(evidence.capabilitySnapshotBytesBase64, "base64").toString("utf8")
  ) as FabricatorCapabilitySnapshotDocument;

const hotCopperResistivity = (temperatureC: unknown): { temperatureC: number; rho: number } => {
  const temperature = bounded(
    temperatureC,
    "copperTemperatureC",
    PCB_ENGINEERING_CALCULATION_DOMAINS.copperTemperatureC
  );
  const rho =
    COPPER_LINEAR_MATERIAL_MODEL.resistivityOhmMmAtReferenceTemperature *
    (1 +
      COPPER_LINEAR_MATERIAL_MODEL.linearTemperatureCoefficientPerC *
        (temperature - COPPER_LINEAR_MATERIAL_MODEL.referenceTemperatureC));
  if (!Number.isFinite(rho) || rho <= 0) {
    rejectInput(
      "Copper temperature is outside the positive domain of the cited linear model",
      "copperTemperatureC",
      temperature
    );
  }
  return { temperatureC: temperature, rho };
};

export const calculateHotCopperResistance = (
  input: HotCopperResistanceInput
): HotCopperResistanceResult => {
  const snapshot = snapshotPlainInput(input, "input");
  if (!isRecord(snapshot) || !isRecord(snapshot.geometry)) {
    rejectInput("Worst-case copper geometry is required", "geometry", snapshot);
  }
  exactInputKeys(snapshot, ["geometry", "copperTemperatureC"], "input");
  const geometry = snapshot.geometry as unknown as Record<string, unknown>;
  exactInputKeys(
    geometry,
    [
      "conductorLayer",
      "lengthMm",
      "minimumFinishedWidthMm",
      "minimumFinishedCopperThicknessMm",
      "evidence"
    ],
    "geometry"
  );
  if (geometry.conductorLayer !== "outer" && geometry.conductorLayer !== "inner") {
    rejectInput("Conductor layer must be explicit", "geometry.conductorLayer", geometry.conductorLayer);
  }
  const lengthMm = bounded(
    geometry.lengthMm,
    "geometry.lengthMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.traceLengthMm
  );
  const widthMm = bounded(
    geometry.minimumFinishedWidthMm,
    "geometry.minimumFinishedWidthMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.traceWidthMm
  );
  const thicknessMm = bounded(
    geometry.minimumFinishedCopperThicknessMm,
    "geometry.minimumFinishedCopperThicknessMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.copperThicknessMm
  );
  const evidence = validateAndSnapshotWorstCaseGeometryEvidence(geometry.evidence);
  const capabilityDocument = capabilityDocumentFor(evidence);
  const traceCapabilities = capabilityDocument.capabilityData.traceGeometry.filter(
    (candidate) => candidate.conductorLayer === geometry.conductorLayer
  );
  const stackupLayers = evidence.stackupDefinition.layers.filter(
    (layer) => layer.role === geometry.conductorLayer
  );
  if (
    traceCapabilities.length !== 1 ||
    traceCapabilities[0]!.minimumFinishedWidthMm !== widthMm ||
    traceCapabilities[0]!.minimumFinishedCopperThicknessMm !== thicknessMm ||
    stackupLayers.length === 0 ||
    stackupLayers.some((layer) => layer.minimumFinishedCopperThicknessMm !== thicknessMm)
  ) {
    rejectUnresolvedEvidence(
      "Trace geometry does not equal the captured minimum-after-tolerance capability and stackup values",
      "geometry",
      geometry
    );
  }
  const material = hotCopperResistivity(snapshot.copperTemperatureC);
  const numerator = finitePositiveResult(material.rho * lengthMm, "resistanceNumerator");
  const crossSection = finitePositiveResult(widthMm * thicknessMm, "traceCrossSectionMm2");
  const resistanceOhm = finitePositiveResult(numerator / crossSection, "resistanceOhm");
  const geometrySnapshot: WorstCaseCopperGeometryInput = detachedFrozen({
    conductorLayer: geometry.conductorLayer,
    lengthMm,
    minimumFinishedWidthMm: widthMm,
    minimumFinishedCopperThicknessMm: thicknessMm,
    evidence
  });
  const payload = {
    status: "calculated_unverified_non_gating" as const,
    evidenceAuthority: "self_attested_unverified" as const,
    modelId: "ti-linear-copper-resistance-v1" as const,
    modelIdentity: COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,
    exactInputs: [
      geometrySnapshot.evidence.capabilitySnapshotIdentity,
      geometrySnapshot.evidence.stackupIdentity,
      COPPER_LINEAR_MATERIAL_MODEL_IDENTITY
    ] as const,
    resistanceOhm,
    resistivityOhmMmAtTemperature: material.rho,
    copperTemperatureC: material.temperatureC,
    geometry: geometrySnapshot
  };
  return detachedFrozen({
    ...payload,
    identity: canonicalIdentity(payload, "evleda.hot-copper-resistance-result.v1")
  });
};

export const calculateCopperVoltageDrop = (
  input: CopperVoltageDropInput
): CopperVoltageDropResult => {
  const snapshot = snapshotPlainInput(input, "input");
  if (!isRecord(snapshot)) rejectInput("Voltage-drop inputs are required", "input", snapshot);
  exactInputKeys(snapshot, ["currentA", "resistanceOhm"], "input");
  const currentA = bounded(
    snapshot.currentA,
    "currentA",
    PCB_ENGINEERING_CALCULATION_DOMAINS.currentA
  );
  const resistanceOhm = bounded(
    snapshot.resistanceOhm,
    "resistanceOhm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.resistanceOhm
  );
  const payload = {
    status: "arithmetic_only_non_gating" as const,
    checkerId: "copper_voltage_drop_v1" as const,
    currentA,
    resistanceOhm,
    voltageDropV: finitePositiveResult(currentA * resistanceOhm, "voltageDropV")
  };
  return detachedFrozen({
    ...payload,
    identity: canonicalIdentity(payload, "evleda.copper-voltage-drop-arithmetic.v1")
  });
};

export const calculateCopperI2RLoss = (input: CopperI2RLossInput): CopperI2RLossResult => {
  const snapshot = snapshotPlainInput(input, "input");
  if (!isRecord(snapshot)) rejectInput("Resistive-loss inputs are required", "input", snapshot);
  exactInputKeys(snapshot, ["rmsCurrentA", "resistanceOhm"], "input");
  const rmsCurrentA = bounded(
    snapshot.rmsCurrentA,
    "rmsCurrentA",
    PCB_ENGINEERING_CALCULATION_DOMAINS.currentA
  );
  const resistanceOhm = bounded(
    snapshot.resistanceOhm,
    "resistanceOhm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.resistanceOhm
  );
  const currentSquared = finitePositiveResult(rmsCurrentA * rmsCurrentA, "rmsCurrentSquaredA2");
  const payload = {
    status: "arithmetic_only_non_gating" as const,
    checkerId: "copper_i2r_loss_v1" as const,
    rmsCurrentA,
    resistanceOhm,
    lossW: finitePositiveResult(currentSquared * resistanceOhm, "lossW")
  };
  return detachedFrozen({
    ...payload,
    identity: canonicalIdentity(payload, "evleda.copper-i2r-arithmetic.v1")
  });
};

export const calculateViaBarrelResistance = (
  input: ViaBarrelResistanceInput
): ViaBarrelResistanceResult => {
  const snapshot = snapshotPlainInput(input, "input");
  if (!isRecord(snapshot) || !isRecord(snapshot.geometry)) {
    rejectInput("Worst-case via barrel geometry is required", "geometry", snapshot);
  }
  exactInputKeys(snapshot, ["geometry", "copperTemperatureC"], "input");
  const geometry = snapshot.geometry as unknown as Record<string, unknown>;
  exactInputKeys(
    geometry,
    [
      "holeDepthMm",
      "minimumFinishedHoleDiameterMm",
      "minimumBarrelPlatingThicknessMm",
      "evidence"
    ],
    "geometry"
  );
  const holeDepthMm = bounded(
    geometry.holeDepthMm,
    "geometry.holeDepthMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.viaDepthMm
  );
  const finishedDiameterMm = bounded(
    geometry.minimumFinishedHoleDiameterMm,
    "geometry.minimumFinishedHoleDiameterMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.viaFinishedDiameterMm
  );
  const platingThicknessMm = bounded(
    geometry.minimumBarrelPlatingThicknessMm,
    "geometry.minimumBarrelPlatingThicknessMm",
    PCB_ENGINEERING_CALCULATION_DOMAINS.viaPlatingThicknessMm
  );
  const evidence = validateAndSnapshotWorstCaseGeometryEvidence(geometry.evidence);
  const capabilityDocument = capabilityDocumentFor(evidence);
  const viaCapabilities = capabilityDocument.capabilityData.viaBarrelGeometry.filter(
    (candidate) => candidate.viaType === "through"
  );
  if (
    viaCapabilities.length !== 1 ||
    viaCapabilities[0]!.minimumFinishedHoleDiameterMm !== finishedDiameterMm ||
    viaCapabilities[0]!.minimumBarrelPlatingThicknessMm !== platingThicknessMm ||
    viaCapabilities[0]!.holeDepthMm !== holeDepthMm ||
    evidence.stackupDefinition.finishedBoardThicknessMm !== holeDepthMm
  ) {
    rejectUnresolvedEvidence(
      "Via geometry does not equal the captured minimum-after-tolerance capability and stackup values",
      "geometry",
      geometry
    );
  }
  const material = hotCopperResistivity(snapshot.copperTemperatureC);
  const diameterSum = finitePositiveResult(
    finishedDiameterMm + platingThicknessMm,
    "viaDiameterPlusPlatingMm"
  );
  const conductiveCrossSectionMm2 = finitePositiveResult(
    Math.PI * platingThicknessMm * diameterSum,
    "conductiveCrossSectionMm2"
  );
  const resistanceNumerator = finitePositiveResult(
    material.rho * holeDepthMm,
    "resistanceNumerator"
  );
  const resistanceOhm = finitePositiveResult(
    resistanceNumerator / conductiveCrossSectionMm2,
    "resistanceOhm"
  );
  const geometrySnapshot: WorstCaseViaBarrelGeometryInput = detachedFrozen({
    holeDepthMm,
    minimumFinishedHoleDiameterMm: finishedDiameterMm,
    minimumBarrelPlatingThicknessMm: platingThicknessMm,
    evidence
  });
  const payload = {
    status: "calculated_unverified_non_gating" as const,
    evidenceAuthority: "self_attested_unverified" as const,
    modelId: "cylindrical-copper-annulus-v1" as const,
    modelIdentity: VIA_BARREL_MODEL_IDENTITY,
    materialModelId: "ti-linear-copper-resistance-v1" as const,
    materialModelIdentity: COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,
    exactInputs: [
      geometrySnapshot.evidence.capabilitySnapshotIdentity,
      geometrySnapshot.evidence.stackupIdentity,
      COPPER_LINEAR_MATERIAL_MODEL_IDENTITY,
      VIA_BARREL_MODEL_IDENTITY
    ] as const,
    resistanceOhm,
    conductiveCrossSectionMm2,
    resistivityOhmMmAtTemperature: material.rho,
    copperTemperatureC: material.temperatureC,
    geometry: geometrySnapshot,
    ampacity: {
      status: "not_evaluated" as const,
      requiredGate: "licensed_or_qualified_current_temperature_model" as const
    }
  };
  return detachedFrozen({
    ...payload,
    identity: canonicalIdentity(payload, "evleda.via-barrel-resistance-result.v1")
  });
};

assertValidPcbEngineeringPracticeCatalog(PCB_ENGINEERING_PRACTICE_CATALOG);
