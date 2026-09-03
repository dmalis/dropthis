/**
 * `.md` files import as their text. Wrangler bundles them through the `Text`
 * rule in `wrangler.jsonc`; vitest through the plugin in `vitest.config.ts`.
 */
declare module "*.md" {
  const text: string;
  export default text;
}
