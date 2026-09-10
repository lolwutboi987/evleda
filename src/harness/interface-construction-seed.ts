import { parseFreshPcbStackup } from "./fresh-kicad-parser.js";
import { createNativeEmptyBoardSeed } from "./native-empty-board-seed.js";
import { isAuthenticatedPcbPlaneCompilationBundle, type PcbPlaneCompilationBundle } from "./pcb-design-plane-bundle.js";
import { pcbInterfaceConstructionSchema, type PcbInterfaceConstruction } from "./pcb-interface-requirements.js";

// KiCad 10.0.3, commit 146a4f2a7585c65bc580427a19b6fe2ec4a3f622:
// pcbnew/board_stackup_manager/board_stackup.cpp:736-818 (field order), :495-516 (total),
// common/string_utils.cpp:1446-1473 (scalar precision), common/eda_units.cpp:194-245,
// pcbnew/pcb_io/kicad_sexpr/pcb_io_kicad_sexpr_parser.cpp:200-227 (native length domain).
// These are file-creation bytes, not a live IPC stackup mutation or a native receipt.
const maximumNativeNm = 2_147_483_637;
const requireValue = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`Construction seed: ${message}`);
};
const trimFraction = (value: string): string => value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
const quote = (value: string): string => {
  requireValue(value.length > 0 && value.length <= 1024 && value.isWellFormed()
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), "unsupported native string");
  requireValue(value.toLowerCase() !== "not specified", "native unspecified material/finish sentinel is not a declaration");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};
const nativeNm = (value: number): number => {
  const nm = Math.round(value * 1_000_000);
  requireValue(Number.isFinite(value) && !Object.is(value, -0) && value > 0
    && Number.isSafeInteger(nm) && nm <= maximumNativeNm && nm / 1_000_000 === value,
  "thickness must be exact positive integer nanometers within the native domain");
  return nm;
};
const nativeThickness = (value: number): string => trimFraction((nativeNm(value) / 1_000_000).toFixed(6));
const nativeScalar = (value: number): string => {
  requireValue(Number.isFinite(value) && !Object.is(value, -0) && value >= 0 && value <= 1000, "unsupported native material scalar");
  const result = value !== 0 && value <= 0.0001 ? trimFraction(value.toFixed(16)) : String(Number(value.toPrecision(10)));
  requireValue(Number(result) === value, "material scalar cannot survive native serialization without rounding");
  return result;
};

interface NativeLayer {
  readonly name: string;
  readonly type: string;
  readonly thicknessMm: number;
  readonly material?: string;
  readonly relativePermittivity?: number;
  readonly lossTangent?: number;
}

function constructionLayers(construction: PcbInterfaceConstruction): readonly NativeLayer[] {
  const mask = (side: "front" | "back"): NativeLayer => {
    const value = construction.solderMask[side];
    const common = { name: side === "front" ? "F.Mask" : "B.Mask", type: side === "front" ? "Top Solder Mask" : "Bottom Solder Mask" };
    // Zero is an explicit absence declaration. Omission alone would leave saved-mask observation unknown.
    return value.kind === "absent" ? { ...common, thicknessMm: 0 }
      : { ...common, thicknessMm: value.thicknessMm, material: value.material, relativePermittivity: value.relativePermittivity, lossTangent: value.lossTangent };
  };
  return [mask("front"), { name: "F.Cu", type: "copper", thicknessMm: construction.frontCopperThicknessMm },
    { name: "dielectric 1", type: "core", thicknessMm: construction.dielectric.thicknessMm, material: construction.dielectric.material,
      relativePermittivity: construction.dielectric.relativePermittivity, lossTangent: construction.dielectric.lossTangent },
    { name: "B.Cu", type: "copper", thicknessMm: construction.backCopperThicknessMm }, mask("back")];
}

