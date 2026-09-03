/**
 * An in-memory stand-in for the `OAUTH_KV` binding, for unit tests only.
 *
 * It exists so `@cloudflare/workers-oauth-provider` can run the whole
 * authorization-code dance under Node, and so a test can look at what the
 * provider wrote: which keys, and — the binding amendment's proof — whether a
 * grant was put WITH an expiration. KV's real semantics (eventual consistency,
 * the 60-second minimum TTL) are not modelled; the deployed instance proves
 * those in `contract-tests/`.
 */
export type KvPut = { key: string; options: Record<string, unknown> | undefined };

type KvListResult = {
  keys: Array<{ name: string; expiration?: number; metadata?: unknown }>;
  list_complete: boolean;
  cursor?: string;
};

export type MemoryKv = {
  get(key: string, options?: { type?: string } | string): Promise<unknown>;
  getWithMetadata(key: string, options?: { type?: string } | string): Promise<{ value: unknown; metadata: unknown }>;
  put(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<KvListResult>;
  /** Every `put`, in order, with the options the provider passed. */
  puts: KvPut[];
  /** Every key present now. */
  keys(): string[];
  /** Every stored value, for "the raw key appears nowhere" assertions. */
  values(): string[];
};

export function memoryKv(): MemoryKv {
  const store = new Map<string, { value: string; metadata?: unknown; expiration?: number }>();
  const puts: KvPut[] = [];

  const decode = (value: string, options?: { type?: string } | string) => {
    const type = typeof options === "string" ? options : options?.type;
    return type === "json" ? (JSON.parse(value) as unknown) : value;
  };

  return {
    puts,
    async get(key, options) {
      const stored = store.get(key);
      return stored === undefined ? null : decode(stored.value, options);
    },
    async getWithMetadata(key, options) {
      const stored = store.get(key);
      return stored === undefined
        ? { value: null, metadata: null }
        : { value: decode(stored.value, options), metadata: stored.metadata ?? null };
    },
    async put(key, value, options) {
      puts.push({ key, options });
      const entry: { value: string; metadata?: unknown; expiration?: number } = { value };
      if (options?.metadata !== undefined) entry.metadata = options.metadata;
      if (typeof options?.expiration === "number") entry.expiration = options.expiration;
      if (typeof options?.expirationTtl === "number") {
        entry.expiration = Math.floor(Date.now() / 1000) + options.expirationTtl;
      }
      store.set(key, entry);
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix ?? "";
      const all = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = options.cursor === undefined ? 0 : Number(options.cursor);
      const limit = options.limit ?? 1000;
      const page = all.slice(start, start + limit);
      const complete = start + limit >= all.length;
      return {
        keys: page.map((name) => {
          const stored = store.get(name)!;
          return {
            name,
            ...(stored.expiration === undefined ? {} : { expiration: stored.expiration }),
            ...(stored.metadata === undefined ? {} : { metadata: stored.metadata }),
          };
        }),
        list_complete: complete,
        ...(complete ? {} : { cursor: String(start + limit) }),
      };
    },
    keys() {
      return [...store.keys()].sort();
    },
    values() {
      return [...store.values()].map((entry) => entry.value);
    },
  };
}
