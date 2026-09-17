import { canonicalIdentity } from "../core/canonical.js";
import type { CanonicalIdentity } from "../domain/types.js";
import { parsePcbExternalPowerBinding, type PcbExternalPowerBinding } from "./pcb-external-power.js";
import {
  parsePcbDesignContract,
  type PcbDesignContract,
} from "./pcb-design-contract.js";
import {
  PCB_PLANE_CONTRACT_SCHEMA_VERSION,
  parsePcbPlaneDesignContract,
  type PcbPlaneDesignContract,
} from "./pcb-design-plane-contract.js";
import {
  parseFreshLedIndicatorContract,
  type FreshLedIndicatorContract,
} from "./fresh-project.js";

export const FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION =
  "evleda.fresh-connectivity-contract.v1" as const;

export interface FreshConnectivityEndpoint {
  readonly reference: string;
  readonly pin: string;
}

export interface FreshConnectivityNet {
  readonly name: string;
  readonly endpoints: readonly FreshConnectivityEndpoint[];
}

export interface FreshConnectivityComponent {
  readonly reference: string;
  readonly symbolLibId: string;
  readonly value: string;
  readonly footprintLibId: string;
}

export interface FreshConnectivityContract {
  readonly schemaVersion: typeof FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION;
  readonly sourceContractIdentity: CanonicalIdentity;
  readonly components: readonly FreshConnectivityComponent[];
  readonly nets: readonly FreshConnectivityNet[];
  readonly noConnects: readonly FreshConnectivityEndpoint[];
  /** Separate source-bound schematic annotations; never physical components or routing endpoints. */
  readonly externalPowerBinding?: PcbExternalPowerBinding;
  readonly identity: CanonicalIdentity;
}

export type FreshConnectivityContractSource = FreshLedIndicatorContract | PcbDesignContract | PcbPlaneDesignContract;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
const compareEndpoint = (left: FreshConnectivityEndpoint, right: FreshConnectivityEndpoint): number =>
  compareText(left.reference, right.reference) || compareText(left.pin, right.pin);

const freeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

function fromLedContract(value: unknown): Omit<FreshConnectivityContract, "identity"> {
  const contract = parseFreshLedIndicatorContract(value);
  if (contract.schematic.noConnectMarkers !== 0) {
    throw new Error(
      "The LED proof contract records only a no-connect count; nonzero no-connects require endpoint identities before host connectivity can be applied.",
    );
  }
  return {
    schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
    sourceContractIdentity: canonicalIdentity(contract, contract.schemaVersion),
    components: contract.components
      .map(({ reference, symbolId, value, footprintId }) => ({ reference, symbolLibId: symbolId, value, footprintLibId: footprintId }))
      .sort((left, right) => compareText(left.reference, right.reference)),
    nets: contract.schematic.exactNets
      .map((net) => ({
        name: net.name,
        endpoints: net.endpoints
          .map((endpoint) => {
            const separator = endpoint.indexOf(":");
            return { reference: endpoint.slice(0, separator), pin: endpoint.slice(separator + 1) };
          })
          .sort(compareEndpoint),
      }))
      .sort((left, right) => compareText(left.name, right.name)),
    noConnects: [],
  };
}

function fromValidatedPcbDesignContract(contract: PcbDesignContract | PcbPlaneDesignContract): Omit<FreshConnectivityContract, "identity"> {
  return {
    schemaVersion: FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION,
    sourceContractIdentity: contract.identity,
    components: contract.components
      .map(({ reference, symbolLibId, value, footprintLibId }) => ({ reference, symbolLibId, value, footprintLibId }))
      .sort((left, right) => compareText(left.reference, right.reference)),
    nets: contract.nets
      .map((net) => ({
        name: net.name,
        endpoints: net.endpoints.map(({ reference, pin }) => ({ reference, pin })).sort(compareEndpoint),
      }))
      .sort((left, right) => compareText(left.name, right.name)),
    noConnects: contract.components
      .flatMap((component) => component.pins
        .filter((pin) => pin.assignment.kind === "no_connect")
        .map((pin) => ({ reference: component.reference, pin: pin.pin })))
      .sort(compareEndpoint),
  };
}

/**
 * Extract schematic connectivity only after validating the actual source
 * family. This graph protocol has no PCB routing or plane topology fields:
 * its existing v1 schema does not turn a V2 plane design into a V1 design.
 * Every plane-net endpoint remains in the schematic graph, and the actual
 * source contract identity retains all V2 constraints. The provider never
 * receives or supplies this payload as tool arguments.
 */
export function createFreshConnectivityContract(value: FreshConnectivityContractSource, externalPowerBinding?: PcbExternalPowerBinding): FreshConnectivityContract {
  const record = value as unknown as { schemaVersion?: unknown } | null;
  let payload: Omit<FreshConnectivityContract, "identity">;
  switch (record?.schemaVersion) {
    case "evleda.pcb-design-contract.v1":
      payload = fromValidatedPcbDesignContract(parsePcbDesignContract(value));
      break;
    case PCB_PLANE_CONTRACT_SCHEMA_VERSION:
      payload = fromValidatedPcbDesignContract(parsePcbPlaneDesignContract(value));
      break;
    case "evleda.fresh-led-indicator-contract.v1":
      payload = fromLedContract(value);
      break;
    default:
      throw new Error("Unsupported fresh connectivity source schema; a validated LED, PCB V1, or PCB plane V2 contract is required.");
  }
  if (externalPowerBinding !== undefined) {
    if (record?.schemaVersion !== PCB_PLANE_CONTRACT_SCHEMA_VERSION) throw new Error("External power annotations require their genuine V2 contract.");
    payload = { ...payload, externalPowerBinding: parsePcbExternalPowerBinding(externalPowerBinding, payload.sourceContractIdentity) };
  }
  return freeze({
    ...payload,
    identity: canonicalIdentity(payload, FRESH_CONNECTIVITY_CONTRACT_SCHEMA_VERSION),
  });
}
