// Interactions provider -> Gemini client: streamed function-call steps are reassembled before they are emitted
// (upstream 65864c04, 9d60b36f). Expected values come from the Go tests of those commits
// (interactions_gemini_response_test.go).
import { describe, expect, it } from "vite-plus/test";
import { get, isJsonArray, type Json, tryParseJson } from "@commissary/json";
import { builtinTranslators } from "../src/translator/builtin.ts";
import { makeTranslationState } from "../src/translator/registry.ts";

/** One translated stream: each `send` translates one `data:` event and returns its chunks. */
const stream = (): ((event: string) => ReadonlyArray<string>) => {
  const ctx = {
    model: "gemini-test",
    originalRequest: undefined,
    translatedRequest: undefined,
    state: makeTranslationState(),
  };

  return (event) =>
    builtinTranslators.translateStream("gemini", "interactions", ctx, `data: ${event}`);
};

interface Call {
  readonly id: Json;
  readonly name: Json;
  readonly args: Json;
  readonly signature: Json;
}

const partsOf = (chunk: string): Json[] => {
  const parts = get(tryParseJson(chunk) ?? null, "candidates.0.content.parts");

  return isJsonArray(parts) ? parts : [];
};

const callsOf = (chunks: ReadonlyArray<string>): Call[] =>
  chunks.flatMap((chunk) =>
    partsOf(chunk)
      .filter((part) => get(part, "functionCall") !== undefined)
      .map((part) => ({
        id: get(part, "functionCall.id") ?? null,
        name: get(part, "functionCall.name") ?? null,
        args: get(part, "functionCall.args") ?? null,
        signature: get(part, "thoughtSignature") ?? null,
      })),
  );

const argumentsDelta = (index: number, fragment: string): string =>
  JSON.stringify({
    event_type: "step.delta",
    index,
    delta: { type: "arguments_delta", arguments: fragment },
  });

const lookup = (args: Json): Call => ({ id: "call_1", name: "lookup", args, signature: "sig_1" });

const stepStop = (index: number): string => JSON.stringify({ event_type: "step.stop", index });

describe("a complete function call step is emitted once, on step.stop (65864c04)", () => {
  it.each<[string, Json]>([
    ["with arguments", { q: "example" }],
    ["empty arguments", {}],
  ])("%s", (_name, args) => {
    const send = stream();

    expect(
      send(
        JSON.stringify({
          event_type: "step.start",
          index: 0,
          step: { type: "function_call", id: "call_1", name: "lookup", arguments: args },
        }),
      ),
    ).toEqual([]);

    const stopped = send(stepStop(0));

    expect(stopped).toHaveLength(1);
    expect(partsOf(stopped[0] ?? "")).toHaveLength(1);
    expect(callsOf(stopped)).toEqual([{ id: "call_1", name: "lookup", args, signature: null }]);
    expect(send(stepStop(0))).toEqual([]);

    const completed = send(
      JSON.stringify({
        event_type: "interaction.completed",
        interaction: { status: "requires_action" },
      }),
    );

    expect(completed).toHaveLength(1);
    expect(get(tryParseJson(completed[0] ?? "") ?? null, "candidates.0.finishReason")).toBe("STOP");
    expect(callsOf(completed)).toEqual([]);
  });
});

describe("streamed arguments are reassembled (9d60b36f)", () => {
  const startLookup = JSON.stringify({
    event_type: "step.start",
    index: 0,
    step: {
      type: "function_call",
      id: "call_1",
      name: "lookup",
      signature: "sig_1",
      arguments: {},
    },
  });

  it.each<[string, string[], Call[]]>([
    [
      "split JSON object",
      [startLookup, argumentsDelta(0, '{"q":'), argumentsDelta(0, '"example"}'), stepStop(0)],
      [lookup({ q: "example" })],
    ],
    [
      "single delta emits the equivalent call",
      [startLookup, argumentsDelta(0, '{"q":"example"}'), stepStop(0)],
      [lookup({ q: "example" })],
    ],
    [
      "interleaved calls preserve whitespace inside strings",
      [
        startLookup,
        JSON.stringify({
          event_type: "step.start",
          index: 1,
          step: {
            type: "function_call",
            call_id: "call_2",
            name: "search",
            signature: "sig_2",
            arguments: {},
          },
        }),
        argumentsDelta(0, '{"q":"New '),
        argumentsDelta(1, '{"q":"exa'),
        argumentsDelta(0, " "),
        argumentsDelta(0, ' York"}'),
        argumentsDelta(0, " "),
        stepStop(0),
        argumentsDelta(1, 'mple"}'),
        stepStop(1),
      ],
      [
        lookup({ q: "New   York" }),
        { id: "call_2", name: "search", args: { q: "example" }, signature: "sig_2" },
      ],
    ],
    [
      "complete arguments before late function name",
      [
        JSON.stringify({
          event_type: "step.start",
          index: 0,
          step: { type: "function_call", id: "call_1", signature: "sig_1", arguments: {} },
        }),
        argumentsDelta(0, '{"q":"example"}'),
        JSON.stringify({
          event_type: "step.start",
          index: 0,
          step: { type: "function_call", call_id: "call_1", name: "lookup", arguments: {} },
        }),
        stepStop(0),
      ],
      [lookup({ q: "example" })],
    ],
    [
      "nested objects and escaped quotes across fragments",
      [
        startLookup,
        argumentsDelta(0, '{"items":[{"n":1}'),
        argumentsDelta(0, ',{"n":2}'),
        argumentsDelta(0, '],"q":"left\\'),
        argumentsDelta(0, '"}right"}'),
        stepStop(0),
      ],
      [lookup({ items: [{ n: 1 }, { n: 2 }], q: 'left"}right' })],
    ],
    [
      "truncated arguments do not become an empty call",
      [startLookup, argumentsDelta(0, '{"q":'), stepStop(0)],
      [],
    ],
  ])("%s", (_name, events, want) => {
    const send = stream();

    expect(callsOf(events.flatMap((event) => send(event)))).toEqual(want);
  });

  // Commissary counts the buffer in UTF-16 code units where Go counts bytes; the ASCII padding makes them equal.
  it("rejects a call past the shared 50 MiB argument budget and releases its buffer", () => {
    const send = stream();

    for (const index of [0, 1]) {
      send(
        JSON.stringify({
          event_type: "step.start",
          index,
          step: { type: "function_call", id: `call_${index + 1}`, name: "lookup", arguments: {} },
        }),
      );
    }

    send(argumentsDelta(0, '{"q":"'));
    send(argumentsDelta(1, '{"q":"'));
    const padding = "x".repeat(1 << 20);
    const delta0 = argumentsDelta(0, padding);
    const delta1 = argumentsDelta(1, padding);

    for (let i = 0; i < 30; i++) expect(send(delta0)).toEqual([]);

    for (let i = 0; i < 25; i++) expect(send(delta1)).toEqual([]);

    // Step 1 crossed the budget: closing its string does not emit it, and later fragments do not restart it.
    expect(send(argumentsDelta(1, '"}'))).toEqual([]);
    expect(send(argumentsDelta(1, "{}"))).toEqual([]);

    // This fragment only fits if step 1's buffer was released.
    send(delta0);
    expect(send(argumentsDelta(0, '"}'))).toHaveLength(1);
  });
});
