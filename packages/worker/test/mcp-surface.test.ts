import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "../src/registry/index.js";
import { TOOL_TEXT } from "../src/registry/tools.js";
import { toolOf, toolSurface, toolsFor } from "../src/mcp/tools.js";

/**
 * The MCP tool surface is PRODUCT SURFACE (docs/decisions.md #80): the words
 * in a description decide which tool an agent picks, and the old product
 * once made a live feature unusable for months with one wrong sentence. So
 * the surface is pinned here — name, description and annotations hashed per
 * tool — and any edit fails the suite until the pin moves in the same commit.
 *
 * The trigger clause is asserted word for word as well: the owner's binding
 * rule is that `dropthis_publish` catches every way a human says "share
 * this", and a later edit that drops that vocabulary must not pass quietly.
 */
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const pinOf = (tool: { name: string; description: string; annotations: unknown }) =>
  sha256(JSON.stringify({ name: tool.name, description: tool.description, annotations: tool.annotations }));

/** Move a pin only in the commit that changes the tool's wording on purpose. */
const PINS: Record<string, string> = {
  dropthis_publish: "d301ed979518a0dac64c08c97a8420835772fbf0ba52dae3249b933f6f7e2af0",
  dropthis_update: "b7fc63125b3aecd37ad9cec22588cadfe3c2e5290f4b3ab5e9872d34d5857dc4",
  dropthis_get: "4964c34dbb9531847016f669a634fbd86f1a1db1daee5d5c10e69255fdeee128",
  dropthis_list: "90c3017b61f72f78444e144555906de1efb1e5c6528fd1d76d902736e0dfdab4",
  dropthis_delete: "297d5fd6825dbc9c7fc91d2206d2a5713062be3ab1157fc2f4ede1c662021722",
  dropthis_user_add: "12e76b4fd3d95998568f5f51f19f2dbbdaf9cfa9d484505d913a5a7018c59f33",
  dropthis_user_list: "5e86d3fd30de497f07f8daa6fa7d4d5d6cf82903f945e0f165f5880014041981",
  dropthis_user_remove: "72699e099d45f867f8f375f889be75d4012a274dfc32969c680a083b323e74bc",
  dropthis_config_get: "416e59d19f322bed14700d178721ea27bf4e2c4b943ecf9eac29804d90e31319",
  dropthis_config_set: "7ec7ebb55eaa6104da331a17b06352012f6d058cb467267ceeedb49cc581b667",
  dropthis_usage: "3a8864d34972377be74579f692f5acfb1f05a089d371e2ef8998b6f512d2e89f",
  dropthis_prune: "8322da7de02f98016357bdb74051a505196d4a1fe903ed7ae03c00c9fef0caeb",
  dropthis_doctor: "08f60e9e0f2a9058beeab6dc64c2e6120404e0f0d491be2dc72dd5e8d51e1d1e",
  dropthis_doctor_checks: "52bff4d52780da4aecdf237320b34acd46682f5300298b70732b9b208b0b0c5d",
};

const USER_TOOLS = ["dropthis_publish", "dropthis_update", "dropthis_get", "dropthis_list", "dropthis_delete"];

