// Claude -> OpenAI Chat Completions compat request translation (Go: internal/translator/openai/claude/
// openai_claude_compat_test.go; upstream 0e0cab0d).
import { describe, expect, it } from "vitest";
import { get, type Json } from "@commissary/json";
import {
  convertClaudeRequestToOpenAI,
  convertClaudeRequestToOpenAIWithCompat,
} from "../src/translator/openai/claude/request.ts";
import {
  convertOpenAIResponseToClaude,
  convertOpenAIResponseToClaudeNonStream,
} from "../src/translator/openai/claude/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const toolTurn = (extra: Record<string, unknown>, lead: Json[] = []): Json =>
  JSON.parse(
    JSON.stringify({
      ...extra,
      messages: [
        {
          role: "assistant",
          content: [...lead, { type: "tool_use", id: "call_1", name: "Read", input: {} }],
        },
      ],
    }),
  ) as Json;

const compat = (body: Json): Json =>
  convertClaudeRequestToOpenAIWithCompat("deepseek-v4", body, false);

describe("compat Claude request: placeholder reasoning_content", () => {
  it.each([
    [
      "enabled thinking with absent thinking block",
      toolTurn({ thinking: { type: "enabled", budget_tokens: 1024 } }),
    ],
    [
      "enabled thinking with whitespace-only thinking block",
      toolTurn({ thinking: { type: "enabled", budget_tokens: 1024 } }, [
        { type: "thinking", thinking: " ", signature: "" },
      ]),
    ],
    ["adaptive thinking with absent thinking block", toolTurn({ thinking: { type: "adaptive" } })],
    [
      "standalone output_config effort with absent thinking block",
      toolTurn({ output_config: { effort: "high" } }),
    ],
    [
      "model suffix high overrides disabled body",
      toolTurn({ model: "deepseek-v4(high)", thinking: { type: "disabled" } }),
    ],
  ])("adds a single-space placeholder: %s", (_name, body) => {
    const result = compat(body);
    expect(get(result, "messages.0.reasoning_content")).toBe(" ");
    expect(get(result, "messages.0.tool_calls")).toBeDefined();
  });

  it.each([
    ["no thinking in the request", toolTurn({})],
    ["thinking type disabled", toolTurn({ thinking: { type: "disabled" } })],
    ["thinking budget zero", toolTurn({ thinking: { type: "enabled", budget_tokens: 0 } })],
    ["output_config effort none", toolTurn({ output_config: { effort: "none" } })],
    [
      "model suffix none overrides enabled body",
      toolTurn({ model: "deepseek-v4(none)", thinking: { type: "enabled", budget_tokens: 1024 } }),
    ],
  ])("adds nothing: %s", (_name, body) => {
    const result = compat(body);
    expect(get(result, "messages.0.reasoning_content")).toBeUndefined();
    expect(get(result, "messages.0.tool_calls")).toBeDefined();
  });

  it("adds nothing to a text-only assistant turn", () => {
    const result = compat({
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "assistant", content: [{ type: "text", text: "Plain answer." }] }],
    });

    expect(get(result, "messages.0.reasoning_content")).toBeUndefined();
  });

  it("adds nothing without compat", () => {
    for (const body of [
      toolTurn({}),
      toolTurn({ thinking: { type: "enabled", budget_tokens: 1024 } }),
    ]) {
      const result = convertClaudeRequestToOpenAI("deepseek-v4", body, false);
      expect(get(result, "messages.0.reasoning_content")).toBeUndefined();
    }
  });
});

// OpenAI Chat Completions -> Claude response (Go: internal/translator/openai/claude/openai_claude_response_test.go;
// upstream c449529e, 9a7db8e3, 6044c5d1, 69637a66).
interface SseEvent {
  readonly type: string;
  readonly payload: Json;
}

const text = (value: Json | undefined): string => (typeof value === "string" ? value : "");

const streamRequest: Json = { stream: true };

