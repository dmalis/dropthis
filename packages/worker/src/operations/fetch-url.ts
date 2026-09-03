/**
 * Fetching a `url` file entry — the only outbound request dropthis ever makes
 * on a caller's behalf (AGENTS.md, "One call uploads a drop").
 *
 * An agent that already knows where an image lives should not spend its own
 * output tokens re-typing the bytes: one base64 byte is roughly one generated
 * token, so a 200 KB photo is a stall, not an upload (decision #86). A `url`
 * entry costs the agent nothing — the instance fetches it.
 *
 * That makes the Worker a fetcher of caller-named URLs, which is the classic
 * SSRF shape, so every target passes these rules BEFORE any byte moves:
 *
 *   - `http` or `https` only, on port 80 or 443 only, no credentials;
 *   - no loopback, private, link-local, carrier-NAT or metadata target that a
 *     literal host can name — and no `localhost`/`.local` name;
 *   - every redirect hop re-validated, at most three, followed manually.
 *
 * Names that RESOLVE to a private address cannot be caught here — the Worker
 * has no resolver — so the deployment also runs with the
 * `global_fetch_strictly_public` compatibility flag, which is Cloudflare's own
 * guard on the resolved address. The two layers are deliberate: this one gives
 * the agent a clear `FETCH_FAILED` for an obvious mistake, that one is the
 * boundary.
 */
import { ApiError } from "../errors.js";

/** `url` entries per call: the Free plan allows 50 external subrequests. */
export const MAX_URL_ENTRIES = 20;
/** Fetches per call, redirect hops included, inside the same budget. */
export const MAX_FETCHES_PER_CALL = 45;
/** Hops followed manually; each one is re-validated. */
export const MAX_REDIRECTS = 3;
/** Per fetch, so one dead host cannot hold the whole call. */
export const FETCH_TIMEOUT_MS = 20_000;

/** The fetches one call has spent, shared across its entries. */
export type FetchBudget = { used: number };

export function newFetchBudget(): FetchBudget {
  return { used: 0 };
}

export type FetchOptions = {
  budget: FetchBudget;
  fetchImpl?: typeof fetch;
};

function refuse(message: string): never {
  throw new ApiError("FETCH_FAILED", message);
}

const FORBIDDEN_NAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

/**
 * The literal-address classes a URL may not name. Hostnames are checked as
 * written: this is the honest half of the guard, not the whole of it.
 */
function forbiddenHost(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (FORBIDDEN_NAMES.has(host)) return `${host} is not a public host`;
  if (host.endsWith(".localhost")) return `${host} is a loopback name`;
  if (host.endsWith(".local") || host.endsWith(".internal")) return `${host} is a local name`;

  // A URL's IPv6 literal keeps its brackets in `hostname` off some parsers;
  // WHATWG strips them, so handle both.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.includes(":")) return forbiddenIpv6(bare);
  if (/^\d+(\.\d+){3}$/.test(bare)) return forbiddenIpv4(bare);
  return null;
}

function forbiddenIpv4(address: string): string | null {
  const parts = address.split(".").map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return `${address} is not a valid address`;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return `${address} is not a routable address`;
  if (a === 10) return `${address} is a private address`;
  if (a === 127) return `${address} is a loopback address`;
  if (a === 172 && b >= 16 && b <= 31) return `${address} is a private address`;
  if (a === 192 && b === 168) return `${address} is a private address`;
  if (a === 169 && b === 254) return `${address} is a link-local address`;
  if (a === 100 && b >= 64 && b <= 127) return `${address} is a carrier-NAT address`;
  if (a === 192 && b === 0) return `${address} is a reserved address`;
  if (a === 198 && (b === 18 || b === 19)) return `${address} is a benchmarking address`;
  if (a >= 224) return `${address} is not a unicast address`;
  return null;
}

function forbiddenIpv6(address: string): string | null {
  const lower = address.toLowerCase();
  // `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same loopback wearing a hat.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped !== null) return forbiddenIpv4(mapped[1]!);
  if (lower === "::" || lower === "::1") return `${address} is a loopback address`;
  if (/^f[cd]/.test(lower)) return `${address} is a unique-local address`;
  if (/^fe[89ab]/.test(lower)) return `${address} is a link-local address`;
  if (lower.startsWith("ff")) return `${address} is not a unicast address`;
  if (lower.startsWith("::ffff:")) return `${address} is an IPv4-mapped address`;
  return null;
}

/**
 * The whole target rule, as one function, so validation of the first URL and
 * of every redirect hop is literally the same code.
 */
export function checkPublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse(`${JSON.stringify(raw)} is not a URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return refuse(`${url.protocol.replace(":", "")} is not a scheme this instance fetches; use https.`);
  }
  if (url.username !== "" || url.password !== "") {
    return refuse("A fetched URL may not carry credentials.");
  }
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return refuse(`Port ${url.port} is not fetched; use 80 or 443.`);
  }
  const bad = forbiddenHost(url.hostname);
  if (bad !== null) return refuse(`${bad}: this instance fetches public targets only.`);
  return url;
}

/**
 * Fetch one target, following up to `MAX_REDIRECTS` hops by hand so each hop
 * is validated. Returns the final 2xx response; every other outcome — a bad
 * target, a status, a network error, a timeout, one hop too many, an empty
 * budget — is an error the caller can show an agent verbatim.
 */
export async function fetchPublicUrl(raw: string, options: FetchOptions): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  let target = checkPublicUrl(raw);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (options.budget.used >= MAX_FETCHES_PER_CALL) {
      throw new ApiError(
        "INVALID_INPUT",
        `This call would spend more than ${MAX_FETCHES_PER_CALL} fetches, redirects included; send fewer url entries.`,
      );
    }
    options.budget.used += 1;

    let response: Response;
    try {
      response = await doFetch(target.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "*/*" },
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return refuse(`Fetching ${target.href} failed: ${why}.`);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) return refuse(`${target.href} answered ${response.status} with no location.`);
      if (hop === MAX_REDIRECTS) {
        return refuse(`${raw} redirected more than ${MAX_REDIRECTS} times.`);
      }
      target = checkPublicUrl(new URL(location, target).href);
      continue;
    }

    if (!response.ok) {
      return refuse(`${target.href} answered ${response.status}.`);
    }
    return response;
  }

  return refuse(`${raw} redirected more than ${MAX_REDIRECTS} times.`);
}
