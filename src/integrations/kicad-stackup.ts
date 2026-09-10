import type { ContentIdentity } from "../domain/types.js";
import { parseFreshPcbStackup, type FreshPcbStackup, type FreshStackupField, type FreshStackupObservationStatus } from "../harness/fresh-kicad-parser.js";
import { createKicadSavedSourceReader } from "./kicad-saved-source.js";

export { KICAD_SAVED_SOURCE_MAX_BYTES as KICAD_STACKUP_SOURCE_MAX_BYTES } from "./kicad-saved-source.js";
export interface KicadCopperSeparation {
  readonly fromCopper: string;
  readonly toCopper: string;
  readonly status: FreshStackupObservationStatus;
  readonly dielectricSublayers: readonly Readonly<{ layerIndex: number; sublayerIndex: number }>[];
  readonly thicknessMm: FreshStackupField<number>;
  readonly reason: string;
}
export interface KicadStackupReadResult {
  readonly schemaVersion: "evleda.kicad-stackup-observation.v1";
  readonly sourceIdentity: ContentIdentity;
  readonly stackup: FreshPcbStackup;
  /** Separations between adjacent copper layers, not selected signal-reference assignments. */
  readonly adjacentCopperSeparations: readonly KicadCopperSeparation[];
  readonly impedanceValidation: "not_performed";
  readonly limitations: readonly string[];
}

function copperSeparations(stackup: FreshPcbStackup): readonly KicadCopperSeparation[] {
  const copper = stackup.layers.filter(layer => layer.kind === "copper");
  return Object.freeze(copper.slice(1).map((to, index) => {
    const from = copper[index]!;
    const between = stackup.layers.slice(from.index + 1, to.index);
    const dielectrics = between.filter(layer => layer.kind === "dielectric");
    const dielectricSublayers = dielectrics.flatMap(layer => layer.sublayers.map(sublayer => Object.freeze({ layerIndex: layer.index, sublayerIndex: sublayer.index })));
    const fields = dielectrics.flatMap(layer => layer.sublayers.map(sublayer => sublayer.thicknessMm));
    const unsupported = stackup.status === "unsupported" || between.some(layer => layer.kind !== "dielectric") || fields.some(field => field.status === "unsupported");
    const absent = between.length === 0 || fields.length === 0 || fields.some(field => field.status !== "explicit" || field.value === null);
    const status = unsupported ? "unsupported" : absent ? "missing" : "explicit";
    const sources = Object.freeze(fields.flatMap(field => field.sources));
    return Object.freeze({ fromCopper: from.name!, toCopper: to.name!, status,
      dielectricSublayers: Object.freeze(dielectricSublayers),
      thicknessMm: Object.freeze({ status, value: status === "explicit" ? fields.reduce((sum, field) => sum + field.value!, 0) : null, sources }),
      reason: unsupported ? "Unsupported stackup or non-dielectric material lies between copper layers; no separation is inferred."
        : absent ? "One or more explicit intervening dielectric thicknesses are missing; general board thickness is not substituted."
          : "Sum of the explicit intervening dielectric sublayer thicknesses only; no effective epsilon_r or reference-plane assignment is inferred.",
    });
  }));
}

/** Bind once from host-owned project state. The returned reader accepts no model-selected path. */
export async function createKicadStackupReader(input: { readonly pcbPath: string }): Promise<() => Promise<KicadStackupReadResult>> {
  const observe = await createKicadSavedSourceReader(input);
  return async () => {
    const { value: stackup, sourceIdentity } = await observe(parseFreshPcbStackup);
    return Object.freeze({ schemaVersion: "evleda.kicad-stackup-observation.v1", sourceIdentity, stackup,
        adjacentCopperSeparations: copperSeparations(stackup), impedanceValidation: "not_performed",
        limitations: Object.freeze([
          "Explicit is a source-observation status, not a claim of complete or verified electrical inputs. Missing fields retain null values.",
          "General board thickness is not signal-reference dielectric height. Mask, paste, and silkscreen are never selected as substrate.",
          "Dielectric sublayers retain their separate material, epsilon_r, and loss tangent; heterogeneous values are not averaged.",
          "Declared epsilon_r has no verified frequency, method, process/design-value provenance, or fabrication tolerance in this observation.",
          "Copper layer presence is not a verified ground/reference plane. No field solving, impedance matching, return-path, or manufacturing pass is established.",
        ]),
    });
  };
}
