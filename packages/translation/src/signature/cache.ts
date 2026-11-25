/**
 * Thinking-signature cache (Antigravity "cache mode") and signature settings.
 *
 * Go source: internal/cache/signature_cache.go (`CacheSignature`, `GetCachedSignature`, `HasValidSignature`,
 * `GetModelGroup`, `SignatureCacheEnabled`, `SignatureBypassStrictMode`).
 *
 * Translators are synchronous, so the cache they read is a bounded per-isolate map ({@link MemorySignatureCache}).
 * Persistence is best-effort and asynchronous behind `SignatureStore` (`store.ts`; the Worker's is its `CACHE` KV):
 * executors prefetch the signatures a request needs before translating (`prefetchSignatures`) and flush the writes the
 * response translator recorded afterwards (`flushSignatureWrites`). A store failure never fails a request.
 *
 * Ambient state follows `translator/model-info.ts`: {@link withSignatureContext} scopes the cache and settings of the
 * current attempt around a synchronous translator call; the module default is an isolate-wide cache with Go's default
 * settings (cache mode on, basic bypass validation).
 */
import { createHash } from "node:crypto";

/** `SignatureCacheTTL` (3 h), sliding. */
export const SIGNATURE_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

/** `MinValidSignatureLen`. */
export const MIN_VALID_SIGNATURE_LEN = 50;

/** `SignatureTextHashLen`. */
export const SIGNATURE_TEXT_HASH_LEN = 16;

export const GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR = "skip_thought_signature_validator";

/**
 * `GetModelGroup`: gpt / claude / gemini share a cache bucket per family, matched case-insensitively (Go 0286e5d1);
 * other models get a bucket of their own, keyed by the name as given.
 */
export const getModelGroup = (modelName: string): string => {
  const normalized = modelName.trim().toLowerCase();

  if (normalized.includes("gpt")) return "gpt";

  if (normalized.includes("claude")) return "claude";

  if (normalized.includes("gemini")) return "gemini";

  return modelName;
};

/** `hashText`: the 16 hex character key of the thinking text. */
export const hashSignatureText = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex").slice(0, SIGNATURE_TEXT_HASH_LEN);

/** Key of the persistent store (`cpa:signature:<group>:<hash>` in Go's home KV). */
export const signatureStoreKey = (modelName: string, text: string): string =>
  `sig:${getModelGroup(modelName)}:${hashSignatureText(text)}`;

export interface SignatureSettings {
  /** `SignatureCacheEnabled` (cache mode); `false` = bypass mode. */
  readonly cacheEnabled: boolean;
  /** `SignatureBypassStrictMode`: strict protobuf-tree validation in bypass mode. */
  readonly bypassStrictMode: boolean;
}

export const defaultSignatureSettings: SignatureSettings = {
  cacheEnabled: true,
  bypassStrictMode: false,
};

/** Synchronous cache read by the translators. */
export interface SignatureCache {
  /** `GetCachedSignature`: the cached signature, the Gemini bypass sentinel on a Gemini miss, `""` otherwise. */
  get(modelName: string, text: string): string;
  /** `CacheSignature`; `false` when the signature is too short or the text empty. */
  set(modelName: string, text: string, signature: string): boolean;
  /** `DeleteCachedSignatureRequired`. */
  delete(modelName: string, text: string): void;
  clear(): void;
}

/** A signature write recorded for asynchronous persistence. */
export interface SignatureWrite {
  readonly modelName: string;
  readonly text: string;
  readonly signature: string;
}

interface Entry {
  readonly signature: string;
  touched: number;
}

const MAX_ENTRIES = 4096;

