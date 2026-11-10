/**
 * Claude SSE event observer shared by the upstream reader (`stream.ts`) and the downstream framer (`handlers/framing.ts`).
 *
 * Go source: internal/runtime/executor/claude_executor_diagnostics.go (observeClaudeSSEEvent, observeClaudeStreamJSONPayload)
 * and sdk/api/handlers/claude/code_handlers.go (claudeSSEStreamState), Go 4f2e5270. An event's `data:` lines are joined
 * before they are inspected, so a `message_stop` inside a multi-line payload is not a completion. Bare JSON lines
 * (providers that ignore `stream: true`) complete on a `message` with a `stop_reason`.
 */
import { get, isJsonObject, tryParseJson, type Json } from "@commissary/json";
import { str } from "@commissary/translation";

export class ClaudeEventObserver {
  readonly #data: string[] = [];
  #currentEvent = "";
  /** A `message_stop` (or a bare completed `message`) was seen. */
  completed = false;
  /** A bare JSON `message` completed the stream: no SSE framing applies. */
  bareMessage = false;
  /** Id of a bare completed `message`. */
  bareMessageId = "";
  /** Payload text of the first `error` event. */
  errorPayload: string | undefined;

  #observeJson(payload: Json, text: string, hasDataPrefix: boolean): void {
    switch (str(get(payload, "type"))) {
      case "message_stop":
        this.completed = true;
        break;

      case "error":
        if (hasDataPrefix) this.errorPayload ??= text;
        break;

      case "message":
        if (!hasDataPrefix && str(get(payload, "stop_reason")).trim() !== "") {
          this.bareMessageId = str(get(payload, "id")).trim();
          this.completed = true;
          this.bareMessage = true;
        }

        break;

      default:
        if (hasDataPrefix && this.#currentEvent === "error" && get(payload, "error") !== undefined)
          this.errorPayload ??= text;
    }
  }

  /** Inspects the joined `data:` lines of the event that just ended. */
  flush(): void {
    if (this.#data.length === 0) return;
    const text = this.#data.join("\n").trim();
    this.#data.length = 0;
    const payload = tryParseJson(text);

    if (isJsonObject(payload)) this.#observeJson(payload, text, true);
  }

  /** Feeds one line without its terminator. */
  observeLine(line: string): void {
    const trimmed = line.trim();

    if (trimmed === "") {
      this.flush();
      this.#currentEvent = "";

      return;
    }

    if (trimmed.startsWith("event:")) {
      this.#currentEvent = trimmed.slice(6).trim();

      return;
    }

    if (trimmed.startsWith("data:")) {
      const payload = trimmed.slice(5).trim();

      if (payload !== "") this.#data.push(payload);

      return;
    }

    if (!trimmed.startsWith("{")) return;
    const payload = tryParseJson(trimmed);

    if (isJsonObject(payload)) this.#observeJson(payload, trimmed, false);
  }
}
