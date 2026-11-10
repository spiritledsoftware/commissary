// Codex commentary phase <-> Claude thinking blocks (Go: internal/translator/codex/claude/
// codex_claude_commentary_{phase,replay,cross_format}_test.go and internal/signature/claude_messages_sanitize_compat_test.go;
// upstream 376015c3, 531721bf).
import { describe, expect, it } from "vitest";
import { asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  restoreCodexCommentaryMarkers,
  sanitizeClaudeMessagesSignaturesForModel,
} from "../src/signature/claude-messages.ts";
import { convertClaudeRequestToAntigravity } from "../src/translator/antigravity/claude/request.ts";
import {
  convertClaudeRequestToCodex,
  convertClaudeRequestToCodexWithCompat,
} from "../src/translator/codex/claude/request.ts";
import {
  convertCodexResponseToClaude,
  convertCodexResponseToClaudeNonStream,
} from "../src/translator/codex/claude/response.ts";
import {
  convertClaudeRequestToGemini,
  convertClaudeRequestToGeminiWithCompat,
} from "../src/translator/gemini/claude/request.ts";
import {
  convertClaudeRequestToInteractions,
  convertClaudeRequestToInteractionsWithCompat,
} from "../src/translator/interactions/claude/request.ts";
import {
  convertClaudeRequestToOpenAI,
  convertClaudeRequestToOpenAIWithCompat,
} from "../src/translator/openai/claude/request.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const MARKER = "cpa:commentary:v1";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (): ResponseContext => ({
  model: "gpt-5",
  originalRequest: parse(`{"messages":[]}`),
  translatedRequest: undefined,
  state: makeTranslationState(),
});

interface Blocks {
  text: string[];
  thinking: string[];
  signatures: string[];
}

const collectStreamBlocks = (lines: readonly string[]): Blocks => {
  const ctx = context();
  const blocks: Blocks = { text: [], thinking: [], signatures: [] };
  let current = "";
  let currentType = "";

  for (const line of lines) {
    for (const chunk of convertCodexResponseToClaude(ctx, `data: ${line}`)) {
      for (const sse of chunk.split("\n")) {
        if (!sse.startsWith("data: ")) continue;
        const data = parse(sse.slice(6));

        switch (get(data, "type")) {
          case "content_block_start":
            currentType = asString(get(data, "content_block.type"));
            current = "";
            break;
          case "content_block_delta":
            switch (get(data, "delta.type")) {
              case "text_delta":
                current += asString(get(data, "delta.text"));
                break;
              case "thinking_delta":
                current += asString(get(data, "delta.thinking"));
                break;
              case "signature_delta":
                blocks.signatures.push(asString(get(data, "delta.signature")));
                break;
            }

            break;
          case "content_block_stop":
            if (currentType === "text") blocks.text.push(current);

            if (currentType === "thinking") blocks.thinking.push(current);
            currentType = "";
            break;
        }
      }
    }
  }

  return blocks;
};

const completed = `{"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}`;

const created = `{"type":"response.created","response":{"id":"resp_1","model":"gpt-5"}}`;

const msgAdded = (phase: string) =>
  `{"type":"response.output_item.added","item":{"type":"message","role":"assistant","phase":"${phase}"}}`;

const msgDone = (phase: string, text: string) =>
  `{"type":"response.output_item.done","item":{"type":"message","role":"assistant","phase":"${phase}","content":[{"type":"output_text","text":"${text}"}]}}`;

const delta = (text: string) => `{"type":"response.output_text.delta","delta":"${text}"}`;

const partAdded = `{"type":"response.content_part.added","part":{"type":"output_text"}}`;

const partDone = (text: string) =>
  `{"type":"response.content_part.done","part":{"type":"output_text","text":"${text}"}}`;

