// Responses -> Gemini parallel tool outputs across developer notices (ticket C8; upstream 3ac38498, Go tests
// gemini_openai-responses_request_test.go).
import { describe, expect, it } from "vite-plus/test";
import { get, type Json } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { collectFunctionCallOutputs } from "../src/translator/gemini/openai/responses/request.ts";

const MODEL = "gemini-4-argon";

const convert = (input: Json[]): Json =>
  builtinTranslators.translateRequest(
    "openai-response",
    "gemini",
    { format: "openai-response", model: MODEL, stream: false, body: { model: MODEL, input } },
    undefined,
  ).body;

const contentsOf = (out: Json): Json[] => {
  const contents = get(out, "contents");

  return Array.isArray(contents) ? contents : [];
};

describe("parallel outputs across notices", () => {
  const cases = ["developer", "system"].flatMap((role) =>
    [false, true].flatMap((image) => [false, true].map((reverse) => ({ role, image, reverse }))),
  );

  it.each(cases)("$role image=$image reverse=$reverse", ({ role, image, reverse }) => {
    const items: Json[] = [{ type: "message", role: "user", content: "Inspect files." }];

    for (let i = 0; i < 4; i++)
      items.push({
        type: "function_call",
        call_id: `call-${i}`,
        name: "view_image",
        arguments: "{}",
      });

    for (let i = 0; i < 4; i++) {
      const id = reverse ? 3 - i : i;

      const output: Json = image
        ? [
            { type: "input_text", text: `result-${id}` },
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ]
        : `result-${id}`;

      items.push({ type: "function_call_output", call_id: `call-${id}`, output });

      // Codex also emits role-only messages without an explicit type.
      const content = `<image_resize_notice>notice-${i}</image_resize_notice>`;

      items.push(i % 2 === 0 ? { type: "message", role, content } : { role, content });
    }

    const contents = contentsOf(convert(items));

    expect(contents).toHaveLength(4);
    const results = get(contents[2], "parts") as Json[];

    expect(results).toHaveLength(4);

    results.forEach((part, i) => {
      expect(get(part, "functionResponse.id")).toBe(`call-${i}`);
      expect(get(part, "functionResponse.response.result")).toBe(`result-${i}`);

      if (image) expect(get(part, "functionResponse.parts.0.inlineData.data")).toBe("aGVsbG8=");
    });

    for (let i = 0; i < 4; i++) {
      const raw = JSON.stringify(contents[3]);

      expect(raw.split(`notice-${i}`)).toHaveLength(2);
    }
  });
});

describe("collectFunctionCallOutputs", () => {
  const notice: Json = { type: "message", role: "developer", content: "notice" };

  it.each([
    { type: "message", role: "user", content: "new request" },
    { type: "message", role: "assistant", content: "next response" },
    { type: "function_call", call_id: "new", name: "next", arguments: "{}" },
    { type: "reasoning", summary: [] },
  ] satisfies Json[])("stops at the turn boundary %j", (boundary) => {
    const items: Json[] = [
      { type: "function_call_output", call_id: "one", output: "first" },
      notice,
      boundary,
      { type: "function_call_output", call_id: "two", output: "second" },
    ];

    const { ordered, consumedIndexes } = collectFunctionCallOutputs(items, 0, ["one", "two"]);

    expect(ordered).toHaveLength(1);
    expect(consumedIndexes).toEqual([0]);
  });

  it.each([[["one"]], [[]]])("does not move an orphan across a notice (pending %j)", (pending) => {
    const items: Json[] = [
      { type: "function_call_output", call_id: "one", output: "first" },
      notice,
      { type: "function_call_output", call_id: "orphan", output: "unrelated" },
    ];

    const { ordered, consumedIndexes } = collectFunctionCallOutputs(items, 0, pending);

    expect(ordered).toHaveLength(1);
    expect(consumedIndexes).toEqual([0]);
  });

  it("collects non-contiguous outputs while calls stay pending", () => {
    const items: Json[] = [
      { type: "function_call_output", call_id: "b", output: "B" },
      notice,
      { role: "system", content: "untyped notice" },
      { type: "function_call_output", call_id: "a", output: "A" },
    ];

    const { ordered, consumedIndexes } = collectFunctionCallOutputs(items, 0, ["a", "b"]);

    expect(ordered.map((item) => get(item, "call_id"))).toEqual(["a", "b"]);
    expect(consumedIndexes).toEqual([0, 3]);
  });
});
