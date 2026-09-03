/**
 * The control plane's literal path prefixes. Routing checks them with
 * `startsWith` and nothing else, so a slug can never shadow one (generated
 * slugs never start with `_`). Every new control-plane prefix is added here
 * together with a viewer-collision test.
 */
export const RESERVED_PREFIXES = [
  "/_api",
  "/_oauth",
  "/.well-known",
  "/_connect",
  "/_skill.md",
] as const;

export function isReservedPath(pathname: string): boolean {
  return RESERVED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
