// Local countTokens answers of the Codex, OpenAI-compatibility, xAI, Meta and Claude (gateway) executors compared with
// the real Go executors (go run ./tools/fixturegen/tokens).
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";
import { isJsonArray, isJsonObject, type Json } from "@commissary/json";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { makeCodexExecutor } from "../src/executor/codex/executor.ts";
import { makeMetaExecutor } from "../src/executor/meta/executor.ts";
import { makeOpenAICompatExecutor } from "../src/executor/openai-compat/executor.ts";
import { makeXaiExecutor } from "../src/executor/xai/executor.ts";
import { credential, harness, options, runFail } from "./support/executor-run.ts";
import { tokenFixtures as fixtures } from "@commissary/translation/testing";

const executors = new Map([
  [
    "codex",
    {
      executor: makeCodexExecutor(),
      credential: credential("codex", { metadata: { access_token: "t" } }),
    },
  ],
  [
    "openai-compat",
    {
      executor: makeOpenAICompatExecutor("openai-compatibility"),
      credential: credential("openai-compatibility", {
        kind: "apikey",
        attributes: { api_key: "k", base_url: "https://compat.test/v1" },
      }),
    },
  ],
  [
    "xai",
    {
      executor: makeXaiExecutor(),
      credential: credential("xai", { metadata: { access_token: "t" } }),
    },
  ],
  [
    "meta",
    {
      executor: makeMetaExecutor(),
      credential: credential("meta", { kind: "apikey", attributes: { api_key: "k" } }),
    },
  ],
  [
    "claude",
    {
      executor: makeClaudeExecutor(),
      credential: credential("claude", {
        kind: "apikey",
        attributes: { api_key: "k", base_url: "https://gateway.example.com" },
      }),
    },
  ],
]);

/**
 * Token counts are estimates over the serialised tool parameters and schemas. Go serialises those with sorted keys
 * and HTML escaping, Commissary keeps build order, and BPE merges across the different separators, so a count can
 * land a token or two away from Go's. Everything else must match exactly.
 */
const TOKEN_TOLERANCE = 2;

const sameWithinTokenTolerance = (got: Json | undefined, want: Json | undefined): boolean => {
  if (typeof got === "number" && typeof want === "number")
    return Math.abs(got - want) <= TOKEN_TOLERANCE;

  if (isJsonArray(got) && isJsonArray(want))
    return (
      got.length === want.length && got.every((item, i) => sameWithinTokenTolerance(item, want[i]))
    );

  if (isJsonObject(got) && isJsonObject(want)) {
    const keys = Object.keys(want);

    return (
      Object.keys(got).length === keys.length &&
      keys.every((key) => sameWithinTokenTolerance(got[key], want[key]))
    );
  }

  return got === want;
};

const noUpstream = () => new Response("unexpected upstream call", { status: 500 });

describe("countTokens parity with the Go executors", () => {
  for (const [provider, { executor, credential: cred }] of executors) {
    const cases = fixtures.executors.filter((c) => c.provider === provider);
    it(`${provider}: ${cases.length} scenarios`, async () => {
      const h = await harness(cred, noUpstream);
      const mismatches: unknown[] = [];

      for (const c of cases) {
        const opts = options({
          sourceFormat: c.source,
          headers: new Headers({ "user-agent": "codex_cli_rs/0.1" }),
          metadata: { ...options().metadata, requestPath: "/v1/messages/count_tokens" },
        });

        const request = { model: c.model, payload: JSON.parse(c.payload) };

        const result = await Effect.runPromise(
          Effect.result(
            executor.countTokens(h.context, request, opts).pipe(Effect.provide(h.layers)),
          ),
        );

        const label = `${c.source} ${c.model} ${c.payload.slice(0, 70)}`;

        if (c.error !== undefined && c.error !== "") {
          if (Result.isSuccess(result) || !result.failure.message.includes(c.error)) {
            mismatches.push({
              label,
              want: `error: ${c.error}`,
              got: Result.isSuccess(result) ? result.success.payload : result.failure.message,
            });
          }
        } else if (Result.isFailure(result)) {
          mismatches.push({ label, want: c.out, got: `error: ${result.failure.message}` });
        } else if (
          !sameWithinTokenTolerance(JSON.parse(result.success.payload), JSON.parse(c.out as string))
        ) {
          mismatches.push({ label, want: c.out, got: result.success.payload });
        }
      }

      expect(mismatches).toEqual([]);
      expect(h.calls).toHaveLength(0);
    });
  }

  it("Meta rejects a missing token like Go ensureAuth (401)", async () => {
    const h = await harness(credential("meta", { kind: "apikey" }), noUpstream);

    const error = await runFail(
      makeMetaExecutor().countTokens(
        h.context,
        { model: "m", payload: { input: "hi" } },
        options({ sourceFormat: "openai-response" }),
      ),
      h.layers,
    );

    expect(error.status).toBe(401);
  });
});
