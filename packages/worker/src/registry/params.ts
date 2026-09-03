/**
 * Schemas for values that arrive as text on one surface and as themselves on
 * another. A query string carries `files=true`; an MCP tool call carries
 * `files: true`; the CLI carries a parsed flag. One schema per operation means
 * one schema has to accept both, so these do the coercion in one place instead
 * of every operation repeating it.
 */
import { z } from "zod";

export const boolParam = z.union([
  z.boolean(),
  z.literal("true").transform(() => true),
  z.literal("false").transform(() => false),
]);

export const intParam = z.union([
  z.number().int(),
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform((value) => Number(value)),
]);
