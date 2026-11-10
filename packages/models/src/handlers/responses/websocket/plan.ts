/**
 * Per-socket state and the decision made for each client frame: which normalisation applies, whether the turn is a local
 * warm-up, passes through to the pinned upstream WebSocket or runs over HTTP with a locally rebuilt transcript.
 *
 * Go source: sdk/api/handlers/openai/openai_responses_websocket.go (ResponsesWebsocket main loop: pinned credential,
 * upstream mode, `responsesWebsocketNativePassthroughAllowed`, `responsesWebsocketRequestRequiresCurrentUpstream`,
 * observed compaction, request normalisation branches), openai_responses_websocket_session.go (provider/model keys).
 *
 * Go decides `useUpstreamWebsocketPassthrough` from the global credential list; the Worker has no such list, so the
 * decision uses the credential that served the previous turn (`pinned`): the first turn of a socket is always
 * normalised as a plain create (identical in Go, which requires an established upstream mode for passthrough) and later
 * turns pass through only while the pinned credential has `websockets` enabled. Credential pinning is likewise scoped
 * to WebSocket-capable credentials (Go only pins when the turn ran over the upstream socket) and is dropped when the
 * model changes.
 */
import { Data } from "effect";
import { asString, cloneJson, type Json, type JsonObject } from "@commissary/json";
import { parseSuffix } from "@commissary/translation/thinking";
import {
  inputContainsFullTranscript,
  normalizeCreateRequest,
  normalizePassthroughRequest,
  normalizePrewarmFollowup,
  normalizeRequest,
  normalizeTranscriptReplacement,
  previousResponseNotFoundError,
  REQUEST_TYPE_APPEND,
  REQUEST_TYPE_CREATE,
  shouldHandlePrewarmLocally,
  type WsRequestError,
} from "./normalize.ts";

export type UpstreamMode = "" | "websocket" | "http";

export interface PinnedCredential {
  readonly authId: string;
  readonly provider: string;
  readonly modelKey: string;
}

export interface SocketState {
  /** Normalised previous request (HTTP-mode transcript); `undefined` while the upstream socket keeps the state. */
  lastRequest: JsonObject | undefined;
  lastResponseOutput: Json[];
  lastResponseId: string;
  lastPendingToolCallIds: string[];
  /** Id of a synthetic warm-up that the next request may continue. */
  pendingPrewarmId: string;
  pinned: PinnedCredential | undefined;
  passthroughModelName: string;
  upstreamMode: UpstreamMode;
  /** Credential that owns the upstream socket while `upstreamMode` is `websocket`. */
  upstreamWebsocketAuthId: string;
  /** A completed compaction was observed for this model/credential. */
  observedCompaction: { readonly modelKey: string; readonly authId: string } | undefined;
  /** Provider of the credential that served the previous turn. */
  lastProvider: string;
}

export const newSocketState = (): SocketState => ({
  lastRequest: undefined,
  lastResponseOutput: [],
  lastResponseId: "",
  lastPendingToolCallIds: [],
  pendingPrewarmId: "",
  pinned: undefined,
  passthroughModelName: "",
  upstreamMode: "",
  upstreamWebsocketAuthId: "",
  observedCompaction: undefined,
  lastProvider: "",
});

/** `responsesWebsocketProviderSetForModel` model key: the base model without its `(thinking)` suffix. */
export const modelKeyOf = (modelName: string): string => {
  const base = parseSuffix(modelName.trim()).modelName.trim();

  return base === "" ? modelName.trim() : base;
};

export type Plan = Data.TaggedEnum<{
  error: { readonly error: WsRequestError };
  /** The continuation needs the live upstream socket, which this turn cannot use: the client replays. */
  replay: {};
  prewarm: { readonly request: JsonObject; readonly last: JsonObject };
  execute: {
    readonly request: JsonObject;
    readonly modelName: string;
    readonly nativePassthrough: boolean;
    /** `WithRequiredUpstreamWebsocket`. */
    readonly requiresCurrentUpstream: boolean;
    /** The normalised request: the transcript to remember when the turn runs over HTTP (before tool-call repair). */
    readonly lastRequest: JsonObject | undefined;
    readonly pinnedId: string;
  };
}>;

export const Plan = Data.taggedEnum<Plan>();

const trimmed = (value: Json | undefined): string => asString(value).trim();

