/**
 * How the sandbox tools cut their output (#222): as pi's coding tools do, so a hosted agent's bash and file tools read
 * the same (#230). Two limits, whichever is hit first: 2000 lines or 50 KB. A file read keeps its start, whole lines
 * only; a command's output keeps its end, where errors and results are. The cut is always stated.
 *
 * Copies pi's `truncateHead` and `truncateTail` (badlogic/pi-mono, `packages/coding-agent/src/core/tools/truncate.ts`).
 */

export const MAX_LINES = 2000;

export const MAX_BYTES = 50 * 1024;

export interface Truncation {
  readonly content: string;
  readonly truncated: boolean;
  /** Which limit cut it. */
  readonly truncatedBy: "lines" | "bytes" | undefined;
  readonly totalLines: number;
  /** Lines kept, whole or (a tail's first, when one line alone passes the byte limit) partial. */
  readonly outputLines: number;
  /** A tail's only line is the end of a longer one. */
  readonly lastLinePartial: boolean;
  /** A head's first line alone passes the byte limit: nothing is kept. */
  readonly firstLineExceedsLimit: boolean;
}

const encoder = new TextEncoder();

export const byteLength = (text: string): number => encoder.encode(text).byteLength;

const linesOf = (content: string): Array<string> => {
  if (content.length === 0) return [];
  const lines = content.split("\n");

  if (content.endsWith("\n")) lines.pop();

  return lines;
};

const whole = (content: string, totalLines: number): Truncation => ({
  content,
  truncated: false,
  truncatedBy: undefined,
  totalLines,
  outputLines: totalLines,
  lastLinePartial: false,
  firstLineExceedsLimit: false,
});

/** Human-readable bytes, as pi writes them (`50.0KB`). */
export const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes}B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)}KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;

/** Keeps the first lines of `content` within the limits, whole lines only. */
export const truncateHead = (content: string, maxLines = MAX_LINES): Truncation => {
  const lines = linesOf(content);

  if (lines.length <= maxLines && byteLength(content) <= MAX_BYTES)
    return whole(content, lines.length);

  if (byteLength(lines[0] ?? "") > MAX_BYTES)
    return {
      content: "",
      truncated: true,
      truncatedBy: "bytes",
      totalLines: lines.length,
      outputLines: 0,
      lastLinePartial: false,
      firstLineExceedsLimit: true,
    };

  const kept: Array<string> = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (const [index, line] of lines.entries()) {
    if (index >= maxLines) break;
    const size = byteLength(line) + (index > 0 ? 1 : 0);

    if (bytes + size > MAX_BYTES) {
      truncatedBy = "bytes";
      break;
    }

    kept.push(line);
    bytes += size;
  }

  return {
    content: kept.join("\n"),
    truncated: true,
    truncatedBy: kept.length >= maxLines ? "lines" : truncatedBy,
    totalLines: lines.length,
    outputLines: kept.length,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
  };
};

/** The end of `line` within `maxBytes`, cut at a character boundary. */
const tailBytes = (line: string, maxBytes: number): string => {
  const bytes = encoder.encode(line);
  let start = bytes.byteLength - maxBytes;

  // Continuation bytes (10xxxxxx) start no character.
  while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;

  return new TextDecoder().decode(bytes.subarray(start));
};

/** Keeps the last lines of `content` within the limits; a last line alone past the byte limit keeps its end. */
export const truncateTail = (content: string): Truncation => {
  const lines = linesOf(content);

  if (lines.length <= MAX_LINES && byteLength(content) <= MAX_BYTES)
    return whole(content, lines.length);

  const kept: Array<string> = [];
  let bytes = 0;
  let truncatedBy: "lines" | "bytes" = "lines";
  let lastLinePartial = false;

  for (let index = lines.length - 1; index >= 0 && kept.length < MAX_LINES; index -= 1) {
    const line = lines[index] ?? "";
    const size = byteLength(line) + (kept.length > 0 ? 1 : 0);

    if (bytes + size > MAX_BYTES) {
      truncatedBy = "bytes";

      if (kept.length === 0) {
        kept.unshift(tailBytes(line, MAX_BYTES));
        lastLinePartial = true;
      }

      break;
    }

    kept.unshift(line);
    bytes += size;
  }

  return {
    content: kept.join("\n"),
    truncated: true,
    truncatedBy: kept.length >= MAX_LINES && bytes <= MAX_BYTES ? "lines" : truncatedBy,
    totalLines: lines.length,
    outputLines: kept.length,
    lastLinePartial,
    firstLineExceedsLimit: false,
  };
};
