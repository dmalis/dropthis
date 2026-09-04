import { describe, expect, it } from "vitest";
import { publicHttpsUrlProblem } from "../src/domain/public-url.js";

/**
 * The guard every URL the Worker is asked to fetch passes first (SECURITY.md,
 * `files: [{path, url}]`; the OAuth slice's Client ID Metadata Documents).
 * It answers with the reason a URL is refused, or `null` when it may be
 * fetched. The Worker also runs with `global_fetch_strictly_public`, which
 * catches what only DNS can reveal; this guard is the cheap first line, and
 * the one a test can prove without a network.
 */
describe("publicHttpsUrlProblem", () => {
  it.each([
    "https://claude.ai/oauth/mcp-oauth-client-metadata",
    "https://example.com:443/client.json",
    "https://sub.example.co.uk/a/b?c=d",
  ])("accepts %s", (url) => {
    expect(publicHttpsUrlProblem(url)).toBeNull();
  });

  it.each([
    ["http://example.com/client.json", "https"],
    ["ftp://example.com/x", "https"],
    ["not a url", "https"],
    ["https://example.com:8443/x", "443"],
    ["https://user:pw@example.com/x", "credentials"],
    ["https://localhost/x", "private"],
    ["https://LOCALHOST./x", "private"],
    ["https://foo.localhost/x", "private"],
    ["https://127.0.0.1/x", "private"],
    ["https://127.9.9.9/x", "private"],
    ["https://10.0.0.1/x", "private"],
    ["https://172.16.0.1/x", "private"],
    ["https://172.31.255.255/x", "private"],
    ["https://192.168.1.1/x", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://100.64.0.1/x", "private"],
    ["https://0.0.0.0/x", "private"],
    ["https://[::1]/x", "private"],
    ["https://[fe80::1]/x", "private"],
    ["https://[fc00::1]/x", "private"],
    ["https://[fd12::1]/x", "private"],
    ["https://[::ffff:10.0.0.1]/x", "private"],
    ["https://metadata.google.internal/x", "private"],
    ["https://printer.local/x", "private"],
    ["https://2130706433/x", "private"],
    ["https://0x7f000001/x", "private"],
    ["https://0177.0.0.1/x", "private"],
    // Reserved and documentation ranges — decision #92b: "every private,
    // loopback, link-local, carrier-NAT, RESERVED or NON-UNICAST IPv4 or IPv6
    // literal" (issue #24, finding 14).
    ["https://192.0.0.1/x", "private"],
    ["https://192.0.2.5/x", "private"],
    ["https://198.51.100.5/x", "private"],
    ["https://203.0.113.5/x", "private"],
    ["https://198.18.0.1/x", "private"],
    ["https://240.0.0.1/x", "private"],
    ["https://255.255.255.255/x", "private"],
    ["https://[2001:db8::1]/x", "private"],
    ["https://[100::1]/x", "private"],
    ["https://box.home.arpa/x", "private"],
    ["https://host.internal/x", "private"],
  ])("refuses %s (%s)", (url, reason) => {
    expect(publicHttpsUrlProblem(url)).toContain(reason);
  });
});