const runStream = (...chunks: string[]): SseEvent[] => {
  const ctx: ResponseContext = {
    model: "m",
    originalRequest: streamRequest,
    translatedRequest: undefined,
    state: makeTranslationState(),
  };

  return [...chunks, "[DONE]"]
    .flatMap((chunk) => convertOpenAIResponseToClaude(ctx, `data: ${chunk}`))
    .flatMap((raw) =>
      raw
        .split("\n\n")
        .filter((block) => block.trim() !== "")
        .map((block) => {
          const data = block.split("\n").find((line) => line.startsWith("data:")) ?? "data: {}";
          const payload = JSON.parse(data.slice(5).trim()) as Json;

          return { type: text(get(payload, "type")), payload };
        }),
    );
};

const ofType = (events: SseEvent[], type: string): SseEvent[] =>
  events.filter((event) => event.type === type);

/** `type:text` per content block, in order, concatenating the deltas of each block. */
const blockTexts = (events: SseEvent[]): string[] => {
  const got: string[] = [];

  for (const event of events) {
    if (event.type === "content_block_start")
      got.push(`${text(get(event.payload, "content_block.type"))}:`);
    else if (event.type === "content_block_delta") {
      got[got.length - 1] +=
        text(get(event.payload, "delta.thinking")) + text(get(event.payload, "delta.text"));
    }
  }

  return got;
};

const finishChunk = `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`;

const baseContext = (): ResponseContext => ({
  model: "m",
  originalRequest: undefined,
  translatedRequest: undefined,
  state: makeTranslationState(),
});

/** The Claude body of a non-stream response through both entry points: the non-stream and the stream transform. */
const nonStream = (message: string, finishReason = `"stop"`): [Json, Json] => {
  const body = `{"id":"c1","model":"m","choices":[{"index":0,"message":${message},"finish_reason":${finishReason}}]}`;

  const viaNonStream = JSON.parse(
    convertOpenAIResponseToClaudeNonStream({ ...baseContext(), originalRequest: undefined }, body),
  ) as Json;

  const viaStreamEntry = JSON.parse(
    convertOpenAIResponseToClaude(
      { ...baseContext(), originalRequest: { stream: false } },
      `data: ${body}`,
    )[0] ?? "{}",
  ) as Json;

  return [viaNonStream, viaStreamEntry];
};

const toolCallMessage = (id: string, args: string): string =>
  `{"role":"assistant","content":null,"tool_calls":[{"id":"${id}","type":"function","function":{"name":"get_weather","arguments":${JSON.stringify(args)}}}]}`;

describe("non-stream stop reason with tool calls (c449529e)", () => {
  it.each([
    ["finish_reason stop", `"stop"`, "tool_use"],
    ["finish_reason null", "null", "tool_use"],
    ["finish_reason length", `"length"`, "max_tokens"],
    ["finish_reason content_filter", `"content_filter"`, "end_turn"],
  ])("tool_calls with %s", (_name, finish, expected) => {
    for (const out of nonStream(toolCallMessage("call_1", "{}"), finish))
      expect(get(out, "stop_reason")).toBe(expected);
  });

  it("tool_calls with an omitted finish_reason maps to tool_use", () => {
    const body = `{"id":"c1","model":"m","choices":[{"index":0,"message":${toolCallMessage("call_1", "{}")}}]}`;

    const out = JSON.parse(convertOpenAIResponseToClaudeNonStream(baseContext(), body)) as Json;
    expect(get(out, "stop_reason")).toBe("tool_use");
  });

  it("an empty tool_calls array stays end_turn", () => {
    for (const out of nonStream(`{"role":"assistant","content":"Done","tool_calls":[]}`))
      expect(get(out, "stop_reason")).toBe("end_turn");
  });
});

