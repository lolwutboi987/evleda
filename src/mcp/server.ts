import { McpServer } from "@modelcontextprotocol/server";
import type { StandardSchemaWithJSON, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import { canonicalJson } from "../core/canonical.js";
import type { ApplicationService } from "../application/application-service.js";
import { MCP_CONTEXT } from "../contracts/capabilities.js";
import { failureEnvelopeSchema } from "../contracts/errors.js";
import { operationResultSchemas } from "../contracts/results.js";
import {
  OPERATION_DESCRIPTIONS,
  OPERATION_NAMES,
  operationInputSchemas,
  type OperationName
} from "../contracts/operations.js";

const READ_ONLY_OPERATIONS = new Set<OperationName>([
  "get_run_status",
  "inspect_requirements",
  "list_artifacts",
  "inspect_evidence",
  "inspect_engineering_practices"
]);

const IDEMPOTENT_OPERATIONS = new Set<OperationName>([
  "create_project",
  "start_design_run",
  "approve_requirements",
  "resume_run",
  "rerun_stage",
  "export_candidate_bundle",
  "export_prototype_bundle",
  "generate_bringup_plan",
  "generate_firmware_scaffold"
]);

const applicationValidatedInputSchema = (schema: z.ZodType): StandardSchemaWithJSON => ({
  "~standard": {
    version: 1,
    vendor: "evleda-application-dispatch",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }),
      output: () => z.toJSONSchema(schema, { target: "draft-2020-12", io: "output" })
    }
  }
});

export const MCP_TOOL_DEFINITIONS = OPERATION_NAMES.map((name) => {
  const readOnly = READ_ONLY_OPERATIONS.has(name);
  const annotations: ToolAnnotations = {
    readOnlyHint: readOnly,
    destructiveHint: false,
    idempotentHint: readOnly || IDEMPOTENT_OPERATIONS.has(name),
    openWorldHint: false
  };
  return {
    name,
    title: name
      .split("_")
      .map((part) => part.charAt(0).toLocaleUpperCase("en-US") + part.slice(1))
      .join(" "),
    description: OPERATION_DESCRIPTIONS[name],
    inputSchema: operationInputSchemas[name],
    outputSchema: z.union([
      z.object({
        ok: z.literal(true),
        operation: z.literal(name),
        requestId: z.string().min(1),
        result: operationResultSchemas[name]
      }).strict(),
      failureEnvelopeSchema
    ]),
    annotations
  };
});

export const createMcpServer = (service: ApplicationService): McpServer => {
  const server = new McpServer(
    { name: "evleda", version: "0.1.0" },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "EvlEDA creates candidate robotics-controller designs only. MCP callers cannot approve requirements, qualify hardware, or authorize manufacturing. Human-only operations return CAPABILITY_REQUIRED unless invoked through a trusted local human context."
    }
  );

  for (const definition of MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        // ApplicationService.dispatch owns request parsing so schema failures use the
        // same public INVALID_ARGUMENT envelope as REST. The wrapper advertises the
        // exact Zod JSON schema while deferring runtime validation to that dispatcher.
        inputSchema: applicationValidatedInputSchema(definition.inputSchema),
        outputSchema: definition.outputSchema,
        annotations: definition.annotations
      },
      async (args: unknown) => {
        const envelope = await service.dispatch(definition.name, args, MCP_CONTEXT);
        return {
          content: [{ type: "text" as const, text: canonicalJson(envelope) }],
          structuredContent: envelope as unknown as Record<string, unknown>,
          ...(!envelope.ok ? { isError: true } : {})
        };
      }
    );
  }
  return server;
};