describe("Codex commentary -> Claude response", () => {
  it("streams a commentary message as one marked thinking block and the final answer as text", () => {
    const got = collectStreamBlocks([
      created,
      msgAdded("commentary"),
      partAdded,
      delta("Checking the "),
      delta("gate first."),
      partDone("Checking the gate first."),
      msgDone("commentary", "Checking the gate first."),
      msgAdded("final_answer"),
      partAdded,
      delta("The merge was refused."),
      partDone("The merge was refused."),
      msgDone("final_answer", "The merge was refused."),
      completed,
    ]);

    expect(got.thinking).toEqual(["Checking the gate first."]);
    expect(got.text).toEqual(["The merge was refused."]);
    expect(got.signatures).toEqual([MARKER]);
  });

  it("emits commentary that only arrives on output_item.done as thinking", () => {
    const got = collectStreamBlocks([
      created,
      msgDone("commentary", "On it."),
      msgDone("final_answer", "Done: two PRs merged."),
      completed,
    ]);

    expect(got.thinking).toEqual(["On it."]);
    expect(got.text).toEqual(["Done: two PRs merged."]);
    expect(got.signatures).toEqual([MARKER]);
  });

  it("keeps a parked reasoning signature for the reasoning block, not the commentary block", () => {
    const got = collectStreamBlocks([
      created,
      `{"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"parked_sig"}}`,
      msgAdded("commentary"),
      delta("Checking."),
      msgDone("commentary", "Checking."),
      `{"type":"response.output_item.done","item":{"type":"reasoning","summary":[],"encrypted_content":""}}`,
      completed,
    ]);

    // The reasoning item has no streamed summary, so its block is signature-only.
    expect(got.thinking).toEqual(["Checking.", ""]);
    expect(got.signatures).toEqual([MARKER, "parked_sig"]);
  });

  it("closes an unclosed reasoning block with its fallback signature before commentary starts", () => {
    const got = collectStreamBlocks([
      created,
      `{"type":"response.output_item.added","item":{"type":"reasoning","encrypted_content":"enc_fallback"}}`,
      `{"type":"response.reasoning_summary_part.added"}`,
      `{"type":"response.reasoning_summary_text.delta","delta":"Reasoning step"}`,
      msgAdded("commentary"),
      partAdded,
      delta("Commentary step"),
      partDone("Commentary step"),
      msgDone("commentary", "Commentary step"),
      completed,
    ]);

    expect(got.thinking).toEqual(["Reasoning step", "Commentary step"]);
    expect(got.signatures).toEqual(["enc_fallback", MARKER]);
  });

  it("leaves a final_answer-only stream as text", () => {
    const got = collectStreamBlocks([
      created,
      msgAdded("final_answer"),
      delta("Hi."),
      msgDone("final_answer", "Hi."),
      completed,
    ]);

    expect(got).toEqual({ text: ["Hi."], thinking: [], signatures: [] });
  });

  it("maps a non-stream commentary message to a marked thinking block", () => {
    const body = JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-5",
        output: [
          {
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: "COMMENTARY_SENTINEL" }],
          },
          {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "FINAL_SENTINEL" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

    const out = parse(convertCodexResponseToClaudeNonStream(context(), body));

    expect(get(out, "content")).toEqual([
      { type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER },
      { type: "text", text: "FINAL_SENTINEL" },
    ]);
  });
});

const replay = (assistant: Json[]): Json =>
  parse(
    JSON.stringify({
      model: "gpt-6.1-sol",
      messages: [
        { role: "user", content: "First turn" },
        { role: "assistant", content: assistant },
        { role: "user", content: "Next turn" },
      ],
    }),
  );

describe("Claude replay of marked commentary", () => {
  it("restores a marked thinking block as an assistant commentary message for Codex", () => {
    const out = convertClaudeRequestToCodex(
      "gpt-6.1-sol",
      replay([
        { type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER },
        { type: "text", text: "FINAL_SENTINEL" },
      ]),
      false,
    );

    expect(JSON.stringify(out)).not.toContain(MARKER);
    expect(get(out, "input")).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "First turn" }] },
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "COMMENTARY_SENTINEL" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "FINAL_SENTINEL" }],
      },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Next turn" }] },
    ]);
  });

  it("keeps commentary before a tool call across the tool round trip", () => {
    const request = parse(
      JSON.stringify({
        model: "gpt-6.1-sol",
        messages: [
          { role: "user", content: "First turn" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
          },
        ],
      }),
    );

    const out = convertClaudeRequestToCodex("gpt-6.1-sol", request, true);
    const input = get(out, "input") as Json[];

    expect(JSON.stringify(out)).not.toContain(MARKER);
    expect(input.map((item) => get(item, "type"))).toEqual([
      "message",
      "message",
      "function_call",
      "function_call_output",
    ]);
    expect(get(input[1], "phase")).toBe("commentary");
    expect(get(input[1], "content.0.text")).toBe("COMMENTARY_SENTINEL");
  });

  it("restores commentary rather than reasoning in compat mode", () => {
    const out = convertClaudeRequestToCodexWithCompat(
      "deepseek-v4",
      parse(
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER }],
            },
          ],
        }),
      ),
      false,
    );

    expect(get(out, "input")).toEqual([
      {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "COMMENTARY_SENTINEL" }],
      },
    ]);
  });

  it("round-trips a non-stream response through the request translator", () => {
    const body = JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        model: "gpt-5",
        output: [
          {
            type: "message",
            phase: "commentary",
            content: [{ type: "output_text", text: "COMMENTARY_SENTINEL" }],
          },
          {
            type: "message",
            phase: "final_answer",
            content: [{ type: "output_text", text: "FINAL_SENTINEL" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });

    const content = get(parse(convertCodexResponseToClaudeNonStream(context(), body)), "content");
    const out = convertClaudeRequestToCodex("gpt-6.1-sol", replay(content as Json[]), false);
    const text = JSON.stringify(out);

    expect(text).toContain("COMMENTARY_SENTINEL");
    expect(text).toContain("FINAL_SENTINEL");
    expect(text).not.toContain(MARKER);
  });
});

