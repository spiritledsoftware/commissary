/**
 * The input_json_delta bookkeeping of the open `tool_use` block in a Gemini or Antigravity -> Claude stream.
 *
 * Go source: `CurrentToolName`, `CurrentToolIsParameterless`, `CurrentToolInputEmitted`, `CurrentToolPendingEmpty`,
 * `CurrentToolInputOpen`, `CurrentToolSignature`, `appendToolInputObject` and `flushPendingToolInput` in
 * gemini/claude/gemini_claude_response.go and antigravity/claude/antigravity_claude_response.go (upstream 202b8b8c,
 * e1fb2521, 3a353935).
 *
 * A call may arrive in several parts (the first names the tool, later ones carry only args). A cleaned `{}` is deferred
 * until the block completes without other input, so continuation parts never concatenate duplicate or empty objects.
 */
import { isJsonObject, tryParseJson } from "@commissary/json";

/** The Gemini tracker: each part's cleaned args are sent as they are. */
export class ToolInputTracker {
  /** Client-facing name of the open block. */
  name = "";
  protected parameterless = false;
  protected emitted = false;
  protected pendingEmpty = false;

  /** A new tool_use block opens. */
  begin(name: string, parameterless: boolean): void {
    this.name = name;
    this.parameterless = parameterless;
    this.emitted = false;
    this.pendingEmpty = false;
  }

  /** The `partial_json` to emit for one part's cleaned args, or `undefined` when the empty object is deferred. */
  next(cleaned: string): string | undefined {
    let partial = cleaned;

    if (this.parameterless) {
      if (this.emitted) {
        partial = "";
      } else {
        this.emitted = true;
        this.pendingEmpty = false;
      }
    } else if (partial === "{}") {
      if (!this.emitted) this.pendingEmpty = true;
      partial = "";
    } else if (partial !== "") {
      this.emitted = true;
      this.pendingEmpty = false;
    }

    return partial !== "" || !this.pendingEmpty ? partial : undefined;
  }

  /** The deferred `{}`, once, when the block completes without other input. */
  flush(): string | undefined {
    if (!this.pendingEmpty || this.emitted) return undefined;
    this.emitted = true;
    this.pendingEmpty = false;

    return "{}";
  }
}

/**
 * The Antigravity tracker (CLIProxyAPI 3a353935): the object members of every part stream into one open object, closed
 * when the block ends, and the signature of a continuation part waits to follow the block.
 */
export class MergingToolInputTracker extends ToolInputTracker {
  /** Signature of a continuation part, re-attached after the block closes. */
  signature = "";
  #open = false;

  override begin(name: string, parameterless: boolean): void {
    super.begin(name, parameterless);
    this.signature = "";
    this.#open = false;
  }

  /** `appendToolInputObject`: the partial JSON for `cleaned`; object members join the open object. */
  #object(cleaned: string): string[] {
    if (cleaned === "") return [];

    if (isJsonObject(tryParseJson(cleaned))) {
      const body = cleaned.replace(/^\{/, "").replace(/\}$/, "");

      if (body === "") return [];
      const partial = this.#open ? `,${body}` : `{${body}`;
      this.#open = true;
      this.emitted = true;
      this.pendingEmpty = false;

      return [partial];
    }

    this.emitted = true;
    this.pendingEmpty = false;

    return [cleaned];
  }

  /** The partial JSON for the cleaned args of the part that opens the block. */
  openingArguments(cleaned: string): string[] {
    let partial = cleaned;

    if (this.parameterless) {
      if (this.emitted) partial = "";
      else this.emitted = true;
    } else if (partial === "{}") {
      this.pendingEmpty = true;
      partial = "";
    }

    return this.#object(partial);
  }

  /** The partial JSON for the cleaned args of a continuation part (one without a name). */
  continuationArguments(cleaned: string): string[] {
    if (this.parameterless) {
      if (this.emitted) return [];
      this.emitted = true;
      this.pendingEmpty = false;

      return ["{}"];
    }

    if (cleaned === "{}") {
      if (!this.emitted) this.pendingEmpty = true;

      return [];
    }

    return this.#object(cleaned);
  }

  /** `flushPendingToolInput`: closes the open object, or sends the deferred `{}` once. */
  override flush(): string | undefined {
    if (this.#open) {
      this.#open = false;
      this.pendingEmpty = false;

      return "}";
    }

    const deferred = super.flush();
    this.pendingEmpty = false;

    return deferred;
  }
}
