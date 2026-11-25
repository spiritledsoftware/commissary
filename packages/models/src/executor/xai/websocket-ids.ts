/**
 * xAI Responses WebSocket id state: maps the response ids the downstream client holds to the ids of the upstream
 * socket and keeps the transcript needed to continue a conversation on a new upstream connection.
 *
 * Go source: internal/runtime/executor/xai_websockets_executor.go (xaiWebsocketIDState, xaiWebsocketRequestIDMapper,
 * rewriteXAIWebsocketDownstreamIDs). When the upstream target (credential or URL) changes, `previous_response_id` is
 * dropped and the recorded transcript is prepended to `input` ("replay"); downstream ids that would repeat an upstream
 * id get a `-xai-<seq>` suffix. A turn is recorded with its `input` from before the payload rules (`recordTranscriptTurn`'s
 * input snapshot, CLIProxyAPI b4410dd5). State lives per isolate, keyed by the downstream socket id (the socket keeps its
 * isolate alive), and is released with the execution session or after 24 h idle (Go 679166b8). Every state belongs to a
 * downstream socket, so Go's eviction of ephemeral states (a turn without an execution session) has no counterpart.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";

interface TranscriptReset {
  readonly payload: JsonObject;
  readonly replayed: boolean;
}

export class XaiIdState {
  readonly downstreamToUpstream = new Map<string, string>();
  sequence = 0;
  transcriptInput: Json[] = [];
  replayCompactedTranscriptOnReset = false;

  upstreamIdForDownstream(downstreamId: string): string {
    const id = downstreamId.trim();

    if (id === "") return id;

    return (this.downstreamToUpstream.get(id) ?? id).trim();
  }

  mapDownstreamToUpstream(downstreamId: string, upstreamId: string): void {
    const id = downstreamId.trim();

    if (id !== "") this.downstreamToUpstream.set(id, upstreamId.trim());
  }

  /** `snapshotTranscriptInput`: a copy of the recorded transcript. */
  snapshotTranscriptInput(): Json[] {
    return cloneJson(this.transcriptInput);
  }

  /** `replaceTranscriptWithItems`: after a compaction the transcript is the compacted state alone. */
  replaceTranscriptWithItems(...items: Json[]): void {
    this.transcriptInput = items.map((item) => cloneJson(item));
    this.replayCompactedTranscriptOnReset = this.transcriptInput.length > 0;
  }

  /** `prependTranscriptInput`: the recorded transcript goes in front of the request's `input`. */
  prependTranscriptInput(payload: JsonObject): JsonObject {
    if (this.transcriptInput.length === 0) return payload;
    const current = isJsonArray(payload["input"]) ? payload["input"] : [];

    return { ...payload, input: [...cloneJson(this.transcriptInput), ...current] };
  }

  /** `prependCompactedTranscriptOnReset`. */
  prependCompactedTranscriptOnReset(payload: JsonObject): TranscriptReset {
    if (!this.replayCompactedTranscriptOnReset || this.transcriptInput.length === 0)
      return { payload, replayed: false };

    return { payload: this.prependTranscriptInput(payload), replayed: true };
  }

  /**
   * `recordTranscriptTurn`: `input` is the request's input before the payload rules (CLIProxyAPI b4410dd5), so a rule
   * is not applied twice, nor accumulates, when the transcript is replayed into a later request.
   */
  recordTranscriptTurn(inputItems: Json | undefined, completed: Json, reset: boolean): void {
    const outputItems = get(completed, "response.output");

    if (reset) {
      this.transcriptInput = [];
      this.replayCompactedTranscriptOnReset = false;
    }

    const input = isJsonArray(inputItems) ? inputItems : [];
    const output = isJsonArray(outputItems) ? outputItems : [];

    if (input.length === 0 && output.length === 0) return;
    this.transcriptInput.push(...cloneJson(input), ...cloneJson(output));
  }
}

/** `defaultXAIWebsocketIDStateIdleTTL` (Go 679166b8): an id state unused this long is dropped. */
export const XAI_ID_STATE_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

interface StoredIdState {
  readonly state: XaiIdState;
  lastUsedMs: number;
  inFlight: number;
}

/**
 * Process-wide (per isolate) id states, like Go's `globalXAIWebsocketIDStates`. A state unused for 24 h with no
 * stream in flight is evicted (Go 679166b8), lazily on the next access: a Worker has no background ticker. Map order is
 * the least recently used first.
 */
export class XaiIdStateStore {
  private readonly states = new Map<string, StoredIdState>();

  /** `evictExpiredLocked`: drops idle states from the least recently used end; one still fresh ends the scan. */
  private evictExpired(nowMs: number): void {
    for (const [id, entry] of this.states) {
      if (nowMs - entry.lastUsedMs < XAI_ID_STATE_IDLE_TTL_MS) break;

      if (entry.inFlight === 0) this.states.delete(id);
    }
  }

  private touch(id: string, entry: StoredIdState, nowMs: number): void {
    entry.lastUsedMs = nowMs;
    this.states.delete(id);
    this.states.set(id, entry);
  }

  /**
   * `getOrCreateLocked`: the session's state (a fresh one after 24 h idle), marked as used now and, with `hold`, in
   * flight until `release`. A blank session id has no state.
   */
  private use(sessionId: string, nowMs: number, hold: boolean): XaiIdState | undefined {
    const id = sessionId.trim();

    if (id === "") return undefined;
    this.evictExpired(nowMs);
    const current = this.states.get(id);

    const entry =
      current !== undefined &&
      (current.inFlight > 0 || nowMs - current.lastUsedMs < XAI_ID_STATE_IDLE_TTL_MS)
        ? current
        : { state: new XaiIdState(), lastUsedMs: nowMs, inFlight: 0 };

    this.touch(id, entry, nowMs);

    if (hold) entry.inFlight++;

    return entry.state;
  }

