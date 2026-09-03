import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ERRORS } from "../src/errors.js";
import type { ErrorCode } from "../src/errors.js";

/**
 * The catalogue is frozen, so it holds codes nothing can raise yet. That is
 * fine — and it is exactly the thing that rots quietly. This test makes the
 * gap explicit: every code is either RAISED somewhere in the Worker, or listed
 * below with the issue that will raise it. A code that is neither is a
 * contract nobody can reach; a code raised without a row here means the list
 * is stale.
 *
 * The check is a source scan, not a runtime one, because several of these
 * codes are raised by paths that need a real R2 failure to reach.
 */
const srcRoot = fileURLToPath(new URL("../src", import.meta.url));

/** Codes the current Worker cannot raise, and the slice that will raise them. */
const NOT_YET_RAISED: Partial<Record<ErrorCode, string>> = {
  FETCH_FAILED: "issue #9: `url` file entries the Worker fetches",
  NAME_TAKEN: "issue #10: the CLI installer, which names instances",
};

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

async function raisedCodes(): Promise<Set<string>> {
  const files = await sourceFiles(srcRoot);
  const bodies = await Promise.all(files.map((path) => readFile(path, "utf8")));
  const raised = new Set<string>();

  for (const body of bodies) {
    // Every raise names its code as a literal first argument — `new
    // ApiError("X", …)`, `new StorageError("X", …)`, the typed domain errors
    // (`TargetError`, `ExpiryError`), or `errorBody("X", …)` for the two
    // places that build the wire object directly.
    for (const match of body.matchAll(
      /(?:new [A-Za-z]*Error|errorBody)\(\s*"([A-Z][A-Z0-9_]*)"/g,
    )) {
      raised.add(match[1]!);
    }
  }
  return raised;
}

describe("error catalogue against the registry", () => {
  it("raises every code that is not explicitly deferred to a later slice", async () => {
    const raised = await raisedCodes();
    const unreachable = (Object.keys(ERRORS) as ErrorCode[]).filter(
      (code) => !raised.has(code) && NOT_YET_RAISED[code] === undefined,
    );

    expect(unreachable, "codes in the catalogue that nothing can raise").toEqual([]);
  });

  it("lists no deferred code that the Worker already raises", async () => {
    const raised = await raisedCodes();
    const stale = (Object.keys(NOT_YET_RAISED) as ErrorCode[]).filter((code) => raised.has(code));

    expect(stale, "codes listed as deferred that are already raised").toEqual([]);
  });

  it("raises no code the catalogue does not define", async () => {
    const raised = await raisedCodes();
    const unknown = [...raised].filter((code) => !(code in ERRORS));

    expect(unknown, "codes raised that the catalogue does not define").toEqual([]);
  });

  it("says which slice will raise each deferred code", () => {
    for (const [code, reason] of Object.entries(NOT_YET_RAISED)) {
      expect(reason, code).toMatch(/issue #\d+/);
    }
  });

  it("gives the two auth refusals the statuses the wire contract names", () => {
    expect(ERRORS.UNAUTHENTICATED.status).toBe(401);
    expect(ERRORS.FORBIDDEN_SCOPE.status).toBe(403);
    expect(ERRORS.LABEL_TAKEN.status).toBe(409);
  });
});
