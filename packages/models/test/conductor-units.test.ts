// Unit tests for the conductor building blocks: session extraction, force-mapping rewrite, executor snapshots,
// Worker-side error classification / report building and the live thinking layer.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { toExecutorSnapshot } from "../src/executor/control-plane-picker.ts";
import {
  failureReport,
  isCompactRequestFault,
  isProviderSpecificRequest,
  matchRequestScopedAction,
  requestScopedRules,
  successReport,
} from "../src/executor/classify.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { CredentialRefresher, needsPreparation } from "../src/executor/helps/credential-refresh.ts";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { makeLiveThinking } from "../src/executor/thinking.ts";
import { compatModelInfo } from "../src/handlers/model-capabilities.ts";
import { rewriteResponseModel, rewriteStreamChunk } from "../src/handlers/model-rewrite.ts";
import { providerFailover } from "../src/handlers/provider-failover.ts";
import { extractSessionInfo, normalizeExplicitId } from "../src/handlers/session.ts";
import { builtinTranslators } from "@commissary/translation";
import { Formats } from "@commissary/translation/formats";
import type { JsonObject } from "@commissary/json";
import { loadConfig } from "./support/pool.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "./support/context.ts";

const headers = (init: Record<string, string>) => new Headers(init);

describe("session extraction (sdk/cliproxy/session/info.go)", () => {
  it("explicit ids are bounded to printable text of at most 256 bytes", () => {
    assert.strictEqual(normalizeExplicitId("  abc  "), "abc");
    assert.strictEqual(normalizeExplicitId("a\u0000b"), "");
    assert.strictEqual(normalizeExplicitId("x".repeat(257)), "");
    assert.strictEqual(normalizeExplicitId("x".repeat(256)).length, 256);
  });

  it("Claude Code headers: main session, agent and parent agent", () => {
    assert.deepStrictEqual(
      extractSessionInfo(headers({ "x-claude-code-session-id": "s1" }), undefined),
      {
        sessionId: "claude:s1",
        agentName: "main",
        clientType: "claude",
        isFork: false,
        isSubagent: false,
      },
    );

    const sub = extractSessionInfo(
      headers({
        "x-claude-code-session-id": "s1",
        "x-claude-code-agent-id": "a1",
        "x-claude-code-parent-agent-id": "p1",
      }),
      undefined,
    );

    assert.strictEqual(sub?.sessionId, "claude:s1:agent:a1");
    assert.strictEqual(sub?.parentSessionId, "claude:s1:agent:p1");
    assert.strictEqual(sub?.agentName, "a1");
  });

  it("Claude metadata.user_id (JSON and legacy suffix) outranks generic headers", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";

    const json = extractSessionInfo(headers({ "x-session-id": "ignored" }), {
      metadata: { user_id: JSON.stringify({ session_id: "sess", agent_id: "ag" }) },
    });

    assert.strictEqual(json?.sessionId, "claude:sess:agent:ag");
    assert.strictEqual(json?.parentSessionId, "claude:sess");

    const legacy = extractSessionInfo(headers({}), {
      metadata: { user_id: `user_abc_account__session_${uuid}` },
    });

    assert.strictEqual(legacy?.sessionId, `claude:${uuid}`);
  });

  it("Codex: session/thread headers, forks and subagents", () => {
    assert.strictEqual(
      extractSessionInfo(headers({ "session-id": "c1" }), undefined)?.sessionId,
      "codex:c1",
    );

    const thread = extractSessionInfo(
      headers({ "session-id": "c1", "thread-id": "t2" }),
      undefined,
    );

    assert.deepInclude(thread, {
      sessionId: "codex:t2",
      parentSessionId: "codex:c1",
      isSubagent: true,
    });

    const fork = extractSessionInfo(headers({ "session-id": "c1" }), {
      forked_from_thread_id: "c0",
    });

    assert.deepInclude(fork, { sessionId: "codex:c1", parentSessionId: "codex:c0", isFork: true });

    const meta = extractSessionInfo(
      headers({
        "x-codex-turn-metadata": JSON.stringify({
          session_id: "m1",
          subagent_kind: "thread_spawn",
        }),
      }),
      undefined,
    );

    assert.strictEqual(meta?.isSubagent, true);
  });

  it("generic headers and their parents", () => {
    assert.strictEqual(
      extractSessionInfo(headers({ "x-http-session-id": "g" }), undefined)?.sessionId,
      "agy:g",
    );
    assert.deepInclude(
      extractSessionInfo(headers({ "x-session-id": "h", "x-parent-session-id": "hp" }), undefined),
      {
        sessionId: "header:h",
        parentSessionId: "header:hp",
        agentName: "subagent",
      },
    );
    assert.strictEqual(
      extractSessionInfo(headers({ "x-session-affinity": "a" }), undefined)?.sessionId,
      "affinity:a",
    );
    // Not in Go: OpenCode / pi send x-opencode-session for OpenCode Zen/Go.
    assert.deepInclude(extractSessionInfo(headers({ "x-opencode-session": "o" }), undefined), {
      sessionId: "affinity:o",
      clientType: "opencode",
    });
    assert.strictEqual(
      extractSessionInfo(
        headers({ "x-session-affinity": "a", "x-opencode-session": "o" }),
        undefined,
      )?.sessionId,
      "affinity:a",
    );
    assert.strictEqual(
      extractSessionInfo(headers({ "x-slot-session-id": "s" }), undefined)?.sessionId,
      "slot:s",
    );
    assert.strictEqual(
      extractSessionInfo(headers({ "x-conversation-id": "c" }), undefined)?.sessionId,
      "conv:c",
    );
    assert.strictEqual(
      extractSessionInfo(headers({ "x-thread-id": "t" }), undefined)?.sessionId,
      "thread:t",
    );
    assert.strictEqual(
      extractSessionInfo(headers({ "x-client-request-id": "r" }), undefined)?.sessionId,
      "clientreq:r",
    );
  });

  it("body fields in Go priority order", () => {
    assert.strictEqual(
      extractSessionInfo(headers({}), { cachedContent: "cc" })?.sessionId,
      "geminicache:cc",
    );
    assert.strictEqual(extractSessionInfo(headers({}), { thread_id: "t" })?.sessionId, "thread:t");
    assert.strictEqual(
      extractSessionInfo(headers({}), { session_id: "s" })?.sessionId,
      "session:s",
    );
    assert.strictEqual(
      extractSessionInfo(headers({}), { metadata: { session_id: "s" } })?.sessionId,
      "session:s",
    );
    assert.strictEqual(extractSessionInfo(headers({}), { task_id: "k" })?.sessionId, "task:k");
    assert.strictEqual(
      extractSessionInfo(headers({}), { prompt_cache_key: "p" })?.sessionId,
      "pck:p",
    );
    assert.strictEqual(
      extractSessionInfo(headers({}), { conversation: { id: "c" } })?.sessionId,
      "conv:c",
    );
    assert.strictEqual(
      extractSessionInfo(headers({}), { metadata: { user_id: "u" } })?.sessionId,
      "user:u",
    );
    assert.strictEqual(
      extractSessionInfo(headers({}), { conversation_id: "x" })?.sessionId,
      "conv:x",
    );
    // Nested `request` bodies (Gemini CLI envelopes) are looked through.
    assert.strictEqual(
      extractSessionInfo(headers({}), { request: { session_id: "n" } })?.sessionId,
      "session:n",
    );
    assert.isUndefined(extractSessionInfo(headers({}), { messages: [] }));
    assert.isUndefined(extractSessionInfo(headers({}), undefined));
  });

  it("subagent and fork relations from the body", () => {
    const sub = extractSessionInfo(headers({}), { session_id: "s", parent_session_id: "p" });
    assert.deepInclude(sub, {
      sessionId: "session:s",
      parentSessionId: "session:p",
      isSubagent: true,
      agentName: "subagent",
    });

    const fork = extractSessionInfo(headers({}), {
      session_id: "s",
      parent_session_id: "p",
      forked_from_id: "p",
    });

    assert.deepInclude(fork, { isFork: true, isSubagent: false });
    // A self-referential parent is dropped.
    assert.isUndefined(
      extractSessionInfo(headers({}), { session_id: "s", parent_id: "s" })?.parentSessionId,
    );
  });
});

