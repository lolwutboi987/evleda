import { z } from "zod";
import { hardenPortableValue } from "../core/portable-artifact.js";
import { pcbDifferentialPairRequirementSchema } from "../harness/pcb-interface-requirements.js";
import type { KicadTransmissionLineCalculator } from "../integrations/kicad-transmission-line.js";
import type { ToolboxInterfaceResult } from "./toolbox-interface-report.js";

/** Requirements and source selection are bound by the host, never supplied here. */
export const toolboxInterfaceQuerySchema = z.object({
  interfaceId: pcbDifferentialPairRequirementSchema.shape.id,
}).strict();

export function snapshotToolboxInterfaceQuery(argument: unknown) {
  return toolboxInterfaceQuerySchema.parse(hardenPortableValue(argument, {
    maxBytes: 1024, maxDepth: 2, maxNodes: 8, maxArrayLength: 0,
    maxOwnKeys: 1, maxKeyBytes: 32, maxStringBytes: 128,
  }));
}

export type ToolboxInterfaceCheck = (interfaceId: string,
  calculator?: KicadTransmissionLineCalculator) => Promise<ToolboxInterfaceResult>;

/** Native, filesystem and helper failures may contain private paths or sources. */
export const TOOLBOX_INTERFACE_ERROR = "Interface assessment could not verify the selected interface and current saved project; no assessment was published.";
