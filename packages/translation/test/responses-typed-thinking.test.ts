// Typed thinking content-part arrays, Chat Completions -> Responses (Go:
// internal/translator/openai/openai/responses/openai_openai-responses_response_test.go; upstream c3a6c741).
import { describe, expect, it } from "vite-plus/test";
import { asInt, asString, get, type Json, tryParseJson } from "@commissary/json";
import {
  convertOpenAIChatCompletionsResponseToOpenAIResponses,
  convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream,
} from "../src/translator/openai/openai/responses/response.ts";
import { makeTranslationState, type ResponseContext } from "../src/translator/registry.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON in test: ${text}`);

  return value;
};

const context = (model: string): ResponseContext => {
  const request = parse(`{"model":"${model}"}`);

  return {
    model,
    originalRequest: request,
    translatedRequest: request,
    state: makeTranslationState(),
  };
};

interface SseEvent {
  readonly event: string;
  readonly data: Json;
}

const lineValue = (lines: ReadonlyArray<string>, prefix: string): string =>
  lines
    .find((line) => line.startsWith(prefix))
    ?.slice(prefix.length)
    .trim() ?? "";

const events = (chunks: ReadonlyArray<string>): SseEvent[] =>
  chunks.map((chunk) => {
    const lines = chunk.split("\n");

    return { event: lineValue(lines, "event:"), data: parse(lineValue(lines, "data:")) };
  });

const run = (ctx: ResponseContext, ...lines: string[]): SseEvent[] =>
  events(
    lines.flatMap((line) => [...convertOpenAIChatCompletionsResponseToOpenAIResponses(ctx, line)]),
  );

const s = (value: Json | undefined): string => asString(value);

