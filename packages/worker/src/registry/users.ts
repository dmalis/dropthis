/**
 * The registry entries for `user add|list|remove` (AGENTS.md, "Team model").
 *
 * A label is a person. `users/<normalized-label>` is claimed with a
 * conditional write, so the claim itself — not a check-then-write — is what
 * makes a label mean one person.
 */
import { z } from "zod";
import { parseKeyRecord } from "../auth/caller.js";
import type { Bucket } from "../bindings.js";
import { KEYS_PREFIX, keyRecordKey } from "../storage/keys.js";
import type { Operation } from "./types.js";

export type UserSummary = {
  id: string;
  label: string;
  scope: "admin" | "user";
  created: string;
};

const listSchema = z.strictObject({});

/**
 * Every key record, oldest first. This is one of the two `list()` calls the
 * product makes on purpose (the other is `list` over `list/`): a team is a
 * handful of people, and an index file would be a second truth to keep.
 */
export async function listUsers(bucket: Bucket): Promise<UserSummary[]> {
  const users: UserSummary[] = [];
  let cursor: string | undefined;

  do {
    const listing = await bucket.list(
      cursor === undefined ? { prefix: KEYS_PREFIX } : { prefix: KEYS_PREFIX, cursor },
    );
    for (const object of listing.objects) {
      const record = await bucket.get(object.key);
      if (record === null) continue;
      const parsed = parseKeyRecord(await record.text());
      // A record this Worker cannot read is skipped rather than guessed at;
      // `doctor` is where an unreadable record should surface, not `user list`.
      if (parsed === null) continue;
      users.push({
        id: parsed.id,
        label: parsed.label,
        scope: parsed.scope,
        created: parsed.created,
      });
    }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor !== undefined);

  return users;
}

export const userList: Operation<z.infer<typeof listSchema>> = {
  name: "user.list",
  method: "GET",
  path: "/users",
  scope: "admin",
  summary: "List every key of this instance: id, label, scope and creation date.",
  schema: listSchema,
  handler: async (_input, ctx) => ({ value: { users: await listUsers(ctx.bucket) } }),
};

export { keyRecordKey };
