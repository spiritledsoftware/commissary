// Claude document blocks with text, content and URL sources, in messages and tool results (Go:
// internal/translator/common/claude_messages_test.go, internal/translator/{codex,openai,interactions}/claude/*_test.go;
// upstream e21cf8a5, e1384430).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json, tryParseJson } from "@commissary/json";
import { convertClaudeRequestToCodex } from "../src/translator/codex/claude/request.ts";
import {
  claudeDocumentHeader,
  claudeDocumentTextBlock,
  expandClaudeContentDocument,
} from "../src/translator/common/claude-documents.ts";
import { convertClaudeRequestToInteractions } from "../src/translator/interactions/claude/request.ts";
import { convertClaudeRequestToOpenAI } from "../src/translator/openai/claude/request.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const userTurn = (content: string): Json =>
  parse(`{"messages":[{"role":"user","content":[${content}]}]}`);

/** A user turn, then an assistant tool call answered by a tool_result with `content`. */
const toolTurn = (content: string): Json =>
  parse(
    `{"messages":[{"role":"user","content":"go"},{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"read","input":{}}]},{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":${content}}]}]}`,
  );

describe("Claude document helpers (e21cf8a5)", () => {
  it("formats the title and context header", () => {
    expect(claudeDocumentHeader(parse(`{"title":" T ","context":" C "}`))).toBe(
      "Document: T\nContext: C",
    );
    expect(claudeDocumentHeader(parse(`{"context":"C"}`))).toBe("Context: C");
    expect(claudeDocumentHeader(parse(`{}`))).toBe("");
  });

  it("formats a text document with its header", () => {
    expect(
      claudeDocumentTextBlock(
        parse(`{"type":"document","title":"T","source":{"type":"text","data":"body"}}`),
      ),
    ).toBe("Document: T\nbody");
    expect(
      claudeDocumentTextBlock(parse(`{"type":"document","source":{"type":"text","data":"  "}}`)),
    ).toBeUndefined();
    expect(
      claudeDocumentTextBlock(parse(`{"type":"document","source":{"type":"base64","data":"x"}}`)),
    ).toBeUndefined();
  });

  it("expands a content document, header first, only when something converts", () => {
    const emitted: string[] = [];
    let drops = 0;

    const ok = expandClaudeContentDocument(
      parse(
        `{"type":"document","title":"T","source":{"type":"content","content":["a",{"type":"text","text":"b"},{"type":"image","source":{"type":"url","url":"x"}},{"type":"image","source":{"type":"base64","data":"Zg=="}},{"type":"text","text":" "}]}}`,
      ),
      (text) => emitted.push(`text:${text}`),
      (image) =>
        get(image, "source.type") === "base64"
          ? { converted: get(image, "source.data") }
          : undefined,
      (image) => emitted.push(`image:${JSON.stringify(image)}`),
      () => drops++,
    );

    expect(ok).toBe(true);
    expect(emitted).toEqual(["text:Document: T", "text:a", "text:b", `image:{"converted":"Zg=="}`]);
    expect(drops).toBe(1);

    const none: string[] = [];

    expect(
      expandClaudeContentDocument(
        parse(`{"type":"document","title":"T","source":{"type":"content","content":[" "]}}`),
        (text) => none.push(text),
      ),
    ).toBe(false);
    expect(none).toEqual([]);
  });
});

