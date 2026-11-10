// Responses -> Claude: mid-session system/developer items stay in place as `role: "system"` turns when the executor
// says so (Go: internal/translator/claude/openai/responses/claude_openai-responses_system_placement_test.go, upstream
// 27762819). The executor's `topLevelSystemItems` request option picks the placement; absent means top level.
import { describe, expect, it } from "vitest";
import { get, type Json, type JsonObject } from "@commissary/json";
import { Formats } from "../src/translator/formats.ts";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { convertOpenAIResponsesRequestToClaude } from "../src/translator/claude/openai/responses/request.ts";

const FORMAT = `"text":{"format":{"type":"json_schema","name":"facts","schema":{"type":"object","properties":{"facts":{"type":"string"}}}}}`;

const IN_PLACE = { topLevelSystemItems: false };

const convert = (body: string, options?: { topLevelSystemItems?: boolean }): JsonObject =>
  convertOpenAIResponsesRequestToClaude(
    "claude-opus-5",
    JSON.parse(body) as Json,
    false,
    options,
  ) as JsonObject;

const roles = (out: JsonObject): string[] =>
  (out.messages as JsonObject[]).map((message) => message.role as string);

const blockText = (block: JsonObject | undefined): string =>
  typeof block?.text === "string" ? block.text : "";

const systemTexts = (out: JsonObject): string[] =>
  ((out.system ?? []) as JsonObject[]).map((block) => blockText(block));

const text = (role: string, value: string, type = "input_text"): string =>
  `{"type":"message","role":"${role}","content":[{"type":"${type}","text":"${value}"}]}`;

const turn = (items: string[]): string => `{"model":"claude-opus-5","input":[${items.join(",")}]}`;

describe("mid-session system items kept in place", () => {
  const TURN_TWO = [
    text("developer", "base instructions"),
    text("user", "first request"),
    `{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{}"}`,
    `{"type":"function_call_output","call_id":"call_1","output":"ok"}`,
    text("assistant", "first answer", "output_text"),
    text("developer", "<time_context>2026-11-06</time_context>"),
    text("user", "second request"),
  ];

  const TURN_THREE = [
    ...TURN_TWO,
    text("assistant", "second answer", "output_text"),
    text("developer", "<skills>changed</skills>"),
    text("user", "third request"),
  ];

  // Codex appends system-level items on later turns: the messages of one turn must stay a prefix of the next turn's, and
  // the top-level system must not change, or Claude's prompt cache misses on everything after the first changed block.
  it("keeps the prompt prefix between turns", () => {
    const two = convert(turn(TURN_TWO), IN_PLACE);
    const three = convert(turn(TURN_THREE), IN_PLACE);

    expect(three.system).toEqual(two.system);
    const twoMessages = two.messages as Json[];
    const threeMessages = three.messages as Json[];
    expect(threeMessages.length).toBeGreaterThan(twoMessages.length);
    expect(threeMessages.slice(0, twoMessages.length)).toEqual(twoMessages);

    expect(roles(three)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "system",
      "assistant",
      "user",
      "system",
    ]);

    expect(get(three, "messages.5.content.0.text")).toBe("<time_context>2026-11-06</time_context>");
    expect(get(three, "messages.8.content.0.text")).toBe("<skills>changed</skills>");
    expect(systemTexts(three)).toEqual(["base instructions"]);
  });

  it("follows the user message that is still being accumulated", () => {
    const out = convert(
      `{"instructions":"I1","input":[${[
        text("system", "S1"),
        text("user", "U1"),
        `{"type":"message","role":"developer","content":"D1"}`,
        text("assistant", "A1", "output_text"),
        text("user", "U2"),
      ].join(",")}]}`,
      IN_PLACE,
    );

    expect(systemTexts(out)).toEqual(["I1", "S1"]);
    expect(roles(out)).toEqual(["user", "system", "assistant", "user"]);
    expect(get(out, "messages.1.content.0.text")).toBe("D1");
  });

  it("does not separate a tool call from its result", () => {
    const out = convert(
      `{"input":[${[
        text("user", "run it"),
        `{"type":"function_call","call_id":"call_1","name":"shell","arguments":"{}"}`,
        text("developer", "prefix approved"),
        `{"type":"function_call_output","call_id":"call_1","output":"done"}`,
        text("assistant", "finished", "output_text"),
        text("user", "thanks"),
      ].join(",")}]}`,
      IN_PLACE,
    );

    expect(roles(out)).toEqual(["user", "assistant", "user", "system", "assistant", "user"]);
    expect(get(out, "messages.2.content.0.type")).toBe("tool_result");
    expect(out).not.toHaveProperty("system");
  });

  it("keeps leading, non-text, non-message and trailing items top-level in source order, the format instruction last", () => {
    const out = convert(
      `{${FORMAT},"input":[${[
        text("user", "hello"),
        `{"type":"custom_note","role":"developer","content":"typed"}`,
        `{"type":"message","role":"developer","content":[{"type":"input_text","text":"see image"},{"type":"input_image","image_url":"https://example.com/a.png"}]}`,
        text("user", "next"),
        text("assistant", "answer", "output_text"),
        text("developer", "trailing"),
        `{"type":"custom_note","role":"developer","content":"after_trailing"}`,
      ].join(",")}]}`,
      IN_PLACE,
    );

    expect(roles(out)).not.toContain("system");
    const system = out.system as JsonObject[];
    expect(system.map((block) => block.type)).toEqual([
      "text",
      "text",
      "input_image",
      "text",
      "text",
      "text",
    ]);
    expect(system[0]?.text).toBe("typed");
    expect(system[3]?.text).toBe("trailing");
    expect(system[4]?.text).toBe("after_trailing");
    expect(blockText(system[5])).toContain("facts");
  });

  it("keeps the fallback user message of a request that only carries a structured-output format", () => {
    const out = convert(`{${FORMAT}}`, IN_PLACE);

    expect(out.system).toHaveLength(1);
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "" }] }]);
  });

  it("carries the item's cache_control on its last block", () => {
    const out = convert(
      `{"input":[${[
        text("user", "U1"),
        `{"type":"message","role":"developer","cache_control":{"type":"ephemeral"},"content":[{"type":"input_text","text":"D1"},{"type":"input_text","text":"D2"}]}`,
        text("user", "U2"),
      ].join(",")}]}`,
      IN_PLACE,
    );

    expect(get(out, "messages.1")).toEqual({
      role: "system",
      content: [
        { type: "text", text: "D1" },
        { type: "text", text: "D2", cache_control: { type: "ephemeral" } },
      ],
    });
  });
});