/** Bounded in-memory cache with sliding TTL and a log of writes that still have to reach the persistent store. */
export class MemorySignatureCache implements SignatureCache {
  readonly #entries = new Map<string, Entry>();
  #pending: SignatureWrite[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.#entries.size;
  }

  #key(modelName: string, text: string): string {
    return `${getModelGroup(modelName)}\u0000${text}`;
  }

  get(modelName: string, text: string): string {
    const miss =
      getModelGroup(modelName) === "gemini" ? GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR : "";

    if (text === "") return miss;
    const key = this.#key(modelName, text);
    const entry = this.#entries.get(key);

    if (entry === undefined) return miss;
    const now = this.now();

    if (now - entry.touched > SIGNATURE_CACHE_TTL_MS) {
      this.#entries.delete(key);

      return miss;
    }

    // Sliding expiration; re-insert to keep the map in recency order.
    entry.touched = now;
    this.#entries.delete(key);
    this.#entries.set(key, entry);

    return entry.signature;
  }

  /** Whether a real (non-sentinel) value is cached; used to decide whether a store prefetch is needed. */
  has(modelName: string, text: string): boolean {
    return this.#entries.has(this.#key(modelName, text));
  }

  set(modelName: string, text: string, signature: string): boolean {
    if (text === "" || signature === "" || signature.length < MIN_VALID_SIGNATURE_LEN) return false;
    this.#store(modelName, text, signature);
    this.#pending.push({ modelName, text, signature });

    if (this.#pending.length > MAX_ENTRIES)
      this.#pending.splice(0, this.#pending.length - MAX_ENTRIES);

    return true;
  }

  /** Inserts a value that came from the persistent store (no write-back). */
  hydrate(modelName: string, text: string, signature: string): void {
    if (text !== "" && signature.length >= MIN_VALID_SIGNATURE_LEN)
      this.#store(modelName, text, signature);
  }

  #store(modelName: string, text: string, signature: string): void {
    const key = this.#key(modelName, text);
    this.#entries.delete(key);
    this.#entries.set(key, { signature, touched: this.now() });

    while (this.#entries.size > MAX_ENTRIES) {
      const oldest = this.#entries.keys().next().value;

      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  delete(modelName: string, text: string): void {
    if (text !== "") this.#entries.delete(this.#key(modelName, text));
  }

  clear(): void {
    this.#entries.clear();
    this.#pending = [];
  }

  /** Takes the writes recorded since the last call. */
  drainPendingWrites(): SignatureWrite[] {
    const writes = this.#pending;
    this.#pending = [];

    return writes;
  }
}

/** `HasValidSignature`. */
export const hasValidSignature = (modelName: string, signature: string): boolean =>
  (signature !== "" && signature.length >= MIN_VALID_SIGNATURE_LEN) ||
  (signature === GEMINI_SKIP_THOUGHT_SIGNATURE_VALIDATOR && getModelGroup(modelName) === "gemini");

interface SignatureContext {
  readonly cache: SignatureCache;
  readonly settings: SignatureSettings;
  /** A cache was installed for the current attempt ({@link withSignatureContext}), rather than the isolate default. */
  readonly scoped: boolean;
}

const isolateCache = new MemorySignatureCache();

let current: SignatureContext = {
  cache: isolateCache,
  settings: defaultSignatureSettings,
  scoped: false,
};

/**
 * The scope whose isolate-wide cache is the default of {@link currentSignatureCache}. The Worker scopes caches by org,
 * and its global org's id is this value.
 */
export const DEFAULT_SIGNATURE_SCOPE = "global";

const scopeCaches = new Map<string, MemorySignatureCache>([
  [DEFAULT_SIGNATURE_SCOPE, isolateCache],
]);

/** Most scopes whose caches one isolate keeps besides the default's; the oldest other scope's cache goes first. */
const MAX_SCOPE_CACHES = 64;

/**
 * The isolate-wide cache of `scope` ({@link DEFAULT_SIGNATURE_SCOPE}'s is the default of {@link currentSignatureCache}).
 * The Worker passes the org: signatures are org data, so one org's thinking never meets another org's cached signature.
 */
export const isolateSignatureCache = (scope: string): MemorySignatureCache => {
  const existing = scopeCaches.get(scope);

  if (existing !== undefined) return existing;

  if (scopeCaches.size > MAX_SCOPE_CACHES) {
    const oldest = [...scopeCaches.keys()].find((cached) => cached !== DEFAULT_SIGNATURE_SCOPE);

    if (oldest !== undefined) scopeCaches.delete(oldest);
  }

  const created = new MemorySignatureCache();
  scopeCaches.set(scope, created);

  return created;
};

export const currentSignatureCache = (): SignatureCache => current.cache;

export const currentSignatureSettings = (): SignatureSettings => current.settings;

/** Runs the synchronous `fn` with the given cache/settings installed and restores the previous context afterwards. */
export const withSignatureContext = <T>(
  context: { readonly cache?: SignatureCache; readonly settings?: Partial<SignatureSettings> },
  fn: () => T,
): T => {
  const previous = current;
  current = {
    cache: context.cache ?? previous.cache,
    settings: { ...previous.settings, ...context.settings },
    scoped: context.cache !== undefined || previous.scoped,
  };

  try {
    return fn();
  } finally {
    current = previous;
  }
};

/** Installs the process-wide default settings (tests). */
export const setSignatureSettings = (settings: Partial<SignatureSettings>): void => {
  current = { ...current, settings: { ...current.settings, ...settings } };
};

/** `cache.SignatureCacheEnabled()`. */
export const signatureCacheEnabled = (): boolean => current.settings.cacheEnabled;

/** `cache.SignatureBypassStrictMode()`. */
export const signatureBypassStrictMode = (): boolean => current.settings.bypassStrictMode;

/**
 * Whether the current attempt installed its own cache. Go's `RequireSignatureCacheScope`: request-time recovery on the
 * Antigravity Claude path fails closed without one (CLIProxyAPI 85225381).
 */
export const signatureCacheScoped = (): boolean => current.scoped;

/** `cache.GetCachedSignature`. */
export const getCachedSignature = (modelName: string, text: string): string =>
  current.cache.get(modelName, text);

/** `cache.CacheSignature`. */
export const cacheSignature = (modelName: string, text: string, signature: string): boolean =>
  current.cache.set(modelName, text, signature);