describe("streaming tool calls without index (c449529e)", () => {
  const call = (id: string, args: string): string =>
    `{"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"id":"${id}","type":"function","function":{"name":"get_weather","arguments":${JSON.stringify(args)}}}]}}]}`;

  const fragment = (args: string): string =>
    `{"choices":[{"index":0,"delta":{"tool_calls":[{"function":{"arguments":${JSON.stringify(args)}}}]}}]}`;

  const cities = (events: SseEvent[]): string[] =>
    ofType(events, "content_block_delta")
      .filter((event) => get(event.payload, "delta.type") === "input_json_delta")
      .map((event) =>
        text(get(JSON.parse(text(get(event.payload, "delta.partial_json"))) as Json, "city")),
      );

  it("keeps parallel calls from separate chunks apart", () => {
    const events = runStream(
      call("call_paris", `{"city":"Paris"}`),
      call("call_tokyo", `{"city":"Tokyo"}`),
      `{"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":"stop"}]}`,
    );

    expect(
      ofType(events, "content_block_start").map((e) => get(e.payload, "content_block.id")),
    ).toEqual(["call_paris", "call_tokyo"]);
    expect(cities(events)).toEqual(["Paris", "Tokyo"]);
    expect(ofType(events, "content_block_stop")).toHaveLength(2);
    expect(get(ofType(events, "message_delta")[0]!.payload, "delta.stop_reason")).toBe("tool_use");
  });

  it("keeps fragmented arguments with their own call", () => {
    const events = runStream(
      call("call_paris", `{"city":`),
      fragment(`"Paris"}`),
      call("call_tokyo", `{"city":`),
      fragment(`"Tokyo"}`),
      `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    );

    expect(
      ofType(events, "content_block_start").map((e) => get(e.payload, "content_block.id")),
    ).toEqual(["call_paris", "call_tokyo"]);
    expect(cities(events)).toEqual(["Paris", "Tokyo"]);
    expect(get(ofType(events, "message_delta")[0]!.payload, "delta.stop_reason")).toBe("tool_use");
  });
});

describe("message_delta waits for the trailing usage chunk (9a7db8e3)", () => {
  const usageBase = `"prompt_tokens":140025,"completion_tokens":741,"total_tokens":140766`;

  it.each([
    [
      "text with stop",
      `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}`,
      `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{${usageBase},"prompt_tokens_details":{}}}`,
      "end_turn",
    ],
    [
      "tool call with tool_calls",
      `{"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}`,
      `{"id":"c1","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{${usageBase},"prompt_tokens_details":{}}}`,
      "tool_use",
    ],
  ])("preserves cached tokens: %s", (_name, first, finish, stopReason) => {
    const trailing = `{"id":"c1","model":"m","choices":[],"usage":{${usageBase},"prompt_tokens_details":{"cached_tokens":139136}}}`;
    const events = runStream(first, finish, trailing);

    expect(ofType(events, "message_delta")).toHaveLength(1);
    expect(ofType(events, "message_stop")).toHaveLength(1);
    expect(events[events.length - 1]!.type).toBe("message_stop");
    const delta = ofType(events, "message_delta")[0]!.payload;
    expect(get(delta, "delta.stop_reason")).toBe(stopReason);
    expect(get(delta, "usage.cache_read_input_tokens")).toBe(139136);
    expect(get(delta, "usage.input_tokens")).toBe(889);
    expect(get(delta, "usage.output_tokens")).toBe(741);
  });
});