  get(sessionId: string, nowMs: number): XaiIdState | undefined {
    return this.use(sessionId, nowMs, false);
  }

  /** `acquireXAIWebsocketIDState`: the state, held in flight (never evicted) until `release`. */
  acquire(sessionId: string, nowMs: number): XaiIdState | undefined {
    return this.use(sessionId, nowMs, true);
  }

  /** `releaseXAIWebsocketIDState`: ends one in-flight use of `state`; the state counts as used now. */
  release(state: XaiIdState, nowMs: number): void {
    for (const [id, entry] of this.states) {
      if (entry.state !== state) continue;

      if (entry.inFlight > 0) entry.inFlight--;
      this.touch(id, entry, nowMs);
      break;
    }

    this.evictExpired(nowMs);
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId.trim());
  }

  /** The number of states held (tests). */
  get size(): number {
    return this.states.size;
  }
}

export const xaiIdStates = new XaiIdStateStore();

const rewriteIdString = (
  value: string,
  key: string,
  ids: {
    upstream: string;
    downstream: string;
    upstreamPrevious: string;
    downstreamPrevious: string;
  },
): string => {
  if (key === "id" || key === "item_id") {
    if (
      ids.upstream !== "" &&
      ids.downstream !== "" &&
      ids.downstream !== ids.upstream &&
      value.includes(ids.upstream)
    ) {
      return value.replaceAll(ids.upstream, ids.downstream);
    }
  } else if (key === "previous_response_id") {
    if (
      ids.upstreamPrevious !== "" &&
      ids.downstreamPrevious !== "" &&
      value === ids.upstreamPrevious
    ) {
      return ids.downstreamPrevious;
    }
  }

  return value;
};

const rewriteIds = (
  value: Json,
  ids: {
    upstream: string;
    downstream: string;
    upstreamPrevious: string;
    downstreamPrevious: string;
  },
): boolean => {
  if (isJsonArray(value)) {
    let changed = false;

    for (const child of value) if (rewriteIds(child, ids)) changed = true;

    return changed;
  }

  if (!isJsonObject(value)) return false;
  let changed = false;

  for (const [childKey, child] of Object.entries(value)) {
    if (typeof child === "string") {
      const replaced = rewriteIdString(child, childKey, ids);

      if (replaced !== child) {
        value[childKey] = replaced;
        changed = true;
      }
    } else if (rewriteIds(child, ids)) changed = true;
  }

  return changed;
};

/** One request's view of the id state (Go `xaiWebsocketRequestIDMapper`). */
export class XaiRequestIdMapper {
  readonly downstreamPreviousId: string;
  upstreamPreviousId: string;
  upstreamResponseId = "";
  downstreamResponseId = "";
  replayedCompactedTranscript = false;

  constructor(
    readonly state: XaiIdState,
    downstreamRequest: Json,
  ) {
    this.downstreamPreviousId = asString(get(downstreamRequest, "previous_response_id")).trim();
    this.upstreamPreviousId =
      this.downstreamPreviousId === ""
        ? ""
        : state.upstreamIdForDownstream(this.downstreamPreviousId);
  }

  /** `upstreamRequestPayload`. */
  upstreamRequestPayload(payload: JsonObject): JsonObject {
    if (this.downstreamPreviousId === this.upstreamPreviousId) {
      if (
        this.downstreamPreviousId === "" &&
        asString(payload["type"]).trim() === "response.append"
      ) {
        const out = this.state.prependCompactedTranscriptOnReset(payload);
        this.replayedCompactedTranscript = out.replayed;

        return out.payload;
      }

      return payload;
    }

    if (this.upstreamPreviousId === "") {
      const { previous_response_id: _dropped, ...rest } = payload;

      if (this.downstreamPreviousId === "") return rest;
      this.replayedCompactedTranscript = true;

      return this.state.prependTranscriptInput(rest);
    }

    return { ...payload, previous_response_id: this.upstreamPreviousId };
  }

  /** `downstreamIDForUpstreamResponse`. */
  private downstreamIdFor(upstreamResponseId: string): string {
    const upstream = upstreamResponseId.trim();

    if (this.upstreamResponseId !== "") return this.downstreamResponseId;

    if (upstream === "") return "";
    this.upstreamResponseId = upstream;
    this.downstreamResponseId = upstream;
    const seen = this.state.downstreamToUpstream.has(upstream);

    if (
      (this.downstreamPreviousId !== "" &&
        this.upstreamPreviousId !== "" &&
        upstream === this.upstreamPreviousId) ||
      seen
    ) {
      this.state.sequence += 1;
      this.downstreamResponseId = `${upstream}-xai-${this.state.sequence}`;
    }

    this.state.downstreamToUpstream.set(upstream, upstream);
    this.state.downstreamToUpstream.set(this.downstreamResponseId, upstream);

    return this.downstreamResponseId;
  }

  /** `downstreamResponsePayload`: rewrites response/item ids in an upstream event (in place). */
  downstreamResponsePayload(payload: JsonObject): JsonObject {
    const downstream = this.downstreamIdFor(asString(get(payload, "response.id")));

    if (downstream === "") return payload;

    const ids = {
      upstream: this.upstreamResponseId.trim(),
      downstream: downstream.trim(),
      upstreamPrevious: this.upstreamPreviousId.trim(),
      downstreamPrevious: this.downstreamPreviousId.trim(),
    };

    if (ids.upstream === ids.downstream && ids.upstreamPrevious === ids.downstreamPrevious)
      return payload;
    rewriteIds(payload, ids);

    return payload;
  }
}
