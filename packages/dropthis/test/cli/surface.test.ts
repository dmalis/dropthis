import { describe, expect, it } from "vitest";
import { coerceFlag, commandSurface } from "../../src/cli/surface.js";
import type { CommandSpec } from "../../src/cli/surface.js";

/**
 * The CLI surface is GENERATED from the operation registry: one zod schema per
 * operation drives the flags, path parameters become positional arguments, and
 * `files` becomes the paths on the command line. These pin the mapping, so a
 * registry change shows up here before it shows up as a missing flag.
 */
const byWords = (words: string): CommandSpec => {
  const found = commandSurface().find((spec) => spec.words.join(" ") === words);
  if (found === undefined) throw new Error(`no command ${words}`);
  return found;
};

const flagsOf = (spec: CommandSpec) => spec.flags.map((f) => `${f.flag}:${f.kind}${f.nullable ? "?" : ""}`);
const argsOf = (spec: CommandSpec) =>
  spec.args.map((a) => `${a.name}${a.variadic ? "..." : ""}${a.required ? "" : "?"}:${a.kind}`);

describe("commandSurface", () => {
  it("lists exactly the AGENTS.md grammar, in registry order", () => {
    expect(commandSurface().map((spec) => spec.words.join(" "))).toEqual([
      "publish",
      "update",
      "get",
      "list",
      "delete",
      "user add",
      "user list",
      "user remove",
      "config get",
      "config set",
      "usage",
      "prune",
      "doctor",
    ]);
  });

  it("maps publish: paths positional, every other input a flag", () => {
    const spec = byWords("publish");
    expect(argsOf(spec)).toEqual(["paths...:files"]);
    expect(flagsOf(spec)).toEqual([
      "title:string",
      "meta:json",
      "expires:string",
      "noindex:boolean",
      "idempotency-key:string",
    ]);
  });

  it("maps update: the target then optional paths; title can be cleared", () => {
    const spec = byWords("update");
    expect(argsOf(spec)).toEqual(["target:target", "paths...?:files"]);
    expect(flagsOf(spec)).toContain("title:string?");
  });

  it("maps path and query parameters", () => {
    expect(argsOf(byWords("get"))).toEqual(["target:target"]);
    expect(flagsOf(byWords("get"))).toEqual(["files:boolean"]);
    expect(argsOf(byWords("delete"))).toEqual(["target:target"]);
    expect(flagsOf(byWords("list"))).toEqual(["limit:integer", "cursor:string", "q:string"]);
    expect(argsOf(byWords("user add"))).toEqual(["label:string"]);
    expect(flagsOf(byWords("user add"))).toEqual(["idempotency-key:string"]);
    expect(argsOf(byWords("user remove"))).toEqual(["label:string"]);
    expect(argsOf(byWords("user list"))).toEqual([]);
    expect(flagsOf(byWords("prune"))).toEqual(["dry-run:boolean", "cursor:string"]);
  });

  it("takes a free-form policy patch as one JSON argument", () => {
    expect(argsOf(byWords("config set"))).toEqual(["json:json"]);
    expect(argsOf(byWords("config get"))).toEqual([]);
  });

  it("folds doctor.checks into doctor --list", () => {
    expect(flagsOf(byWords("doctor"))).toEqual(["list:boolean"]);
    expect(commandSurface().some((spec) => spec.words.join(" ") === "doctor checks")).toBe(false);
  });

  it("takes every flag's help line from the registry schema, not a second list", () => {
    for (const spec of commandSurface()) {
      const shape = (spec.op.schema as unknown as { shape?: Record<string, { description?: string }> }).shape;
      if (shape === undefined) continue;
      for (const flag of spec.flags) {
        const described = shape[flag.field]?.description;
        if (described === undefined) continue;
        expect(flag.description.startsWith(described), `${spec.words.join(" ")} --${flag.flag}`).toBe(true);
      }
    }
  });

  it("describes update's clearable fields with the flag that clears them", () => {
    const title = byWords("update").flags.find((f) => f.flag === "title");
    expect(title?.description).toContain("Short human name of the drop");
    expect(title?.description).toContain("--no-title clears it.");
  });

  it("streams step events only where the operation pages", () => {
    expect(commandSurface().filter((spec) => spec.steps).map((spec) => spec.words.join(" "))).toEqual([
      "usage",
      "prune",
    ]);
  });

  it("never exposes health, the raw download or the staged-upload path as commands", () => {
    const names = commandSurface().map((spec) => spec.op.name);
    for (const hidden of ["health", "file_download", "upload.create", "upload.put", "upload.commit"]) {
      expect(names).not.toContain(hidden);
    }
  });
});

describe("coerceFlag", () => {
  const flag = (kind: "string" | "boolean" | "integer" | "json") => ({
    field: "x",
    flag: "x",
    kind,
    nullable: false,
    description: "",
  });

  it("turns an integer flag into a number and refuses anything else", () => {
    expect(coerceFlag(flag("integer"), "5")).toBe(5);
    expect(() => coerceFlag(flag("integer"), "five")).toThrow(/whole number/);
  });

  it("parses a json flag and names the flag on a syntax error", () => {
    expect(coerceFlag(flag("json"), '{"a":[1,null]}')).toEqual({ a: [1, null] });
    expect(() => coerceFlag(flag("json"), "{nope")).toThrow(/--x/);
  });

  it("passes strings and booleans through", () => {
    expect(coerceFlag(flag("string"), "hi")).toBe("hi");
    expect(coerceFlag(flag("boolean"), true)).toBe(true);
  });
});
