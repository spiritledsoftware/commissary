/**
 * Advisor block ownership: which credential minted each advisor `tool_use_id`, so a conversation that moves to another
 * credential sends none of the first one's encrypted advisor state (Anthropic rejects it).
 *
 * Go source: internal/runtime/executor/helps/claude_advisor_state.go (`ClaudeAdvisorOwnerStore`,
 * `ClaudeAdvisorRequestState`, `StripForeignAdvisorBlocksDoc`), claude_executor.go (`claudeAdvisorCredentialOwner`,
 * `stripForeignClaudeAdvisorBlocksDoc`); CLIProxyAPI 91a3f455.
 *
 * Differences from Go (ARCHITECTURE.md, "Claude provider"):
 *  - The owners live in the `SessionState` Durable Object (one instance per org, caller and provider) instead of
 *    process memory backed by an optional KV; first-writer-wins is a compare-and-swap on an absent key.
 *  - Every lookup slides the 24 h expiry; Go refreshes its KV expiry at most once an hour.
 *  - The owner is a hash of the credential id (Go: `id:<auth id>`, or the hashed API key).
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
  type SessionAddress,
} from "@commissary/state";
import type { CredentialSnapshot } from "../picker.ts";

/** The SessionState store of advisor owners (the org suites write and wipe it). */
export const ADVISOR_OWNER_STORE = "claude-advisor-owner";

/** `ClaudeAdvisorOwnerTTL`, sliding. */
const OWNER_TTL_MS = 24 * 60 * 60 * 1000;

/** `claudeAdvisorOwnerLimit`. */
const OWNER_LIMIT = 4096;

/** Where a caller's advisor owners live: one instance per caller and provider (`claude`, `kimi`). */
export interface AdvisorOwnerScope {
  readonly callerScope: string;
  readonly provider: string;
}