describe("force-mapping rewrite (response_model_rewriter.go)", () => {
  it("rewrites every model field of a JSON body and leaves other bodies alone", () => {
    const out = JSON.parse(
      rewriteResponseModel(
        '{"model":"u","response":{"model":"u","modelVersion":"v"},"message":{"model":"u"},"x":1}',
        "alias",
      ),
    ) as Record<string, unknown>;

    assert.deepStrictEqual(out, {
      model: "alias",
      response: { model: "alias", modelVersion: "alias" },
      message: { model: "alias" },
      x: 1,
    });
    assert.strictEqual(rewriteResponseModel('{"id":"1"}', "alias"), '{"id":"1"}');
    assert.strictEqual(rewriteResponseModel("not json", "alias"), "not json");
    assert.strictEqual(rewriteResponseModel('{"model":"u"}', ""), '{"model":"u"}');
  });

  it("rewrites bare JSON chunks and SSE data lines, keeping event framing", () => {
    assert.strictEqual(rewriteStreamChunk('{"model":"u"}', "a"), '{"model":"a"}');

    const framed =
      'event: message_start\ndata: {"type":"message_start","message":{"model":"u"}}\n\n';

    assert.strictEqual(
      rewriteStreamChunk(framed, "a"),
      'event: message_start\ndata: {"type":"message_start","message":{"model":"a"}}\n\n',
    );
    assert.strictEqual(rewriteStreamChunk("data: [DONE]\n\n", "a"), "data: [DONE]\n\n");
    assert.strictEqual(rewriteStreamChunk("event: ping\n\n", "a"), "event: ping\n\n");
  });
});

