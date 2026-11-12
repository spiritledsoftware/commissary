// Go source: internal/runtime/executor/helps/gemini_content_turns.go and its tests (CLIProxyAPI a2718314, ceb4397f,
// 15d2148b).
import { describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import {
  dropGeminiTrailingThoughtOnlyContent,
  ensureGeminiBoundaryUserContent,
  ensureGeminiLeadingUserContent,
  ensureGeminiTrailingUserContent,
} from "../../src/executor/gemini/content-turns.ts";

const roles = (body: Json): string =>
  ((body as { contents: Array<{ role: string }> }).contents ?? []).map((c) => c.role).join(",");

const media = (kind: string): Json => ({
  functionResponse: {
    name: "view_image",
    response: { result: "" },
    parts: [{ [kind]: { mimeType: "image/png", data: "AAAA" } }],
  },
});

describe("dropGeminiTrailingThoughtOnlyContent", () => {
  const user = { role: "user", parts: [{ text: "hi" }] };

  it.each<[string, Json[], Json[]]>([
    [
      "drops trailing thought turns",
      [
        user,
        { role: "model", parts: [{ text: "a", thought: true }] },
        { role: "model", parts: [{ text: "b", thought: true, thoughtSignature: "sig" }] },
      ],
      [user],
    ],
    [
      "keeps visible model text",
      [user, { role: "model", parts: [{ text: "a", thought: true }, { text: "answer" }] }],
      [user, { role: "model", parts: [{ text: "a", thought: true }, { text: "answer" }] }],
    ],
    [
      "keeps function call",
      [
        user,
        { role: "model", parts: [{ thought: true, functionCall: { name: "run", args: {} } }] },
      ],
      [
        user,
        { role: "model", parts: [{ thought: true, functionCall: { name: "run", args: {} } }] },
      ],
    ],
    [
      "keeps earlier signed reasoning",
      [
        user,
        { role: "model", parts: [{ text: "a", thought: true, thoughtSignature: "sig" }] },
        { role: "user", parts: [{ text: "next" }] },
        { role: "model", parts: [{ text: "b", thought: true }] },
      ],
      [
        user,
        { role: "model", parts: [{ text: "a", thought: true, thoughtSignature: "sig" }] },
        { role: "user", parts: [{ text: "next" }] },
      ],
    ],
    [
      "keeps the only turn",
      [{ role: "model", parts: [{ text: "a", thought: true }] }],
      [{ role: "model", parts: [{ text: "a", thought: true }] }],
    ],
  ])("%s", (_name, contents, want) => {
    const out = dropGeminiTrailingThoughtOnlyContent({ contents }, "contents");

    expect((out as { contents: Json }).contents).toEqual(want);
  });

  it("works at a nested path and ignores a missing array", () => {
    const out = dropGeminiTrailingThoughtOnlyContent(
      { request: { contents: [user, { role: "model", parts: [{ text: "a", thought: true }] }] } },
      "request.contents",
    );

    expect(out).toEqual({ request: { contents: [user] } });
    expect(dropGeminiTrailingThoughtOnlyContent({}, "contents")).toEqual({});
  });
});

describe("ensureGeminiTrailingUserContent with function response media", () => {
  const call = { role: "model", parts: [{ functionCall: { name: "view_image" } }] };

  it.each(["inlineData", "inline_data", "fileData", "file_data"])(
    "appends an empty user turn after a model functionResponse with nested %s",
    (kind) => {
      const out = ensureGeminiTrailingUserContent(
        { contents: [call, { role: "model", parts: [media(kind)] }] },
        "contents",
      );

      expect(roles(out)).toBe("model,model,user");
      expect((out as { contents: Json[] }).contents[2]).toEqual({
        role: "user",
        parts: [{ text: "" }],
      });
    },
  );

  it("keeps a model functionResponse without media last", () => {
    const out = ensureGeminiTrailingUserContent(
      {
        contents: [
          call,
          {
            role: "model",
            parts: [{ functionResponse: { name: "x", response: { result: "ok" } } }],
          },
        ],
      },
      "contents",
    );

    expect(roles(out)).toBe("model,model");
  });

  it("leaves a user functionResponse turn with media unchanged", () => {
    const out = ensureGeminiTrailingUserContent(
      { contents: [call, { role: "user", parts: [media("inlineData")] }] },
      "contents",
    );

    expect(roles(out)).toBe("model,user");
  });
});

describe("trailing turns with dropThoughtOnlyTail", () => {
  const thought = { role: "model", parts: [{ text: "a", thought: true }] };
  const empty = { role: "user", parts: [{ text: "" }] };

  it("ends a thought-only conversation as a lone empty user turn, not [empty, thought, empty]", () => {
    const options = { dropThoughtOnlyTail: true };

    const boundary = ensureGeminiBoundaryUserContent({ contents: [thought] }, "contents", options);

    expect((boundary as { contents: Json }).contents).toEqual([empty]);

    const leadingThenTrailing = ensureGeminiTrailingUserContent(
      ensureGeminiLeadingUserContent({ contents: [thought] }, "contents"),
      "contents",
      options,
    );

    expect((leadingThenTrailing as { contents: Json }).contents).toEqual([empty]);
  });

  it("keeps a thought-only tail when the option is off", () => {
    const out = ensureGeminiBoundaryUserContent({ contents: [thought] }, "contents");

    expect((out as { contents: Json }).contents).toEqual([empty, thought, empty]);
  });

  it("reads a snake_case function_response as a response the model answers", () => {
    const answered = {
      role: "model",
      parts: [{ function_response: { name: "x", response: { result: "ok" } } }],
    };

    const out = ensureGeminiTrailingUserContent({ contents: [answered] }, "contents");

    expect(roles(out)).toBe("model");
  });
});
