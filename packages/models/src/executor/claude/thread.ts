/**
 * Claude Thread continuation: the MCP tool-name aliases of a conversation turn are remembered per upstream message so
 * that `thread.type = "continue"` requests without `tools` can restore the aliased names in the response.
 *
 * Go source: internal/runtime/executor/claude_executor_tool_state.go (`claudeOAuthToolAliasStore`,
 * `claudeOAuthToolAliasKeys`, `claudeThreadContinuationNeedsAliasState`, `prepareClaudeOAuthToolNamesForRequest`,
 * `rememberClaudeOAuthToolAliases`, `claudeThreadNotFoundError`). Go keeps the aliases in executor memory (1024
 * entries, oldest evicted); here they live in the `SessionState` Durable Object, one instance per caller scope with the
 * same 1024-entry bound, and expire after 7 days.
 *
 * A Thread's `Anthropic-Beta` profile (CLIProxyAPI 02ec93d0, `helps/claude_thread.go`): the record of each accepted
 * message also keeps the betas sent with it and the credential that sent them, and a `continue` turn on the same
 * credential sends that snapshot again (plus any beta its own body requires), so a Thread keeps the capabilities it
 * started with. Narrower than Go (ARCHITECTURE.md, "Claude provider"): no policy fingerprint or 409 conflict, an unknown
 * profile sends the turn's own betas, no credential pinning beyond session affinity, and a stream's end is not held
 * back until `message_stop`.
 */
import { Effect } from "effect";
import { get, type JsonObject, tryParseJson } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import {
  type BackendResolver,
  bestEffort,
  fixedBackend,
  makeMemoryBackend,
  resolveBackend,
  type SessionAddress,
  type StateOp,
} from "@commissary/state";
import { ExecutionError } from "../errors.ts";
import {
  BETA,
  hasAdvisorTool,
  withAdvisorToolBeta,
  withExtendedCacheTTLBeta,
  withThinkingBindingBeta,
} from "./betas.ts";
import { payloadHas1hTTL } from "./cache-control.ts";

const STORE_NAME = "claude-tool-aliases";

const ENTRY_LIMIT = 1024;

const TTL_MS = 7 * 24 * 3_600_000;

export const THREAD_NOT_FOUND_MESSAGE =
  "No thread state was found for the requested previous_message_id. Replay the full conversation with thread create to start a new Thread.";

/** `newClaudeThreadNotFoundError`: a request-scoped 404 with Anthropic's error body. */
export const threadNotFoundError = (): ExecutionError =>
  new ExecutionError({
    status: 404,
    message: JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: THREAD_NOT_FOUND_MESSAGE },
    }),
    requestScoped: true,
    direct: true,
  });

/** `claudeOAuthToolAliasKeys`: the previous message and (once known) the new message of the thread. */
export const threadAliasKeys = (body: JsonObject, messageId: string): string[] => {
  const keys: string[] = [];
  const previous = str(isObj(body.thread) ? body.thread.previous_message_id : undefined);

  if (previous !== "") keys.push(`message:${previous}`);

  if (messageId !== "") keys.push(`message:${messageId}`);

  return keys;
};

/** `claudeThreadContinuationNeedsAliasState`: a `continue` turn that sends no tool definitions itself. */
export const threadContinuationNeedsAliasState = (body: JsonObject): boolean => {
  const thread = body.thread;

  if (!isObj(thread) || str(thread.type) !== "continue") return false;
  const previous = thread.previous_message_id;

  if (previous === undefined || str(previous) === "") return false;

  return !isArr(body.tools) || body.tools.length === 0;
};

/** The `Anthropic-Beta` header an accepted Thread message was sent with, and the credential (a hash) that sent it. */
export interface ThreadBetaProfile {
  readonly betas: string;
  readonly credential: string;
}

/** The previous message of a `thread.type = "continue"` turn (empty otherwise). */
export const threadContinuationOf = (body: JsonObject): string => {
  const thread = body.thread;

  return isObj(thread) && str(thread.type) === "continue"
    ? str(thread.previous_message_id).trim()
    : "";
};

const withBeta = (betas: string, beta: string): string =>
  betas
    .split(",")
    .map((part) => part.trim())
    .includes(beta)
    ? betas
    : [betas, beta].filter((part) => part.trim() !== "").join(",");

