import { z } from "zod";
import { pcbDesignContractPayloadSchema } from "./pcb-design-contract.js";

const identifier = pcbDesignContractPayloadSchema.shape.netClasses.element.shape.id;
export const text = z.string().min(1).max(1024).refine(value => value.trim() === value && value.isWellFormed()
  && !/[\u0000-\u001f\u007f]/u.test(value), "Provide bounded scalar text without surrounding whitespace or control characters");
export const number = (min: number, max: number) => z.number().finite().min(min).max(max)
  .refine(value => !Object.is(value, -0), "Negative zero is not canonical");
export const positive = number(0.000_001, 1_000_000);
export const nativeThickness = number(0.000_001, 2147.483637).refine(value => Number(value.toFixed(6)) === value,
  "Saved native construction requires exact integer-nanometre thicknesses");
export const nativeMaterialScalar = (min: number, max: number) => number(min, max).refine(value =>
  Number(value !== 0 && value <= 0.0001 ? value.toFixed(16) : value.toPrecision(10)) === value,
  "Material scalar cannot be saved exactly by the pinned native stackup serializer; provide an explicit representable value");
export const nativeMaterialText = text.refine(value => value.toLowerCase() !== "not specified",
  "The native unspecified-material sentinel cannot stand for an explicit material or finish declaration");
export const frequency = number(1, 1e15);
export const length = number(0, 1_000_000);
export const source = z.object({ kind: z.literal("caller_assertion"), reference: text, description: text }).strict();
export const sourceDraft = source.extend({ reference: text.nullable(), description: text.nullable() }).strict();

const material = z.object({ material: nativeMaterialText, relativePermittivity: nativeMaterialScalar(1, 1000), lossTangent: nativeMaterialScalar(0, 100), frequencyHz: frequency, source }).strict();
const materialDraft = material.extend({ material: nativeMaterialText.nullable(), relativePermittivity: material.shape.relativePermittivity.nullable(),
  lossTangent: material.shape.lossTangent.nullable(), frequencyHz: frequency.nullable(), source: sourceDraft.nullable() }).strict();
const dielectric = material.extend({ thicknessMm: nativeThickness, substrateRelativePermeability: positive }).strict();
const dielectricDraft = materialDraft.extend({ thicknessMm: nativeThickness.nullable(), substrateRelativePermeability: positive.nullable() }).strict();
const absentMask = z.object({ kind: z.literal("absent") }).strict();
const presentMask = material.extend({ kind: z.literal("present"), thicknessMm: nativeThickness }).strict();
const presentMaskDraft = materialDraft.extend({ kind: z.literal("present"), thicknessMm: nativeThickness.nullable() }).strict();
const mask = z.discriminatedUnion("kind", [absentMask, presentMask]);
const maskDraft = z.discriminatedUnion("kind", [absentMask, presentMaskDraft]);
const masks = z.object({ front: mask, back: mask }).strict();
const masksDraft = masks.extend({ front: maskDraft.nullable(), back: maskDraft.nullable() }).strict();
const exterior = z.object({ front: z.literal("air"), back: z.literal("air") }).strict();
const exteriorDraft = exterior.extend({ front: z.literal("air").nullable(), back: z.literal("air").nullable() }).strict();
const conductor = z.object({ conductivitySiemensPerMetre: number(1, 1e10), relativePermeability: positive, roughnessNm: length, source }).strict();
const conductorDraft = conductor.extend({ conductivitySiemensPerMetre: conductor.shape.conductivitySiemensPerMetre.nullable(),
  relativePermeability: positive.nullable(), roughnessNm: length.nullable(), source: sourceDraft.nullable() }).strict();
export const pcbInterfaceConstructionSchema = z.object({ mode: z.literal("two_layer"), id: identifier,
  boardThicknessMm: nativeThickness, frontCopperThicknessMm: nativeThickness, backCopperThicknessMm: nativeThickness,
  dielectric, conductor, solderMask: masks, exterior, surfaceFinish: nativeMaterialText, source }).strict();
export const pcbInterfaceConstructionDraftSchema = pcbInterfaceConstructionSchema.extend({ boardThicknessMm: nativeThickness.nullable(), frontCopperThicknessMm: nativeThickness.nullable(),
  backCopperThicknessMm: nativeThickness.nullable(), dielectric: dielectricDraft.nullable(), conductor: conductorDraft.nullable(),
  solderMask: masksDraft.nullable(), exterior: exteriorDraft.nullable(), surfaceFinish: nativeMaterialText.nullable(), source: sourceDraft.nullable() }).strict();