describe("the MCP tool surface", () => {
  const surface = toolSurface();

  it("holds every registry operation that is not health or REST-only, in registry order", () => {
    const expected = OPERATIONS.filter((op) => op.scope !== "public" && op.restOnly !== true).map(
      (op) => `dropthis_${op.name.replace(/\./g, "_")}`,
    );
    expect(surface.map((tool) => tool.name)).toEqual(expected);
    expect(surface.map((tool) => tool.name)).toEqual(Object.keys(PINS));
  });

  it("is pinned: name, description and annotations hash to the value in this file", () => {
    const actual = Object.fromEntries(surface.map((tool) => [tool.name, pinOf(tool)]));
    expect(actual).toEqual(PINS);
  });

  it("opens every description with its trigger clause, word for word", () => {
    for (const tool of surface) {
      const text = TOOL_TEXT[tool.operation]!;
      expect(tool.description.startsWith(`Use when the user says: ${text.triggers}. `), tool.name).toBe(true);
    }
  });

  it("catches the owner's share vocabulary on publish", () => {
    const { triggers } = TOOL_TEXT.publish!;
    for (const phrase of [
      "share this",
      "send this to someone",
      "make this shareable",
      "make this public",
      "get me a link",
      "give me a URL",
      "create a URL",
      "host this",
      "put this online",
      "show this to",
    ]) {
      expect(triggers, phrase).toContain(phrase);
    }
  });

  it("steers between siblings: publish names update, update names publish, get names list", () => {
    const byName = Object.fromEntries(surface.map((tool) => [tool.name, tool.description]));
    expect(byName.dropthis_publish).toContain("dropthis_update");
    expect(byName.dropthis_publish).toContain("never publish again");
    expect(byName.dropthis_update).toContain("dropthis_publish");
    expect(byName.dropthis_get).toContain("dropthis_list");
    expect(byName.dropthis_publish).toContain("ALWAYS set title");
  });

  it("never sends a next hint: no description promises one on success", () => {
    for (const tool of surface) expect(tool.description, tool.name).not.toMatch(/\bnext\b:/);
  });

  it("gives every tool an explicit tri-state annotation set and a short title", () => {
    for (const tool of surface) {
      expect(Object.keys(tool.annotations).sort(), tool.name).toEqual([
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
        "readOnlyHint",
        "title",
      ]);
      expect(tool.annotations.title.length, tool.name).toBeLessThan(40);
      expect(tool.title).toBe(tool.annotations.title);
    }
  });

  it("marks exactly the irreversible tools destructive and the reads read-only", () => {
    const destructive = surface.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    expect(destructive).toEqual(["dropthis_delete", "dropthis_user_remove", "dropthis_prune"]);
    const readOnly = surface.filter((t) => t.annotations.readOnlyHint).map((t) => t.name);
    expect(readOnly).toEqual([
      "dropthis_get",
      "dropthis_list",
      "dropthis_user_list",
      "dropthis_config_get",
      "dropthis_usage",
      "dropthis_doctor_checks",
    ]);
    // Nothing fetches a caller's URL yet (`url` file entries are issue #9).
    expect(surface.filter((t) => t.annotations.openWorldHint)).toEqual([]);
  });

  it("takes the drop as `target` — URL or slug — where REST takes a slug in the path", () => {
    for (const name of ["dropthis_get", "dropthis_update", "dropthis_delete"]) {
      const tool = surface.find((t) => t.name === name)!;
      const properties = tool.inputSchema.properties as Record<string, { type?: string; description?: string }>;
      expect(Object.keys(properties), name).toContain("target");
      expect(Object.keys(properties), name).not.toContain("slug");
      expect(properties.target!.type).toBe("string");
      expect(properties.target!.description).toContain("URL");
      expect(tool.inputSchema.required).toContain("target");
    }
  });

  it("renders the coercing params as plain JSON types", () => {
    const get = surface.find((t) => t.name === "dropthis_get")!;
    expect((get.inputSchema.properties as Record<string, unknown>).files).toMatchObject({ type: "boolean" });
    const list = surface.find((t) => t.name === "dropthis_list")!;
    expect((list.inputSchema.properties as Record<string, unknown>).limit).toMatchObject({ type: "integer" });
    for (const tool of surface) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("$schema");
    }
  });

  it("describes every input field", () => {
    for (const tool of surface) {
      const properties = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it("refuses to make a tool of an operation whose scope is not a key scope", () => {
    for (const op of OPERATIONS.filter((o) => o.scope === "public" || o.scope === "signed")) {
      expect(() => toolOf(op), op.name).toThrow(`Operation ${op.name} is not a key-scoped tool.`);
    }
  });

  it("filters by scope: a user key sees exactly the five drop tools, admin sees all", () => {
    expect(toolsFor("user").map((t) => t.name)).toEqual(USER_TOOLS);
    expect(toolsFor("admin").map((t) => t.name)).toEqual(Object.keys(PINS));
  });
});
