/**
 * What each operation SAYS to an agent — the MCP tool text (docs/decisions.md
 * #80; the craft is stolen from the archived product, `docs/research/`).
 *
 * This is product surface, not documentation. An agent reads these words to
 * decide which tool to call, so every entry follows the same rules:
 *
 *   - it opens with `Use when the user says:` and the words a HUMAN uses —
 *     "share this", "get me a link" — never the product's own verbs;
 *   - it names the sibling tool and disowns the neighbouring job ("to change
 *     an existing drop use dropthis_update — never publish again");
 *   - it SHOUTS the invariant at the point of misuse (NEW / EXISTING /
 *     REPLACES THE WHOLE FILE SET);
 *   - it states the identity rule plainly: the URL IS the id, nothing is
 *     resolved first;
 *   - it pre-names the failure code and the fix, so the agent pre-checks;
 *   - it never promises a `next` hint: the URL is the id and there is nothing
 *     to re-teach on success (#51).
 *
 * The text is pinned by `test/mcp-surface.test.ts`, and `/_skill.md` renders
 * from the same entries, so the served skill and the tool list cannot drift.
 *
 * Every entry is keyed by the registry name and consumed by `mcp/tools.ts`;
 * an operation with no entry here is a build error, not a silent gap.
 */
import type { ToolAnnotations } from "../mcp/tools.js";

export type ToolText = {
  /** A short noun phrase, the client's label for the tool. */
  title: string;
  /** The human's own words, comma-separated; rendered after `Use when the user says:`. */
  triggers: string;
  /** The contract, the invariants and the sibling steering, in that order. */
  body: string;
  /** Sentences that apply only when the schema carries the named field. */
  whenField?: Record<string, string>;
  annotations: ToolAnnotations;
};

/** Explicit tri-state on every tool: nothing is left to a client's default. */
const hints = (
  readOnly: boolean,
  destructive: boolean,
  idempotent: boolean,
  openWorld: boolean,
): Omit<ToolAnnotations, "title"> => ({
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: openWorld,
});

