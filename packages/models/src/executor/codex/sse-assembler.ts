/**
 * Joins a Codex SSE event whose JSON the upstream split across several `data:` lines.
 *
 * Go source: internal/runtime/executor/helps/codex_sse_scanner.go (CodexSSEScanner, CLIProxyAPI 7795de19). In SSE an
 * event's data may span several `data:` lines joined with `\n`; taking each line as a whole event cuts such an event
 * (a split `response.completed` ends the stream at the first fragment). Every event on this path is one JSON value, so:
 *
 * - a data line that is complete JSON on its own, or cannot start JSON (empty, `[DONE]`), is delivered as read;
 * - a data line that opens an object or array without closing it starts an event that collects the following data
 *   lines until their joined value closes, a blank line ends the event, the stream ends, or the bytes would exceed
 *   the line limit;
 * - a completed event is delivered compacted onto one `data:` line; one that never becomes valid JSON is delivered as
 *   the held multi-line field, so it still fails downstream.
 *
 * Only data lines are held: any other line is delivered the moment it is read, so a comment or `event:` line inside
 * a held event comes before the event's data (SSE treats these alike).
 *
 * Differences from Go: no invalid-event warning (nothing to log through), and the bootstrap budgets count an
 * assembled event as one frame of its joined size instead of its physical lines.
 */

const DATA_PREFIX = "data:";

/** One physical line's bound, as the Go scanner's `Buffer(nil, 52_428_800)`. */
export const CODEX_SSE_MAX_BYTES = 52_428_800;

/** Follows the nesting of a JSON text fed in pieces: validated once, when the outermost value closes. */
class JsonNesting {
  #depth = 0;
  #inString = false;
  #escaped = false;

  /** Consumes `text`; true when the outermost object or array closed within it. */
  feed(text: string): boolean {
    for (const char of text) {
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (char === "\\") this.#escaped = true;
        else if (char === '"') this.#inString = false;
      } else if (char === '"') this.#inString = true;
      else if (char === "{" || char === "[") this.#depth++;
      else if (char === "}" || char === "]") {
        this.#depth--;

        if (this.#depth <= 0) return true;
      }
    }

    return false;
  }
}

const isValidJson = (text: string): boolean => {
  try {
    JSON.parse(text);

    return true;
  } catch {
    return false;
  }
};

/** `codexSSEClosed`: complete JSON that ends with a closing bracket. */
const isClosed = (joined: string): boolean => {
  const trimmed = joined.trimEnd();

  return (trimmed.endsWith("}") || trimmed.endsWith("]")) && isValidJson(joined);
};

/** `codexSSEIncompleteJSON`: the value opens an object or array it does not complete. */
const isIncompleteJson = (value: string): boolean =>
  value !== "" && (value[0] === "{" || value[0] === "[") && value !== "[DONE]" && !isClosed(value);

/** One data line's value: the text after `data:` without the one leading space. */
const valueOf = (line: string): string => {
  const rest = line.slice(DATA_PREFIX.length);

  return rest.startsWith(" ") ? rest.slice(1) : rest;
};

/** `json.Compact`: strips the whitespace outside strings, leaving every token as written. */
const compact = (json: string): string => {
  let out = "";
  let inString = false;
  let escaped = false;

  for (const char of json) {
    if (inString) {
      out += char;

      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char !== " " && char !== "\t" && char !== "\n" && char !== "\r") out += char;
  }

  return out;
};

export class CodexSseAssembler {
  #held: string[] = [];
  #size = 0;
  #joined = "";
  #nesting = new JsonNesting();

  constructor(readonly maxBytes: number = CODEX_SSE_MAX_BYTES) {}

  /** Feeds one upstream line (without terminator); returns the lines to deliver, in order. */
  push(line: string): string[] {
    if (!line.startsWith(DATA_PREFIX)) {
      if (line === "" && this.#held.length > 0) return [...this.#release(), line];

      return [line];
    }

    if (this.#held.length === 0) {
      if (!isIncompleteJson(valueOf(line).trim())) return [line];
    } else if (this.#size + line.length > this.maxBytes) {
      // Bounded like a single line: stop collecting and let this line be read on its own.
      return [...this.#release(), line];
    }

    return this.#hold(line) ? this.#release() : [];
  }

  /** The end of the stream: a half-collected event is delivered as it is. */
  end(): string[] {
    return this.#held.length > 0 ? this.#release() : [];
  }

  /** Adds a data line to the event being collected; true when its data has closed. */
  #hold(line: string): boolean {
    const value = valueOf(line);

    if (this.#held.length > 0) {
      this.#joined += "\n";
      this.#nesting.feed("\n");
    }

    this.#held.push(line);
    this.#joined += value;
    this.#size += line.length;

    return this.#nesting.feed(value);
  }

  /** Ends the collection: the event as one line when its data is valid JSON, else the lines as held. */
  #release(): string[] {
    const held = this.#held;
    const joined = this.#joined;
    this.#held = [];
    this.#size = 0;
    this.#joined = "";
    this.#nesting = new JsonNesting();

    if (held.length > 1 && isValidJson(joined)) return [`${DATA_PREFIX} ${compact(joined)}`];

    return [held.join("\n")];
  }
}
