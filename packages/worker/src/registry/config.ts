/**
 * The registry entries for `config get|set`.
 *
 * The PATCH body is validated by the operation, not by a zod schema: the
 * policy is a nested object whose rules depend on each other (a `default`
 * expiry has to fit inside the `max` in the same patch), and one place that
 * knows those rules beats a schema that half-knows them.
 */
import { z } from "zod";
import { PROSPECTIVE_NOTE, configView, setConfig } from "../operations/config.js";
import type { Operation } from "./types.js";

const getSchema = z.strictObject({});
const setSchema = z.record(z.string(), z.unknown());

export const configGet: Operation<z.infer<typeof getSchema>> = {
  name: "config.get",
  method: "GET",
  path: "/config",
  scope: "admin",
  summary: "Read this instance's policy: the defaults it fills in and the rules it enforces.",
  schema: getSchema,
  handler: async (_input, ctx) => ({ value: configView(ctx.config) }),
};

export const configSet: Operation<Record<string, unknown>> = {
  name: "config.set",
  method: "PATCH",
  path: "/config",
  scope: "admin",
  summary: "Change policy fields; the change applies to future calls only.",
  schema: setSchema,
  handler: async (input, ctx) => ({
    value: {
      ...(await setConfig(input, ctx.bucket, ctx.config, ctx.now)),
      note: PROSPECTIVE_NOTE,
    },
  }),
};
