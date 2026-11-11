/**
 * Whether translated stream chunks carry a client-visible terminal event: the point before which the accumulated reasoning
 * replay items must be committed to the ledger (the next turn reads them, so a client that got the terminal event must find
 * them).
 *
 * Go source: internal/runtime/executor/antigravity_reasoning_replay.go (`antigravityStreamChunksHaveTerminalCommitEvent`).
 */
import { asString, get, tryParseJson } from "@commissary/json";
import { jsonPayload } from "../../gemini/usage.ts";

const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.done",
  "message_stop",
]);

const FINISH_REASON_PATHS = [
  "choices.0.finish_reason",
  "response.choices.0.finish_reason",
  "candidates.0.finishReason",
  "response.candidates.0.finishReason",
] as const;

export const chunksHaveTerminalCommitEvent = (chunks: ReadonlyArray<string>): boolean =>
  chunks.some((chunk) =>
    chunk.split("\n").some((line) => {
      const payload = jsonPayload(line);

      if (payload === undefined) return false;
      const root = tryParseJson(payload);

      if (TERMINAL_TYPES.has(asString(get(root, "type")))) return true;

      if (asString(get(root, "event_type")) === "interaction.completed") return true;

      return FINISH_REASON_PATHS.some((path) => asString(get(root, path)).trim() !== "");
    }),
  );
