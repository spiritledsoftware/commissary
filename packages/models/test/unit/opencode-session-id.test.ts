// OpenCode-format session ids (`ses_` + 12 hex of the descending timestamp + 14 base62), which OpenCode Zen's free
// tier requires (ADR 0033). The worked examples are OpenCode's own `Identifier.descending()` at a fixed time and
// counter 1, ids Zen accepted on 2026-10-18.
import { describe, expect, it } from "vitest";
import {
  formatOpenCodeSessionId,
  isOpenCodeSessionId,
  openCodeSessionIdOf,
} from "../../src/executor/opencode/session-id.ts";

const TAIL = "xxxxxxxxxxxxxx";

describe("OpenCode session ids", () => {
  it("encodes the timestamp as OpenCode's descending identifier does", () => {
    expect(formatOpenCodeSessionId(Date.parse("2020-01-01T00:00:00Z"), TAIL)).toBe(
      `ses_0a19917ffffe${TAIL}`,
    );
    expect(formatOpenCodeSessionId(Date.parse("2025-01-01T00:00:00Z"), TAIL)).toBe(
      `ses_be0d683ffffe${TAIL}`,
    );
  });

  it("derives a stable, well-formed id per identity", () => {
    const one = openCodeSessionIdOf("derived-session\u0000conversation-a");

    expect(one).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(openCodeSessionIdOf("derived-session\u0000conversation-a")).toBe(one);
    expect(openCodeSessionIdOf("derived-session\u0000conversation-b")).not.toBe(one);
  });

  it("recognises OpenCode's format and nothing else", () => {
    expect(isOpenCodeSessionId("ses_eb1612f3bffeJ2oubftJlUX4Oy")).toBe(true);
    expect(isOpenCodeSessionId(openCodeSessionIdOf("x"))).toBe(true);
    expect(isOpenCodeSessionId("3f0c1e4e-8a51-4c5e-9d0e-6f1f4b7c2a10")).toBe(false);
    expect(isOpenCodeSessionId("ses_eb1612f3bffeabc")).toBe(false);
    expect(isOpenCodeSessionId("ses_EB1612F3BFFEJ2oubftJlUX4Oy")).toBe(false);
  });
});
