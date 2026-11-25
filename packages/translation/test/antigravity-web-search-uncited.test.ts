// Web search grounding -> Claude text blocks: a support without a resolvable citation URL keeps its text (Go:
// internal/translator/antigravity/claude/antigravity_claude_response_test.go; upstream 1b730a1d).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { buildClaudeWebSearchContent } from "../src/translator/antigravity/claude/web-search.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

describe("uncited web search text (1b730a1d)", () => {
  it("keeps a grounding support's text when it has no chunk URL", () => {
    const text = "Hello world. Missing citation segment. Tail sentence.";

    const content = buildClaudeWebSearchContent(
      "srvtoolu_1",
      text,
      parse(
        `{"groundingChunks":[{"web":{"uri":"https://a.example","title":"A"}}],"groundingSupports":[{"segment":{"startIndex":13,"endIndex":38,"text":"Missing citation segment."}}]}`,
      ),
    );

    const textBlocks = content.filter((block) => get(block, "type") === "text");

    expect(textBlocks.map((block) => get(block, "text"))).toEqual([
      "Hello world. ",
      "Missing citation segment.",
      " Tail sentence.",
    ]);
    expect(get(textBlocks[1], "citations")).toBeUndefined();
  });
});