describe("Claude -> Codex documents (e21cf8a5, e1384430)", () => {
  it("sends text, content and URL documents", () => {
    const out = convertClaudeRequestToCodex(
      "gpt-5.4",
      userTurn(
        `{"type":"document","title":"Notes","source":{"type":"text","data":"hello"}},{"type":"document","source":{"type":"content","content":[{"type":"text","text":"inner"}]}},{"type":"document","title":"spec.pdf","source":{"type":"url","url":"https://example.com/spec.pdf"}},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}}`,
      ),
      false,
    );

    expect(get(out, "input.0.content")).toEqual([
      { type: "input_text", text: "Document: Notes\nhello" },
      { type: "input_text", text: "inner" },
      { type: "input_file", file_url: "https://example.com/spec.pdf", filename: "spec.pdf" },
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
    ]);
  });

  it("converts tool_result documents and images, with a placeholder for the rest", () => {
    const out = convertClaudeRequestToCodex(
      "gpt-5.4",
      toolTurn(
        `[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}},{"type":"document","source":{"type":"text","data":"plain"}},{"type":"document","source":{"type":"base64","media_type":"text/csv","data":"YQ=="}},{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}]`,
      ),
      false,
    );

    const input = get(out, "input");

    const output = Array.isArray(input)
      ? get(
          input.find((item) => get(item, "type") === "function_call_output"),
          "output",
        )
      : undefined;

    expect(output).toEqual([
      {
        type: "input_file",
        file_data: "data:application/pdf;base64,JVBE",
        filename: "document.pdf",
      },
      { type: "input_text", text: "plain" },
      { type: "input_text", text: "[Unsupported document content]" },
      { type: "input_image", image_url: "https://example.com/a.png" },
    ]);
  });

  it("converts a single tool_result document object", () => {
    const out = convertClaudeRequestToCodex(
      "gpt-5.4",
      toolTurn(`{"type":"document","source":{"type":"text","data":"plain"}}`),
      false,
    );

    const input = get(out, "input");

    const output = Array.isArray(input)
      ? get(
          input.find((item) => get(item, "type") === "function_call_output"),
          "output",
        )
      : undefined;

    expect(output).toEqual([{ type: "input_text", text: "plain" }]);
  });
});

describe("Claude -> OpenAI Chat documents (e21cf8a5, e1384430)", () => {
  it("sends text and content documents as text parts and names files by title", () => {
    const out = convertClaudeRequestToOpenAI(
      "gpt-4o",
      userTurn(
        `{"type":"document","title":"Notes","context":"ctx","source":{"type":"text","data":"hello"}},{"type":"document","source":{"type":"content","content":"inner"}},{"type":"document","title":"a.pdf","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}}`,
      ),
      false,
    );

    expect(get(out, "messages.0.content")).toEqual([
      { type: "text", text: "Document: Notes\nContext: ctx\nhello" },
      { type: "text", text: "inner" },
      { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,JVBE" } },
    ]);
  });

  it("relays tool_result documents in the next user message", () => {
    const out = convertClaudeRequestToOpenAI(
      "gpt-4o",
      toolTurn(
        `[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}}]`,
      ),
      false,
    );

    const messages = get(out, "messages");

    expect(Array.isArray(messages) ? messages.slice(2) : undefined).toEqual([
      {
        role: "tool",
        tool_call_id: "toolu_1",
        name: "read",
        content: "[Tool returned document content; the documents follow in the next user message.]",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Documents returned by the preceding tool call(s):" },
          { type: "file", file: { filename: "", file_data: "data:application/pdf;base64,JVBE" } },
        ],
      },
    ]);
  });

  it("labels mixed relayed media and keeps text documents in the tool message", () => {
    const out = convertClaudeRequestToOpenAI(
      "gpt-4o",
      toolTurn(
        `[{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"JVBE"}},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO"}}]`,
      ),
      false,
    );

    expect(get(out, "messages.2.content")).toBe(
      "[Tool returned media content; the attachments follow in the next user message.]",
    );
    expect(get(out, "messages.3.content.0.text")).toBe(
      "Media returned by the preceding tool call(s):",
    );

    const text = convertClaudeRequestToOpenAI(
      "gpt-4o",
      toolTurn(
        `[{"type":"document","source":{"type":"text","data":"plain"}},{"type":"document","source":{"type":"file","file_id":"f"}}]`,
      ),
      false,
    );

    expect(get(text, "messages.2.content")).toBe("plain\n\n[Unsupported document content]");
  });
});

describe("Claude -> Interactions documents (e21cf8a5)", () => {
  it("sends text documents as text and URL media as uri parts", () => {
    const out = convertClaudeRequestToInteractions(
      "gemini-3.1-flash-lite",
      userTurn(
        `{"type":"document","title":"Notes","source":{"type":"text","data":"hello"}},{"type":"document","source":{"type":"url","url":"https://example.com/a.pdf"}},{"type":"image","source":{"type":"url","url":"https://example.com/a.png"}}`,
      ),
      false,
    );

    expect(get(out, "input.0.content")).toEqual([
      { type: "text", text: "Document: Notes\nhello" },
      { type: "document", uri: "https://example.com/a.pdf", mime_type: "application/pdf" },
      { type: "image", uri: "https://example.com/a.png" },
    ]);
  });
});
