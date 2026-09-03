import { describe, expect, it } from "vitest";
import { OPERATIONS, operation, routeOf } from "../src/registry/index.js";

/**
 * The frozen REST route table, transcribed from docs/spec-v1.md lines 177-196.
 * This is the SPEC, not a copy of the implementation: the registry generates
 * the routes, so a route that drifts from this list is a broken contract and
 * an operation added without a row here is an unannounced surface.
 *
 * One row of the frozen table is deliberately absent and asserted absent
 * below: `POST /_api/mcp` (issue #8 — a transport, not an operation).
 */
const FROZEN: Array<[name: string, route: string, scope: string]> = [
  ["health", "GET /_api/v1/health", "public"],
  ["publish", "POST /_api/v1/drops", "user"],
  ["update", "PATCH /_api/v1/drops/:slug", "user"],
  ["get", "GET /_api/v1/drops/:slug", "user"],
  ["list", "GET /_api/v1/drops", "user"],
  ["delete", "DELETE /_api/v1/drops/:slug", "user"],
  ["file_download", "GET /_api/v1/drops/:slug/files/*", "user"],
  ["upload.create", "POST /_api/v1/uploads", "user"],
  ["upload.put", "PUT /_api/v1/uploads/:id/blobs/:sha256", "signed"],
  ["upload.commit", "POST /_api/v1/uploads/:id/commit", "user"],
  ["user.add", "POST /_api/v1/users", "admin"],
  ["user.list", "GET /_api/v1/users", "admin"],
  ["user.remove", "DELETE /_api/v1/users/:label", "admin"],
  ["config.get", "GET /_api/v1/config", "admin"],
  ["config.set", "PATCH /_api/v1/config", "admin"],
  ["usage", "GET /_api/v1/usage", "admin"],
  ["prune", "POST /_api/v1/prune", "admin"],
  ["doctor", "GET /_api/v1/doctor", "admin"],
  ["doctor.checks", "GET /_api/v1/doctor/checks", "admin"],
];

/** Owned by another slice; the registry must not claim them yet. */
const NOT_YET = ["POST /_api/mcp"];

describe("operation registry", () => {
  it("holds exactly the operations the frozen table names, in its order", () => {
    expect(OPERATIONS.map((op) => op.name)).toEqual(FROZEN.map(([name]) => name));
  });

  it.each(FROZEN)("%s is %s at %s scope", (name, route, scope) => {
    const op = operation(name);
    expect(routeOf(op)).toBe(route);
    expect(op.scope).toBe(scope);
  });

  it("claims no route another slice owns", () => {
    const routes = OPERATIONS.map(routeOf);
    for (const route of NOT_YET) expect(routes).not.toContain(route);
  });

  it("gives every operation a one-line summary an agent can read", () => {
    for (const op of OPERATIONS) {
      expect(op.summary.length, op.name).toBeGreaterThan(10);
      expect(op.summary.endsWith("."), op.name).toBe(true);
    }
  });

  it("names every operation once and routes every operation once", () => {
    expect(new Set(OPERATIONS.map((op) => op.name)).size).toBe(OPERATIONS.length);
    expect(new Set(OPERATIONS.map(routeOf)).size).toBe(OPERATIONS.length);
  });

  it("authenticates everything but health and the signed blob PUT", () => {
    const open = OPERATIONS.filter((op) => op.scope === "public").map((op) => op.name);
    expect(open).toEqual(["health"]);
    const signed = OPERATIONS.filter((op) => op.scope === "signed").map((op) => op.name);
    expect(signed).toEqual(["upload.put"]);
  });

  it("gives create and delete the statuses the spec froze", () => {
    expect(operation("publish").status).toBeUndefined(); // 201 or 200, decided per call
    expect(operation("user.add").status).toBe(201);
    expect(operation("user.remove").status).toBe(204);
    expect(operation("delete").status).toBe(204);
  });

  it("implements every operation it declares", () => {
    const pending = OPERATIONS.filter((op) => op.handler === undefined).map((op) => op.name);
    expect(pending).toEqual([]);
  });

  it("keeps the raw-file route and the staged-upload path out of the MCP tool list", () => {
    const restOnly = OPERATIONS.filter((op) => op.restOnly === true).map((op) => op.name);
    expect(restOnly).toEqual(["file_download", "upload.create", "upload.put", "upload.commit"]);
  });
});
