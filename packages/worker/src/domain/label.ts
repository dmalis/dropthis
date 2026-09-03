/**
 * The label normalization, in one function (AGENTS.md, "Team model").
 *
 * A label is how a person is named in `user add`, `user remove` and
 * `created_by`. Uniqueness is claimed on `users/<normalized-label>` with a
 * conditional write, so "Anna" and "anna " must reduce to the same key or the
 * claim proves nothing: two records, one person, two live keys.
 *
 * The steps are fixed and ordered: NFKC (compatibility forms fold onto their
 * plain spelling), lowercase, trim, every run of whitespace to one `-`. What
 * survives must match `^[a-z0-9][a-z0-9._-]{0,62}$` — ASCII, because a label
 * appears in a bucket key, in shell arguments and in `.mcp.json`, and a
 * homoglyph there is an impersonation, not a convenience.
 */
export const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export class LabelError extends Error {
  readonly code = "INVALID_INPUT" as const;

  constructor(message: string) {
    super(message);
    this.name = "LabelError";
  }
}

export function normalizeLabel(raw: string): string {
  const normalized = raw
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, "-");

  if (!LABEL_PATTERN.test(normalized)) {
    throw new LabelError(
      `label must start with a-z0-9 and hold only a-z0-9 . _ - (at most 63 characters); ` +
        `${JSON.stringify(raw)} normalizes to ${JSON.stringify(normalized)}.`,
    );
  }
  return normalized;
}
