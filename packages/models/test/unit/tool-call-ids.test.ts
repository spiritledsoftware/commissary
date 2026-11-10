// Go source: internal/runtime/executor/helps/tool_call_ids.go (and its tests, issue 6478).
import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@commissary/json";
import {
  decodeToolCallId,
  encodeToolCallId,
  isPortableToolCallId,
  normalizeClaudeToolCallIds,
} from "../../src/executor/helps/tool-call-ids.ts";

const PREFIX = "cpa_tid_v1_";

describe("portable ids", () => {
  it.each([
    ["call_1", true],
    ["toolu_01-A", true],
    ["Bash:1#abc", false],
    ["call:1", false],
    ["a b", false],
    ["名", false],
    ["", false],
  ])("%s -> %s", (id, want) => {
    expect(isPortableToolCallId(id)).toBe(want);
  });
});

describe("encode/decode", () => {
  it("encodes a non-portable id as cpa_tid_v1_ + base64url and leaves portable and empty ids alone", () => {
    expect(encodeToolCallId("Bash:1#abc")).toBe(`${PREFIX}QmFzaDoxI2FiYw`);
    expect(encodeToolCallId("call_1")).toBe("call_1");
    expect(encodeToolCallId("")).toBe("");
  });

  it("reserves the namespace: a native id carrying the prefix is encoded once more", () => {
    const native = `${PREFIX}Y2FsbF8x`;

    expect(encodeToolCallId(native)).not.toBe(native);
    expect(decodeToolCallId(encodeToolCallId(native))).toBe(native);
  });

  it("round-trips non-portable ids, including multi-byte ones", () => {
    for (const id of ["Write:1#abc", "call:1", "名:1", "a b"])
      expect(decodeToolCallId(encodeToolCallId(id))).toBe(id);
  });

  it("leaves ordinary ids and malformed or non-canonical encodings intact", () => {
    for (const id of [
      "call_1",
      "toolu_01",
      PREFIX,
      `${PREFIX}!!!`,
      `${PREFIX}Y`,
      `${PREFIX}QmFzaDoxI2FiYw==`,
      // Decodes to "call_1", which is portable, so it is not the canonical encoding of anything.
      `${PREFIX}Y2FsbF8x`,
      // Non-zero trailing bits: decodes to "Bash:1#abc" but is not the canonical form.
      `${PREFIX}QmFzaDoxI2FiYx`,
      // Invalid UTF-8.
      `${PREFIX}_w`,
    ])
      expect(decodeToolCallId(id)).toBe(id);
  });
});

const body = (messages: Json): JsonObject => ({ messages }) as JsonObject;

describe("normalizeClaudeToolCallIds", () => {
  it("rewrites tool_use.id and tool_result.tool_use_id consistently and nothing else", () => {
    const input = body([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Bash:1#abc" },
          { type: "tool_use", id: "Bash:1#abc", name: "Bash", input: { id: "Bash:1#abc" } },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "Bash:1#abc", content: "Bash:1#abc" },
          { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
        ],
      },
    ]);

    normalizeClaudeToolCallIds(input);
    expect(input).toEqual(
      body([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Bash:1#abc" },
            {
              type: "tool_use",
              id: `${PREFIX}QmFzaDoxI2FiYw`,
              name: "Bash",
              input: { id: "Bash:1#abc" },
            },
            { type: "tool_use", id: "toolu_01", name: "Bash", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `${PREFIX}QmFzaDoxI2FiYw`, content: "Bash:1#abc" },
            { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
          ],
        },
      ]),
    );
  });

  it("gives a collision with a legal id of the same body the _ prefix", () => {
    const encoded = `${PREFIX}QmFzaDoxI2FiYw`;

    const input = body([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "Bash:1#abc", name: "Bash", input: {} },
          // A legal id that already equals the encoding of the illegal one, later in the document.
          { type: "tool_use", id: encoded, name: "Bash", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "Bash:1#abc", content: "a" },
          { type: "tool_result", tool_use_id: encoded, content: "b" },
        ],
      },
    ]);

    normalizeClaudeToolCallIds(input);

    const [assistant, user] = (input.messages as JsonObject[]).map((m) => m.content) as [
      JsonObject[],
      JsonObject[],
    ];

    expect(assistant[0]?.id).toBe(`_${encoded}`);
    expect(assistant[1]?.id).toBe(encoded);
    expect(user[0]?.tool_use_id).toBe(`_${encoded}`);
    expect(user[1]?.tool_use_id).toBe(encoded);
  });

  it("ignores string content, empty and non-string ids and leaves a clean body untouched", () => {
    const input = body([
      { role: "user", content: "call:1" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "", name: "x", input: {} },
          { type: "tool_use", name: "x", input: {} },
          { type: "tool_use", id: 7, name: "x", input: {} },
        ],
      },
    ]);

    const before = structuredClone(input);
    normalizeClaudeToolCallIds(input);
    expect(input).toEqual(before);
    expect(() => normalizeClaudeToolCallIds({})).not.toThrow();
  });
});
