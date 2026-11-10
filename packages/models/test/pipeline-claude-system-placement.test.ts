// Mid-session Responses system/developer items through the Claude executor (CLIProxyAPI 27762819): the executor decides
// once per attempt whether the Responses translator keeps them in place as `role: "system"` turns (cloaked wire, a model
// that accepts the turn) or at the top level, and tells the translator through its request options.
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { registerBuiltinTranslators, TranslatorRegistry } from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import type { JsonObject } from "@commissary/json";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { makeMemoryContinuityStore } from "../src/executor/claude/continuity.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import type { ExecutorOptions } from "../src/executor/types.ts";
import { credential, execute, harness, json, options } from "./support/executor-run.ts";

const PAYLOAD = (model: string): JsonObject => ({
  model,
  instructions: "Top rule",
  input: [
    { role: "user", content: [{ type: "input_text", text: "hi" }] },
    { role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    { role: "developer", content: [{ type: "input_text", text: "Mid rule" }] },
    { role: "user", content: [{ type: "input_text", text: "go" }] },
  ],
});

const oauth = (attributes: Record<string, string> = {}): CredentialSnapshot =>
  credential("claude", {
    kind: "oauth",
    attributes,
    metadata: { access_token: "sk-ant-oat01-placement" },
  });

const STREAM =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

const respond = (call: { text: string; url: string }): Response =>
  call.url.includes("count_tokens")
    ? Response.json({ input_tokens: 7 })
    : call.text.includes('"stream":true')
      ? new Response(STREAM, { headers: { "content-type": "text/event-stream" } })
      : Response.json({
          id: "msg_1",
          type: "message",
          model: "claude-opus-4-8",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });

/** A registry with every built-in translator that records the placement each Responses -> Claude request asks for. */
class SpyRegistry extends TranslatorRegistry {
  constructor(readonly seen: Array<boolean | undefined>) {
    super();
  }

  override translateRequest(
    ...args: Parameters<TranslatorRegistry["translateRequest"]>
  ): ReturnType<TranslatorRegistry["translateRequest"]> {
    const [client, provider, , , options] = args;

    if (client === Formats.OpenAIResponse && provider === Formats.Claude)
      this.seen.push(options?.topLevelSystemItems);

    return super.translateRequest(...args);
  }
}

const spyRegistry = (seen: Array<boolean | undefined>): TranslatorRegistry =>
  registerBuiltinTranslators(new SpyRegistry(seen));

const responsesOptions = (overrides: Partial<ExecutorOptions> = {}): ExecutorOptions =>
  options({
    sourceFormat: "openai-response",
    metadata: { ...options().metadata, requestPath: "/v1/responses" },
    ...overrides,
  });

interface Sent {
  readonly body: JsonObject;
  readonly placement: Array<boolean | undefined>;
}

/** Runs one Responses request through the executor and returns the upstream body and the placement it asked for. */
const send = async (
  cred: CredentialSnapshot,
  model = "claude-opus-4-8",
  yaml = "",
  via: "execute" | "count" = "execute",
): Promise<Sent> => {
  const placement: Array<boolean | undefined> = [];

  const executor = makeClaudeExecutor({
    translators: spyRegistry(placement),
    continuity: makeMemoryContinuityStore(),
  });

  const h = await harness(cred, respond, yaml);
  const request = { model, payload: json(PAYLOAD(model)) };

  if (via === "count") {
    await Effect.runPromise(
      executor.countTokens(h.context, request, responsesOptions()).pipe(Effect.provide(h.layers)),
    );
  } else await execute(executor, h, request, responsesOptions());

  return { body: JSON.parse(h.calls[0]?.text ?? "{}") as JsonObject, placement };
};

const roles = (body: JsonObject): string[] =>
  ((body.messages ?? []) as JsonObject[]).map((message) => message.role as string);

const lastTurnText = (body: JsonObject): string => {
  const messages = (body.messages ?? []) as JsonObject[];
  const content = messages.at(-1)?.content;

  return JSON.stringify(content);
};

describe("a cloaked request on a model that accepts mid-conversation system turns", () => {
  it("keeps the developer item in place right after the user message it preceded", async () => {
    const { body, placement } = await send(oauth());

    expect(placement).toEqual([false]);
    expect(roles(body).slice(-2)).toEqual(["user", "system"]);
    expect(lastTurnText(body)).toContain("Mid rule");
    // The caller's `instructions` still leave the top level, behind the first user turn.
    expect(JSON.stringify(body.system)).not.toContain("Top rule");
    expect(JSON.stringify(body.system)).not.toContain("Mid rule");
  });

  it("does the same at the minimal level, even with strict mode set", async () => {
    const { body, placement } = await send(
      oauth({ cloak_level: "minimal", cloak_strict_mode: "true" }),
    );

    expect(placement).toEqual([false]);
    expect(roles(body).slice(-2)).toEqual(["user", "system"]);
    expect(lastTurnText(body)).toContain("Mid rule");
  });
});

describe("the top-level path", () => {
  const topLevel = async (
    cred: CredentialSnapshot,
    model = "claude-opus-4-8",
    via: "execute" | "count" = "execute",
  ) => {
    const sent = await send(cred, model, "", via);
    expect(sent.placement).toEqual([true]);

    return sent;
  };

  it("is used for a legacy upstream model, which takes the reminder in the first user turn", async () => {
    const { body } = await topLevel(oauth(), "claude-sonnet-4-5");
    const text = JSON.stringify(body);

    expect(roles(body)).not.toContain("system");
    expect(text.indexOf("Top rule")).toBeGreaterThan(-1);
    expect(text.indexOf("Mid rule")).toBeGreaterThan(text.indexOf("Top rule"));
  });

  it("is used under strict mode, which drops every caller instruction", async () => {
    const { body } = await topLevel(oauth({ cloak_strict_mode: "true" }));

    expect(roles(body)).not.toContain("system");
    expect(JSON.stringify(body)).not.toContain("Top rule");
    expect(JSON.stringify(body)).not.toContain("Mid rule");
  });

  it("is used for an uncloaked request, which forwards the caller's betas unchanged", async () => {
    const { body } = await topLevel(oauth({ cloak_mode: "never" }));

    expect(roles(body)).not.toContain("system");
    expect((body.system as JsonObject[]).map((block) => block.text).slice(-2)).toEqual([
      "Top rule",
      "Mid rule",
    ]);
  });

  it("is used with the mid-system rebuild opt-in, which folds the turns into the system field", async () => {
    const { body } = await topLevel(oauth({ rebuild_mid_system_message: "true" }));

    // Both instructions are cloaking's relocation behind the first user turn; none trails the last one.
    expect(roles(body)).toEqual(["user", "system", "system", "assistant", "user"]);
  });

  it("is used for a local token count, which sends nothing upstream", async () => {
    const placement: Array<boolean | undefined> = [];

    const executor = makeClaudeExecutor({
      translators: spyRegistry(placement),
      continuity: makeMemoryContinuityStore(),
    });

    const h = await harness(oauth({ base_url: "https://gateway.invalid" }), respond, "");

    const counted = await Effect.runPromise(
      executor
        .countTokens(
          h.context,
          { model: "claude-opus-4-8", payload: json(PAYLOAD("claude-opus-4-8")) },
          responsesOptions(),
        )
        .pipe(Effect.provide(h.layers)),
    );

    expect(h.calls).toHaveLength(0);
    expect(counted.payload.length).toBeGreaterThan(0);
    expect(placement).toEqual([true]);
  });
});

describe("upstream count_tokens", () => {
  it("follows the wire policy of the attempt", async () => {
    const cloaked = await send(oauth(), "claude-opus-4-8", "", "count");
    expect(cloaked.placement).toEqual([false]);
    expect(roles(cloaked.body).slice(-2)).toEqual(["user", "system"]);

    const strict = await send(oauth({ cloak_strict_mode: "true" }), "claude-opus-4-8", "", "count");
    expect(strict.placement).toEqual([true]);
    expect(roles(strict.body)).not.toContain("system");

    const legacy = await send(oauth(), "claude-sonnet-4-5", "", "count");
    expect(legacy.placement).toEqual([true]);
  });
});

describe("failover", () => {
  it("switches the placement with the credential of each attempt", async () => {
    const placement: Array<boolean | undefined> = [];

    const executor = makeClaudeExecutor({
      translators: spyRegistry(placement),
      continuity: makeMemoryContinuityStore(),
    });

    const request = {
      model: "claude-opus-4-8",
      payload: json(PAYLOAD("claude-opus-4-8")),
    };

    const bodies: JsonObject[] = [];

    for (const cred of [oauth(), oauth({ cloak_mode: "never" })]) {
      const h = await harness(cred, respond, "");
      await execute(executor, h, request, responsesOptions());
      bodies.push(JSON.parse(h.calls[0]?.text ?? "{}") as JsonObject);
    }

    expect(placement).toEqual([false, true]);
    expect(roles(bodies[0] as JsonObject)).toContain("system");
    expect(roles(bodies[1] as JsonObject)).not.toContain("system");
  });
});

describe("a payload rule that rewrites the model to a legacy one after translation", () => {
  // The rule is outside the placement decision: the in-place turns stay, and the final validation answers explicitly
  // instead of sending a turn the model rejects.
  it("fails with a 400 for a first-party caller that is not Claude Code", async () => {
    const yaml = `requests:
  payload:
    override:
      - models: [{ name: "*", protocol: claude }]
        params:
          model: claude-haiku-4-5-20251001
`;

    const executor = makeClaudeExecutor({ continuity: makeMemoryContinuityStore() });
    const h = await harness(oauth(), respond, yaml);

    const result = await Effect.runPromise(
      Effect.result(
        executor
          .execute(
            h.context,
            { model: "claude-opus-4-8", payload: json(PAYLOAD("claude-opus-4-8")) },
            responsesOptions(),
          )
          .pipe(Effect.provide(h.layers)),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure.status).toBe(400);
      expect(result.failure.message).toContain("role 'system' is not supported");
    }

    expect(h.calls).toHaveLength(0);
  });
});