describe("executor snapshots", () => {
  it("maps the ControlPlane snapshot to the executor view", () => {
    const snapshot = toExecutorSnapshot({
      id: "x",
      provider: "openai-compatibility",
      source: "config",
      authKind: "apikey",
      label: "L",
      prefix: "team",
      disabled: false,
      priority: 0,
      weight: 1,
      attributes: { api_key: "k" },
      metadata: { disable_cooling: true },
      headers: { "X-Org": "o" },
      excludedModels: [],
      modelAliases: [],
      credentialVersion: 1,
      createdAt: 0,
      updatedAt: 0,
      baseUrl: "https://e.example",
      executor: "openai-compatible-l",
    });

    assert.deepStrictEqual(snapshot, {
      id: "x",
      provider: "openai-compatible-l",
      kind: "apikey",
      label: "L",
      credentialVersion: 1,
      prefix: "team",
      attributes: { api_key: "k", base_url: "https://e.example", "header:X-Org": "o" },
      metadata: { disable_cooling: true },
    });
  });
});

const snapshot = (overrides: Partial<CredentialSnapshot> = {}): CredentialSnapshot => ({
  id: "c",
  provider: "claude",
  kind: "oauth",
  attributes: {},
  metadata: {},
  ...overrides,
});

describe("Worker-side classification", () => {
  it.effect(
    "request-scoped rules come from the credential, then from oauth.request-scoped-errors",
    () =>
      Effect.gen(function* () {
        const config = yield* Effect.promise(() =>
          loadConfig(`
oauth:
  request-scoped-errors:
    claude:
      - { status: 400, match: ["oauth rule"], action: stop }
`),
        );

        const own = snapshot({
          metadata: { request_scoped_errors: [{ status: 429, match: ["x"], action: "continue" }] },
        });

        assert.deepStrictEqual(requestScopedRules(config, own), [
          { status: 429, match: ["x"], action: "continue" },
        ]);
        const rules = requestScopedRules(config, snapshot());
        assert.strictEqual(rules.length, 1);
        assert.deepStrictEqual(requestScopedRules(config, snapshot({ kind: "apikey" })), []);
        assert.deepStrictEqual(requestScopedRules(config, snapshot({ provider: "codex" })), []);
      }),
  );

  it("matches by status and substring or regexp; the first valid rule wins; bad rules are skipped", () => {
    const rules = [
      { status: 400, match: [], action: "stop" },
      { status: 400, "match-regexr": ["([unclosed"], action: "stop" },
      { status: 400, "match-regexr": ["context (window|length)"], action: "Continue-And-Cooldown" },
      { status: 400, match: ["context"], action: "bogus" },
      { status: 429, match: ["slow"], action: "stop" },
    ];

    const error = (status: number, message: string) => new ExecutionError({ status, message });
    assert.strictEqual(
      matchRequestScopedAction(rules, error(400, "context window exceeded")),
      "continue-and-cooldown",
    );
    assert.isUndefined(matchRequestScopedAction(rules, error(400, "context only")));
    assert.strictEqual(matchRequestScopedAction(rules, error(429, "slow down")), "stop");
    assert.isUndefined(matchRequestScopedAction(rules, error(500, "context window")));
  });

  it("builds report payloads with the Go error codes", () => {
    const report = (error: ExecutionError, extra = {}) =>
      failureReport(error, { provider: "openai-compatible-x", ...extra });

    assert.deepInclude(report(new ExecutionError({ status: 400, message: "bad" })).error, {
      code: "request_scoped",
    });
    assert.deepInclude(
      report(new ExecutionError({ status: 404, message: '{"error":{"code":"model_not_found"}}' }))
        .error,
      { code: "model_not_found" },
    );
    assert.deepInclude(
      report(
        new ExecutionError({ status: 500, code: "transient_transport", message: "fetch failed" }),
      ).error,
      { code: "transient_transport" },
    );

    const transport = report(
      new ExecutionError({ status: 500, code: "transient_transport", message: "x" }),
    );

    assert.isUndefined(transport.httpStatus);
    assert.deepInclude(
      report(new ExecutionError({ status: 400, message: "bad" }), { action: "stop-and-cooldown" })
        .error,
      {
        code: "force_cooldown",
      },
    );
    assert.deepInclude(
      report(new ExecutionError({ status: 500, message: "bad" }), { action: "continue" }).error,
      {
        code: "request_scoped",
      },
    );

    const quota = report(
      new ExecutionError({ status: 429, message: "q", retryAfterMs: 5000, credentialScoped: true }),
      { stateModel: "up-1" },
    );

    assert.deepInclude(quota, {
      retryAfterMs: 5000,
      credentialScoped: true,
      model: "up-1",
      httpStatus: 429,
    });
  });

  it("forwards response headers only for providers with quota signals", () => {
    const withHeaders = new Headers({ "retry-after": "3" });
    assert.deepStrictEqual(successReport({ provider: "claude", headers: withHeaders }).headers, {
      "retry-after": "3",
    });
    assert.isUndefined(successReport({ provider: "gemini", headers: withHeaders }).headers);
  });

  it("responses/compact failures are availability-neutral unless they are credential failures", () => {
    const report = (status: number, extra = {}) =>
      failureReport(new ExecutionError({ status, message: "x", ...extra }), {
        provider: "codex",
        compact: true,
      });

    assert.isTrue(report(500).availabilityNeutral);
    assert.isTrue(report(503).availabilityNeutral);

    for (const status of [401, 402, 403, 429])
      assert.isUndefined(report(status).availabilityNeutral);
    assert.isUndefined(report(500, { credentialScoped: true }).availabilityNeutral);
    assert.isUndefined(
      failureReport(new ExecutionError({ status: 500, message: "x" }), { provider: "codex" })
        .availabilityNeutral,
    );
  });

  it("count_tokens: a generic 404 is availability-neutral, model-not-found is not; no quota snapshot", () => {
    const report = (message: string) =>
      failureReport(new ExecutionError({ status: 404, message }), {
        provider: "claude",
        countTokens: true,
      });

    assert.isTrue(report("Not Found").availabilityNeutral);
    assert.isUndefined(report('{"error":{"code":"model_not_found"}}').availabilityNeutral);
    assert.isTrue(report("x").skipQuotaObservation);
    assert.isTrue(successReport({ provider: "claude", countTokens: true }).skipQuotaObservation);
  });

  it("compact request faults fail fast", () => {
    assert.isTrue(
      isCompactRequestFault(
        new ExecutionError({ status: 405, message: "no" }),
        "responses/compact",
      ),
    );
    assert.isFalse(isCompactRequestFault(new ExecutionError({ status: 405, message: "no" }), ""));
    assert.isFalse(
      isCompactRequestFault(
        new ExecutionError({ status: 500, message: "no" }),
        "responses/compact",
      ),
    );
    assert.isFalse(
      isCompactRequestFault(
        new ExecutionError({ status: 400, message: "no", credentialScoped: true }),
        "responses/compact",
      ),
    );
  });
});

