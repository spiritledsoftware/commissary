// Claude stream input-token estimate (Go helps.TranslateStreamWithClaudeInputTokens) and the local Claude estimate,
// compared with the Go fixtures (go run ./tools/fixturegen/tokens).
import { describe, expect, it } from "vitest";
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts";
import { tryParseJson } from "@commissary/json";
import { applyClaudeInputTokens, countClaudeInputTokens } from "@commissary/translation/tokenizer";
import { builtinTranslators, makeTranslationState } from "@commissary/translation";
import { collectStream, credential, harness, options } from "./support/executor-run.ts";
import { tokenFixtures as fixtures } from "@commissary/translation/testing";

const start = (n: number) =>
  `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":${n}}}}\n\n`;

/**
 * Golden stream scenarios whose recorded steps predate an upstream change Commissary has ported, by scenario name:
 * the events each step (by index) must now emit (ticket C3, Go `9a7db8e3`). `message_delta` and `message_stop` wait
 * for the trailing usage-only chunk or `[DONE]` instead of firing on the chunk that carries `finish_reason`, so in
 * "openai upstream" they move from step 2 to the `[DONE]` step. Regenerating `tokens.json` at `d1ea84f4` gives the
 * steps below. The fixture stays untouched; F2 (#388) regenerates it and deletes this table.
 */
const AHEAD_OF_FIXTURE: ReadonlyMap<string, ReadonlyMap<number, ReadonlyArray<string>>> = new Map([
  [
    "openai upstream",
    new Map([
      [2, ['event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n']],
      [
        3,
        [
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":11,"output_tokens":3}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ],
      ],
    ]),
  ],
]);

const usedAhead = new Set<string>();

describe("Claude input token estimate", () => {
  it("counts Claude requests like helps.CountClaudeInputTokens", () => {
    expect(fixtures.claude.length).toBeGreaterThan(5);

    for (const c of fixtures.claude)
      expect(countClaudeInputTokens(JSON.parse(c.payload)), c.payload).toBe(c.count);
  });

  it("counts nothing for missing or non-object requests", () => {
    expect(countClaudeInputTokens(undefined)).toBe(0);
    expect(countClaudeInputTokens([1, 2])).toBe(0);
    expect(countClaudeInputTokens({ messages: [] })).toBe(0);
  });

  for (const scenario of fixtures.streams) {
    it(`stream: ${scenario.name}`, () => {
      const state = makeTranslationState();

      const context = {
        model: scenario.model,
        originalRequest: tryParseJson(scenario.original),
        translatedRequest:
          scenario.translated === undefined ? undefined : tryParseJson(scenario.translated),
        state,
      };

      const ahead = AHEAD_OF_FIXTURE.get(scenario.name);

      if (ahead !== undefined) usedAhead.add(scenario.name);

      scenario.steps.forEach((step, index) => {
        expect(
          builtinTranslators.translateStream("claude", scenario.upstream, context, step.in),
        ).toEqual(ahead?.get(index) ?? step.out);
      });
    });
  }

  it("consumed every ahead-of-fixture entry", () => {
    expect([...AHEAD_OF_FIXTURE.keys()].filter((key) => !usedAhead.has(key))).toEqual([]);
  });

  it("leaves Claude upstreams and non-Claude clients alone", () => {
    const start =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n';

    const original = { messages: [{ role: "user", content: "Hello, how are you today?" }] };

    for (const [client, provider] of [
      ["claude", "claude"],
      ["openai", "unregistered-provider"],
    ] as const) {
      const context = {
        model: "m",
        originalRequest: original,
        translatedRequest: undefined,
        state: makeTranslationState(),
      };

      expect(builtinTranslators.translateStream(client, provider, context, start)).toEqual([start]);
      expect(context.state.claudeInputTokensHandled).toBeUndefined();
    }
  });

  it("patches message_start only once per attempt state", () => {
    const state = makeTranslationState();
    const original = { messages: [{ role: "user", content: "Hello, how are you today?" }] };
    const first = applyClaudeInputTokens(state, original, [start(0)]);
    expect(first[0]).toBe(start(countClaudeInputTokens(original)));
    expect(countClaudeInputTokens(original)).toBeGreaterThan(0);
    expect(applyClaudeInputTokens(state, original, [start(0)])).toEqual([start(0)]);
  });

  it("an executor stream for a Claude client carries the estimate in message_start", async () => {
    const upstream = [
      {
        id: "c1",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: { content: "Hi" } }],
      },
      {
        id: "c1",
        object: "chat.completion.chunk",
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ];

    const body =
      upstream.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";

    const h = await harness(
      credential("openai-compatibility", {
        kind: "apikey",
        attributes: { api_key: "k", base_url: "https://compat.test/v1" },
      }),
      () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      undefined,
      true,
    );

    const claudeRequest = {
      model: "m",
      max_tokens: 16,
      stream: true,
      system: "System text.",
      messages: [{ role: "user", content: "Hello, how are you today?" }],
    };

    const collected = await collectStream(
      makeOpenAICompatExecutor("openai-compatibility"),
      h,
      { model: "m", payload: claudeRequest },
      options({ stream: true, sourceFormat: "claude", originalRequest: claudeRequest }),
    );

    expect(collected.error).toBeUndefined();
    const starts = collected.chunks.filter((chunk) => chunk.includes('"type":"message_start"'));
    expect(starts).toHaveLength(1);

    const data = (starts[0] as string)
      .split("\n")
      .find((line) => line.startsWith("data:")) as string;

    const expected = countClaudeInputTokens(claudeRequest);
    expect(expected).toBeGreaterThan(0);
    expect(JSON.parse(data.slice(5)).message.usage.input_tokens).toBe(expected);
  });
});
