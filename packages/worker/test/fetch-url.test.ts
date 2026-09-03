import { describe, expect, it, vi } from "vitest";
import {
  FETCH_TIMEOUT_MS,
  MAX_FETCHES_PER_CALL,
  MAX_REDIRECTS,
  MAX_URL_ENTRIES,
  checkPublicUrl,
  fetchPublicUrl,
  newFetchBudget,
} from "../src/operations/fetch-url.js";

const codeOf = async (call: () => unknown | Promise<unknown>) => {
  try {
    await call();
    return "no error";
  } catch (error) {
    return (error as { code?: string }).code ?? "not an ApiError";
  }
};

const ok = (body = "hi") => new Response(body, { status: 200 });

describe("checkPublicUrl", () => {
  it("accepts an ordinary https URL and the default ports", () => {
    expect(checkPublicUrl("https://byrokko.com/a.jpg").hostname).toBe("byrokko.com");
    // WHATWG drops a default port, so these two are simply accepted.
    expect(checkPublicUrl("http://example.com:80/a.jpg").href).toBe("http://example.com/a.jpg");
    expect(checkPublicUrl("https://example.com:443/a.jpg").href).toBe("https://example.com/a.jpg");
  });

  /** Each row is a class AGENTS.md names as forbidden; all answer FETCH_FAILED. */
  const forbidden: Array<[string, string]> = [
    ["a scheme that is not http(s)", "ftp://example.com/a.jpg"],
    ["a data URL", "data:text/plain;base64,aGk="],
    ["a file URL", "file:///etc/passwd"],
    ["a port that is neither 80 nor 443", "https://example.com:8080/a.jpg"],
    ["credentials in the URL", "https://user:pass@example.com/a.jpg"],
    ["loopback by name", "http://localhost/a.jpg"],
    ["a .localhost name", "http://api.localhost/a.jpg"],
    ["an mDNS .local name", "http://printer.local/a.jpg"],
    ["loopback IPv4", "http://127.0.0.1/a.jpg"],
    ["another loopback IPv4", "http://127.9.9.9/a.jpg"],
    ["the unspecified IPv4", "http://0.0.0.0/a.jpg"],
    ["private 10/8", "http://10.0.0.5/a.jpg"],
    ["private 172.16/12", "http://172.20.1.1/a.jpg"],
    ["private 192.168/16", "http://192.168.1.1/a.jpg"],
    ["carrier-grade NAT 100.64/10", "http://100.64.0.1/a.jpg"],
    ["link-local 169.254/16", "http://169.254.1.1/a.jpg"],
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["the Google metadata name", "http://metadata.google.internal/a.jpg"],
    ["loopback IPv6", "http://[::1]/a.jpg"],
    ["the unspecified IPv6", "http://[::]/a.jpg"],
    ["unique-local IPv6 fc00::/7", "http://[fd00::1]/a.jpg"],
    ["link-local IPv6 fe80::/10", "http://[fe80::1]/a.jpg"],
    ["an IPv4-mapped IPv6 loopback", "http://[::ffff:127.0.0.1]/a.jpg"],
    ["a URL that is not a URL", "not a url"],
  ];

  for (const [what, url] of forbidden) {
    it(`refuses ${what}`, async () => {
      expect(await codeOf(() => checkPublicUrl(url))).toBe("FETCH_FAILED");
    });
  }

  it("says which rule refused the target", async () => {
    try {
      checkPublicUrl("http://127.0.0.1/a.jpg");
      throw new Error("unreachable");
    } catch (error) {
      expect((error as Error).message).toMatch(/not a public address|private|loopback/i);
    }
  });
});

describe("fetchPublicUrl", () => {
  it("refuses a forbidden target before it fetches anything", async () => {
    const spy = vi.fn(async () => ok());
    expect(
      await codeOf(() =>
        fetchPublicUrl("http://169.254.169.254/", { budget: newFetchBudget(), fetchImpl: spy }),
      ),
    ).toBe("FETCH_FAILED");
    expect(spy).not.toHaveBeenCalled();
  });

  it("follows a redirect manually and re-validates each hop", async () => {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://a.example/x") {
        return new Response(null, { status: 302, headers: { location: "https://b.example/y" } });
      }
      return ok("landed");
    });
    const budget = newFetchBudget();
    const response = await fetchPublicUrl("https://a.example/x", { budget, fetchImpl: spy });
    expect(await response.text()).toBe("landed");
    expect(spy).toHaveBeenCalledTimes(2);
    expect(budget.used).toBe(2);
  });

  it("refuses a public URL that redirects to a private one, and does not fetch it", async () => {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://a.example/x") {
        return new Response(null, { status: 302, headers: { location: "http://10.0.0.1/y" } });
      }
      return ok("private!");
    });
    expect(
      await codeOf(() =>
        fetchPublicUrl("https://a.example/x", { budget: newFetchBudget(), fetchImpl: spy }),
      ),
    ).toBe("FETCH_FAILED");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it(`stops after ${MAX_REDIRECTS} redirects`, async () => {
    let n = 0;
    const spy = vi.fn(async () => {
      n += 1;
      return new Response(null, { status: 302, headers: { location: `https://a.example/${n}` } });
    });
    expect(
      await codeOf(() =>
        fetchPublicUrl("https://a.example/0", { budget: newFetchBudget(), fetchImpl: spy }),
      ),
    ).toBe("FETCH_FAILED");
    expect(spy).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  it("turns a non-2xx status into FETCH_FAILED naming the status", async () => {
    const spy = vi.fn(async () => new Response("no", { status: 404 }));
    try {
      await fetchPublicUrl("https://a.example/x", { budget: newFetchBudget(), fetchImpl: spy });
      throw new Error("unreachable");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("FETCH_FAILED");
      expect((error as Error).message).toContain("404");
    }
  });

  it("turns a network error into FETCH_FAILED", async () => {
    const spy = vi.fn(async () => {
      throw new TypeError("connection refused");
    });
    expect(
      await codeOf(() =>
        fetchPublicUrl("https://a.example/x", { budget: newFetchBudget(), fetchImpl: spy }),
      ),
    ).toBe("FETCH_FAILED");
  });

  it("refuses to spend more than the per-call fetch budget", async () => {
    const budget = newFetchBudget();
    budget.used = MAX_FETCHES_PER_CALL;
    const spy = vi.fn(async () => ok());
    expect(
      await codeOf(() => fetchPublicUrl("https://a.example/x", { budget, fetchImpl: spy })),
    ).toBe("INVALID_INPUT");
    expect(spy).not.toHaveBeenCalled();
  });

  it("gives each fetch the timeout the contract states", async () => {
    let seen: AbortSignal | undefined;
    const spy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return ok();
    });
    await fetchPublicUrl("https://a.example/x", { budget: newFetchBudget(), fetchImpl: spy });
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(FETCH_TIMEOUT_MS).toBe(20_000);
  });

  it("keeps the per-call ceilings AGENTS.md states", () => {
    expect(MAX_URL_ENTRIES).toBe(20);
    expect(MAX_FETCHES_PER_CALL).toBe(45);
    expect(MAX_REDIRECTS).toBe(3);
  });
});