/** Only an authenticated host bundle can supply construction; no source text or file paths are accepted. */
export function createInterfaceConstructionBoardSeed(bundle: PcbPlaneCompilationBundle): string {
  requireValue(isAuthenticatedPcbPlaneCompilationBundle(bundle), "an authenticated V2 compilation bundle is required");
  const nativeEmpty = createNativeEmptyBoardSeed();
  const declaration = bundle.contract.interfaceRequirements?.construction;
  // Preserve historical no-extension and explicit-none boards byte-for-byte, including platform line endings.
  if (declaration === undefined || declaration.mode === "none") return nativeEmpty;
  const construction = pcbInterfaceConstructionSchema.parse(declaration);
  const layers = constructionLayers(construction);
  requireValue(layers.reduce((sum, layer) => sum + (layer.thicknessMm === 0 ? 0 : nativeNm(layer.thicknessMm)), 0)
    === nativeNm(construction.boardThicknessMm), "general thickness must exactly equal copper, dielectric and declared mask thicknesses");
  const forms = layers.map(layer => [
    `\t\t\t(layer ${quote(layer.name)}`,
    `\t\t\t\t(type ${quote(layer.type)})`,
    `\t\t\t\t(thickness ${layer.thicknessMm === 0 ? "0" : nativeThickness(layer.thicknessMm)}${layer.name === "dielectric 1" ? " locked" : ""})`,
    ...(layer.material === undefined ? [] : [
      `\t\t\t\t(material ${quote(layer.material)})`,
      `\t\t\t\t(epsilon_r ${nativeScalar(layer.relativePermittivity!)})`,
      `\t\t\t\t(loss_tangent ${nativeScalar(layer.lossTangent!)})`,
    ]),
    "\t\t\t)",
  ].join("\n"));
  // Native dielectric_constraints is an editing control, retained at its default; no impedance claim is encoded.
  const stackup = ["\t\t(stackup", ...forms, `\t\t\t(copper_finish ${quote(construction.surfaceFinish)})`,
    "\t\t\t(dielectric_constraints no)", "\t\t)", ""].join("\n");
  const newline = nativeEmpty.includes("\r\n") ? "\r\n" : "\n";
  const emptyLf = nativeEmpty.replaceAll("\r\n", "\n");
  requireValue(emptyLf.split("\t(setup\n").length === 2 && emptyLf.split("\t\t(thickness 1.6)\n").length === 2,
    "pinned native empty-board structure changed");
  const source = emptyLf.replace("\t\t(thickness 1.6)\n", `\t\t(thickness ${nativeThickness(construction.boardThicknessMm)})\n`)
    .replace("\t(setup\n", `\t(setup\n${stackup}`).replaceAll("\n", newline);
  const observed = parseFreshPcbStackup(source);
  requireValue(observed.status === "explicit" && observed.observationsComplete && observed.issues.length === 0
    && observed.generalBoardThicknessMm.status === "explicit" && observed.generalBoardThicknessMm.value === construction.boardThicknessMm
    && observed.boardCopperLayerOrder.join(",") === "F.Cu,B.Cu" && observed.layers.length === layers.length,
  "generated native stackup failed exact source readback");
  layers.forEach((layer, index) => {
    const actual = observed.layers[index]!, sublayer = actual.sublayers[0]!;
    requireValue(actual.name === layer.name && actual.type.status === "explicit" && actual.type.value === layer.type
      && actual.sublayers.length === 1 && sublayer.thicknessMm.status === "explicit" && sublayer.thicknessMm.value === layer.thicknessMm
      && (layer.material === undefined
        ? sublayer.material.status === "missing" && sublayer.epsilonR.status === "missing" && sublayer.lossTangent.status === "missing"
        : sublayer.material.status === "explicit" && sublayer.material.value === layer.material
          && sublayer.epsilonR.status === "explicit" && sublayer.epsilonR.value === layer.relativePermittivity
          && sublayer.lossTangent.status === "explicit" && sublayer.lossTangent.value === layer.lossTangent),
    "generated layer does not preserve the declared construction");
  });
  requireValue(observed.settings.length === 2 && observed.settings[0]?.source === `(copper_finish ${quote(construction.surfaceFinish)})`
    && observed.settings[1]?.source === "(dielectric_constraints no)", "generated finish/settings differ from the declared seed");
  // Frequency, permeability, conductivity, roughness and citations stay in the authenticated caller-assertion bundle.
  return source;
}
