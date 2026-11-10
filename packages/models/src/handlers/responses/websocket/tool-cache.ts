/**
 * Tool-call repair for replayed Responses WebSocket input: orphaned `function_call_output` / `function_call` items are
 * re-attached from per-session caches (upstream rejects transcripts with missing calls or outputs).
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket_toolcall_repair.go (websocketToolOutputCache,
 * responsesWebsocketToolCacheTurn, websocketDownstreamSessionKey, prepareResponsesWebsocketFallbackTurn,
 * repairResponsesToolCallItems, recordResponsesWebsocketToolCallsFromPayload) and the call-tracking helpers of
 * openai_responses_websocket_forward.go (isCompleteResponsesWebsocketToolCall).
 *
 * Caches are per isolate (a live socket keeps its isolate), keyed by caller scope + the client's session key
 * (`X-Client-Request-Id`, the `session_id` of `X-Codex-Turn-Metadata`, `Session-Id`), at most 256 entries per
 * session; a session's caches are dropped when the last socket that retained it closes. Nothing is shared between
 * callers. Go's 30 minute TTL constant is disabled in the Go code itself (ttl 0), so there is none here either.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
  tryParseJson,
} from "@commissary/json";
import {
  dedupeInputItems,
  isToolCallOutputType,
  isToolCallType,
  stripReplayOutputOnlyFields,
  toInputItem,
} from "./normalize.ts";

const MAX_PER_SESSION = 256;

class ToolItemCache {
  private readonly sessions = new Map<string, { items: Map<string, Json>; order: string[] }>();

  record(sessionKey: string, callId: string, item: Json): void {
    const key = sessionKey.trim();
    const id = callId.trim();

    if (key === "" || id === "") return;
    let session = this.sessions.get(key);

    if (session === undefined) {
      session = { items: new Map(), order: [] };
      this.sessions.set(key, session);
    }

    if (!session.items.has(id)) session.order.push(id);
    session.items.set(id, cloneJson(item));

    while (session.order.length > MAX_PER_SESSION) {
      const evict = session.order.shift();

      if (evict !== undefined) session.items.delete(evict);
    }
  }

  get(sessionKey: string, callId: string): Json | undefined {
    const item = this.sessions.get(sessionKey.trim())?.items.get(callId.trim());

    return item === undefined ? undefined : cloneJson(item);
  }

  deleteSession(sessionKey: string): void {
    this.sessions.delete(sessionKey.trim());
  }
}

/** The caches of one isolate; tests construct their own. */
export class ToolCaches {
  readonly outputs = new ToolItemCache();
  readonly calls = new ToolItemCache();
  private readonly refs = new Map<string, number>();

  /** `retainResponsesWebsocketToolCaches`. */
  retain(sessionKey: string): void {
    const key = sessionKey.trim();

    if (key !== "") this.refs.set(key, (this.refs.get(key) ?? 0) + 1);
  }

  /** `releaseResponsesWebsocketToolCaches`: the caches go with the last socket of the session. */
  release(sessionKey: string): void {
    const key = sessionKey.trim();

    if (key === "") return;
    const next = (this.refs.get(key) ?? 0) - 1;

    if (next > 0) {
      this.refs.set(key, next);

      return;
    }

    this.refs.delete(key);
    this.outputs.deleteSession(key);
    this.calls.deleteSession(key);
  }
}

export const defaultToolCaches = new ToolCaches();

/** `isCompleteResponsesWebsocketToolCall`. */
export const isCompleteToolCall = (item: Json | undefined): item is JsonObject => {
  if (!isJsonObject(item)) return false;
  const callId = item["call_id"];
  const name = item["name"];

  if (
    typeof callId !== "string" ||
    callId.trim() === "" ||
    typeof name !== "string" ||
    name.trim() === ""
  )
    return false;

  switch (asString(item["type"]).trim()) {
    case "function_call":
      return typeof item["arguments"] === "string";
    case "custom_tool_call":
      return typeof item["input"] === "string";
    default:
      return false;
  }
};

/**
 * `websocketDownstreamSessionKey`: the client's own session marker, scoped to the caller so two callers can never share
 * cached tool items by reusing an id. Empty = no repair caching.
 */
export const downstreamSessionKey = (headers: Headers, callerScope: string): string => {
  const read = (name: string) => (headers.get(name) ?? "").trim();
  let key = read("x-client-request-id");

  if (key === "") {
    const metadata = read("x-codex-turn-metadata");

    if (metadata !== "") key = asString(get(tryParseJson(metadata), "session_id")).trim();
  }

  if (key === "") key = read("session-id");

  if (key === "") key = read("session_id");

  return key === "" ? "" : `${callerScope}\u0000${key}`;
};

/** `responsesWebsocketToolCacheTurn`: items seen during a turn, committed only when the turn succeeds. */
export class ToolCacheTurn {
  private readonly outputs = new Map<string, Json>();
  private readonly calls = new Map<string, Json>();

  constructor(
    readonly sessionKey: string,
    private readonly caches: ToolCaches,
  ) {}

  recordRawItem(itemType: string, callId: string, item: Json): void {
    const id = callId.trim();

    if (id === "" || (!isToolCallOutputType(itemType) && !isToolCallType(itemType))) return;
    (isToolCallOutputType(itemType) ? this.outputs : this.calls).set(id, cloneJson(item));
  }

