/**
 * The first line of the fetch guard (SECURITY.md, `files: [{path, url}]`):
 * may the Worker fetch this URL at all?
 *
 * Every outbound fetch dropthis makes on a caller's behalf — a `url` file
 * entry, a Client ID Metadata Document named by an OAuth `client_id` — is a
 * request from inside Cloudflare's network, so the targets it must never
 * reach are the ones a public URL cannot name honestly: loopback, private
 * ranges, link-local and cloud metadata. The Worker also runs with
 * `global_fetch_strictly_public`, which refuses what only DNS reveals (a
 * public hostname resolving to a private address); this guard is the cheap,
 * network-free half, and the half a unit test can pin.
 *
 * The answer is the reason for refusal, or `null` when the URL may be
 * fetched. A reason is a sentence for an agent, not a code: the caller turns
 * it into the error its surface uses.
 */

/** Names that never belong to a public host, exactly or as a suffix. */
const PRIVATE_NAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * THE literal-host classifier — the one place that answers "could this
 * hostname belong to the public internet?" for every outbound fetch the Worker
 * makes (a `url` file entry, an OAuth Client ID Metadata Document).
 *
 * There was one of these per caller once, and they had already drifted: one
 * missed `.home.arpa`, both admitted `2001:db8::/32` (issue #24, finding 14).
 * Now the schemes and ports differ per caller and the HOST rule is shared.
 */
export function privateHostProblem(hostname: string): string | null {
  // `URL` keeps an IPv6 literal in its brackets; the parsers below want it bare.
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1");
  if (PRIVATE_NAMES.has(host) || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return `${host} is not a public host`;
  }

  const address = host.includes(":") ? parseIpv6(host) : parseIpv4Loose(host);
  if (address !== null && !isPublicAddress(address)) {
    return `${host} is not a public address`;
  }
  return null;
}

export function publicHttpsUrlProblem(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "The URL must be an absolute https URL.";
  }
  if (url.protocol !== "https:") return "The URL must use https.";
  if (url.username !== "" || url.password !== "") {
    return "The URL must not carry credentials.";
  }
  // `URL` drops a default port, so anything left is an explicit non-443 port.
  if (url.port !== "") return "The URL must use port 443.";

  return privateHostProblem(url.hostname) === null ? null : "The URL names a private host.";
}

type Ip = { v: 4; bytes: [number, number, number, number] } | { v: 6; words: number[] };

/**
 * IPv4 in every form a resolver accepts: dotted decimal, but also the
 * shorthand and radix forms (`2130706433`, `0x7f000001`, `0177.0.0.1`) the URL
 * parser normalises. WHATWG `URL` already rewrites those into dotted decimal,
 * so this mostly sees the canonical form — the loose parse is a belt over
 * that brace.
 */
function parseIpv4Loose(host: string): Ip | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part, 8);
    else if (/^[0-9]+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isFinite(value)) return null;
    numbers.push(value);
  }
  // The last part may carry the remaining bytes (`127.1` = 127.0.0.1).
  const last = numbers.pop()!;
  const width = 4 - numbers.length;
  if (last >= 256 ** width || numbers.some((n) => n > 255)) return null;
  const tail: number[] = [];
  for (let i = width - 1; i >= 0; i -= 1) tail.push(Math.floor(last / 256 ** i) % 256);
  const bytes = [...numbers, ...tail] as [number, number, number, number];
  return { v: 4, bytes };
}

function parseIpv6(host: string): Ip | null {
  if (!host.includes(":")) return null;
  let text = host;
  // An IPv4-mapped tail (`::ffff:10.0.0.1`) is expanded into two words.
  const mapped = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped !== null) {
    const v4 = parseIpv4Loose(mapped[2]!);
    if (v4 === null || v4.v !== 4) return null;
    const [a, b, c, d] = v4.bytes;
    text = `${mapped[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words: number[] = [];
  for (const group of [...head, ...Array<string>(missing).fill("0"), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    words.push(Number.parseInt(group, 16));
  }
  return { v: 6, words };
}

function isPublicAddress(ip: Ip): boolean {
  if (ip.v === 4) return isPublicIpv4(ip.bytes);
  const [w0, w1, w2, w3, w4, w5, w6, w7] = ip.words as [
    number, number, number, number, number, number, number, number,
  ];
  // Unspecified and loopback: `::` and `::1`.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0) {
    return false;
  }
  // IPv4-mapped (`::ffff:a.b.c.d`) is judged as the IPv4 it wraps.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0xffff) {
    return isPublicIpv4([w6 >> 8, w6 & 0xff, w7 >> 8, w7 & 0xff]);
  }
  if ((w0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((w0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  // The rest of what IANA marks as anything but global unicast, so "reserved or
  // non-unicast" (#92b) is the whole rule and not a sample of it.
  if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return false; // 100::/64 discard
  if (w0 === 0x2001 && w1 === 0x0db8) return false; // 2001:db8::/32 documentation
  if (w0 === 0x2001 && w1 === 0) return false; // 2001::/32 Teredo
  if (w0 === 0x2002) return false; // 2002::/16 6to4
  if (w0 === 0x3fff) return false; // 3fff::/20 documentation (RFC 9637)
  return true;
}

function isPublicIpv4([a, b, c]: readonly number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local + cloud metadata
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 special, 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a! >= 224) return false; // multicast, reserved 240/4 and broadcast
  return true;
}
