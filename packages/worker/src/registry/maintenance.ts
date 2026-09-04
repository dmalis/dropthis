/**
 * The registry entries for `usage` and `prune`.
 *
 * Both spend the instance's `cron_ops_budget`, so a big bucket is swept over
 * several calls rather than one call the platform kills. The cursor they hand
 * back is a drop id, not an R2 cursor — see `operations/usage.ts`.
 */
import { z } from "zod";
import { prune, usage } from "../operations/usage.js";
import { boolParam } from "./params.js";
import { count } from "./result-line.js";
import type { Operation } from "./types.js";

const CURSOR_DESCRIPTION = "The cursor of an incomplete previous call, to continue the scan.";

const usageSchema = z.strictObject({
  cursor: z.string().min(1).optional().describe(CURSOR_DESCRIPTION),
});

const pruneSchema = z.strictObject({
  dry_run: boolParam
    .optional()
    .describe("Report only (default true). Pass false to delete what is past grace."),
  cursor: z.string().min(1).optional().describe(CURSOR_DESCRIPTION),
});

export const usageOp: Operation<z.infer<typeof usageSchema>> = {
  name: "usage",
  method: "GET",
  path: "/usage",
  scope: "admin",
  summary: "Count the drops and the bytes this instance holds, per state.",
  resultLine: (_input, value) =>
    `Usage: ${count((value as { total: { count: number } }).total.count, "drop")}`,
  schema: usageSchema,
  query: ["cursor"],
  handler: async (input, ctx) => ({
    value: await usage({
      bucket: ctx.bucket,
      now: ctx.now,
      budget: ctx.config.policy.cron_ops_budget,
      cursor: input.cursor,
    }),
  }),
};

export const pruneOp: Operation<z.infer<typeof pruneSchema>> = {
  name: "prune",
  method: "POST",
  path: "/prune",
  scope: "admin",
  summary: "Delete drops that are past their grace window; dry_run only reports.",
  resultLine: (input, value) => {
    const report = value as { total: { count: number } };
    return input.dry_run === false
      ? `Pruned; ${count(report.total.count, "drop")} remain`
      : `Prune, dry run: ${count(report.total.count, "drop")} counted, nothing deleted`;
  },
  schema: pruneSchema,
  handler: async (input, ctx) => ({
    value: await prune({
      bucket: ctx.bucket,
      now: ctx.now,
      budget: ctx.config.policy.cron_ops_budget,
      cursor: input.cursor,
      // Reporting is the safe default: an agent that meant to look must not
      // delete because it forgot a flag.
      dryRun: input.dry_run !== false,
    }),
  }),
};
