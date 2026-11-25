/**
 * xAI Responses WebSocket id state: maps the response ids the downstream client holds to the ids of the upstream
 * socket and keeps the transcript needed to continue a conversation on a new upstream connection.
 *
 * Go source: internal/runtime/executor/xai_websockets_executor.go (xaiWebsocketIDState, xaiWebsocketRequestIDMapper,
 * rewriteXAIWebsocketDownstreamIDs). When the upstream target (credential or URL) changes, `previous_response_id` is
 * dropped and the recorded transcript is prepended to `input` ("replay"); downstream ids that would repeat an upstream
 * id get a `-xai-<seq>` suffix. A turn is recorded with its `input` from before the payload rules (`recordTranscriptTurn`'s
 * input snapshot, CLIProxyAPI b4410dd5). State lives per isolate, keyed by the downstream socket id (the socket keeps its
 * isolate alive), and is released with the execution session.
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

/** Process-wide (per isolate) id states, like Go's `globalXAIWebsocketIDStates`. */
export class XaiIdStateStore {
  private readonly states = new Map<string, XaiIdState>();

  get(sessionId: string): XaiIdState | undefined {
    const id = sessionId.trim();

    if (id === "") return undefined;
    let state = this.states.get(id);

    if (state === undefined) {
      state = new XaiIdState();
      this.states.set(id, state);
    }

    return state;
  }

  delete(sessionId: string): void {
    this.states.delete(sessionId.trim());
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