export interface AdvisorOwnerStore {
  /** The recorded owners of `ids` (absent = unknown); a hit slides its expiry. A backend failure knows none. */
  readonly lookup: (
    scope: AdvisorOwnerScope,
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string>>;
  /** Records `owner` for each id not owned yet (first writer wins). */
  readonly remember: (
    scope: AdvisorOwnerScope,
    ids: ReadonlyArray<string>,
    owner: string,
  ) => Effect.Effect<void>;
}

const addressOf = (scope: AdvisorOwnerScope): SessionAddress => ({
  store: ADVISOR_OWNER_STORE,
  scope: scope.callerScope,
  session: scope.provider,
});

/** Store over the `SessionState` backend of the current request (Durable Object, or the per-isolate fallback). */
export const makeSessionStateAdvisorOwnerStore = (
  backend: BackendResolver = resolveBackend(),
): AdvisorOwnerStore => ({
  lookup: (scope, ids) =>
    ids.length === 0
      ? Effect.succeed(new Map())
      : bestEffort(
          "claude advisor owners",
          new Map<string, string>(),
          Effect.gen(function* () {
            const state = yield* backend;

            const results = yield* state.run(
              addressOf(scope),
              ids.map((key) => ({ op: "get", key, extendTtlMs: OWNER_TTL_MS })),
            );

            const owners = new Map<string, string>();

            ids.forEach((id, index) => {
              const result = results[index];
              const owner = result?.status === "ok" ? (result.value ?? "").trim() : "";

              if (owner !== "") owners.set(id, owner);
            });

            return owners;
          }),
        ),
  remember: (scope, ids, owner) =>
    ids.length === 0 || owner === ""
      ? Effect.void
      : bestEffort(
          "claude advisor owners",
          undefined,
          Effect.gen(function* () {
            const state = yield* backend;

            // `ifGeneration: 0` writes only an absent key: an earlier owner keeps the id.
            yield* state.run(
              addressOf(scope),
              ids.map((key) => ({
                op: "put",
                key,
                value: owner,
                ttlMs: OWNER_TTL_MS,
                ifGeneration: 0,
                maxEntries: OWNER_LIMIT,
              })),
            );
          }),
        ),
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryAdvisorOwnerStore = (now?: () => number): AdvisorOwnerStore =>
  makeSessionStateAdvisorOwnerStore(fixedBackend(makeMemoryBackend(now)));

/** `claudeAdvisorCredentialOwner`: the credential that minted an advisor block (empty without an id). */
export const advisorCredentialOwner = (credential: CredentialSnapshot): string =>
  credential.id.trim() === ""
    ? ""
    : `id:${createHash("sha256").update(credential.id.trim()).digest("hex").slice(0, 32)}`;

const isAdvisorResultType = (type: string): boolean =>
  type === "advisor_tool_result" || type === "advisor_redacted_result";

/** `claudeToolResultContainsAdvisorRedacted`. */
const toolResultContainsAdvisorRedacted = (inner: Json | undefined): boolean => {
  if (isObj(inner)) return str(inner.type) === "advisor_redacted_result";

  return (
    isArr(inner) &&
    inner.some((sub) => str(isObj(sub) ? sub.type : "") === "advisor_redacted_result")
  );
};

/** `claudeAdvisorBlockID`: the advisor `tool_use_id` a content block carries (empty for other blocks). */
export const advisorBlockId = (block: Json | undefined): string => {
  if (!isObj(block)) return "";
  const type = str(block.type);

  if (type === "server_tool_use") return str(block.name) === "advisor" ? str(block.id).trim() : "";

  if (isAdvisorResultType(type)) return str(block.tool_use_id).trim();

  if (type === "tool_result" && toolResultContainsAdvisorRedacted(block.content))
    return str(block.tool_use_id).trim();

  return "";
};

/** The advisor ids of a message's content: blocks of an array, or a single advisor result object. */
const contentAdvisorIds = (content: Json | undefined): string[] => {
  if (isArr(content)) return content.map(advisorBlockId).filter((id) => id !== "");

  if (isObj(content) && isAdvisorResultType(str(content.type))) {
    const id = str(content.tool_use_id).trim();

    return id === "" ? [] : [id];
  }

  return [];
};

/** Every advisor id of `body.messages`, in order and without duplicates (`claudeMessagesContainAdvisorState`). */
export const advisorIdsOf = (body: JsonObject): string[] => {
  if (!isArr(body.messages)) return [];
  const ids = new Set<string>();

  for (const message of body.messages)
    for (const id of contentAdvisorIds(isObj(message) ? message.content : undefined)) ids.add(id);

  return [...ids];
};

/**
 * `ClaudeAdvisorRequestState`: the request's advisor ids no credential owns yet, committed to this credential once the
 * upstream accepts the request, plus the ids its response mints.
 */
export class AdvisorRequestState {
  readonly scope: AdvisorOwnerScope;
  readonly owner: string;
  #unknownIds: string[];
  #accepted = false;
  readonly #minted = new Set<string>();

  constructor(scope: AdvisorOwnerScope, owner: string, unknownIds: ReadonlyArray<string>) {
    this.scope = scope;
    this.owner = owner;
    this.#unknownIds = [...unknownIds];
  }

  /**
   * `FilterUnknownIDsFromFinalBody`: keeps only the unknown ids still in the final body's messages (payload rules may
   * have removed some).
   */
  filterUnknownIds(body: JsonObject): void {
    if (this.#unknownIds.length === 0) return;
    const present = new Set(advisorIdsOf(body));
    this.#unknownIds = this.#unknownIds.filter((id) => present.has(id));
  }

  /** `RecordAccepted`. */
  recordAccepted(): void {
    if (this.#accepted) return;
    this.#accepted = true;

    for (const id of this.#unknownIds) this.#minted.add(id);
  }

  /** `RecordResponseJSON`: the advisor blocks of a whole Messages response. */
  recordResponse(message: Json | undefined): void {
    const content = isObj(message) ? message.content : undefined;

    if (!isArr(content)) return;

    for (const block of content) {
      const id = advisorBlockId(block);

      if (id !== "") this.#minted.add(id);
    }
  }

  /** `ObserveSSELine`: `message_start` accepts the request, `content_block_start` may mint an advisor block. */
  observeLine(line: string): void {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();

    if (!payload.includes("content_block_start") && !payload.includes("message_start")) return;
    const event = tryParseJson(payload);

    if (!isObj(event)) return;
    const type = str(event.type);

    if (type === "message_start") this.recordAccepted();
    else if (type === "content_block_start") {
      const id = advisorBlockId(event.content_block);

      if (id !== "") this.#minted.add(id);
    }
  }

  /** `RecordResponseSSE`. */
  recordStream(data: string): void {
    for (const line of data.split("\n")) this.observeLine(line);
  }

  /** The ids to record as this credential's. */
  get owned(): string[] {
    return [...this.#minted];
  }
}

export interface StripResult {
  /** Advisor blocks removed or emptied. */
  readonly stripped: number;
  /** Advisor ids no credential owns yet, in order. */
  readonly unknownIds: string[];
}

/**
 * `StripForeignAdvisorBlocksDoc`: removes from `body.messages`, in place, the advisor blocks another credential owns,
 * and the messages left empty by it. A foreign advisor result inside an ordinary `tool_result` (its `tool_use` is a
 * client tool) is emptied instead, so the pair stays valid. Returns the number of stripped blocks and the ids no
 * credential owns yet.
 */
export const stripForeignAdvisorBlocks = (
  body: JsonObject,
  owners: ReadonlyMap<string, string>,
  owner: string,
): StripResult => {
  const unknownIds: string[] = [];

  if (!isArr(body.messages)) return { stripped: 0, unknownIds };
  const { messages } = body;
  const ordinaryToolUseIds = new Set<string>();

  for (const message of messages) {
    const content = isObj(message) ? message.content : undefined;

    if (!isArr(content)) continue;

    for (const block of content) {
      if (isObj(block) && str(block.type) === "tool_use") {
        const id = str(block.id).trim();

        if (id !== "") ordinaryToolUseIds.add(id);
      }
    }
  }

  const isForeign = (id: string): boolean => {
    if (id === "") return false;
    const recorded = owners.get(id);

    if (recorded === undefined) {
      if (!unknownIds.includes(id)) unknownIds.push(id);

      return false;
    }

    return recorded !== owner;
  };

  let stripped = 0;
  const droppedMessages = new Set<number>();

  messages.forEach((message, index) => {
    if (!isObj(message)) return;
    const { content } = message;

    if (isObj(content)) {
      if (isAdvisorResultType(str(content.type)) && isForeign(str(content.tool_use_id).trim())) {
        droppedMessages.add(index);
        stripped++;
      }

      return;
    }

    if (!isArr(content)) return;
    const droppedParts = new Set<number>();

    content.forEach((block, part) => {
      if (!isObj(block)) return;
      const type = str(block.type);

      if (type === "server_tool_use") {
        if (str(block.name) === "advisor" && isForeign(str(block.id).trim())) {
          droppedParts.add(part);
          stripped++;
        }

        return;
      }

      if (isAdvisorResultType(type)) {
        if (isForeign(str(block.tool_use_id).trim())) {
          droppedParts.add(part);
          stripped++;
        }

        return;
      }

      if (type !== "tool_result") return;
      const inner = block.content;
      const id = str(block.tool_use_id).trim();

      if (isObj(inner)) {
        if (str(inner.type) !== "advisor_redacted_result" || !isForeign(id)) return;

        if (ordinaryToolUseIds.has(id)) block.content = "";
        else droppedParts.add(part);
        stripped++;

        return;
      }

      if (!isArr(inner)) return;

      const advisorItems = inner.filter(
        (sub) => str(isObj(sub) ? sub.type : "") === "advisor_redacted_result",
      );

      if (advisorItems.length === 0 || !isForeign(id)) return;

      if (!ordinaryToolUseIds.has(id)) {
        // The paired advisor `server_tool_use` goes in the same pass: drop the whole result, no dangling reference.
        droppedParts.add(part);
        stripped++;
      } else if (advisorItems.length < inner.length) {
        block.content = inner.filter((sub) => !advisorItems.includes(sub));
        stripped += advisorItems.length;
      } else {
        block.content = "";
        stripped += advisorItems.length;
      }
    });

    if (droppedParts.size === 0) return;

    if (droppedParts.size === content.length) droppedMessages.add(index);
    else message.content = content.filter((_, part) => !droppedParts.has(part));
  });

  if (droppedMessages.size > 0)
    body.messages = messages.filter((_, index) => !droppedMessages.has(index));

  return { stripped, unknownIds };
};

/**
 * `stripForeignClaudeAdvisorBlocksDoc`: looks up the owners of the request's advisor blocks, strips the foreign ones
 * and returns the request's state (undefined for a credential without an id).
 */
export const prepareAdvisorState = (
  store: AdvisorOwnerStore,
  scope: AdvisorOwnerScope,
  credential: CredentialSnapshot,
  body: JsonObject,
): Effect.Effect<AdvisorRequestState | undefined> =>
  Effect.gen(function* () {
    const owner = advisorCredentialOwner(credential);

    if (owner === "") return undefined;
    const ids = advisorIdsOf(body);

    if (ids.length === 0) return new AdvisorRequestState(scope, owner, []);
    const owners = yield* store.lookup(scope, ids);
    const { stripped, unknownIds } = stripForeignAdvisorBlocks(body, owners, owner);

    if (stripped > 0)
      yield* Effect.logDebug(
        `claude executor: stripped ${stripped} foreign advisor blocks before upstream`,
      );

    return new AdvisorRequestState(scope, owner, unknownIds);
  });

/** Records what `state` saw as its credential's (`RecordAccepted` and the response's minted blocks). */
export const commitAdvisorOwners = (
  store: AdvisorOwnerStore,
  state: AdvisorRequestState | undefined,
): Effect.Effect<void> =>
  state === undefined ? Effect.void : store.remember(state.scope, state.owned, state.owner);