describe("the topLevelSystemItems option", () => {
  const BODY = `{"instructions":"I1",${FORMAT},"input":[${[
    text("system", "S1"),
    text("user", "U1"),
    `{"type":"message","role":"developer","content":"D1"}`,
    text("assistant", "A1", "output_text"),
    text("system", "S2"),
    text("user", "U2"),
  ].join(",")}]}`;

  it.each([
    ["absent", undefined],
    ["true", { topLevelSystemItems: true }],
  ])("%s: every item is a top-level block in source order", (_name, options) => {
    const out = convert(BODY, options);

    expect(systemTexts(out).slice(0, 4)).toEqual(["I1", "S1", "D1", "S2"]);
    expect(systemTexts(out).at(-1)).toContain("facts");
    expect(roles(out)).toEqual(["user", "assistant", "user"]);
  });

  it("absent equals true", () => {
    expect(convert(BODY)).toEqual(convert(BODY, { topLevelSystemItems: true }));
  });

  it("false: D1 and S2 stay in place after the next user message", () => {
    const out = convert(BODY, IN_PLACE);

    expect(systemTexts(out).slice(0, 2)).toEqual(["I1", "S1"]);
    expect(systemTexts(out).at(-1)).toContain("facts");
    expect(roles(out)).toEqual(["user", "system", "assistant", "user", "system"]);
  });

  it("reaches the transform through the registry, for the compat variant as well", () => {
    for (const compat of [false, true]) {
      const translated = builtinTranslators.translateRequest(
        Formats.OpenAIResponse,
        Formats.Claude,
        {
          format: Formats.OpenAIResponse,
          model: "claude-opus-5",
          stream: false,
          body: JSON.parse(BODY) as Json,
        },
        undefined,
        { compat, topLevelSystemItems: false },
      );

      expect(roles(translated.body as JsonObject)).toEqual([
        "user",
        "system",
        "assistant",
        "user",
        "system",
      ]);
    }
  });
});