/**
 * The snapshot replayed for a continuation, with the betas this turn's final body cannot go without (Go answers 409
 * instead): fast mode, the advisor tool, the binding controls and the 1 h cache TTL.
 */
export const replayThreadBetas = (snapshot: string, body: JsonObject): string => {
  let betas = snapshot;

  if (str(body.speed).trim().toLowerCase() === "fast") betas = withBeta(betas, BETA.fastMode);

  if (hasAdvisorTool(body)) betas = withAdvisorToolBeta(betas);

  if (get(body, "thinking.block_binding") !== undefined) betas = withThinkingBindingBeta(betas);

  if (payloadHas1hTTL(body)) betas = withExtendedCacheTTLBeta(betas);

  return betas;
};

export interface ToolAliasStore {
  /** The aliases saved for the first of `keys` that exists (`alias -> client tool name`). */
  readonly load: (
    callerScope: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, string> | undefined>;
  /** The beta profile saved for `message:<messageId>`, if any. */
  readonly loadBetas: (
    callerScope: string,
    messageId: string,
  ) => Effect.Effect<ThreadBetaProfile | undefined>;
  readonly save: (
    callerScope: string,
    keys: ReadonlyArray<string>,
    aliases: ReadonlyMap<string, string>,
    profile?: ThreadBetaProfile,
  ) => Effect.Effect<void>;
}

const addressOf = (callerScope: string): SessionAddress => ({
  store: STORE_NAME,
  scope: callerScope,
  session: "state",
});

interface ThreadRecord {
  readonly aliases: ReadonlyMap<string, string>;
  readonly profile: ThreadBetaProfile | undefined;
}

const stringEntries = (value: JsonObject): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

/** A record is `{ aliases, betas?, credential? }`; one written before the beta profiles is the bare alias map. */
const parseRecord = (text: string | undefined): ThreadRecord | undefined => {
  if (text === undefined) return undefined;
  const parsed = tryParseJson(text);

  if (!isObj(parsed)) return undefined;

  if (!isObj(parsed.aliases)) return { aliases: stringEntries(parsed), profile: undefined };
  const { betas, credential } = parsed;

  return {
    aliases: stringEntries(parsed.aliases),
    profile:
      typeof betas === "string" && typeof credential === "string"
        ? { betas, credential }
        : undefined,
  };
};

export const makeSessionStateToolAliasStore = (
  backend: BackendResolver = resolveBackend(),
): ToolAliasStore => ({
  load: (callerScope, keys) =>
    keys.length === 0
      ? Effect.succeed(undefined)
      : bestEffort(
          "claude tool alias load",
          undefined,
          Effect.gen(function* () {
            const ops: StateOp[] = keys.map((key) => ({ op: "get", key }));
            const results = yield* (yield* backend).run(addressOf(callerScope), ops);

            for (const result of results) {
              if (result.status !== "ok" || result.value === undefined) continue;
              const record = parseRecord(result.value);

              if (record !== undefined) return record.aliases;
            }

            return undefined;
          }),
        ),
  loadBetas: (callerScope, messageId) =>
    messageId === ""
      ? Effect.succeed(undefined)
      : bestEffort(
          "claude thread beta load",
          undefined,
          Effect.gen(function* () {
            const [result] = yield* (yield* backend).run(addressOf(callerScope), [
              { op: "get", key: `message:${messageId}` },
            ]);

            return result?.status === "ok" ? parseRecord(result.value)?.profile : undefined;
          }),
        ),
  save: (callerScope, keys, aliases, profile) => {
    const targets = keys.filter((key) => key !== "");

    if (targets.length === 0) return Effect.void;
    const value = JSON.stringify({ aliases: Object.fromEntries(aliases), ...profile });

    return bestEffort(
      "claude tool alias save",
      undefined,
      Effect.gen(function* () {
        const ops: StateOp[] = targets.map((key) => ({
          op: "put",
          key,
          value,
          ttlMs: TTL_MS,
          maxEntries: ENTRY_LIMIT,
        }));

        yield* (yield* backend).run(addressOf(callerScope), ops);
      }),
    );
  },
});

/** In-memory store for tests (`now` is injectable). */
export const makeMemoryToolAliasStore = (now?: () => number): ToolAliasStore =>
  makeSessionStateToolAliasStore(fixedBackend(makeMemoryBackend(now)));