/** `responsesWebsocketRequestRequiresCurrentUpstream`. */
export const requiresCurrentUpstream = (payload: JsonObject): boolean =>
  trimmed(payload["previous_response_id"]) !== "" ||
  trimmed(payload["type"]) === REQUEST_TYPE_APPEND;

/**
 * Decides how a frame is executed. Mutates `state` where Go does while planning (pin validation, passthrough model
 * name); everything that depends on the turn's outcome is applied by `commitTurn`.
 */
export const planTurn = (state: SocketState, payload: JsonObject): Plan => {
  const explicitModel = trimmed(payload["model"]);

  const requestModel =
    explicitModel !== ""
      ? explicitModel
      : state.passthroughModelName !== ""
        ? state.passthroughModelName
        : trimmed(state.lastRequest?.["model"]);

  const modelKey = modelKeyOf(requestModel);

  if (state.pinned !== undefined && state.pinned.modelKey !== modelKey) state.pinned = undefined;

  // The pinned credential is only ever a WebSocket-capable one (see module header).
  const useUpstreamWebsocket = state.pinned !== undefined;

  const nativePassthrough =
    state.upstreamMode === "websocket" &&
    useUpstreamWebsocket &&
    state.pinned?.authId !== "" &&
    state.pinned?.authId === state.upstreamWebsocketAuthId;

  const requiresCurrent = requiresCurrentUpstream(payload);

  if (state.upstreamMode === "websocket" && !nativePassthrough && requiresCurrent)
    return Plan.replay();

  if (explicitModel !== "" && !useUpstreamWebsocket) state.passthroughModelName = "";

  const compactionSupported =
    state.observedCompaction !== undefined &&
    state.observedCompaction.modelKey === modelKey &&
    state.observedCompaction.authId === state.upstreamWebsocketAuthId;

  const allowCompactionReplayBypass =
    compactionSupported || (!nativePassthrough && state.lastProvider === "codex");

  const previousResponseId = trimmed(payload["previous_response_id"]);
  const isPrewarm = !useUpstreamWebsocket && shouldHandlePrewarmLocally(payload);
  const rawInput = payload["input"];

  const inputError: WsRequestError = {
    status: 400,
    message: "websocket request requires array field: input",
  };

  let request: JsonObject | undefined;
  let last: JsonObject | undefined;
  let error: WsRequestError | undefined;

  const apply = (result: ReturnType<typeof normalizeRequest>) => {
    if (result.ok) {
      request = result.request;
      last = result.last;
    } else error = result.error;
  };

  if (state.pendingPrewarmId !== "" && previousResponseId !== "") {
    if (previousResponseId !== state.pendingPrewarmId) error = previousResponseNotFoundError();
    else apply(normalizePrewarmFollowup(payload, state.lastRequest ?? {}));
  } else if (isPrewarm && previousResponseId === "") {
    if (rawInput !== undefined && !Array.isArray(rawInput)) error = inputError;
    else apply(normalizeCreateRequest(normalizeTranscriptReplacement(payload, state.lastRequest)));
  } else if (state.pendingPrewarmId !== "" && trimmed(payload["type"]) === REQUEST_TYPE_CREATE) {
    if (rawInput !== undefined && !Array.isArray(rawInput)) error = inputError;
    else apply(normalizeCreateRequest(normalizeTranscriptReplacement(payload, state.lastRequest)));
  } else if (nativePassthrough) {
    const result = normalizePassthroughRequest(payload, requestModel);

    if (result.ok) request = result.request;
    else error = result.error;
  } else if (state.lastRequest === undefined && previousResponseId !== "") {
    error = previousResponseNotFoundError();
  } else {
    apply(
      normalizeRequest(
        payload,
        {
          lastRequest: state.lastRequest,
          lastResponseOutput: state.lastResponseOutput,
          lastResponseId: state.lastResponseId,
          pendingToolCallIds: state.lastPendingToolCallIds,
        },
        false,
        allowCompactionReplayBypass,
      ),
    );
  }

  if (error !== undefined || request === undefined) {
    return Plan.error({
      error: error ?? { status: 400, message: "invalid websocket request" },
    });
  }

  if (isPrewarm) {
    return Plan.prewarm({
      request: withoutGenerate(request),
      last: withoutGenerate(last ?? request),
    });
  }

  return Plan.execute({
    request,
    modelName: trimmed(request["model"]),
    nativePassthrough,
    requiresCurrentUpstream: nativePassthrough && requiresCurrent,
    lastRequest: last,
    pinnedId: state.pinned?.authId ?? "",
  });
};

