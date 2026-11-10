/**
 * Reconcilers for the model-specific cloaking additions after payload rules rewrote the request model.
 *
 * Go source: internal/runtime/executor/claude_executor_cloaking.go (`claudeCodeFableState`,
 * `captureClaudeCodeFableState`, `hasFableReportingBlock`, `reconcileClaudeCodeFableModelAfterPayload`,
 * `claudeCodeSystemPlacementState`, `captureClaudeCodeSystemPlacement`,
 * `reconcileClaudeCodeSystemPlacementAfterPayload`). They repair what cloaking injected for the *old* model (Opus
 * fallback, `thinking.display = updates`, the `# Reporting outcomes` system block, the modern system-turn placement)
 * when the final model differs. Like in Go, the executors do not call them: user payload rules are the final barrier
 * before the request is sent (AGENTS.md), so nothing may rewrite the body afterwards. The functions are ported (and
 * tested against the Go cases) for callers that apply payload rules earlier.
 */
import { cloneJson, get, type JsonObject } from "@commissary/json";
import { isArr, isObj, str } from "@commissary/translation";
import { textBlock } from "./cache-control.ts";
import {
  isFable51Model,
  isOpus55Model,
  usesLegacySystemReminder,
  usesProgressDisplay,
} from "./classify.ts";
import {
  applyThinkingDisplay,
  collectForwardedBlocks,
  FABLE_REPORTING_OUTCOMES,
  firstUserMessageIndex,
  leadingUserRunEnd,
  messageContentText,
  prependSystemReminderBlocks,
} from "./cloaking.ts";

const ZERO_WIDTH_SPACE = "\u200B";

const withoutZeroWidth = (text: string): string => text.replaceAll(ZERO_WIDTH_SPACE, "");

/** `hasFableReportingBlock`. */
const hasReportingBlock = (body: JsonObject): boolean => {
  const system = body.system;

  if (!isArr(system)) {
    // gjson `.String()` of a missing/non-string value.
    const text = withoutZeroWidth(typeof system === "string" ? system : "");

    return text === FABLE_REPORTING_OUTCOMES || text.includes(FABLE_REPORTING_OUTCOMES);
  }

  return system.some(
    (block) => withoutZeroWidth(str(get(block, "text"))) === FABLE_REPORTING_OUTCOMES,
  );
};

export interface FableState {
  readonly injectedFallbacks: boolean;
  readonly injectedDisplay: boolean;
  readonly injectedReporting: boolean;
}

const NO_FABLE_STATE: FableState = {
  injectedFallbacks: false,
  injectedDisplay: false,
  injectedReporting: false,
};

/** `captureClaudeCodeFableState`: what cloaking added (compare the body before and after cloaking). */
export const captureFableState = (
  before: JsonObject | undefined,
  after: JsonObject | undefined,
  cloaked: boolean,
): FableState => {
  if (!cloaked || before === undefined || after === undefined) return NO_FABLE_STATE;

  return {
    injectedFallbacks: before.fallbacks === undefined && after.fallbacks !== undefined,
    injectedDisplay:
      get(before, "thinking.display") === undefined && get(after, "thinking.display") !== undefined,
    injectedReporting: !hasReportingBlock(before) && hasReportingBlock(after),
  };
};

const removeReportingBlock = (body: JsonObject): void => {
  const system = body.system;

  if (isArr(system)) {
    const kept = system.filter(
      (block) => withoutZeroWidth(str(get(block, "text"))) !== FABLE_REPORTING_OUTCOMES,
    );

    if (kept.length !== system.length) body.system = kept;
  } else if (
    withoutZeroWidth(typeof system === "string" ? system : "") === FABLE_REPORTING_OUTCOMES
  ) {
    delete body.system;
  }
};

const appendReportingBlock = (body: JsonObject): void => {
  const system = body.system;

  if (isArr(system)) {
    body.system = [...system, textBlock(FABLE_REPORTING_OUTCOMES)];
  } else if (typeof system === "string") {
    body.system = [textBlock(system), textBlock(FABLE_REPORTING_OUTCOMES)];
  } else if (system === undefined) {
    body.system = [textBlock(FABLE_REPORTING_OUTCOMES)];
  }
};

/**
 * `reconcileClaudeCodeFableModelAfterPayload`: Opus fallback, `thinking.display` and the reporting block follow the
 * final model. Caller/operator choices (`payloadTouched*`) are never overridden; probes carry no additions at all.
 * Mutates `body`.
 */
