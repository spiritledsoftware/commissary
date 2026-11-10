/**
 * The input_json_delta bookkeeping of the open `tool_use` block in a Gemini or Antigravity -> Claude stream.
 *
 * Go source: `CurrentToolName`, `CurrentToolIsParameterless`, `CurrentToolInputEmitted`, `CurrentToolPendingEmpty` and
 * `flushPendingToolInput` in gemini/claude/gemini_claude_response.go and antigravity/claude/antigravity_claude_response.go
 * (upstream 202b8b8c, e1fb2521).
 *
 * A call may arrive in several parts (the first names the tool, later ones carry only args). A cleaned `{}` is deferred
 * until the block completes without other input, so continuation parts never concatenate duplicate or empty objects.
 */
export class ToolInputTracker {
  /** Client-facing name of the open block. */
  name = "";
  #parameterless = false;
  #emitted = false;
  #pendingEmpty = false;

  /** A new tool_use block opens. */
  begin(name: string, parameterless: boolean): void {
    this.name = name;
    this.#parameterless = parameterless;
    this.#emitted = false;
    this.#pendingEmpty = false;
  }

  /** The `partial_json` to emit for one part's cleaned args, or `undefined` when the empty object is deferred. */
  next(cleaned: string): string | undefined {
    let partial = cleaned;

    if (this.#parameterless) {
      if (this.#emitted) {
        partial = "";
      } else {
        this.#emitted = true;
        this.#pendingEmpty = false;
      }
    } else if (partial === "{}") {
      if (!this.#emitted) this.#pendingEmpty = true;
      partial = "";
    } else if (partial !== "") {
      this.#emitted = true;
      this.#pendingEmpty = false;
    }

    return partial !== "" || !this.#pendingEmpty ? partial : undefined;
  }

  /** The deferred `{}`, once, when the block completes without other input. */
  flush(): string | undefined {
    if (!this.#pendingEmpty || this.#emitted) return undefined;
    this.#emitted = true;
    this.#pendingEmpty = false;

    return "{}";
  }
}
