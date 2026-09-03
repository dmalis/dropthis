import { describe, expect, it } from "vitest";
import { instancesPath, resolveCredentials } from "../../src/cli/credentials.js";
import type { InstancesFile } from "../../src/cli/credentials.js";

/**
 * "Two credentials, two env names, env beats file" (AGENTS.md, CLI
 * conventions): `DROPTHIS_URL` + `DROPTHIS_KEY` win over everything;
 * otherwise `--instance` > `DROPTHIS_INSTANCE` > the file's default.
 */
const file: InstancesFile = {
  default: "main",
  instances: {
    main: { url: "https://main.example", key: "k-main" },
    client: { url: "https://client.example", key: "k-client" },
  },
};

const codeOf = (call: () => unknown): { code: string; message: string } => {
  try {
    call();
    return { code: "no error", message: "" };
  } catch (error) {
    const e = error as { code?: string; message: string };
    return { code: e.code ?? "not a CliError", message: e.message };
  }
};

describe("resolveCredentials", () => {
  it("takes the env pair over the file and over --instance", () => {
    const resolved = resolveCredentials({
      env: { DROPTHIS_URL: "https://env.example/", DROPTHIS_KEY: "k-env", DROPTHIS_INSTANCE: "client" },
      instance: "client",
      file,
    });
    expect(resolved).toEqual({ url: "https://env.example", key: "k-env", source: "env" });
  });

  it("refuses half an env pair, naming the missing half", () => {
    const half = codeOf(() => resolveCredentials({ env: { DROPTHIS_URL: "https://env.example" }, file }));
    expect(half.code).toBe("INVALID_INPUT");
    expect(half.message).toContain("DROPTHIS_KEY");
  });

  it("selects --instance, then DROPTHIS_INSTANCE, then the file's default", () => {
    expect(resolveCredentials({ env: { DROPTHIS_INSTANCE: "client" }, instance: "main", file })).toEqual({
      url: "https://main.example",
      key: "k-main",
      source: "file",
      instance: "main",
    });
    expect(resolveCredentials({ env: { DROPTHIS_INSTANCE: "client" }, file }).instance).toBe("client");
    expect(resolveCredentials({ env: {}, file }).instance).toBe("main");
  });

  it("names the known instances when the asked-for one does not exist", () => {
    const unknown = codeOf(() => resolveCredentials({ env: {}, instance: "nope", file }));
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.message).toContain("nope");
    expect(unknown.message).toContain("client, main");
  });

  it("uses the only instance when the file names no default, and asks when there are several", () => {
    const one: InstancesFile = { instances: { solo: { url: "https://solo.example", key: "k" } } };
    expect(resolveCredentials({ env: {}, file: one }).instance).toBe("solo");
    const two: InstancesFile = { instances: file.instances };
    const asked = codeOf(() => resolveCredentials({ env: {}, file: two }));
    expect(asked.code).toBe("INVALID_INPUT");
    expect(asked.message).toContain("--instance");
  });

  it("exits 4-worthy with the two env names when there is nothing at all", () => {
    const none = codeOf(() => resolveCredentials({ env: {}, file: null }));
    expect(none.code).toBe("UNAUTHENTICATED");
    expect(none.message).toContain("DROPTHIS_URL");
    expect(none.message).toContain("DROPTHIS_KEY");
  });

  it("finds instances.json under XDG_CONFIG_HOME, else ~/.config", () => {
    expect(instancesPath({ XDG_CONFIG_HOME: "/x/cfg", HOME: "/home/u" })).toBe(
      "/x/cfg/dropthis/instances.json",
    );
    expect(instancesPath({ HOME: "/home/u" })).toBe("/home/u/.config/dropthis/instances.json");
  });
});