export const reconcileFableModelAfterPayload = (
  body: JsonObject,
  state: FableState,
  payloadTouchedFallbacks: boolean,
  payloadTouchedDisplay: boolean,
  cloaked: boolean,
  isProbeOrHelper: boolean,
): void => {
  if (!cloaked) return;

  if (isProbeOrHelper) {
    if (state.injectedFallbacks && !payloadTouchedFallbacks) delete body.fallbacks;

    if (state.injectedDisplay && !payloadTouchedDisplay && isObj(body.thinking))
      delete body.thinking.display;

    if (state.injectedReporting) removeReportingBlock(body);

    return;
  }

  const model = str(body.model).trim().toLowerCase();

  // A model rewrite may change the native fallback target: replace only a fallback that cloaking inserted.
  if (state.injectedFallbacks && !payloadTouchedFallbacks) {
    const wanted = isFable51Model(model)
      ? "claude-opus-5"
      : isOpus55Model(model)
        ? "claude-opus-4-8"
        : "";

    if (str(get(body, "fallbacks.0.model")) !== wanted) delete body.fallbacks;
  }

  if (isFable51Model(model)) {
    // Rewritten to (or originally) Fable 5.1: attach the Fable additions unless rules configured or filtered them.
    if (body.fallbacks === undefined && !payloadTouchedFallbacks)
      body.fallbacks = [{ model: "claude-opus-5" }];
    const thinking = body.thinking;

    if (thinking !== undefined) {
      const type = str(get(thinking, "type"));

      if (
        type === "adaptive" &&
        isObj(thinking) &&
        get(thinking, "display") === undefined &&
        !payloadTouchedDisplay
      ) {
        thinking.display = "updates";
      } else if (
        type !== "adaptive" &&
        state.injectedDisplay &&
        !payloadTouchedDisplay &&
        isObj(thinking)
      ) {
        delete thinking.display;
      }
    } else if (state.injectedDisplay && !payloadTouchedDisplay) {
      // `thinking.display` of a missing `thinking` object: nothing to delete.
    }

    if (!hasReportingBlock(body)) appendReportingBlock(body);

    if (!payloadTouchedDisplay) applyThinkingDisplay(body);

    return;
  }

  if (isOpus55Model(model) && body.fallbacks === undefined && !payloadTouchedFallbacks) {
    body.fallbacks = [{ model: "claude-opus-4-8" }];
  }

  const thinkingType = str(get(body, "thinking.type")).trim().toLowerCase();
  const thinkingActive = thinkingType === "adaptive" || thinkingType === "enabled";

  // Payload rules can disable thinking without touching display: drop only the value cloaking inserted.
  if (
    state.injectedDisplay &&
    !payloadTouchedDisplay &&
    (!thinkingActive || !usesProgressDisplay(model)) &&
    isObj(body.thinking)
  ) {
    delete body.thinking.display;
  }

  if (!payloadTouchedDisplay) applyThinkingDisplay(body);

  if (state.injectedReporting) removeReportingBlock(body);
};

export interface SystemPlacementState {
  readonly insertAt: number;
  readonly insertedRaw: ReadonlyArray<string>;
  readonly texts: ReadonlyArray<string>;
}

const NO_PLACEMENT: SystemPlacementState = { insertAt: 0, insertedRaw: [], texts: [] };

/**
 * `captureClaudeCodeSystemPlacement`: the `role: "system"` turns cloaking itself inserted for a modern model (caller
 * owned turns are excluded, so a legacy-model pairing still ends in the 400 of the final validation).
 */
export const captureSystemPlacement = (
  before: JsonObject,
  after: JsonObject,
  cloaked: boolean,
): SystemPlacementState => {
  if (!cloaked || usesLegacySystemReminder(before)) return NO_PLACEMENT;
  const texts = collectForwardedBlocks(before.system).map((block) => block.text);

  if (texts.length === 0) return NO_PLACEMENT;
  const beforeMessages = isArr(before.messages) ? before.messages : [];
  const afterMessages = isArr(after.messages) ? after.messages : [];

  if (afterMessages.length !== beforeMessages.length + texts.length) return NO_PLACEMENT;
  const firstUser = firstUserMessageIndex(before);

  if (firstUser < 0) return NO_PLACEMENT;
  const insertAt = leadingUserRunEnd(beforeMessages, firstUser);

  if (insertAt + texts.length > afterMessages.length) return NO_PLACEMENT;
  const insertedRaw: string[] = [];

  for (const [index, text] of texts.entries()) {
    const message = afterMessages[insertAt + index];

    if (message === undefined) return NO_PLACEMENT;

    if (
      str(get(message, "role")) !== "system" ||
      messageContentText(get(message, "content")) !== text
    ) {
      return NO_PLACEMENT;
    }

    insertedRaw.push(JSON.stringify(message));
  }

  return { insertAt, insertedRaw, texts };
};

/**
 * `reconcileClaudeCodeSystemPlacementAfterPayload`: a model rewritten from modern to legacy gets the captured system
 * turns replayed through the legacy `<system-reminder>` path. Fails closed (leaves the body) when payload rules touched
 * those messages. Mutates `body`.
 */
export const reconcileSystemPlacementAfterPayload = (
  body: JsonObject,
  state: SystemPlacementState,
): void => {
  if (state.insertedRaw.length === 0 || !usesLegacySystemReminder(body)) return;
  const messages = isArr(body.messages) ? body.messages : [];

  if (state.insertAt < 0 || state.insertAt + state.insertedRaw.length > messages.length) return;

  for (const [index, raw] of state.insertedRaw.entries()) {
    if (JSON.stringify(messages[state.insertAt + index]) !== raw) return;
  }

  body.messages = messages.filter(
    (_, index) => index < state.insertAt || index >= state.insertAt + state.insertedRaw.length,
  );
  prependSystemReminderBlocks(
    body,
    state.texts.map((text) => ({ text, cacheControl: undefined })),
    false,
  );
};

/** Deep copy helper for callers that capture the pre-cloaking body. */
export const snapshotBody = (body: JsonObject): JsonObject => cloneJson(body);
