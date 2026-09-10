import type { ContentIdentity } from "../domain/types.js";
import { createFreshConnectivityContract, type FreshConnectivityContractSource } from "./fresh-connectivity-contract.js";
import {
  FreshKicadParseError,
  parseFreshSchematicTerminalGeometrySource,
  selectFreshSymbolBodyGeometry,
  selectFreshSymbolTerminalGeometryPins,
  type FreshSchematicTerminalPinGeometry,
  type FreshSymbolTerminalGeometry,
} from "./fresh-kicad-parser.js";
import {
  buildSchematicTerminalGroups,
  transformFreshSchematicSourcePin,
  type FreshSchematicSourceComponent,
  type FreshSchematicTerminalInput,
} from "./fresh-schematic-terminal-groups.js";
import type { FreshSchematicWorkBudget } from "./fresh-schematic-work-budget.js";
import { applyFreshSchematicStrokeStyle, assertFreshSchematicStrokeStyleEvidence, type FreshSchematicStrokeStyleEvidence } from "./fresh-schematic-stroke-style.js";

/** Host-owned read-only port. Bind this to the allowlisted stock resolver, never tool arguments. */
export interface FreshSchematicApprovedGeometryResolver {
  inspectSymbolTerminalGeometry(exactLibraryId: string): FreshSymbolTerminalGeometry | null;
}

export interface FreshSchematicSourceAdapterInput {
  readonly schematicSource: string;
  readonly expectedSourceIdentity: ContentIdentity;
  readonly contract: FreshConnectivityContractSource;
  readonly libraryResolver: FreshSchematicApprovedGeometryResolver;
  /** Must originate in the host's current private native readback, not model metadata. */
  readonly livePins: FreshSchematicTerminalInput["livePins"];
  readonly strokeStyleEvidence?: FreshSchematicStrokeStyleEvidence;
}

function pinKey(pin: FreshSchematicTerminalPinGeometry): string {
  // Exact numeric geometry and every electrical/visibility selector are compared;
  // file hashes retain raw byte identity separately. This is not drawing equivalence.
  return JSON.stringify([pin.number, pin.name, pin.electricalType, pin.graphicalShape,
    pin.at.xMm, pin.at.yMm, pin.angleDeg, pin.lengthMm, pin.hidden, pin.unit, pin.bodyStyle]);
}

/**
 * Convert exact current schematic bytes into complete terminal input. The same
 * bounded S-expression reader extracts embedded and approved stock geometry.
 * No caller-provided local coordinates, pin inventory, or source hash alone is
 * treated as proof. Native provenance of livePins remains the host's obligation.
 */
