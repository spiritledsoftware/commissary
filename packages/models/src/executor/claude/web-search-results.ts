/**
 * Claude web search result cache: the `web_search_tool_result` content of a session, kept per upstream credential and
 * restored when a Responses client replays its history without it.
 *
 * Go source: internal/runtime/executor/helps/claude_web_search_results.go (`RecordClaudeWebSearchResults`,
 * `RestoreClaudeWebSearchResults`), internal/cache/claude_web_search_result_cache.go (store semantics),
 * claude_executor.go (`claudeWebSearchResultCacheScope`, `claudeWebSearchResultCacheCredentialScope`); upstream 9d453bc0,
 * cddc9bb8. A Responses `web_search_call` item carries its results without the `encrypted_content` Anthropic requires
 * once a client drops them, so the replayed `web_search_tool_result` would be empty (and its citations unbacked).
 *
 * Differences from Go (ARCHITECTURE.md, "Claude provider"):
 *  - The store is the `claude-web-search-results` store of `SessionState` (org + caller scope + session), like the date pin;
 *    no process-wide LRU and no `limit` setting (the instance bounds its entries).
 *  - There is no `client.codex.web-search-result-cache` switch: the cache serves every Responses client that names its
 *    session (Go default: off).
 *  - The lookup is read before translating (`responsesWebSearchCallsWithoutResults`) and handed to the Responses -> Claude
 *    translator, which restores the block and drops the citations it could not back; Go restores into the translated body.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { type Json, get, isJsonArray, tryParseJson } from "@commissary/json";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
  type SessionAddress,
  type StateOp,
} from "@commissary/state";
import { str } from "@commissary/translation";
import type { CredentialSnapshot } from "../picker.ts";

const STORE_NAME = "claude-web-search-results";

/** Go `defaultClaudeWebSearchResultTTL`. */
const TTL_MS = 24 * 3600_000;

/** Entries one session keeps (Go `defaultClaudeWebSearchResultLimit` bounds the whole process). */
const MAX_ENTRIES = 256;

/** Where one request's results live: caller, session, and the upstream credential that produced them. */
export interface WebSearchResultScope {
  readonly callerScope: string;
  readonly session: string;
  /** `claudeWebSearchResultCacheCredentialScope`: a hash of the credential, so only that credential's results return. */
  readonly credential: string;
}

export interface WebSearchResult {
  /** The Claude `server_tool_use` id. */
  readonly id: string;
  /** The raw `content` of the `web_search_tool_result` block. */
  readonly content: Json;
}

export interface WebSearchResultStore {
  /** The cached content of each id found (a hit slides its expiry); failures are misses. */
  readonly load: (
    scope: WebSearchResultScope,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, Json>>;
  readonly save: (
    scope: WebSearchResultScope,
    results: ReadonlyArray<WebSearchResult>,
  ) => Effect.Effect<void>;
}

/** `claudeWebSearchResultCacheCredentialScope`. */
export const webSearchCredentialScope = (credential: CredentialSnapshot): string =>
  createHash("sha256").update(credential.id).digest("hex").slice(0, 16);

const entryKey = (scope: WebSearchResultScope, toolUseId: string): string =>
  `${scope.credential}:${toolUseId}`;

const addressOf = (scope: WebSearchResultScope): SessionAddress => ({
  store: STORE_NAME,
  scope: scope.callerScope,
  session: scope.session,
});

/** Store over the `SessionState` backend of the current request (Durable Object, or the per-isolate fallback). */
export const makeSessionStateWebSearchResultStore = (
  backend: BackendResolver = resolveBackend(),
): WebSearchResultStore => ({
  load: (scope, ids) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, Json>())
      : bestEffort(
          "claude web search results get",
          new Map<string, Json>(),
          Effect.gen(function* () {
            const state = yield* backend;

            const ops: StateOp[] = ids.map((id) => ({
              op: "get",
              key: entryKey(scope, id),
              extendTtlMs: TTL_MS,
            }));

            const results = yield* state.run(addressOf(scope), ops);
            const found = new Map<string, Json>();

            ids.forEach((id, index) => {
              const result = results[index];

              if (result?.status !== "ok" || result.value === undefined) return;
              const content = tryParseJson(result.value);

              if (content !== undefined && !contentIsEmpty(content)) found.set(id, content);
            });

            return found;
          }),
        ),
  save: (scope, results) =>
    results.length === 0
      ? Effect.void
      : bestEffort(
          "claude web search results put",
          undefined,
          Effect.gen(function* () {
            const state = yield* backend;

            const ops: StateOp[] = results.map(({ id, content }) => ({
              op: "put",
              key: entryKey(scope, id),
              value: JSON.stringify(content),
              ttlMs: TTL_MS,
              maxEntries: MAX_ENTRIES,
            }));

            yield* state.run(addressOf(scope), ops);
          }),
        ),
});

/** In-memory store for tests. */
export const makeMemoryWebSearchResultStore = (now?: () => number): WebSearchResultStore =>
  makeSessionStateWebSearchResultStore(fixedBackend(makeMemoryBackend(now)));

/** `claudeWebSearchResultContentEmpty`. */
const contentIsEmpty = (content: Json | undefined): boolean =>
  content === undefined || content === null || (isJsonArray(content) && content.length === 0);

/** The `web_search_tool_result` of a Claude content block, when it carries content. */
const resultOfBlock = (block: Json | undefined): WebSearchResult | undefined => {
  if (str(get(block, "type")) !== "web_search_tool_result") return undefined;
  const content = get(block, "content");
  const id = str(get(block, "tool_use_id")).trim();

  return id === "" || content === undefined || contentIsEmpty(content)
    ? undefined
    : { id, content };
};

/**
 * Collects the `web_search_tool_result` blocks of a Claude response (`RecordClaudeWebSearchResults`): a complete Messages
 * body ({@link observeMessage}) or SSE lines, where the result block arrives whole in its `content_block_start`
 * ({@link observeLine}).
 */
export class WebSearchResultCollector {
  readonly results: WebSearchResult[] = [];

  observeLine(line: string): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:") || !trimmed.includes('"web_search_tool_result"')) return;
    const event = tryParseJson(trimmed.slice(5).trim());

    if (str(get(event, "type")) !== "content_block_start") return;
    this.#add(resultOfBlock(get(event, "content_block")));
  }

  observeMessage(message: Json | undefined): void {
    const content = get(message, "content");

    if (!isJsonArray(content)) return;

    for (const block of content) this.#add(resultOfBlock(block));
  }

  #add(result: WebSearchResult | undefined): void {
    if (result !== undefined) this.results.push(result);
  }
}