describe("provider-specific request errors (issue #185)", () => {
  it("an upstream 400 or 422 qualifies; the executor's own request-scoped errors do not", () => {
    assert.isTrue(isProviderSpecificRequest(new ExecutionError({ status: 400, message: "bad" })));
    assert.isTrue(isProviderSpecificRequest(new ExecutionError({ status: 422, message: "bad" })));

    assert.isFalse(
      isProviderSpecificRequest(
        new ExecutionError({ status: 400, message: "bad", requestScoped: true }),
      ),
    );
    assert.isFalse(isProviderSpecificRequest(new ExecutionError({ status: 409, message: "bad" })));
    assert.isFalse(isProviderSpecificRequest(new ExecutionError({ status: 413, message: "bad" })));
  });

  it("a transport failure is not an upstream 400, whatever status the executor gave it", () => {
    assert.isFalse(
      isProviderSpecificRequest(
        new ExecutionError({ status: 400, message: "bad", code: "transient_transport" }),
      ),
    );
  });
});

describe("provider failover state (issue #185)", () => {
  const first = new ExecutionError({ status: 400, message: "first" });
  const second = new ExecutionError({ status: 422, message: "second" });

  it("excludes a provider whatever the case or padding of its key", () => {
    const failover = providerFailover(["openai-compatible-a", "claude", "openai-compatible-b"]);
    failover.exclude(" OpenAI-Compatible-A ", first);
    assert.deepStrictEqual(failover.remaining(), ["claude", "openai-compatible-b"]);

    const padded = providerFailover([" Claude ", "codex"]);
    padded.exclude("claude", first);
    assert.deepStrictEqual(padded.remaining(), ["codex"]);
  });

  it("remembers the first error that caused an exclusion", () => {
    const failover = providerFailover(["a", "b", "c"]);
    assert.isUndefined(failover.firstFault());
    assert.strictEqual(failover.exclude("a", first), first);
    assert.strictEqual(failover.exclude("b", second), first);
    assert.strictEqual(failover.firstFault(), first);
    assert.deepStrictEqual(failover.remaining(), ["c"]);
  });
});