export const TOOL_TEXT: Record<string, ToolText> = {
  publish: {
    title: "Publish a drop",
    triggers:
      "share this, send this to someone, make this shareable, make this public, get me a link, " +
      "give me a URL, create a URL, host this, put this online, show this to <person>, let them see it",
    body:
      "Files in, one permanent URL out: the files become a NEW drop at https://<instance>/<slug>/ " +
      "and the response is the Drop (url, slug, title, expires_at, state, files). " +
      "ALWAYS set title: it is what the user sees in lists and on the password page. " +
      "{{password}} " +
      "Creates a NEW drop and a NEW URL every call — an EXISTING drop is changed with " +
      "dropthis_update; never publish again to change something you already published, that " +
      "makes a duplicate URL. " +
      "The files field says how to send each file — text inline, anything already on the web " +
      "as {path, url}, base64 only for small binaries; a single file is served at the drop's " +
      "root, a folder from its index.html when it has one, else as a file list. " +
      "The whole call must stay under this instance's max_request_bytes (see /_skill.md), " +
      "PAYLOAD_TOO_LARGE otherwise. " +
      'expires is "7d", a date, an RFC 3339 instant or "never", inside this instance\'s policy ' +
      "(POLICY_VIOLATION otherwise); omitted, the policy default applies. " +
      "{{slug}} " +
      "Send idempotency_key when a retry must not make a second drop.",
    whenField: {
      slug:
        "The slug is generated for you; pass slug only when the user wants a readable " +
        "campaign link (3-40 characters of a-z 0-9 and -), it is permanent, and one another " +
        "drop already holds is SLUG_TAKEN.",
      password:
        'Prefer password: "generate" — the generated password is in THIS response once and ' +
        "never again; hand it to the user.",
    },
    annotations: { title: "Publish a drop", ...hints(false, false, false, false) },
  },

  update: {
    title: "Update a drop",
    triggers:
      "change it, fix it, update the page, replace the content, edit the report, regenerate it, " +
      "rename it, extend it, make it expire later, bring the link back",
    body:
      "Changes an EXISTING drop in place and keeps its URL; the response is the whole Drop after " +
      "the change. target is the drop's URL or its slug — the URL IS the identity, there is " +
      "nothing to look up first. Only the fields given change. " +
      "files REPLACES THE WHOLE FILE SET, not one file: send every file the drop should have, " +
      "not only the changed ones (read the current set with dropthis_get files: true, then send " +
      "it all back). meta merges at the top level and a key set to null is removed; title: null " +
      "removes the title. {{password}} The same resulting state is a no-op. " +
      "An expired drop inside its 7-day grace comes back only with a future expires in the same " +
      "call (EXPIRED_NEEDS_EXPIRES otherwise); past grace it is EXPIRED_FINAL and must be " +
      "published again. To make something new use dropthis_publish; to remove a drop use " +
      "dropthis_delete. A URL from another instance is WRONG_INSTANCE. " +
      "Send idempotency_key when a retry must not apply twice.",
    whenField: {
      password:
        'password: "generate", a chosen password of 8+ characters, or null to remove it; a ' +
        "generated password is in THIS response once and never again.",
    },
    annotations: { title: "Update a drop", ...hints(false, false, true, false) },
  },

  get: {
    title: "Read a drop",
    triggers:
      "what is at this link, open this drop, look at what I published, pull the current version, " +
      "what are its settings, is it still live, when does it expire",
    body:
      "Reads an EXISTING drop by target — its URL or its slug; the URL IS the identity: title, " +
      "settings, state (live, expired_grace or expired_final), the agent's own meta and the file " +
      "list. With files: true the text files come back inline as content (1 MB in total; larger " +
      "or binary files carry a download_url instead). This is the read half of the edit loop: " +
      "get, change, write back with dropthis_update. Returns settings and files, never a " +
      "password. To find drops without a URL use dropthis_list. A URL from another instance is " +
      "WRONG_INSTANCE; a drop past its grace window is EXPIRED_FINAL; a deleted or unknown " +
      "target is NOT_FOUND.",
    annotations: { title: "Read a drop", ...hints(true, false, true, false) },
  },

  list: {
    title: "List drops",
    triggers:
      "what have I published, list my drops, show my links, find the report I shared, which " +
      "drops expire soon, what did <person> publish",
    body:
      "One page of this instance's drops, newest first, with cursor and has_more. Every key of " +
      "the instance sees every drop; created_by says who made each one. q is a case-insensitive " +
      "substring of the title applied within the page, so a page can be empty while has_more is " +
      "true — keep paging with cursor until has_more is false. Rows carry the settings but not " +
      "meta or files: read one drop in full with dropthis_get. Drops inside their grace window " +
      "are shown with state expired_grace; past it they are hidden.",
    annotations: { title: "List drops", ...hints(true, false, true, false) },
  },

  delete: {
    title: "Delete a drop",
    triggers: "delete it, take it down, remove the link, unpublish it, kill this URL",
    body:
      "Permanently deletes an EXISTING drop — its files and its URL — by target, the URL or the " +
      "slug. Destructive and irreversible: the URL answers 404 from the next request on and is " +
      "never reused. To change content or settings while keeping the URL use dropthis_update; " +
      "to let a link lapse on its own set expires with dropthis_update instead. Succeeds whether " +
      "or not the drop still exists, so a retry is safe. A URL from another instance is " +
      "WRONG_INSTANCE.",
    annotations: { title: "Delete a drop", ...hints(false, true, true, false) },
  },

  "upload.create": {
    title: "Upload big files",
    triggers:
      "upload this photo, share this video, this file is too big to paste, put this PDF online, " +
      "send them the zip, publish the recording, host the screenshot I gave you",
    body:
      "Step one of THREE, for files too big to inline — a photo, a video, a PDF, an archive, or " +
      "anything past this instance's max_request_bytes. Use it only when your environment can run " +
      "curl and reach the internet; when it cannot, send {path, url} to dropthis_publish for " +
      "anything already on the web, or shrink the file. " +
      "Send manifest: one entry per file, the digest in lowercase hex, in one of three shapes — " +
      "{path, size, sha256} for a file you will PUT; {path, sha256} with NO size to keep a file " +
      "the target drop already holds under that digest (an update only); {path, size, sha256, " +
      "url} for a file already on the web, which this instance fetches at commit. Back come " +
      "upload_id, the slug the drop will have, missing (the digests this instance does not hold " +
      "yet and you must PUT — never a keep, never a url entry) and put_urls, one absolute URL " +
      "per missing digest. " +
      "STEP TWO IS YOURS: for each digest in missing run curl -sS -T <file> '<put_url>'. The URL " +
      "is the whole credential — send NO Authorization header — it fits one file and lasts one " +
      "hour. Step three is dropthis_commit with the upload_id: NOTHING IS PUBLISHED and the URL " +
      "does not work until then. " +
      "target updates an EXISTING drop, its URL or its slug, and REPLACES its whole file set; " +
      "omit target for a new drop. Bytes that do not match sha256 are HASH_MISMATCH and nothing " +
      "is stored. A session lasts one day, past that UPLOAD_EXPIRED. A URL from another instance " +
      "is WRONG_INSTANCE. Send idempotency_key when a retry must not open a second upload.",
    annotations: { title: "Upload big files", ...hints(false, false, false, false) },
  },

  "upload.commit": {
    title: "Finish an upload",
    triggers:
      "the upload finished, curl is done, publish what I uploaded, finish the upload, commit it",
    body:
      "Step three of the staged upload dropthis_upload opened: id is the upload_id it returned. " +
      "This is where the drop is published — the response is the whole Drop (url, slug, title, " +
      "expires_at, state, files) and the URL starts working here, not before. " +
      "It takes the settings dropthis_publish takes: title (ALWAYS set it), meta, password, " +
      "expires, noindex. {{password}} " +
      "Call it only after every digest in missing has been PUT: a blob that is not there yet is " +
      "INVALID_INPUT naming the digest — upload that one and call again. Calling twice is safe, " +
      "the second call replays the same Drop; the same id with different settings is " +
      "IDEMPOTENCY_MISMATCH. A session older than a day is UPLOAD_EXPIRED: open a new one with " +
      "dropthis_upload. For files small enough to inline use dropthis_publish instead, and to " +
      "change a drop later use dropthis_update.",
    whenField: {
      password:
        'Prefer password: "generate" — the generated password is in THIS response once and ' +
        "never again; hand it to the user.",
    },
    annotations: { title: "Finish an upload", ...hints(false, false, true, false) },
  },

  "user.add": {
    title: "Add a person",
    triggers:
      "add <person>, give <person> access, invite <person>, onboard a colleague, create a key " +
      "for <person>",
    body:
      "Admin key only. Mints a new user-scope key for one person, labelled with their name, and " +
      "returns the key ONCE together with a connect object (per-client snippets for Claude " +
      "Code, Cursor, Codex and claude.ai) and a ready-to-send message: relay the message and " +
      "the key to the person, in separate messages. The key is never shown again; a lost key " +
      "is replaced with dropthis_user_remove then dropthis_user_add. Labels are unique per " +
      'instance after normalisation ("Anna" and "anna " are the same label): LABEL_TAKEN ' +
      "otherwise. Send idempotency_key when a retry must not mint a second key.",
    annotations: { title: "Add a person", ...hints(false, false, false, false) },
  },

  "user.list": {
    title: "List people",
    triggers: "who has access, list users, show the team, which keys exist",
    body:
      "Admin key only. Every key of this instance — id, label, scope and creation date — never " +
      "the keys themselves. To revoke one use dropthis_user_remove with its label.",
    annotations: { title: "List people", ...hints(true, false, true, false) },
  },

  "user.remove": {
    title: "Remove a person",
    triggers: "remove <person>, revoke <person>'s access, offboard <person>, rotate <person>'s key",
    body:
      "Admin key only. Deletes the key behind a label: it stops working on the very next " +
      "request and every session behind it ends. Destructive and irreversible; the label can " +
      "be reused with dropthis_user_add and gets a new key id. The label admin cannot be " +
      "removed here (INVALID_INPUT): the admin key is rotated with dropthis init " +
      "--rotate-admin-key. Succeeds when the label is already gone, so a retry is safe.",
    annotations: { title: "Remove a person", ...hints(false, true, true, false) },
  },

  "config.get": {
    title: "Read the instance policy",
    triggers:
      "what are the limits, what is the default expiry, is a password required, show the " +
      "policy, why was my publish refused with POLICY_VIOLATION",
    body:
      "Admin key only. Reads this instance's policy: the defaults filled in when a call says " +
      "nothing (expiry, password, noindex) and the rules enforced regardless (expiry max and " +
      "allow_never, password required, max_file_bytes, max_request_bytes, pbkdf2_iterations, " +
      "cron_ops_budget). To change a value use dropthis_config_set.",
    annotations: { title: "Read the instance policy", ...hints(true, false, true, false) },
  },

  "config.set": {
    title: "Change the instance policy",
    triggers:
      "make links expire after 7 days by default, require passwords, never allow never, raise " +
      "the upload limit, change the policy",
    body:
      "Admin key only. Changes the policy fields given and leaves the rest as they are; the " +
      "response is the whole resulting policy plus a note. PROSPECTIVE ONLY: it changes what " +
      "future dropthis_publish and dropthis_update calls resolve to and never rewrites an " +
      "existing drop, which keeps its settings until a call next sets that field. A value " +
      "above a hard ceiling, or a policy that forbids its own default, is POLICY_VIOLATION. " +
      "canonical_url, alias_origins and instance_name belong to dropthis init and cannot be " +
      "set here.",
    annotations: { title: "Change the instance policy", ...hints(false, false, true, false) },
  },

  usage: {
    title: "Instance usage",
    triggers:
      "how much is stored, how many drops are there, how big is the instance, what is expired",
    body:
      "Admin key only. Counts drops and bytes per state (live, expired_grace, expired_final, " +
      "staging, orphan) by scanning the bucket within the cron budget; when incomplete is true, " +
      "call again with the returned cursor. Read-only: to delete what is expired use " +
      "dropthis_prune.",
    annotations: { title: "Instance usage", ...hints(true, false, true, false) },
  },

  prune: {
    title: "Prune expired drops",
    triggers: "clean up, delete expired drops, free space, run the sweep now",
    body:
      "Admin key only. Deletes drops past their 7-day grace window (state expired_final) and " +
      "reports counts per state in the same shape as dropthis_usage. dry_run DEFAULTS TO TRUE " +
      "and only reports; pass dry_run: false to delete — destructive and irreversible then. " +
      "Works within the cron budget: when incomplete is true, call again with the returned " +
      "cursor. The hourly cron does this on its own; this is the manual lever.",
    annotations: { title: "Prune expired drops", ...hints(false, true, true, false) },
  },

  doctor: {
    title: "Check the instance",
    triggers:
      "is dropthis working, check the instance, something is broken, run diagnostics, the " +
      "deploy finished so does it work",
    body:
      "Admin key only. Runs every instance check — publishes, reads back and deletes a real " +
      "hello drop, initializes the MCP endpoint against itself, reads the policy, the cron " +
      "checkpoint and the canonical origin, times a PBKDF2 derive and confirms no admin " +
      "rotation is half finished — and returns {ok, checks: [{id, status: pass | fail | skip | " +
      "inconclusive, evidence, remediation}]}. skip means the check had nothing to look at and " +
      "inconclusive means it could not measure; neither makes ok false, only fail does. " +
      "Leaves the instance as it found it. To see what the checks " +
      "are without running them use dropthis_doctor_checks.",
    annotations: { title: "Check the instance", ...hints(false, false, true, false) },
  },

  "doctor.checks": {
    title: "List the doctor's checks",
    triggers: "what does doctor check, list the health checks",
    body:
      "Admin key only. Lists the checks dropthis_doctor can run, with what each one proves. " +
      "Reads nothing and changes nothing; to run them use dropthis_doctor.",
    annotations: { title: "List the doctor's checks", ...hints(true, false, true, false) },
  },
};

/**
 * The server-level instructions (pattern: the cross-tool contract for raw
 * connectors that show an agent the tool list and nothing else).
 */
export function serverInstructions(canonicalUrl: string): string {
  return (
    "dropthis turns files into a permanent URL on this instance. The URL is the identity: " +
    "dropthis_get, dropthis_update and dropthis_delete take the URL or the slug and nothing is " +
    "resolved first. Publish once, then update — publishing again makes a duplicate URL. " +
    "Always set a title. Every error is {code, message, remediation, retryable}: act on the " +
    "code, read the remediation only when off-path. This instance's own guide, with its live " +
    `limits, is ${canonicalUrl}/_skill.md.`
  );
}
