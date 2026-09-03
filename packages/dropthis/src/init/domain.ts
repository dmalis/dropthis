/**
 * `init --domain <hostname>` — the custom domain the instance is reached at.
 *
 * Three rules, all from AGENTS.md ("Installer principles", "Zone matching"):
 * the longest zone name that is a suffix of the hostname wins; the zone must
 * be in the SAME account the deploy is pinned to (a Workers custom domain
 * cannot cross accounts, decision #68); and an existing DNS record at that
 * name is a refusal, never an overwrite — the record may be someone's live
 * site.
 *
 * Nothing here parses wrangler output: attaching a domain is one Cloudflare
 * API call, and its answer is JSON.
 */
import type Cloudflare from "cloudflare";

export type Zone = { id: string; name: string };

export type ZoneMatch =
  | { ok: true; zone: Zone }
  | { ok: false; detail: string; remediation: string };

export type AttachResult =
  | { ok: true; canonicalUrl: string; zone: Zone; created: boolean }
  | { ok: false; detail: string; remediation: string };

/** `a.b.example.com` is inside `example.com`; `notexample.com` is not. */
function isInside(hostname: string, zoneName: string): boolean {
  return hostname === zoneName || hostname.endsWith(`.${zoneName}`);
}

export async function matchZone(
  client: Cloudflare,
  accountId: string,
  hostname: string,
): Promise<ZoneMatch> {
  const zones: Array<{ id: string; name: string; accountId: string }> = [];
  for await (const zone of client.zones.list()) {
    const account = (zone as { account?: { id?: string } }).account;
    zones.push({ id: zone.id, name: zone.name, accountId: account?.id ?? "" });
  }

  const candidates = zones
    .filter((zone) => isInside(hostname, zone.name))
    .sort((a, b) => b.name.length - a.name.length);

  if (candidates.length === 0) {
    return {
      ok: false,
      detail: `No zone this token can see is a suffix of ${hostname}.`,
      remediation: `Add the zone for ${hostname} to this Cloudflare account, then run init again with --domain.`,
    };
  }

  const inAccount = candidates.find((zone) => zone.accountId === accountId);
  if (inAccount === undefined) {
    const other = candidates[0]!;
    return {
      ok: false,
      detail: `The zone ${other.name} is in another Cloudflare account, so this Worker cannot serve ${hostname}.`,
      remediation: `Deploy this instance into the account that holds ${other.name}, or pick a hostname in a zone this account owns.`,
    };
  }

  return { ok: true, zone: { id: inAccount.id, name: inAccount.name } };
}

export async function attachDomain(
  client: Cloudflare,
  accountId: string,
  workerName: string,
  hostname: string,
): Promise<AttachResult> {
  const match = await matchZone(client, accountId, hostname);
  if (!match.ok) return match;
  const zone = match.zone;

  // Already ours? Then this is a rerun and there is nothing to do — checked
  // before the DNS look-up, because an attached domain HAS a DNS record.
  for await (const domain of client.workers.domains.list({ account_id: accountId, hostname })) {
    if (domain.service === workerName) {
      return { ok: true, canonicalUrl: `https://${hostname}`, zone, created: false };
    }
    return {
      ok: false,
      detail: `${hostname} already routes to the Worker ${String(domain.service)}.`,
      remediation: `Pick another hostname, or detach ${hostname} from ${String(domain.service)} first.`,
    };
  }

  for await (const record of client.dns.records.list({ zone_id: zone.id, name: { exact: hostname } })) {
    return {
      ok: false,
      detail: `A ${String(record.type)} record already exists at ${hostname}.`,
      remediation: `Remove the ${String(record.type)} record at ${hostname} in the Cloudflare dashboard, then run init again.`,
    };
  }

  await client.workers.domains.update({
    account_id: accountId,
    hostname,
    service: workerName,
    zone_id: zone.id,
  });

  return { ok: true, canonicalUrl: `https://${hostname}`, zone, created: true };
}
