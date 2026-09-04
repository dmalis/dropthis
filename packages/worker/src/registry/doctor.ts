/**
 * The registry entries for `doctor` and `doctor --list`.
 *
 * Two routes because an agent needs to know what the checks ARE before it
 * decides to run them: the list is cheap and reads nothing, the run publishes
 * a real drop.
 */
import { z } from "zod";
import { checkList, doctor } from "../operations/doctor.js";
import { count } from "./result-line.js";
import type { Operation } from "./types.js";

const empty = z.strictObject({});

export const doctorOp: Operation<z.infer<typeof empty>> = {
  name: "doctor",
  method: "GET",
  path: "/doctor",
  scope: "admin",
  summary: "Run every instance check and report what passed, failed or was skipped.",
  resultLine: (_input, value) => ((value as { ok: boolean }).ok ? "Doctor: ok" : "Doctor: FAILED"),
  schema: empty,
  handler: async (_input, ctx) => ({
    value: await doctor({
      bucket: ctx.bucket,
      config: ctx.config,
      now: ctx.now,
      secret: ctx.secret(),
      request: ctx.request,
      self: ctx.self,
    }),
  }),
};

export const doctorChecks: Operation<z.infer<typeof empty>> = {
  name: "doctor.checks",
  method: "GET",
  path: "/doctor/checks",
  scope: "admin",
  summary: "List the checks this instance can run, with what each one proves.",
  resultLine: (_input, value) => count((value as { checks: unknown[] }).checks.length, "check"),
  schema: empty,
  handler: async () => ({ value: { checks: checkList() } }),
};
