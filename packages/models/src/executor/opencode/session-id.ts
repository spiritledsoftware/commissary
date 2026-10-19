/**
 * OpenCode-format session ids: `ses_` + 12 lowercase hex digits + 14 base62 characters, as OpenCode's own client
 * creates them (`Identifier.descending()`: the low 48 bits of `~(timestampMs * 0x1000 + counter)` as 6 big-endian
 * bytes, then random base62).
 *
 * Workers addition (no OpenCode provider in Go; ADR 0033): OpenCode Zen serves its free models only to requests whose
 * `x-opencode-session` has this shape. The probed gate accepts any timestamp and any tail, so a cloaked request uses
 * an id derived from the conversation identity: stable across turns, distinct across conversations.
 */
import { createHash } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

const FORMAT = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

const TAIL_LENGTH = 14;

/** 2020-01-01T00:00:00Z: derived timestamps fall in the 80 years after it (all of them passed the probes). */
const EPOCH_MS = 1_577_836_800_000;

const SPAN_MS = 80 * 365 * 86_400_000;

const MASK_48 = (1n << 48n) - 1n;

/** Whether `value` is an OpenCode-format session id. */
export const isOpenCodeSessionId = (value: string): boolean => FORMAT.test(value);

/** The id OpenCode would create at `timestampMs` with counter 1, with the given 14-character base62 `tail`. */
export const formatOpenCodeSessionId = (timestampMs: number, tail: string): string => {
  const descending = ~(BigInt(timestampMs) * 0x1000n + 1n) & MASK_48;

  return `ses_${descending.toString(16).padStart(12, "0")}${tail}`;
};

/** A stable OpenCode-format id of a session identity (timestamp and tail from its SHA-256). */
export const openCodeSessionIdOf = (identity: string): string => {
  const hash = createHash("sha256").update(identity, "utf8").digest();
  const offset = Number(hash.readBigUInt64BE(0) % BigInt(SPAN_MS));

  const tail = Array.from(hash.subarray(8, 8 + TAIL_LENGTH), (byte) => BASE62[byte % 62]).join("");

  return formatOpenCodeSessionId(EPOCH_MS + offset, tail);
};