describe("OpenAI Chat Completions -> Responses stream: typed content parts (c3a6c741)", () => {
  it("splits a typed delta.content array into reasoning and message items", () => {
    const id = "bf39068555d24f22aaa60dc43231a002";
    const head = `"id":"${id}","object":"chat.completion.chunk","created":1794374142,"model":"deepseek-v4-1-flash-1017"`;

    const out = run(
      context("deepseek-v4-1-flash-1017"),
      `data: {${head},"choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"The"}],"closed":true}]},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"erse."}],"closed":true},{"type":"text","text":"收到，链路"}]},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{"index":0,"content":"正常"},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{"index":0,"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"total_tokens":62,"completion_tokens":31,"completion_tokens_details":{"reasoning_tokens":21}}}`,
      `data: [DONE]`,
    );

    const transitions = out.flatMap(({ event, data }) =>
      event === "response.output_item.added" || event === "response.output_item.done"
        ? [
            `${event === "response.output_item.added" ? "added" : "done"}:${s(get(data, "item.type"))}:${asInt(get(data, "output_index"))}`,
          ]
        : [],
    );

    expect(transitions).toEqual([
      "added:reasoning:0",
      "done:reasoning:0",
      "added:message:1",
      "done:message:1",
    ]);

    const of = (event: string, path: string): string[] =>
      out.filter((e) => e.event === event).map((e) => s(get(e.data, path)));

    expect(of("response.reasoning_summary_text.delta", "delta")).toEqual(["The", "erse."]);
    expect(of("response.reasoning_summary_text.done", "text")).toEqual(["Theerse."]);
    expect(of("response.output_text.delta", "delta")).toEqual(["收到，链路", "正常"]);
    expect(of("response.output_text.done", "text")).toEqual(["收到，链路正常"]);

    const completed = out.find((e) => e.event === "response.completed")?.data;

    expect(get(completed, "response.output")).toHaveLength(2);
    expect(get(completed, "response.output.0.type")).toBe("reasoning");
    expect(get(completed, "response.output.0.summary.0.text")).toBe("Theerse.");
    expect(get(completed, "response.output.1.type")).toBe("message");
    expect(get(completed, "response.output.1.content.0.text")).toBe("收到，链路正常");
    expect(get(completed, "response.usage.output_tokens_details.reasoning_tokens")).toBe(21);
  });

  it("keeps interleaved text -> thinking -> text segments sequential with distinct ids", () => {
    const out = run(
      context("zai-glm-5-3"),
      `data: {"id":"chatcmpl_interleaved","object":"chat.completion.chunk","created":1773896263,"model":"zai-glm-5-3","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"First. "},{"type":"thinking","thinking":"Reconsidering..."},{"type":"text","text":"Second."}]},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    );

    const transitions = out.flatMap(({ event, data }) =>
      event === "response.output_item.added" || event === "response.output_item.done"
        ? [
            `${event === "response.output_item.added" ? "added" : "done"}:${s(get(data, "item.type"))}:${asInt(get(data, "output_index"))}:${s(get(data, "item.id"))}`,
          ]
        : [],
    );

    expect(transitions).toEqual([
      "added:message:0:msg_chatcmpl_interleaved_0",
      "done:message:0:msg_chatcmpl_interleaved_0",
      "added:reasoning:1:rs_chatcmpl_interleaved_0",
      "done:reasoning:1:rs_chatcmpl_interleaved_0",
      "added:message:2:msg_chatcmpl_interleaved_0_1",
      "done:message:2:msg_chatcmpl_interleaved_0_1",
    ]);

    const completed = out.find((e) => e.event === "response.completed")?.data;

    expect(get(completed, "response.output")).toHaveLength(3);
    expect(get(completed, "response.output.0.content.0.text")).toBe("First. ");
    expect(get(completed, "response.output.1.summary.0.text")).toBe("Reconsidering...");
    expect(get(completed, "response.output.2.content.0.text")).toBe("Second.");
  });

  for (const tc of [
    { finishReason: "length", incompleteReason: "max_output_tokens" },
    { finishReason: "content_filter", incompleteReason: "content_filter" },
  ]) {
    it(`preserves a closed message's status when truncated (${tc.finishReason})`, () => {
      const out = run(
        context("zai-glm-5-3"),
        `data: {"id":"chatcmpl_trunc","object":"chat.completion.chunk","created":1773896263,"model":"zai-glm-5-3","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Completed prefix."},{"type":"thinking","thinking":"Thinking..."}]},"finish_reason":null}]}`,
        `data: {"id":"chatcmpl_trunc","object":"chat.completion.chunk","created":1773896263,"model":"zai-glm-5-3","choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Truncated tail"}]},"finish_reason":"${tc.finishReason}"}]}`,
        `data: [DONE]`,
      );

      const doneStatusById = new Map<string, string>();

      for (const { event, data } of out) {
        if (event === "response.output_item.done" && get(data, "item.type") === "message")
          doneStatusById.set(s(get(data, "item.id")), s(get(data, "item.status")));
      }

      const terminal = out.find((e) => e.event === "response.incomplete")?.data;

      expect(terminal).toBeDefined();
      expect(get(terminal, "response.incomplete_details.reason")).toBe(tc.incompleteReason);
      expect(doneStatusById.get("msg_chatcmpl_trunc_0")).toBe("completed");
      expect(doneStatusById.get("msg_chatcmpl_trunc_0_1")).toBe("incomplete");
      expect(get(terminal, "response.output.0.status")).toBe("completed");
      expect(get(terminal, "response.output.2.status")).toBe("incomplete");
    });
  }

  it("maps content-part variants to reasoning and text deltas", () => {
    const head = `"id":"chatcmpl_variants","object":"chat.completion.chunk","created":1773896263,"model":"zai-glm-5-3"`;

    const out = run(
      context("zai-glm-5-3"),
      `data: {${head},"choices":[{"index":0,"delta":{"content":[]},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":"step 1"},{"type":"reasoning","text":" step 2"},{"type":"output_text","text":"answer: "},{"type":"refusal","refusal":"blocked "},"plain ",{"type":"custom_part","payload":"raw"}]},"finish_reason":null}]}`,
      `data: {${head},"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
      `data: [DONE]`,
    );

    const of = (event: string): string[] =>
      out.filter((e) => e.event === event).map((e) => s(get(e.data, "delta")));

    expect(of("response.reasoning_summary_text.delta").join("")).toBe("step 1 step 2");
    expect(of("response.output_text.delta")).toEqual([
      "answer: ",
      "blocked ",
      "plain ",
      `{"type":"custom_part","payload":"raw"}`,
    ]);
  });

  it("finalizes a reasoning-only stream with finish_reason length as response.incomplete", () => {
    const ctx = context("deepseek-v4-1-flash-1017");

    const before = run(
      ctx,
      `data: {"id":"chatcmpl_len_thinking","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"index":0,"content":[{"type":"thinking","thinking":[{"type":"text","text":"exhausted budget"}],"closed":true}]},"finish_reason":null}]}`,
      `data: {"id":"chatcmpl_len_thinking","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":20}}}`,
    );

    expect(before.map((e) => e.event)).not.toContain("response.completed");
    expect(ctx.state.canFinalize).toBe(true);

    const incomplete = run(ctx, "data: [DONE]").find(
      (e) => e.event === "response.incomplete",
    )?.data;

    expect(incomplete).toBeDefined();
    expect(get(incomplete, "response.status")).toBe("incomplete");
    expect(get(incomplete, "response.incomplete_details.reason")).toBe("max_output_tokens");
    expect(get(incomplete, "response.output")).toHaveLength(1);
    expect(get(incomplete, "response.output.0.type")).toBe("reasoning");
    expect(get(incomplete, "response.output.0.summary.0.text")).toBe("exhausted budget");
  });

  it("does not complete a reasoning-only stream without finish_reason", () => {
    const out = run(
      context("deepseek-v4-1-flash-1017"),
      `data: {"id":"chatcmpl_unfinished_thinking","object":"chat.completion.chunk","created":1773896263,"model":"deepseek-v4-1-flash-1017","choices":[{"index":0,"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"still thinking"}],"closed":true}]},"finish_reason":null}]}`,
      `data: [DONE]`,
    );

    const types = out.map((e) => e.event);

    expect(types).toContain("response.reasoning_summary_text.delta");
    expect(types).not.toContain("response.completed");
  });
});

const nonStream = (model: string, body: string): Json =>
  parse(convertOpenAIChatCompletionsResponseToOpenAIResponsesNonStream(context(model), body));

describe("OpenAI Chat Completions -> Responses non-stream: content-part arrays (c3a6c741)", () => {
  it("splits a nested thinking array and a text part", () => {
    const resp = nonStream(
      "deepseek-v4-1-flash-1017",
      `{"id":"bd5377d8250c4022b9a1b4dcb258ec4b","object":"chat.completion","created":1773896263,"model":"deepseek-v4-1-flash-1017","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","tool_calls":null,"content":[{"type":"thinking","thinking":[{"type":"text","text":"We need answer to \\"test\\". "},{"type":"text","text":"Respond concise."}],"closed":true},{"type":"text","text":"Test received. How can I help?"}]}}]}`,
    );

    expect(get(resp, "output")).toHaveLength(2);
    expect(get(resp, "output.0.type")).toBe("reasoning");
    expect(get(resp, "output.0.summary.0.text")).toBe(`We need answer to "test". Respond concise.`);
    expect(get(resp, "output.1.type")).toBe("message");
    expect(get(resp, "output.1.content.0.text")).toBe("Test received. How can I help?");
  });

  it("prefers top-level reasoning_content without leaking the thinking part into the message", () => {
    const resp = nonStream(
      "zai-glm-5-3",
      `{"id":"chatcmpl_dedup","object":"chat.completion","created":1773896263,"model":"zai-glm-5-3","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","reasoning_content":"top-level reasoning","content":[{"type":"thinking","thinking":"duplicate thinking"},{"type":"text","text":"Clean answer."}]}}]}`,
    );

    expect(get(resp, "output")).toHaveLength(2);
    expect(get(resp, "output.0.summary.0.text")).toBe("top-level reasoning");
    expect(get(resp, "output.1.content.0.text")).toBe("Clean answer.");
  });

  it("omits the empty message item for a thinking-only array with finish_reason length", () => {
    const resp = nonStream(
      "deepseek-v4-1-flash-1017",
      `{"id":"chatcmpl_think_len","object":"chat.completion","created":1773896263,"model":"deepseek-v4-1-flash-1017","choices":[{"index":0,"finish_reason":"length","message":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"truncated thought"}],"closed":true}]}}]}`,
    );

    expect(get(resp, "status")).toBe("incomplete");
    expect(get(resp, "output")).toHaveLength(1);
    expect(get(resp, "output.0.type")).toBe("reasoning");
    expect(get(resp, "output.0.summary.0.text")).toBe("truncated thought");
  });
});
