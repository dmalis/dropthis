/**
 * A stand-in for the `cloudflare:workers` module, for unit tests only.
 *
 * `@cloudflare/workers-oauth-provider` imports `WorkerEntrypoint` from it at
 * module load so that a handler class can extend it. dropthis passes plain
 * `{fetch}` objects, so the class is never instantiated here; the stub exists
 * only so the provider can be loaded under Node and drive the whole
 * authorization-code dance against an in-memory KV.
 */
export class WorkerEntrypoint {}