const payload = (): Json =>
  parse(
    JSON.stringify({
      model: "test-model",
      messages: [
        { role: "user", content: "First turn" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER },
            { type: "text", text: "FINAL_SENTINEL" },
          ],
        },
        { role: "user", content: "Next turn" },
      ],
    }),
  );

const expectRestored = (out: Json) => {
  const text = JSON.stringify(out);

  expect(text).not.toContain(MARKER);
  expect(text).toContain("COMMENTARY_SENTINEL");
  expect(text).toContain("FINAL_SENTINEL");
  expect(text).not.toContain('"thought":true');
  expect(text).not.toContain('"type":"thought"');
};

describe("marker restore for non-Codex targets", () => {
  it("restores the marker as text in every Claude request translator", () => {
    for (const convert of [
      convertClaudeRequestToOpenAI,
      convertClaudeRequestToOpenAIWithCompat,
      convertClaudeRequestToGemini,
      convertClaudeRequestToGeminiWithCompat,
      convertClaudeRequestToInteractions,
      convertClaudeRequestToInteractionsWithCompat,
      convertClaudeRequestToAntigravity,
    ])
      expectRestored(convert("test-model", payload(), false));
  });

  it("does not mutate the caller's request", () => {
    const input = payload();
    const before = JSON.stringify(input);

    convertClaudeRequestToOpenAI("test-model", input, false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("restoreCodexCommentaryMarkers rewrites marked blocks and passes other payloads through", () => {
    const { payload: out, restored } = restoreCodexCommentaryMarkers(payload());

    expect(restored).toBe(1);
    expect(get(out, "messages.1.content")).toEqual([
      { type: "text", text: "COMMENTARY_SENTINEL" },
      { type: "text", text: "FINAL_SENTINEL" },
    ]);

    const untouched = parse(
      `{"messages":[{"role":"assistant","content":[{"type":"thinking","thinking":"reason","signature":"opaque-deepseek-id"}]}]}`,
    );

    const result = restoreCodexCommentaryMarkers(untouched);

    expect(result.restored).toBe(0);
    expect(result.payload).toBe(untouched);
  });

  it("drops an empty marked block and a message left empty", () => {
    const { payload: out, restored } = restoreCodexCommentaryMarkers(
      parse(
        JSON.stringify({
          messages: [
            { role: "user", content: "hi" },
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "", signature: MARKER }],
            },
          ],
        }),
      ),
    );

    expect(restored).toBe(1);
    expect(get(out, "messages")).toEqual([{ role: "user", content: "hi" }]);
  });

  it("the signature sanitizer restores the marker as text for any target model", () => {
    for (const model of ["claude-sonnet-5", "gpt-5.4", "gemini-3.5-flash", "unknown-model"]) {
      const body = parse(
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              content: [{ type: "thinking", thinking: "COMMENTARY_SENTINEL", signature: MARKER }],
            },
          ],
        }),
      );

      sanitizeClaudeMessagesSignaturesForModel(body, model);
      expect(get(body, "messages.0.content")).toEqual([
        { type: "text", text: "COMMENTARY_SENTINEL" },
      ]);
    }
  });
});