const withoutGenerate = (request: JsonObject): JsonObject => {
  const out: JsonObject = {};

  for (const [key, value] of Object.entries(request)) if (key !== "generate") out[key] = value;

  return out;
};

/** A synthetic warm-up answered locally: the transcript root of the socket moves to the warm-up request. */
export const commitPrewarm = (
  state: SocketState,
  plan: Extract<Plan, { _tag: "prewarm" }>,
  prewarmId: string,
): void => {
  state.lastRequest = plan.last;
  state.lastResponseOutput = [];
  state.observedCompaction = undefined;
  state.lastResponseId = "";
  state.lastPendingToolCallIds = [];
  state.pendingPrewarmId = prewarmId;
};

export interface TurnOutcome {
  readonly modelName: string;
  /** The request as executed (tool calls repaired); becomes the transcript root of an HTTP-mode turn. */
  readonly executedRequest: JsonObject | undefined;
  readonly selected:
    | { readonly authId: string; readonly provider: string; readonly websockets: boolean }
    | undefined;
  readonly completedOutput: Json[];
  readonly completedResponseId: string;
  readonly pendingToolCallIds: string[];
}

/** The socket keeps its state upstream: the credential that owns the upstream socket is pinned and no transcript is kept. */
const pinToUpstreamSocket = (
  state: SocketState,
  selected: { readonly authId: string; readonly provider: string },
  modelName: string,
): void => {
  state.upstreamMode = "websocket";
  state.lastProvider = selected.provider;
  state.upstreamWebsocketAuthId = selected.authId;
  state.pinned = {
    authId: selected.authId,
    provider: selected.provider,
    modelKey: modelKeyOf(modelName),
  };
  state.passthroughModelName = modelName;
  state.lastRequest = undefined;
  state.lastResponseOutput = [];
  state.observedCompaction = undefined;
  state.lastResponseId = "";
  state.lastPendingToolCallIds = [];
};

/**
 * An upstream socket loss (or a continuation refused because of one) ended the request without closing the client
 * socket: the credential stays pinned, so the client's next full create reconnects on it and never on another one
 * (the `upstream_websocket_lost` branch of the Go main loop).
 */
export const commitLoss = (
  state: SocketState,
  outcome: Pick<TurnOutcome, "modelName" | "selected">,
): void => {
  state.pendingPrewarmId = "";
  const selected = outcome.selected;

  if (selected?.websockets === true) pinToUpstreamSocket(state, selected, outcome.modelName);
};

/** State changes after a turn completed without error (Go: the tail of the main loop body). */
export const commitTurn = (state: SocketState, outcome: TurnOutcome): void => {
  state.pendingPrewarmId = "";
  const selected = outcome.selected;
  const mode: UpstreamMode = selected?.websockets === true ? "websocket" : "http";
  state.upstreamMode = mode;
  state.lastProvider = selected?.provider ?? "";

  if (mode === "websocket" && selected !== undefined) {
    pinToUpstreamSocket(state, selected, outcome.modelName);

    return;
  }

  state.upstreamWebsocketAuthId = "";
  state.lastRequest =
    outcome.executedRequest === undefined ? undefined : cloneJson(outcome.executedRequest);
  state.lastResponseOutput = outcome.completedOutput;
  const modelKey = modelKeyOf(outcome.modelName);

  if (inputContainsFullTranscript(outcome.completedOutput)) {
    state.observedCompaction = { modelKey, authId: selected?.authId ?? "" };
  } else if (state.observedCompaction !== undefined) {
    const observed = state.observedCompaction;

    if (
      observed.modelKey !== modelKey ||
      (observed.authId !== "" && selected !== undefined && observed.authId !== selected.authId)
    ) {
      state.observedCompaction = undefined;
    }
  }

  state.lastResponseId = outcome.completedResponseId.trim();
  state.lastPendingToolCallIds = [...outcome.pendingToolCallIds];
};

/** Whether the turn's credential supports the upstream socket (`upstreamModeForAuth` provider rule). */
export const isWebsocketProvider = (provider: string): boolean => {
  const key = provider.trim().toLowerCase();

  return key === "codex" || key === "xai";
};