describe("live thinking layer", () => {
  const thinking = makeLiveThinking(builtinTranslators);

  const levels = {
    id: "m",
    type: "openai-compatibility",
    thinking: { levels: ["low", "medium", "high"] },
  };

  it.effect("applies the suffix effort to an OpenAI body with resolved model info", () =>
    Effect.gen(function* () {
      const body = yield* thinking.apply({
        body: { model: "m", messages: [] },
        model: "m(high)",
        from: Formats.OpenAI,
        to: Formats.OpenAI,
        provider: "openai-compatible-x",
        modelInfo: levels,
      });

      assert.strictEqual((body as { reasoning_effort?: string }).reasoning_effort, "high");
    }),
  );

  it.effect("clamps a level the model does not support to its closest supported level", () =>
    Effect.gen(function* () {
      const body = yield* thinking.apply({
        body: { model: "m", messages: [] },
        model: "m(high)",
        from: Formats.OpenAI,
        to: Formats.OpenAI,
        provider: "openai-compatible-x",
        modelInfo: { id: "m", type: "openai-compatibility", thinking: { levels: ["low"] } },
      });

      assert.strictEqual((body as { reasoning_effort?: string }).reasoning_effort, "low");
    }),
  );

  it.effect("an unsupported level of a same-family model is a request-scoped 400", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        thinking.apply({
          body: { model: "m", messages: [] },
          model: "m(high)",
          from: Formats.OpenAI,
          to: Formats.OpenAI,
          provider: "openai",
          modelInfo: { id: "m", type: "openai", thinking: { levels: ["low"] } },
        }),
      );

      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.requestScoped, true);
      assert.include(error.message, "not supported");
    }),
  );

  it.effect("strips thinking for a model without thinking support", () =>
    Effect.gen(function* () {
      const body = yield* thinking.apply({
        body: { model: "m", messages: [], reasoning_effort: "high" },
        model: "m",
        from: Formats.OpenAI,
        to: Formats.OpenAI,
        provider: "openai-compatible-x",
        modelInfo: { id: "m", type: "openai-compatibility" },
      });

      assert.isUndefined((body as { reasoning_effort?: string }).reasoning_effort);
    }),
  );

  it.effect("unknown models are passed through without validation", () =>
    Effect.gen(function* () {
      const body = yield* thinking.apply({
        body: { model: "m", messages: [] },
        model: "m(medium)",
        from: Formats.OpenAI,
        to: Formats.OpenAI,
        provider: "openai-compatible-x",
      });

      assert.strictEqual((body as { reasoning_effort?: string }).reasoning_effort, "medium");
    }),
  );

  it("compat model info: default levels, configured thinking support and image models", () => {
    const models = [
      { name: "plain" },
      { name: "up", alias: "friendly", thinking: { levels: ["None", "auto", "high"], max: 100 } },
      { name: "img", image: true },
    ];

    assert.deepStrictEqual(compatModelInfo(models, "plain(high)")?.thinking?.levels, [
      "low",
      "medium",
      "high",
    ]);
    const configured = compatModelInfo(models, "friendly");
    assert.deepInclude(configured?.thinking, {
      levels: ["none", "auto", "high"],
      zeroAllowed: true,
      dynamicAllowed: true,
      max: 100,
    });
    assert.strictEqual(configured?.id, "friendly");
    assert.strictEqual(compatModelInfo(models, "up")?.id, "friendly");
    assert.deepInclude(compatModelInfo(models, "img"), { type: "openai-image" });
    assert.isUndefined(compatModelInfo(models, "img")?.thinking);
    assert.isUndefined(compatModelInfo(models, "missing"));
  });
});

