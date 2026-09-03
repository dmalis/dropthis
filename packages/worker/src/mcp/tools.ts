/**
 * The MCP tool surface, generated from the operation registry (AGENTS.md,
 * "Operation registry"): one tool per operation, its input schema rendered
 * from the operation's own zod schema, its words from `registry/tools.ts`.
 *
 * Two operations never become tools: `health` (public, a liveness probe) and
 * the raw file download (`restOnly`: a byte stream is not a tool result).
 *
 * One translation, stated here because it is the only one: where REST takes
 * the drop's slug in the path, the tool takes `target` — the drop's URL or its
 * slug — because an agent remembers a URL, and the URL is the identity. The
 * MCP layer resolves it (`domain/target.ts`) before the operation runs, which
 * is where `WRONG_INSTANCE` comes from.
 */
import { z } from "zod";
import type { Scope } from "../auth/key.js";
import { OPERATIONS } from "../registry/index.js";
import { boolParam, intParam } from "../registry/params.js";
import { TOOL_TEXT } from "../registry/tools.js";
import type { ToolText } from "../registry/tools.js";
import type { Operation } from "../registry/types.js";

export type ToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type JsonSchema = Record<string, unknown> & {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

export type Tool = {
  /** `dropthis_<name>`, dots as underscores: `user.add` → `dropthis_user_add`. */
  name: string;
  /** The registry name the tool runs. */
  operation: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  scope: Scope;
  /** The tool takes `target` where the REST path takes a slug. */
  takesTarget: boolean;
};

/** One canonical sentence for the one parameter every drop tool shares. */
export const TARGET_DESCRIPTION = "The drop's URL on this instance, or its slug.";

export function toolNameOf(operationName: string): string {
  return `dropthis_${operationName.replace(/\./g, "_")}`;
}

/** The whole surface, in registry order, before any scope filter. */
export function toolSurface(): Tool[] {
  return OPERATIONS.filter((op) => op.scope !== "public" && op.restOnly !== true).map(toolOf);
}

/** What a caller of this scope may see and call: admin everything, user the drop tools. */
export function toolsFor(scope: Scope): Tool[] {
  return toolSurface().filter((tool) => scope === "admin" || tool.scope === "user");
}

export function toolOf(op: Operation<never>): Tool {
  const text = TOOL_TEXT[op.name];
  if (text === undefined) throw new Error(`Operation ${op.name} has no tool text.`);
  if (op.scope === "public") throw new Error(`Operation ${op.name} is public; it is not a tool.`);

  const takesTarget = op.params?.includes("slug") === true;
  return {
    name: toolNameOf(op.name),
    operation: op.name,
    title: text.title,
    description: describe(op, text),
    inputSchema: jsonSchemaOf(toolSchema(op, takesTarget)),
    annotations: text.annotations,
    scope: op.scope,
    takesTarget,
  };
}

/**
 * The description is the trigger clause, then the body with each conditional
 * sentence substituted in — or cut out — according to whether the schema has
 * the field it talks about. A description never names an input the schema
 * refuses: the archived product told agents about a `password` that was not
 * there, and they got 422s for months.
 */
function describe(op: Operation<never>, text: ToolText): string {
  let body = text.body;
  for (const [field, sentence] of Object.entries(text.whenField ?? {})) {
    const marker = `{{${field}}}`;
    body = body.replace(marker, hasField(op.schema, field) ? sentence : "");
  }
  return `Use when the user says: ${text.triggers}. ${body}`.replace(/\s{2,}/g, " ").trim();
}

function hasField(schema: z.ZodType, field: string): boolean {
  return schema instanceof z.ZodObject && field in schema.shape;
}

/** The tool's input: the operation's schema, with `target` in place of the slug. */
export function toolSchema(op: Operation<never>, takesTarget: boolean): z.ZodType {
  if (!takesTarget) return op.schema;
  if (!(op.schema instanceof z.ZodObject)) {
    throw new Error(`Operation ${op.name} takes a slug but its schema is not an object.`);
  }
  const { slug: _slug, ...rest } = op.schema.shape as Record<string, z.ZodType>;
  return z.strictObject({ target: z.string().describe(TARGET_DESCRIPTION), ...rest });
}

/**
 * zod → JSON Schema, input side. The two coercing params (`registry/params.ts`)
 * accept a string form for the query string; a tool call carries real JSON,
 * so the tool schema shows the plain type and nothing else.
 */
function jsonSchemaOf(schema: z.ZodType): JsonSchema {
  const rendered = z.toJSONSchema(schema, {
    io: "input",
    override(ctx) {
      const plain =
        ctx.zodSchema === boolParam ? "boolean" : ctx.zodSchema === intParam ? "integer" : null;
      if (plain === null) return;
      for (const key of Object.keys(ctx.jsonSchema)) delete ctx.jsonSchema[key];
      ctx.jsonSchema.type = plain;
    },
  }) as JsonSchema;
  delete rendered.$schema;
  return rendered;
}