describe("typed thinking content-part arrays (6044c5d1)", () => {
  it("streams thinking parts as thinking blocks, then text", () => {
    const events = runStream(
      `{"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"The"}],"closed":true}]},"finish_reason":null}]}`,
      `{"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":" done."}],"closed":true},{"type":"text","text":"hello"}]},"finish_reason":null}]}`,
      `{"choices":[{"index":0,"delta":{"index":0,"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":19,"total_tokens":57,"completion_tokens":38}}`,
    );

    expect(
      ofType(events, "content_block_start").map((e) => get(e.payload, "content_block.type")),
    ).toEqual(["thinking", "text"]);
    expect(blockTexts(events)).toEqual(["thinking:The done.", "text:hello"]);
  });

  it("maps plain thinking and reasoning parts and passes unknown parts through as text", () => {
    const events = runStream(
      `{"choices":[{"index":0,"delta":{"content":[]},"finish_reason":null}]}`,
      `{"choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":"step 1"},{"type":"reasoning","text":" step 2"},{"type":"text","text":"answer: "},{"type":"custom_part","payload":"raw"}]},"finish_reason":null}]}`,
      `{"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
    );

    expect(blockTexts(events)).toEqual([
      "thinking:step 1 step 2",
      `text:answer: {"type":"custom_part","payload":"raw"}`,
    ]);
  });

  it("orders non-stream thinking before text for content-part arrays and top-level reasoning", () => {
    const parts = nonStream(
      `{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"First "},{"type":"text","text":"thought."}],"closed":true},{"type":"text","text":"hello"}]}`,
    );

    for (const out of parts)
      expect(get(out, "content")).toEqual([
        { type: "thinking", thinking: "First thought." },
        { type: "text", text: "hello" },
      ]);

    const top = nonStream(
      `{"role":"assistant","content":"Final answer","reasoning_content":"Step by step"}`,
    );

    for (const out of top)
      expect(get(out, "content")).toEqual([
        { type: "thinking", thinking: "Step by step" },
        { type: "text", text: "Final answer" },
      ]);
  });
});

describe("whitespace-only reasoning never opens a thinking block (69637a66)", () => {
  const tool = `{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":"{}"}}]}`;

  it.each([
    ["whitespace only then text", [`{"reasoning_content":" "}`, `{"content":"Hi"}`], ["text:Hi"]],
    [
      "whitespace inside a thought",
      [`{"reasoning_content":"a"}`, `{"reasoning_content":"\\n\\n"}`, `{"reasoning_content":"b"}`],
      ["thinking:a\n\nb"],
    ],
    [
      "whitespace after text closed the thought",
      [
        `{"reasoning_content":"a"}`,
        `{"content":"x"}`,
        `{"reasoning_content":" "}`,
        `{"content":"y"}`,
      ],
      ["thinking:a", "text:xy"],
    ],
    [
      "whitespace only while a tool call is open",
      [tool, `{"reasoning_content":" "}`],
      ["tool_use:"],
    ],
    [
      "whitespace inside a thought while a tool call is open",
      [tool, `{"reasoning_content":"a"}`, `{"reasoning_content":" "}`, `{"reasoning_content":"b"}`],
      ["tool_use:", "thinking:a b"],
    ],
  ])("streaming: %s", (_name, deltas, want) => {
    const chunks = deltas.map(
      (delta) =>
        `{"id":"c1","model":"m","choices":[{"index":0,"delta":${delta},"finish_reason":null}]}`,
    );

    expect(blockTexts(runStream(...chunks, finishChunk))).toEqual(want);
  });

  it.each([
    [
      "whitespace only reasoning_content",
      `{"role":"assistant","content":"Hi","reasoning_content":" "}`,
      ["text:Hi"],
    ],
    [
      "whitespace only thinking part",
      `{"role":"assistant","content":[{"type":"thinking","thinking":" "},{"type":"text","text":"Hi"}]}`,
      ["text:Hi"],
    ],
    [
      "whitespace inside thinking parts",
      `{"role":"assistant","content":[{"type":"thinking","thinking":"a"},{"type":"thinking","thinking":" "},{"type":"thinking","thinking":"b"},{"type":"text","text":"Hi"}]}`,
      ["thinking:a b", "text:Hi"],
    ],
  ])("non-stream: %s", (_name, message, want) => {
    for (const out of nonStream(message)) {
      const blocks = get(out, "content") as Json[];

      expect(
        blocks.map(
          (block) =>
            `${text(get(block, "type"))}:${text(get(block, "thinking")) + text(get(block, "text"))}`,
        ),
      ).toEqual(want);
    }
  });
});