export function buildFreshSchematicSourceTerminalGroups(input: FreshSchematicSourceAdapterInput, budget?: FreshSchematicWorkBudget) {
  const contract = createFreshConnectivityContract(input.contract);
  const placed = parseFreshSchematicTerminalGeometrySource(input.schematicSource, input.expectedSourceIdentity);
  if (input.strokeStyleEvidence !== undefined) assertFreshSchematicStrokeStyleEvidence(input.strokeStyleEvidence, input.expectedSourceIdentity);
  const expected = new Map(contract.components.map((component) => [component.reference, component.symbolLibId]));
  // Both supported contracts explicitly permit only single-unit components (unit 1).
  if (placed.length !== expected.size || placed.some((component) => expected.get(component.reference) !== component.symbolLibId || component.unit !== 1)) {
    throw new FreshKicadParseError("Source terminal component/reference/library inventory differs from the validated contract.");
  }
  const approved = new Map<string, FreshSymbolTerminalGeometry>();
  const sourceBindings = placed.map((component) => {
    let stock = approved.get(component.symbolLibId);
    if (stock === undefined) {
      const inspected = input.libraryResolver.inspectSymbolTerminalGeometry(component.symbolLibId);
      if (inspected === null || inspected.libraryId !== component.symbolLibId) {
        throw new FreshKicadParseError(`Source terminal ${component.reference}: no approved stock geometry for ${component.symbolLibId}.`);
      }
      stock = inspected;
      approved.set(component.symbolLibId, stock);
    }
    if ([stock, component.embeddedGeometry].some((geometry) => geometry.representations.some((entry) => entry.unit > 1))) {
      throw new FreshKicadParseError(`Source terminal ${component.reference}: multi-unit library geometry is unsupported by the validated single-unit contract.`);
    }
    const selected = selectFreshSymbolTerminalGeometryPins(stock, component.unit, component.bodyStyle);
    const stockPins = new Map(selected.map((pin) => [pin.number, pinKey(pin)]));
    if (component.pins.length !== selected.length || component.pins.some((pin) => stockPins.get(pin.number) !== pinKey(pin))) {
      throw new FreshKicadParseError(`Source terminal ${component.reference}: selected embedded pins differ from exact approved library geometry.`);
    }
    return Object.freeze({ reference: component.reference, symbolLibId: component.symbolLibId, symbolUuid: component.symbolUuid,
      unit: component.unit, bodyStyle: component.bodyStyle, bodyStyleOrigin: component.bodyStyleOrigin,
      schematicSourceIdentity: component.sourceIdentity, embeddedDefinitionIdentity: component.embeddedDefinitionIdentity,
      librarySourceIdentity: stock.sourceIdentity, libraryDefinitionIdentity: stock.definitionIdentity });
  });
  const components: readonly FreshSchematicSourceComponent[] = Object.freeze(placed.map((component) => Object.freeze({
    reference: component.reference, symbolLibId: component.symbolLibId, unit: component.unit,
    sourceIdentity: component.sourceIdentity, placement: component.placement,
    pins: Object.freeze(component.pins.map((pin) => Object.freeze({ number: pin.number, at: pin.at, angleDeg: pin.angleDeg }))),
  })));
  const assignments: FreshSchematicTerminalInput["assignments"] = Object.freeze([
    ...contract.nets.flatMap((net) => net.endpoints.map((endpoint) => Object.freeze({ ...endpoint, assignment: Object.freeze({ kind: "net" as const, net: net.name }) }))),
    ...contract.noConnects.map((endpoint) => Object.freeze({ ...endpoint, assignment: Object.freeze({ kind: "no_connect" as const }) })),
  ]);
  const livePins = Object.freeze(input.livePins.map((pin) => Object.freeze({ ...pin, at: Object.freeze({ ...pin.at }) })));
  const terminalInput = Object.freeze({ contractIdentity: contract.sourceContractIdentity, components, assignments, livePins });
  const sourceBodyGeometry = placed.map((component, index) => {
    const stock = selectFreshSymbolBodyGeometry(approved.get(component.symbolLibId)!, component.unit, component.bodyStyle);
    const embedded = selectFreshSymbolBodyGeometry(component.embeddedGeometry, component.unit, component.bodyStyle);
    if (stock.length !== embedded.length || stock.some((graphic, position) => {
      const actual = embedded[position]!;
      return graphic.kind !== actual.kind || graphic.tokenIdentity.digest !== actual.tokenIdentity.digest || graphic.tokenIdentity.size !== actual.tokenIdentity.size;
    })) throw new FreshKicadParseError(`Source terminal ${component.reference}: selected embedded graphics differ from exact approved library graphics.`);
    const effective = input.strokeStyleEvidence === undefined ? embedded : applyFreshSchematicStrokeStyle(embedded, input.strokeStyleEvidence, input.expectedSourceIdentity);
    const unsupportedKinds = [...new Set(effective.flatMap((graphic) => graphic.unsupportedReason === null ? [] : [graphic.unsupportedReason]))].sort();
    const corners = effective.flatMap((graphic) => graphic.bounds === null ? [] : [
      [graphic.bounds.minXmm, graphic.bounds.minYmm], [graphic.bounds.minXmm, graphic.bounds.maxYmm],
      [graphic.bounds.maxXmm, graphic.bounds.minYmm], [graphic.bounds.maxXmm, graphic.bounds.maxYmm],
    ].map(([xMm, yMm]) => {
      // Reuse the audited schematic transform for rectangle-envelope corners, not inferred pins.
      return transformFreshSchematicSourcePin({ number: "body_corner", at: { xMm: xMm!, yMm: yMm! }, angleDeg: 0 }, component.placement).at;
    }));
    if (corners.some((point) => !Number.isFinite(point.xMm) || !Number.isFinite(point.yMm) || Math.abs(point.xMm) > 2000 || Math.abs(point.yMm) > 2000)) {
      unsupportedKinds.push("transformed-graphic-bounds-out-of-envelope");
    }
    const complete = unsupportedKinds.length === 0;
    const bounds = !complete || corners.length === 0 ? null : Object.freeze({
      minXmm: Math.min(...corners.map((point) => point.xMm)), maxXmm: Math.max(...corners.map((point) => point.xMm)),
      minYmm: Math.min(...corners.map((point) => point.yMm)), maxYmm: Math.max(...corners.map((point) => point.yMm)),
    });
    return Object.freeze({ ...sourceBindings[index]!, bounds,
      coverage: Object.freeze({ complete, unsupportedKinds: Object.freeze(unsupportedKinds), includesText: false as const, includesStroke: complete,
        renderedStrokeVerified: complete && input.strokeStyleEvidence !== undefined,
        strokeStyleIdentity: input.strokeStyleEvidence?.identity ?? null,
        scope: "selected-library-graphics-only" as const, graphicCount: embedded.length }) });
  });
  return Object.freeze({
    verificationScope: "exact_source_and_approved_selected_pin_geometry" as const,
    requiresTrustedNativeLiveReadback: true as const,
    sourceBindings: Object.freeze(sourceBindings),
    sourceBodyGeometry: Object.freeze(sourceBodyGeometry),
    terminalInput,
    result: buildSchematicTerminalGroups(terminalInput, budget),
  });
}
