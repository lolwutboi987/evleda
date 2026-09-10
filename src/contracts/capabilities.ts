import type { HumanActor } from "../domain/types.js";

export type HumanCapability =
  | "requirements_approval"
  | "hardware_qualification"
  | "manufacturing_release";

export type CommandContext =
  | {
      readonly kind: "human";
      readonly transport: "local_api" | "trusted_host";
      readonly capability: HumanCapability;
      readonly actor: HumanActor;
    }
  | {
      readonly kind: "mcp";
      readonly transport: "stdio";
    }
  | {
      readonly kind: "system";
      readonly transport: "internal";
    };

export const SYSTEM_CONTEXT: CommandContext = {
  kind: "system",
  transport: "internal"
};

export const MCP_CONTEXT: CommandContext = {
  kind: "mcp",
  transport: "stdio"
};

export const localHumanContext = (
  actor: HumanActor,
  capability: HumanCapability
): CommandContext => ({
  kind: "human",
  transport: "local_api",
  capability,
  actor
});
