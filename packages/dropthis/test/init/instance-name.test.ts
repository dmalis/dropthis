import { describe, expect, it } from "vitest";
import { normalizeInstanceName, InstanceNameError } from "../../src/init/instance-name.js";

describe("normalizeInstanceName", () => {
  it("folds the spellings that mean the same instance", () => {
    expect(normalizeInstanceName("Client-X")).toBe("client-x");
    expect(normalizeInstanceName("  byrokko  ")).toBe("byrokko");
    expect(normalizeInstanceName("acme corp")).toBe("acme-corp");
    expect(normalizeInstanceName("acme_corp")).toBe("acme-corp");
  });

  it("keeps a name that is already normal untouched", () => {
    expect(normalizeInstanceName("main")).toBe("main");
    expect(normalizeInstanceName("dev23")).toBe("dev23");
  });

  it("refuses anything that would not survive as a resource name or a path", () => {
    for (const raw of [
      "../evil",
      "a/b",
      "..",
      "ab",
      "x".repeat(31),
      "-lead",
      "trail-",
      "Ünicode",
      "has.dot",
      "",
    ]) {
      expect(() => normalizeInstanceName(raw), raw).toThrow(InstanceNameError);
    }
  });
});