describe("credential preparation rules (needsPreparation)", () => {
  const NOW = 1_800_000_000_000;

  const oauth = (provider: string, metadata: JsonObject): CredentialSnapshot =>
    snapshot({ provider, kind: "oauth", metadata });

  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

  it("Provider keys never need it; OAuth tokens only when missing or expired", () => {
    assert.isFalse(needsPreparation(snapshot({ kind: "apikey", metadata: {} }), NOW));
    assert.isFalse(
      needsPreparation(oauth("claude", { access_token: "t", expired: iso(3_600_000) }), NOW),
    );
    assert.isTrue(
      needsPreparation(oauth("claude", { access_token: "t", expired: iso(-1000) }), NOW),
    );
    assert.isTrue(needsPreparation(oauth("claude", { refresh_token: "r" }), NOW));
    assert.isFalse(needsPreparation(oauth("claude", { access_token: "t" }), NOW));
  });

  it("Antigravity refreshes within 5 minutes of expiry; Vertex and Meta mint on demand", () => {
    assert.isTrue(
      needsPreparation(oauth("antigravity", { access_token: "t", expired: iso(4 * 60_000) }), NOW),
    );
    assert.isFalse(
      needsPreparation(oauth("antigravity", { access_token: "t", expired: iso(6 * 60_000) }), NOW),
    );
    assert.isTrue(needsPreparation(oauth("vertex", { type: "vertex" }), NOW));
    assert.isFalse(
      needsPreparation(oauth("vertex", { type: "vertex", access_token: "minted" }), NOW),
    );
  });
});

describe("CredentialRefresher over the ControlPlane", () => {
  it.effect("turns a failing RPC into a structured, non-terminal refresh failure", () =>
    Effect.gen(function* () {
      const refresher = yield* CredentialRefresher;
      const result = yield* refresher.refreshNow("x", "tok");
      assert.deepStrictEqual(result, {
        ok: false,
        error: { code: "refresh_failed", message: "credential store unavailable" },
        terminal: false,
      });
    }).pipe(
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.provide(
        CredentialRefresher.layerFor(() => ({
          refreshNow: () => Promise.reject(new Error("rpc down")),
          ensureFresh: () => Promise.reject(new Error("rpc down")),
        })),
      ),
      Effect.provideContext(envContext({} as Cloudflare.Env)),
    ),
  );
});