  recordInputItem(item: {
    readonly raw: Json;
    readonly itemType: string;
    readonly callId: string;
  }): void {
    this.recordRawItem(item.itemType, item.callId, item.raw);
  }

  /** `recordResponse`: complete tool calls of a response event (upstream output: its replay-unsafe fields are dropped). */
  recordResponse(payload: Json): void {
    for (const item of toolCallsOfPayload(payload).map(stripReplayOutputOnlyFields))
      this.recordRawItem(asString(item["type"]), asString(item["call_id"]), item);
  }

  commit(): void {
    for (const [callId, item] of this.outputs)
      this.caches.outputs.record(this.sessionKey, callId, item);

    for (const [callId, item] of this.calls)
      this.caches.calls.record(this.sessionKey, callId, item);
  }
}

const toolCallsOfPayload = (payload: Json): JsonObject[] => {
  switch (asString(get(payload, "type")).trim()) {
    case "response.completed": {
      const output = get(payload, "response.output");

      return isJsonArray(output) ? output.filter(isCompleteToolCall) : [];
    }

    case "response.output_item.added":
    case "response.output_item.done": {
      const item = get(payload, "item");

      return isCompleteToolCall(item) ? [item] : [];
    }

    default:
      return [];
  }
};

/** `recordResponsesWebsocketToolCallsFromPayload`: remembers calls outside a transactional turn. */
export const recordToolCallsFromPayload = (
  caches: ToolCaches,
  sessionKey: string,
  payload: Json,
): void => {
  if (sessionKey.trim() === "") return;

  for (const item of toolCallsOfPayload(payload).map(stripReplayOutputOnlyFields))
    caches.calls.record(sessionKey, asString(item["call_id"]), item);
};

/** `repairResponsesToolCallItems`. */
const repairItems = (
  caches: ToolCaches,
  sessionKey: string,
  items: ReadonlyArray<ReturnType<typeof toInputItem>>,
  allowOrphanOutputs: boolean,
  turn: ToolCacheTurn | undefined,
  repairEnabled: boolean,
): Array<ReturnType<typeof toInputItem>> => {
  if (!repairEnabled) return dedupeInputItems(items);
  const outputPresent = new Set<string>();
  const callPresent = new Set<string>();

  for (const item of items) {
    turn?.recordInputItem(item);

    if (item.callId === "") continue;

    if (isToolCallOutputType(item.itemType)) outputPresent.add(item.callId);
    else if (isToolCallType(item.itemType)) callPresent.add(item.callId);
  }

  const filtered: Array<ReturnType<typeof toInputItem>> = [];
  const insertedCalls = new Set<string>();

  for (const item of items) {
    if (isToolCallOutputType(item.itemType)) {
      if (item.callId === "") {
        // Codex sends standalone named results for heartbeat and delegation input.
        const name = get(item.raw, "name");

        if (
          item.itemType === "function_call_output" &&
          typeof name === "string" &&
          name.trim() !== ""
        )
          filtered.push(item);
        continue;
      }

      if (callPresent.has(item.callId) || allowOrphanOutputs) {
        filtered.push(item);
        continue;
      }

      const cached = caches.calls.get(sessionKey, item.callId);

      if (cached !== undefined) {
        if (!insertedCalls.has(item.callId)) {
          filtered.push(toInputItem(cached));
          insertedCalls.add(item.callId);
          callPresent.add(item.callId);
        }

        filtered.push(item);
      }

      // Orphaned outputs without a known call are dropped.
      continue;
    }

    if (!isToolCallType(item.itemType)) {
      filtered.push(item);
      continue;
    }

    if (item.callId === "") continue;

    if (outputPresent.has(item.callId) || allowOrphanOutputs) {
      filtered.push(item);
      continue;
    }

    const cached = caches.outputs.get(sessionKey, item.callId);

    if (cached !== undefined) {
      filtered.push(item, toInputItem(cached));
      outputPresent.add(item.callId);
    }
    // Orphaned calls without a known output are dropped.
  }

  return dedupeInputItems(filtered);
};

export interface FallbackTurn {
  readonly request: JsonObject;
  readonly turn: ToolCacheTurn | undefined;
}

/**
 * `prepareResponsesWebsocketFallbackTurn`: repairs `request.input` against the session caches and returns the turn that
 * records this request's items. The request is returned unchanged when nothing needs repair.
 */
export const prepareFallbackTurn = (
  caches: ToolCaches,
  sessionKey: string,
  request: JsonObject,
): FallbackTurn => {
  const key = sessionKey.trim();
  const turn = key === "" ? undefined : new ToolCacheTurn(key, caches);
  const input = request["input"];

  if (!isJsonArray(input)) return { request, turn };
  const items = input.map(toInputItem);
  const repairEnabled = key !== "";
  const previous = asString(request["previous_response_id"]).trim() !== "";
  const updated = repairItems(caches, key, items, repairEnabled && previous, turn, repairEnabled);

  const unchanged =
    updated.length === items.length &&
    updated.every((item, index) => item.raw === items[index]?.raw);

  return {
    request: unchanged ? request : { ...request, input: updated.map((item) => item.raw) },
    turn,
  };
};
