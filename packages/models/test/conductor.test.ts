// Execution conductor: retry rounds across credentials, cooldown waits (TestClock), request-scoped rules, stream
// bootstrap failover, alias pools, force-mapping and session affinity, run against the real credential pool with an
// injected clock and a mocked upstream (conductor_retry_round_test.go, conductor_execution_quota_test.go,
// conductor_request_scoped_errors_test.go, conductor_stream_*_test.go, conductor_force_mapping_test.go).
import { assert, beforeEach, describe, it } from "@effect/vitest";
import { Context, Effect, Exit, Fiber, Layer, Result, Scope, Stream } from "effect";
import type { HttpServerRequest } from "effect/http";
import { TestClock } from "effect/testing";
import { type AccessIdentity, AccessPrincipal } from "@commissary/auth";
import { type BillingBindings, BillingEnv } from "@commissary/billing/api";
import { resetBillingCaches } from "@commissary/billing/testing";
import type { ConfigReader } from "../src/config/reader.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import { CredentialRefresher } from "../src/executor/helps/credential-refresh.ts";
import { ExecutorRegistry, makeExecutorRegistry } from "../src/executor/registry.ts";
import type { ProviderExecutor } from "../src/executor/types.ts";
import type { RefreshResult } from "../src/credentials/refresh/index.ts";
import { Thinking } from "../src/executor/thinking.ts";
import { executeCountTokens, executeNonStream, executeStream } from "../src/handlers/execute.ts";
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { Formats } from "@commissary/translation/formats";
import { asString } from "@commissary/json";
import type { UsageCost } from "../src/usage/pricing.ts";
import type { UsageRecord } from "../src/usage/record.ts";
import { UsageSink } from "../src/usage/sink.ts";
import type { PoolOptions } from "../src/credentials/pool.ts";
import { SpendLedger } from "@commissary/state/spend";
import { periodBounds } from "@commissary/state/spend";
import {
  jsonResponse,
  mockHttpClient,
  sseResponse,
  staticConfigReader,
  type UpstreamCall,
} from "./support/pipeline.ts";
import {
  makePool,
  type MemoryPoolStore,
  poolPickerLayer,
  type PoolHarness,
} from "./support/pool.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { limit, MemorySpendBook, USD } from "@commissary/state/testing";
import { envContext } from "./support/context.ts";

const identity = {
  principal: { kind: "user", email: "dev@example.com", sub: "sub" },
  principalId: "user:dev@example.com",
  callerScope: "scope-1",
  org: GLOBAL_ORG,
  platformAdmin: false,
} as const;

const fakeRequest = (headers: Record<string, string> = {}) =>
  // Only url, method and headers are read by the conductor.
  ({
    url: "/v1/chat/completions",
    method: "POST",
    headers,
  }) as unknown as HttpServerRequest.HttpServerRequest;

const group = (name: string, extra = "", models = "{ name: m }") => `
    - name: ${name}
      base-url: https://${name}.example/v1
      ${extra}
      models: [${models}]
      keys: [{ api-key: key-${name} }]`;

const config = (groups: string, extra = "") => `
${extra}
api-keys:
  openai-compatibility:${groups}
`;

const CHAT_OK = {
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
};

/** Which credential an upstream call used (`Authorization: Bearer key-<name>`). */
const keyOf = (call: UpstreamCall): string =>
  (call.headers["authorization"] ?? "").replace("Bearer key-", "");

const upstreamError = (
  status: number,
  body = "upstream failure",
  headers: Record<string, string> = {},
) => new Response(body, { status, headers });

interface Run {
  readonly harness: PoolHarness;
  readonly calls: Array<UpstreamCall>;
  readonly records: Array<UsageRecord>;
  /** Provides every service of the pipeline; scoped effects must be wrapped in `Effect.scoped` by the caller. */
  readonly exec: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E>;
}

interface SetupOptions {
  readonly refresher?:
    | Layer.Layer<CredentialRefresher>
    | ((harness: PoolHarness) => Layer.Layer<CredentialRefresher>);
  readonly executors?: Layer.Layer<ExecutorRegistry>;
  readonly providers?: Layer.Layer<ModelProviders, never, ConfigReader>;
  readonly prepare?: (harness: PoolHarness) => void;
  readonly store?: MemoryPoolStore;
  /** The org's Spend limits (issue #71). */
  readonly spend?: PoolOptions["spend"];
  /** Members' private provider key groups: YAML configs by member id. */
  readonly privateConfigs?: Readonly<Record<string, string>>;
  /** Who asks (a member, an API key); a user without a member by default. */
  readonly identity?: AccessIdentity;
  /** What the usage sink says an attempt cost, for the Spend limits (nothing by default). */
  readonly cost?: (record: UsageRecord) => UsageCost | undefined;
  /** Billing's view of `env`: self-hosted (nothing counted) by default. */
  readonly billing?: BillingBindings;
}

const setup = (
  yaml: string,
  respond: (call: UpstreamCall, index: number) => Response | Promise<Response>,
  options: SetupOptions = {},
): Effect.Effect<Run> =>
  Effect.gen(function* () {
    const harness = yield* Effect.promise(
      async () =>
        await makePool(yaml, {
          ...(options.store === undefined ? {} : { store: options.store }),
          ...(options.spend === undefined ? {} : { spend: options.spend }),
          ...(options.privateConfigs === undefined
            ? {}
            : { privateConfigs: options.privateConfigs }),
        }),
    );

    options.prepare?.(harness);

    const refresher =
      typeof options.refresher === "function"
        ? options.refresher(harness)
        : (options.refresher ?? CredentialRefresher.none);

    const calls: Array<UpstreamCall> = [];
    const records: Array<UsageRecord> = [];

    const layer = Layer.mergeAll(
      poolPickerLayer(harness.pool),
      options.providers ?? ModelProviders.configLayer,
      ModelCapabilities.configLayer,
      options.executors ?? ExecutorRegistry.layer,
      refresher,
      UsageSink.memory(records, options.cost),
      mockHttpClient(calls, (call) => respond(call, calls.length - 1)),
      Thinking.live,
    ).pipe(Layer.provideMerge(staticConfigReader(harness.config)));

    const exec = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      // The layer provides every service the conductor needs (`Scope` is provided by the caller where used).
      effect.pipe(
        Effect.provide(layer),
        Effect.provideService(AccessPrincipal, options.identity ?? identity),
        Effect.provideContext(
          options.billing === undefined
            ? envContext({} as Cloudflare.Env)
            : Context.add(envContext({} as Cloudflare.Env), BillingEnv, options.billing),
        ),
        Effect.provideService(CurrentOrg, GLOBAL_ORG),
      ) as unknown as Effect.Effect<A, E>;

    return { harness, calls, records, exec };
  });

const chatInput = (
  model = "m",
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => ({
  entryProtocol: Formats.OpenAI,
  model,
  body: { model, messages: [{ role: "user", content: "hello" }], ...extra },
  alt: "",
  request: fakeRequest(headers),
});

const bodyOf = (call: UpstreamCall): Record<string, unknown> =>
  JSON.parse(call.body) as Record<string, unknown>;

const failure = <A>(effect: Effect.Effect<A, ExecutionError>) => Effect.flip(effect);

describe("failover within a round", () => {
  it.effect("moves to the next credential after a 5xx and cools the failed one down", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(500) : jsonResponse(CHAT_OK),
      );

      const result = yield* run.exec(executeNonStream(chatInput()));
      assert.include(result.payload, "chat.completion");
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      assert.deepStrictEqual(
        run.records.map((record) => [record.failed, record.source]),
        [
          [true, "a"],
          [false, "b"],
        ],
      );
      // The failed credential is cooling: the next requests keep using b without touching a.
      yield* run.exec(executeNonStream(chatInput()));
      yield* run.exec(executeNonStream(chatInput()));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "b", "b"]);
    }),
  );

  it.effect(
    "returns request faults at once without rotating or cooling (isRequestInvalidError)",
    () =>
      Effect.gen(function* () {
        const body = '{"error":{"message":"bad input","type":"invalid_request_error"}}';
        const run = yield* setup(config(group("a") + group("b")), () => upstreamError(409, body));
        const error = yield* failure(run.exec(executeNonStream(chatInput())));
        assert.strictEqual(error.status, 409);
        assert.strictEqual(error.message, body);
        assert.strictEqual(run.calls.length, 1);
        // The credential stays selectable: request faults carry no penalty.
        const first = run.calls.map(keyOf)[0] as string;
        const credential = run.harness.pool.list().find((item) => item.label === first);
        assert.strictEqual(credential?.unavailable, false);
        assert.strictEqual(credential?.failed, 1);
      }),
  );

  it.effect(
    "429 and 401 rotate to the next credential; the final error is the last upstream error",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(config(group("a") + group("b")), (call) =>
          keyOf(call) === "a" ? upstreamError(401, "bad key") : upstreamError(429, "quota gone"),
        );

        const error = yield* failure(run.exec(executeNonStream(chatInput())));
        assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
        assert.strictEqual(error.status, 429);
        assert.strictEqual(error.message, "quota gone");
      }),
  );

  it.effect("reports a client abort as a lifecycle failure without cooling the credential", () =>
    Effect.gen(function* () {
      // The upstream never answers: the request is interrupted while the attempt is in flight.
      const run = yield* setup(config(group("a")), () => new Promise<Response>(() => {}));
      const fiber = yield* Effect.forkChild(run.exec(executeNonStream(chatInput())));
      yield* TestClock.adjust(10);
      assert.strictEqual(run.calls.length, 1);
      yield* Fiber.interrupt(fiber);
      const credential = run.harness.pool.list()[0];
      assert.strictEqual(credential?.failed, 1);
      assert.strictEqual(credential?.unavailable, false);
      assert.strictEqual(run.records.length, 1);
    }),
  );
});

describe("retry rounds (TestExecuteRetryRoundCredentialWindows / MaxCredentialsAgesSkippedAuths)", () => {
  it.effect("credentials drop out of later rounds when their request-retry is spent", () =>
    Effect.gen(function* () {
      const yaml = config(
        group("a", "request-retry: 3\n      disable-cooling: true") +
          group("b", "request-retry: 2\n      disable-cooling: true") +
          group("c", "request-retry: 2\n      disable-cooling: true"),
        "routing:\n  retry:\n    request-retry: 3",
      );

      const run = yield* setup(yaml, () => upstreamError(500));
      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 500);

      const counts = Object.fromEntries(
        ["a", "b", "c"].map((name) => [
          name,
          run.calls.filter((call) => keyOf(call) === name).length,
        ]),
      );

      assert.deepStrictEqual(counts, { a: 4, b: 3, c: 3 });
    }),
  );

  it.effect("max-retry-credentials caps the credentials tried per round", () =>
    Effect.gen(function* () {
      const off = "disable-cooling: true";

      const yaml = config(
        group("a", `request-retry: 1\n      ${off}`) +
          group("b", `request-retry: 1\n      ${off}`) +
          group("c", `request-retry: 1\n      ${off}`) +
          group("d", `request-retry: 2\n      ${off}`),
        "routing:\n  retry:\n    request-retry: 2\n    max-retry-credentials: 3",
      );

      const run = yield* setup(yaml, () => upstreamError(500));
      yield* failure(run.exec(executeNonStream(chatInput())));
      const order = run.calls.map(keyOf);
      assert.strictEqual(order.length, 7);
      assert.strictEqual(order.at(-1), "d");

      for (const name of ["a", "b", "c"])
        assert.isAtMost(order.filter((key) => key === name).length, 2);
      assert.isAtMost(order.filter((key) => key === "d").length, 3);
    }),
  );

  it.effect(
    "without request-retry a failed request is not retried beyond the credentials of one round",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(config(group("a", "disable-cooling: true")), () =>
          upstreamError(500),
        );

        yield* failure(run.exec(executeNonStream(chatInput())));
        assert.strictEqual(run.calls.length, 1);
      }),
  );
});

describe("cooldown waits", () => {
  const waiting = config(
    group("a"),
    "routing:\n  retry:\n    request-retry: 1\n    max-retry-interval: 30",
  );

  it.effect("waits for the recovery of the only credential (TestClock) and then succeeds", () =>
    Effect.gen(function* () {
      const run = yield* setup(waiting, (_call, index) =>
        index === 0
          ? upstreamError(429, "slow down", { "retry-after": "12" })
          : jsonResponse(CHAT_OK),
      );

      const fiber = yield* Effect.forkChild(run.exec(executeNonStream(chatInput())));
      yield* TestClock.adjust(5000);
      run.harness.clock.advance(5000);
      assert.strictEqual(run.calls.length, 1);
      assert.isUndefined(fiber.pollUnsafe());
      // 12 s cooldown plus up to 2 s of jitter.
      run.harness.clock.advance(10_000);
      yield* TestClock.adjust(10_000);
      const result = yield* Fiber.join(fiber);
      assert.include(result.payload, "chat.completion");
      assert.strictEqual(run.calls.length, 2);
    }),
  );

  it.effect("answers 429 with Retry-After instead of waiting longer than max-retry-interval", () =>
    Effect.gen(function* () {
      const yaml = config(
        group("a"),
        "routing:\n  retry:\n    request-retry: 1\n    max-retry-interval: 5",
      );

      const run = yield* setup(yaml, () => upstreamError(429, "quota", { "retry-after": "90" }));
      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 429);
      assert.strictEqual(error.safeHeaders?.["retry-after"], "90");
      assert.strictEqual(run.calls.length, 1);
    }),
  );

  it.effect(
    "selection failures while every credential cools carry the Go model_cooldown body",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(config(group("a")), () =>
          upstreamError(429, "quota", { "retry-after": "30" }),
        );

        yield* failure(run.exec(executeNonStream(chatInput())));
        const error = yield* failure(run.exec(executeNonStream(chatInput())));
        assert.strictEqual(error.status, 429);
        assert.strictEqual(error.code, "model_cooldown");
        assert.strictEqual(error.safeHeaders?.["retry-after"], "30");
        assert.include(error.message, '"code":"model_cooldown"');
        assert.strictEqual(run.calls.length, 1);
      }),
  );
});

const rule = (action: string) =>
  `request-scoped-errors:\n        - { status: 400, match: ["context window"], action: ${action} }`;

const respondContextWindow = (call: UpstreamCall) =>
  keyOf(call) === "a"
    ? upstreamError(400, "the context window is too large")
    : jsonResponse(CHAT_OK);

describe("request-scoped error rules", () => {
  it.effect("continue: the matching error moves on to the next credential without a penalty", () =>
    Effect.gen(function* () {
      const run = yield* setup(
        config(group("a", rule("continue")) + group("b")),
        respondContextWindow,
      );

      const result = yield* run.exec(executeNonStream(chatInput()));
      assert.include(result.payload, "chat.completion");
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      const a = run.harness.pool.list().find((item) => item.label === "a");
      assert.strictEqual(a?.unavailable, false);
    }),
  );

  it.effect("continue-and-cooldown: moves on and cools the credential", () =>
    Effect.gen(function* () {
      const run = yield* setup(
        config(group("a", rule("continue-and-cooldown")) + group("b")),
        respondContextWindow,
      );

      yield* run.exec(executeNonStream(chatInput()));
      yield* run.exec(executeNonStream(chatInput()));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "b"]);
    }),
  );

  it.effect("stop: returns the error to the client; stop-and-cooldown also cools", () =>
    Effect.gen(function* () {
      const stop = yield* setup(
        config(group("a", rule("stop")) + group("b")),
        respondContextWindow,
      );

      const error = yield* failure(stop.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 400);
      assert.strictEqual(stop.calls.length, 1);

      const cool = yield* setup(
        config(group("a", rule("stop-and-cooldown"))),
        respondContextWindow,
      );

      yield* failure(cool.exec(executeNonStream(chatInput())));
      const next = yield* failure(cool.exec(executeNonStream(chatInput())));
      assert.strictEqual(next.code, "auth_unavailable");
      assert.strictEqual(cool.calls.length, 1);
    }),
  );

  it.effect("a rule that does not match leaves the default classification in place", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", rule("continue"))), () =>
        upstreamError(400, "other problem"),
      );

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 400);
      assert.strictEqual(run.calls.length, 1);
    }),
  );
});

const EXTRA_INPUTS = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "messages.0.foo: Extra inputs are not permitted",
  },
});

const stopExtraInputs = `request-scoped-errors:\n        - { status: 400, match: ["Extra inputs"], action: stop }`;

/** Provider `a` with two credentials (`key-a1`, `key-a2`): one provider, so one failover unit. */
const twoKeys = (extra = "") => `
    - name: a
      base-url: https://a.example/v1
      ${extra}
      models: [{ name: m }]
      keys: [{ api-key: key-a1 }, { api-key: key-a2 }]`;

describe("provider failover after a 400 that may be specific to one provider (issue #185)", () => {
  it.effect("a 400 from provider A is served by provider B, and A is not cooled down", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(400, EXTRA_INPUTS) : jsonResponse(CHAT_OK),
      );

      const result = yield* run.exec(executeNonStream(chatInput()));
      assert.include(result.payload, "chat.completion");
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      assert.deepStrictEqual(
        run.records.map((record) => [record.source, record.failed, record.fail?.statusCode]),
        [
          ["a", true, 400],
          ["b", false, undefined],
        ],
      );
      const a = run.harness.pool.list().find((item) => item.label === "a");
      assert.strictEqual(a?.unavailable, false);
    }),
  );

  it.effect("a 422 behaves like a 400", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(422, "unprocessable") : jsonResponse(CHAT_OK),
      );

      const result = yield* run.exec(executeNonStream(chatInput()));
      assert.include(result.payload, "chat.completion");
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
    }),
  );

  it.effect("two credentials of the same provider: one attempt, the client gets the 400", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(twoKeys()), () => upstreamError(400, EXTRA_INPUTS));

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.message, EXTRA_INPUTS);
      assert.strictEqual(run.calls.length, 1);
      assert.strictEqual(run.records.length, 1);
    }),
  );

  it.effect("the other credentials of the failing provider are skipped", () =>
    Effect.gen(function* () {
      // `a` is the higher priority tier, so it is selected first; `b` is the only other provider.
      const run = yield* setup(config(twoKeys("priority: 5") + group("b")), (call) =>
        keyOf(call).startsWith("a") ? upstreamError(400, EXTRA_INPUTS) : jsonResponse(CHAT_OK),
      );

      yield* run.exec(executeNonStream(chatInput()));
      const keys = run.calls.map(keyOf);
      assert.strictEqual(keys.length, 2);
      assert.isTrue(keys[0]?.startsWith("a"));
      assert.strictEqual(keys[1], "b");
    }),
  );

  it.effect("every provider answers 400: one attempt each, the client gets the first error", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        upstreamError(400, `rejected by ${keyOf(call)}`),
      );

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.message, "rejected by a");
      assert.deepStrictEqual(
        run.records.map((record) => [record.source, record.failed]),
        [
          ["a", true],
          ["b", true],
        ],
      );
    }),
  );

  it.effect(
    "A answers 400, then B answers 503: A is not tried again and the client gets A's 400",
    () =>
      Effect.gen(function* () {
        const yaml = config(
          group("a", "disable-cooling: true\n      priority: 5") +
            group("b", "disable-cooling: true"),
          "routing:\n  retry:\n    request-retry: 2",
        );

        const run = yield* setup(yaml, (call) =>
          keyOf(call) === "a" ? upstreamError(400, EXTRA_INPUTS) : upstreamError(503, "busy"),
        );

        const error = yield* failure(run.exec(executeNonStream(chatInput())));
        // Retry rounds repeat B (its request-retry budget); A, excluded for the request, never comes back.
        assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "b", "b"]);
        assert.strictEqual(error.status, 400);
        assert.strictEqual(error.message, EXTRA_INPUTS);
      }),
  );

  it.effect("B answers 503 before A answers 400: B still gets its retry rounds", () =>
    Effect.gen(function* () {
      // `b` is selected first, then `a` (lower tier). The 400 of `a` must not hide the 503 that opens a retry round.
      const yaml = config(
        group("a", "disable-cooling: true") +
          group("b", "disable-cooling: true\n      priority: 5"),
        "routing:\n  retry:\n    request-retry: 1",
      );

      const run = yield* setup(yaml, (call) =>
        keyOf(call) === "a" ? upstreamError(400, EXTRA_INPUTS) : upstreamError(503, "busy"),
      );

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.deepStrictEqual(run.calls.map(keyOf), ["b", "a", "b"]);
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.message, EXTRA_INPUTS);
    }),
  );

  it.effect("a matching stop rule on A keeps the request from failing over", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a", stopExtraInputs) + group("b")), (call) =>
        keyOf(call) === "a" ? upstreamError(400, EXTRA_INPUTS) : jsonResponse(CHAT_OK),
      );

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 400);
      assert.deepStrictEqual(run.calls.map(keyOf), ["a"]);
    }),
  );

  it.effect("a 409 or 413 from A does not fail over", () =>
    Effect.gen(function* () {
      for (const status of [409, 413]) {
        const run = yield* setup(config(group("a") + group("b")), (call) =>
          keyOf(call) === "a" ? upstreamError(status, "nope") : jsonResponse(CHAT_OK),
        );

        const error = yield* failure(run.exec(executeNonStream(chatInput())));
        assert.strictEqual(error.status, status);
        assert.deepStrictEqual(run.calls.map(keyOf), ["a"]);
      }
    }),
  );

  const localValidation = (credentialLabel: string): Layer.Layer<ExecutorRegistry> => {
    const base = makeExecutorRegistry();

    return Layer.succeed(
      ExecutorRegistry,
      ExecutorRegistry.of({
        get: (provider) => {
          const executor = base.get(provider);

          if (executor === undefined) return undefined;

          return {
            ...executor,
            execute: (context, request, options) =>
              context.credential.label === credentialLabel
                ? Effect.fail(
                    new ExecutionError({
                      status: 400,
                      message: "role 'system' is not supported on this model",
                      requestScoped: true,
                    }),
                  )
                : executor.execute(context, request, options),
          };
        },
      }),
    );
  };

  it.effect("a request-scoped 400 raised by Commissary itself does not fail over", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), () => jsonResponse(CHAT_OK), {
        executors: localValidation("a"),
      });

      const error = yield* failure(run.exec(executeNonStream(chatInput())));
      assert.strictEqual(error.status, 400);
      assert.include(error.message, "role 'system'");
      assert.strictEqual(run.calls.length, 0);
      assert.strictEqual(run.records.length, 1);
    }),
  );

  it.effect("responses/compact keeps stopping at a request fault", () =>
    Effect.gen(function* () {
      const compact = {
        entryProtocol: Formats.OpenAIResponse,
        model: "m",
        body: { model: "m", input: "hello" },
        alt: "responses/compact",
        request: fakeRequest(),
      };

      const answer = (call: UpstreamCall) =>
        keyOf(call) === "a" ? upstreamError(400, EXTRA_INPUTS) : jsonResponse({ output: [] });

      const stopped = yield* setup(config(group("a") + group("b")), answer);
      const error = yield* failure(stopped.exec(executeNonStream(compact)));
      assert.strictEqual(error.status, 400);
      assert.deepStrictEqual(stopped.calls.map(keyOf), ["a"]);

      // The same request without `alt` fails over, so the compact stop is the rule at work.
      const failover = yield* setup(config(group("a") + group("b")), answer);
      yield* failover.exec(executeNonStream({ ...compact, alt: "" }));
      assert.deepStrictEqual(failover.calls.map(keyOf), ["a", "b"]);
    }),
  );

  it.effect("a streamed request fails over before the bootstrap and receives B's stream", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b")), (call) =>
        keyOf(call) === "a"
          ? upstreamError(400, EXTRA_INPUTS)
          : sseResponse([chunk("hi"), "data: [DONE]\n\n"]),
      );

      const chunks = yield* collect(run);
      assert.isTrue(chunks.some((text) => text.includes('"content":"hi"')));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      assert.deepStrictEqual(
        run.records.map((record) => [record.source, record.failed]),
        [
          ["a", true],
          ["b", false],
        ],
      );
      const a = run.harness.pool.list().find((item) => item.label === "a");
      assert.strictEqual(a?.unavailable, false);
    }),
  );
});

describe("alias pools and force-mapping", () => {
  const pooled = config(`
    - name: p
      base-url: https://p.example/v1
      models:
        - { name: up-1, alias: shared }
        - { name: up-2, alias: shared }
      keys: [{ api-key: key-p }]`);

  it.effect(
    "tries the pool's upstream models in turn within one credential and cools them separately",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(pooled, (call) =>
          bodyOf(call).model === "up-1" ? upstreamError(500) : jsonResponse(CHAT_OK),
        );

        for (let index = 0; index < 4; index += 1)
          yield* run.exec(executeNonStream(chatInput("shared")));
        const models = run.calls.map((call) => bodyOf(call).model);
        // up-1 fails at most once (then cools for 60 s); every request is served by up-2.
        assert.strictEqual(models.filter((model) => model === "up-1").length, 1);
        assert.strictEqual(models.filter((model) => model === "up-2").length, 4);
        assert.strictEqual(run.records.filter((record) => record.failed).length, 1);
      }),
  );

  it.effect("rewrites the model of a force-mapped response (non-stream and stream)", () =>
    Effect.gen(function* () {
      const yaml = config(`
    - name: f
      base-url: https://f.example/v1
      models: [{ name: real-model, alias: friendly, force-mapping: true }]
      keys: [{ api-key: key-f }]`);

      const run = yield* setup(yaml, (call) => {
        const stream = bodyOf(call).stream === true;

        return stream
          ? sseResponse([
              'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"real-model","choices":[{"index":0,"delta":{"content":"x"}}]}\n\n',
              "data: [DONE]\n\n",
            ])
          : jsonResponse({ ...CHAT_OK, model: "real-model" });
      });

      const result = yield* run.exec(executeNonStream(chatInput("friendly")));
      assert.strictEqual((JSON.parse(result.payload) as { model: string }).model, "friendly");
      assert.strictEqual(bodyOf(run.calls[0] as UpstreamCall).model, "real-model");

      const stream = yield* run.exec(
        Effect.scoped(
          executeStream(chatInput("friendly", { stream: true })).pipe(
            Effect.flatMap((output) => Stream.runCollect(output.chunks)),
          ),
        ),
      );

      const joined = [...stream].join("");
      assert.include(joined, '"model":"friendly"');
      assert.notInclude(joined, "real-model");
    }),
  );
});

const chunk = (text: string) =>
  `data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\n`;

const collect = (run: Run, input = chatInput("m", { stream: true })) =>
  run.exec(
    Effect.scoped(
      executeStream(input).pipe(
        Effect.flatMap((output) =>
          Stream.runCollect(output.chunks).pipe(Effect.map((chunks) => [...chunks])),
        ),
      ),
    ),
  );

describe("streaming", () => {
  it.effect("fails over before the first byte (HTTP error, then an empty stream)", () =>
    Effect.gen(function* () {
      const run = yield* setup(config(group("a") + group("b") + group("c")), (call) => {
        const key = keyOf(call);

        if (key === "a") return upstreamError(503);

        if (key === "b") return sseResponse([": keep-alive\n\n"]);

        return sseResponse([chunk("hi"), "data: [DONE]\n\n"]);
      });

      const chunks = yield* collect(run);
      assert.isTrue(chunks.some((text) => text.includes('"content":"hi"')));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b", "c"]);
      assert.deepStrictEqual(
        run.records.map((record) => record.failed),
        [true, true, false],
      );
    }),
  );

  it.effect(
    "does not fail over after the first byte: the error reaches the client and is reported",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(config(group("a") + group("b")), () =>
          sseResponse([chunk("part"), '{"error":{"message":"midstream"}}\n']),
        );

        const exit = yield* Effect.exit(collect(run));
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(run.calls.length, 1);
        assert.strictEqual(run.records.length, 1);
        assert.isTrue(run.records[0]?.failed);
      }),
  );

  it.effect(
    "reports success when the stream ends and an early close as lifecycle (no cooldown)",
    () =>
      Effect.gen(function* () {
        const run = yield* setup(config(group("a")), () =>
          sseResponse([chunk("one"), chunk("two"), "data: [DONE]\n\n"]),
        );

        yield* collect(run);
        assert.deepStrictEqual(
          run.harness.pool.list().map((item) => [item.failed, item.unavailable]),
          [[0, false]],
        );

        // Client goes away after the first chunk.
        yield* run.exec(
          Effect.gen(function* () {
            const scope = yield* Scope.make();

            const output = yield* executeStream(chatInput("m", { stream: true })).pipe(
              Scope.provide(scope),
            );

            yield* Stream.take(output.chunks, 1).pipe(Stream.runDrain, Scope.provide(scope));
            yield* Scope.close(scope, Exit.void);
          }),
        );
        const credential = run.harness.pool.list()[0];
        assert.strictEqual(credential?.unavailable, false);
      }),
  );

  it.effect(
    "requests.streaming.bootstrap-retries repeats the execution for bootstrap failures",
    () =>
      Effect.gen(function* () {
        const yaml = config(
          group("a", "disable-cooling: true"),
          "requests:\n  streaming:\n    bootstrap-retries: 1",
        );

        const run = yield* setup(yaml, (_call, index) =>
          index === 0
            ? sseResponse([": nothing\n\n"])
            : sseResponse([chunk("ok"), "data: [DONE]\n\n"]),
        );

        const chunks = yield* collect(run);
        assert.isTrue(chunks.some((text) => text.includes('"content":"ok"')));
        assert.strictEqual(run.calls.length, 2);

        const none = yield* setup(config(group("a", "disable-cooling: true")), () =>
          sseResponse([": nothing\n\n"]),
        );

        const exit = yield* Effect.exit(collect(none));
        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(none.calls.length, 1);
      }),
  );
});

describe("session affinity and thinking", () => {
  it.effect("binds a session (explicit header) to one credential per caller scope", () =>
    Effect.gen(function* () {
      const yaml = config(
        group("a") + group("b") + group("c"),
        "routing:\n  session-affinity: true",
      );

      const run = yield* setup(yaml, () => jsonResponse(CHAT_OK));
      const sessionInput = chatInput("m", {}, { "x-session-id": "session-42" });

      for (let index = 0; index < 5; index += 1) yield* run.exec(executeNonStream(sessionInput));
      assert.strictEqual(new Set(run.calls.map(keyOf)).size, 1);

      // Without a session marker unrelated conversations rotate ...
      const conversation = (text: string) => ({
        ...chatInput(),
        body: { model: "m", messages: [{ role: "user", content: text }] },
      });

      for (let index = 0; index < 6; index += 1)
        yield* run.exec(executeNonStream(conversation(`topic ${index}`)));
      assert.isAbove(new Set(run.calls.slice(5).map(keyOf)).size, 1);
      // ... while the same conversation stays on one credential (LCP matcher / derived identity).
      const before = run.calls.length;

      for (let index = 0; index < 4; index += 1)
        yield* run.exec(executeNonStream(conversation("topic 0")));
      assert.strictEqual(new Set(run.calls.slice(before).map(keyOf)).size, 1);
      assert.strictEqual(
        run.calls.slice(before).map(keyOf)[0],
        keyOf(run.calls[5] as UpstreamCall),
      );
      // Usage records carry the session identity (explicit, then LCP) and the credential's base URL.
      assert.strictEqual(run.records[0]?.sessionId, "header:session-42");
      assert.match(run.records[5]?.sessionId ?? "", /^lcp:v1:[0-9a-f]{64}$/);
      assert.strictEqual(run.records[before]?.sessionId, run.records[5]?.sessionId);
      assert.match(run.records[0]?.baseUrl ?? "", /^https:\/\/[a-z]\.example/);
    }),
  );

  it.effect("applies the thinking suffix through the real pipeline", () =>
    Effect.gen(function* () {
      const run = yield* setup(
        config(group("t", "", "{ name: m, thinking: { levels: [low, medium, high] } }")),
        () => jsonResponse(CHAT_OK),
      );

      yield* run.exec(executeNonStream(chatInput("m(high)")));
      const body = bodyOf(run.calls[0] as UpstreamCall);
      assert.strictEqual(body.model, "m");
      assert.strictEqual(body.reasoning_effort, "high");
    }),
  );
});

describe("credential preparation and 401 refresh (tryRefreshAfterUnauthorized)", () => {
  const AUTH_FILE = {
    type: "claude",
    email: "a@x.com",
    access_token: "old",
    refresh_token: "r",
    expired: "2999-01-01T00:00:00Z",
  };

  const providers = Layer.succeed(
    ModelProviders,
    ModelProviders.of({
      providersFor: () => Effect.succeed(["claude"]),
      firstAvailableModel: Effect.succeed(undefined),
    }),
  );

  /** An executor that rejects the token `old` with 401 and records which token each call used. */
  const tokenExecutor = (seen: string[]): Layer.Layer<ExecutorRegistry> => {
    const execute: ProviderExecutor["execute"] = (context) =>
      Effect.suspend(() => {
        const token = asString(context.credential.metadata["access_token"]);
        seen.push(token);

        return token === "old"
          ? Effect.fail(new ExecutionError({ status: 401, message: "token expired" }))
          : Effect.succeed({ payload: '{"ok":true}', headers: new Headers() });
      });

    const unsupported: ProviderExecutor["executeStream"] = () =>
      Effect.fail(new ExecutionError({ status: 501, message: "unsupported" }));

    const executor: ProviderExecutor = {
      identifier: "claude",
      execute,
      executeStream: unsupported,
      countTokens: execute,
    };

    return Layer.succeed(ExecutorRegistry, ExecutorRegistry.of({ get: () => executor }));
  };

  const refresherFor =
    (
      counts: { refresh: Array<string | undefined>; ensure: number },
      respond: (harness: PoolHarness, rejected: string | undefined) => RefreshResult,
    ) =>
    (harness: PoolHarness): Layer.Layer<CredentialRefresher> =>
      Layer.succeed(
        CredentialRefresher,
        CredentialRefresher.of({
          refreshNow: (_id, rejected) =>
            Effect.sync(() => {
              counts.refresh.push(rejected);

              return respond(harness, rejected);
            }),
          ensureFresh: () =>
            Effect.sync(() => {
              counts.ensure += 1;

              return respond(harness, undefined);
            }),
        }),
      );

  /** Stores a refreshed token (bumping the credential version, like the ControlPlane) and returns the snapshot. */
  const rotate =
    (token: string) =>
    (harness: PoolHarness): RefreshResult => {
      harness.pool.upsert(
        "claude-a.json",
        { ...AUTH_FILE, access_token: token },
        { mergeExisting: false },
      );
      const picked = harness.pool.pick({ providers: ["claude"], model: "m" });

      if (!picked.ok) throw new Error("pick failed");

      return { ok: true, refreshed: true, credential: picked.credential };
    };

  it.effect(
    "refreshes once after a 401, repeats the attempt with the new token and reports against the new version",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const counts = { refresh: [] as Array<string | undefined>, ensure: 0 };

        const run = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor(seen),
          refresher: refresherFor(counts, (harness) => rotate("new")(harness)),
          prepare: (harness) =>
            harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false }),
        });

        const result = yield* run.exec(executeNonStream(chatInput("claude-x")));
        assert.strictEqual(result.payload, '{"ok":true}');
        assert.deepStrictEqual(seen, ["old", "new"]);
        assert.deepStrictEqual(counts.refresh, ["old"]);
        assert.strictEqual(counts.ensure, 0);
        // The rejected attempt keeps its own failed usage record; the repeat is reported as a success.
        assert.deepStrictEqual(
          run.records.map((record) => [record.failed, record.fail?.statusCode]),
          [
            [true, 401],
            [false, undefined],
          ],
        );
        const [credential] = run.harness.pool.list();
        assert.deepInclude(credential, {
          success: 1,
          failed: 0,
          unavailable: false,
          credentialVersion: 2,
        });
      }),
  );

  it.effect(
    "keeps the 401 (and cools the credential) when the refresh fails; marks terminal failures",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const counts = { refresh: [] as Array<string | undefined>, ensure: 0 };

        const failure = (terminal: boolean) => (): RefreshResult => ({
          ok: false,
          error: { code: "unauthorized", message: "invalid_grant", httpStatus: 400 },
          terminal,
        });

        const soft = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor(seen),
          refresher: refresherFor(counts, failure(false)),
          prepare: (harness) =>
            harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false }),
        });

        const error = yield* failure_(soft.exec(executeNonStream(chatInput("claude-x"))));
        assert.strictEqual(error.status, 401);
        assert.isUndefined(error.terminalAuth);
        assert.deepStrictEqual(seen, ["old"]);
        assert.strictEqual(soft.harness.pool.list()[0]?.unavailable, true);

        const hard = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor([]),
          refresher: refresherFor(counts, failure(true)),
          prepare: (harness) =>
            harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false }),
        });

        const terminal = yield* failure_(hard.exec(executeNonStream(chatInput("claude-x"))));
        assert.strictEqual(terminal.terminalAuth, true);
      }),
  );

  it.effect("does not repeat when the token did not change, and ignores other statuses", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 };

      const same = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, (harness) => {
          const picked = harness.pool.pick({ providers: ["claude"], model: "m" });

          if (!picked.ok) throw new Error("pick failed");

          return { ok: true, refreshed: false, credential: picked.credential };
        }),
        prepare: (harness) =>
          harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false }),
      });

      const error = yield* failure_(same.exec(executeNonStream(chatInput("claude-x"))));
      assert.strictEqual(error.status, 401);
      assert.deepStrictEqual(seen, ["old"]);
      assert.strictEqual(counts.refresh.length, 1);

      const fresh = { refresh: [] as Array<string | undefined>, ensure: 0 };

      const other = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: Layer.succeed(
          ExecutorRegistry,
          ExecutorRegistry.of({
            get: () => ({
              identifier: "claude",
              execute: () => Effect.fail(new ExecutionError({ status: 500, message: "boom" })),
              executeStream: () =>
                Effect.fail(new ExecutionError({ status: 500, message: "boom" })),
              countTokens: () => Effect.fail(new ExecutionError({ status: 500, message: "boom" })),
            }),
          }),
        ),
        refresher: refresherFor(fresh, rotate("new")),
        prepare: (harness) =>
          harness.pool.upsert("claude-a.json", AUTH_FILE, { mergeExisting: false }),
      });

      yield* failure_(other.exec(executeNonStream(chatInput("claude-x"))));
      assert.deepStrictEqual(fresh.refresh, []);
    }),
  );

  it.effect(
    "prepares a credential without an access token through ensureFresh before the first attempt",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const counts = { refresh: [] as Array<string | undefined>, ensure: 0 };
        const bare = { type: "claude", email: "a@x.com", refresh_token: "r" };

        const run = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor(seen),
          refresher: refresherFor(counts, (harness) => {
            harness.pool.upsert(
              "claude-a.json",
              { ...bare, access_token: "new" },
              { mergeExisting: false },
            );
            const picked = harness.pool.pick({ providers: ["claude"], model: "m" });

            if (!picked.ok) throw new Error("pick failed");

            return { ok: true, refreshed: true, credential: picked.credential };
          }),
          prepare: (harness) =>
            harness.pool.upsert("claude-a.json", bare, { mergeExisting: false }),
        });

        yield* run.exec(executeNonStream(chatInput("claude-x")));
        assert.strictEqual(counts.ensure, 1);
        assert.deepStrictEqual(seen, ["new"]);
        assert.strictEqual(run.harness.pool.list()[0]?.success, 1);

        // A usable token needs no preparation.
        const ready = { refresh: [] as Array<string | undefined>, ensure: 0 };

        const usable = yield* setup("", () => jsonResponse({}), {
          providers,
          executors: tokenExecutor([]),
          refresher: refresherFor(ready, rotate("new")),
          prepare: (harness) =>
            harness.pool.upsert(
              "claude-a.json",
              { ...AUTH_FILE, access_token: "tok" },
              { mergeExisting: false },
            ),
        });

        yield* usable.exec(executeNonStream(chatInput("claude-x")));
        assert.strictEqual(ready.ensure, 0);
      }),
  );

  it.effect("a credential that cannot be prepared fails the attempt and rotates on", () =>
    Effect.gen(function* () {
      const seen: string[] = [];
      const counts = { refresh: [] as Array<string | undefined>, ensure: 0 };

      const run = yield* setup("", () => jsonResponse({}), {
        providers,
        executors: tokenExecutor(seen),
        refresher: refresherFor(counts, () => ({
          ok: false,
          error: { code: "refresh_failed", message: "refresh endpoint down", httpStatus: 503 },
          terminal: false,
        })),
        prepare: (harness) =>
          harness.pool.upsert(
            "claude-a.json",
            { type: "claude", email: "a@x.com", refresh_token: "r" },
            { mergeExisting: false },
          ),
      });

      const error = yield* failure_(run.exec(executeNonStream(chatInput("claude-x"))));
      assert.strictEqual(error.status, 503);
      assert.deepStrictEqual(seen, []);
      assert.strictEqual(counts.ensure, 1);
    }),
  );
});

const failure_ = <A>(effect: Effect.Effect<A, ExecutionError>) => Effect.flip(effect);

describe("Spend limits (issue #71)", () => {
  const asMember = (memberId: string): AccessIdentity => ({
    ...identity,
    memberId,
    role: "member",
  });

  const asKey = (memberId: string, keyId: string): AccessIdentity => ({
    ...identity,
    principal: { kind: "key", keyId, memberId, email: "dev@example.com" },
    principalId: `key:${keyId}`,
    memberId,
    role: "member",
  });

  /** Every successful attempt costs `micros`; a failed one nothing. */
  const costing =
    (micros: number) =>
    (record: UsageRecord): UsageCost | undefined =>
      record.failed ? undefined : { micros, unpriced: false };

  const ledgerOf = (book: MemorySpendBook) => new SpendLedger(book, () => []);

  const spentToday = (book: MemorySpendBook, run: Run, kind: "member" | "key", subject: string) =>
    book.spent(
      { kind, subject },
      "day",
      periodBounds("day", run.harness.clock.now(), "UTC", "monday").start,
    );

  it.effect(
    "charges the cost of an attempt and refuses at the limit with a 429 that no credential or cooldown follows",
    () =>
      Effect.gen(function* () {
        const book = new MemorySpendBook([limit("member", "m1", "day", 5 * USD)]);

        const run = yield* setup(config(group("a") + group("b")), () => jsonResponse(CHAT_OK), {
          spend: ledgerOf(book),
          identity: asMember("m1"),
          cost: costing(3 * USD),
        });

        yield* run.exec(executeNonStream(chatInput()));
        assert.strictEqual(spentToday(book, run, "member", "m1"), 3 * USD);
        // The record stored for the attempt carries the cost it was charged.
        assert.strictEqual(run.records[0]?.cost?.micros, 3 * USD);

        yield* run.exec(executeNonStream(chatInput()));
        assert.strictEqual(spentToday(book, run, "member", "m1"), 6 * USD);

        const error = yield* failure(run.exec(executeNonStream(chatInput())));

        const resetSeconds = Math.ceil(
          (periodBounds("day", run.harness.clock.now(), "UTC", "monday").end -
            run.harness.clock.now()) /
            1000,
        );

        assert.strictEqual(error.status, 429);
        assert.strictEqual(error.code, "spend_limit_reached");
        assert.strictEqual(error.safeHeaders?.["retry-after"], String(resetSeconds));
        assert.include(error.message, "daily");
        // No upstream call, no cooldown and no failure on any credential.
        assert.strictEqual(run.calls.length, 2);
        assert.deepStrictEqual(
          run.harness.pool.list().map((item) => [item.unavailable, item.failed]),
          [
            [false, 0],
            [false, 0],
          ],
        );

        // The period ends: the member is served again and the counter starts over.
        run.harness.clock.advance(24 * 3600 * 1000);
        yield* run.exec(executeNonStream(chatInput()));
        assert.strictEqual(run.calls.length, 3);
        assert.strictEqual(spentToday(book, run, "member", "m1"), 3 * USD);
      }),
  );

  it.effect(
    "refuses before any credential is tried when the API key has no room, and never charges a failed attempt",
    () =>
      Effect.gen(function* () {
        const book = new MemorySpendBook([limit("key", "k1", "day", 0)]);

        const refused = yield* setup(config(group("a") + group("b")), () => jsonResponse(CHAT_OK), {
          spend: ledgerOf(book),
          identity: asKey("m1", "k1"),
          cost: costing(USD),
        });

        const error = yield* failure(refused.exec(executeNonStream(chatInput())));

        assert.strictEqual(error.status, 429);
        assert.strictEqual(error.code, "spend_limit_reached");
        assert.strictEqual(refused.calls.length, 0);

        // Failover to the next credential charges only what the attempt that answered cost.
        const roomy = new MemorySpendBook([limit("key", "k1", "day", 10 * USD)]);

        const failover = yield* setup(
          config(group("a") + group("b")),
          (call) => (keyOf(call) === "a" ? upstreamError(500) : jsonResponse(CHAT_OK)),
          { spend: ledgerOf(roomy), identity: asKey("m1", "k1"), cost: costing(USD) },
        );

        yield* failover.exec(executeNonStream(chatInput()));
        assert.deepStrictEqual(failover.calls.map(keyOf), ["a", "b"]);
        assert.strictEqual(spentToday(roomy, failover, "key", "k1"), USD);
      }),
  );

  it.effect("skips a shared credential at its own limit while another one serves", () =>
    Effect.gen(function* () {
      const run0 = yield* setup(config(group("a") + group("b")), () => jsonResponse(CHAT_OK));
      const a = run0.harness.pool.list().find((item) => item.label === "a");

      assert.isDefined(a);
      const book = new MemorySpendBook([limit("credential", a?.id ?? "", "day", 0)]);

      const run = yield* setup(config(group("a") + group("b")), () => jsonResponse(CHAT_OK), {
        spend: ledgerOf(book),
        identity: asMember("m1"),
      });

      for (let i = 0; i < 3; i += 1) yield* run.exec(executeNonStream(chatInput()));
      assert.deepStrictEqual(run.calls.map(keyOf), ["b", "b", "b"]);
    }),
  );

  it.effect("counts a member's private credential traffic toward the API key's limit only", () =>
    Effect.gen(function* () {
      const book = new MemorySpendBook([
        limit("member", "m1", "day", 0),
        limit("key", "k1", "day", 10 * USD),
      ]);

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        spend: ledgerOf(book),
        // Same provider as the shared group (a member's own key for it), with a key of its own.
        privateConfigs: { m1: config(group("a").replace("key-a", "key-mine")) },
        identity: asKey("m1", "k1"),
        cost: costing(2 * USD),
      });

      yield* run.exec(executeNonStream(chatInput()));
      // The member is at their limit, so only their private credential serves; the member's counter stays at zero.
      assert.deepStrictEqual(run.calls.map(keyOf), ["mine"]);
      assert.strictEqual(spentToday(book, run, "member", "m1"), 0);
      assert.strictEqual(spentToday(book, run, "key", "k1"), 2 * USD);
    }),
  );

  it.effect("an unpriced model costs nothing and charges nothing", () =>
    Effect.gen(function* () {
      const book = new MemorySpendBook([limit("member", "m1", "day", USD)]);

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        spend: ledgerOf(book),
        identity: asMember("m1"),
        cost: () => ({ micros: 0, unpriced: true }),
      });

      for (let i = 0; i < 3; i += 1) yield* run.exec(executeNonStream(chatInput()));
      assert.strictEqual(run.calls.length, 3);
      assert.strictEqual(spentToday(book, run, "member", "m1"), 0);
    }),
  );
});

describe("free usage metering (ADR 0042)", () => {
  // An isolate remembers a refusal for a while; each test starts without one.
  beforeEach(resetBillingCaches);

  /** An org's Billing part as a counter: what `admit` counted and `refund` took back, a Free org's limit and the clock. */
  const metering = (limit = Number.POSITIVE_INFINITY) => {
    const state = { admits: 0, refunds: 0 };

    const part = {
      admit: async () =>
        state.admits - state.refunds >= limit
          ? {
              ok: false,
              limit: {
                limit: "requests",
                allowed: limit,
                // An hour after the test clock's start.
                resetsAt: 3_600_000,
              },
            }
          : { ok: true, monthStart: ((state.admits += 1), 0) },
      refund: async () => {
        state.refunds += 1;
      },
    };

    const billing = {
      COMMISSARY_MODE: "cloud",
      CONTROL_PLANE: { getByName: () => ({ billing: () => part }) },
      PLATFORM: {
        getByName: () => ({
          getOrgById: async () => ({ slug: "acme" }),
        }),
      },
      APP_DOMAIN: "app.example.com",
      // SAFETY: the fake answers only what Billing calls.
    } as unknown as BillingBindings;

    return { billing, counted: () => state.admits - state.refunds };
  };

  it.effect("counts a request once, however many credentials it tries", () =>
    Effect.gen(function* () {
      const meter = metering();

      const run = yield* setup(
        config(group("a") + group("b")),
        (call) => (keyOf(call) === "a" ? upstreamError(500) : jsonResponse(CHAT_OK)),
        { billing: meter.billing },
      );

      yield* run.exec(executeNonStream(chatInput()));
      assert.deepStrictEqual(run.calls.map(keyOf), ["a", "b"]);
      assert.strictEqual(meter.counted(), 1);

      // A request that fails on every credential counts too: it did the work of trying.
      const failing = yield* setup(config(group("a")), () => upstreamError(500), {
        billing: meter.billing,
      });

      yield* failure(failing.exec(executeNonStream(chatInput())));
      assert.strictEqual(meter.counted(), 2);
    }),
  );

  it.effect("counts a request served by a private credential", () =>
    Effect.gen(function* () {
      const meter = metering();

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        billing: meter.billing,
        privateConfigs: { m1: config(group("a").replace("key-a", "key-mine")) },
        identity: { ...identity, memberId: "m1", role: "member" },
      });

      yield* run.exec(executeNonStream(chatInput()));
      assert.strictEqual(meter.counted(), 1);
    }),
  );

  it.effect("does not count a request a spend limit refuses", () =>
    Effect.gen(function* () {
      const meter = metering();
      const book = new MemorySpendBook([limit("member", "m1", "day", 0)]);

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        billing: meter.billing,
        spend: new SpendLedger(book, () => []),
        identity: { ...identity, memberId: "m1", role: "member" },
      });

      const error = yield* failure(run.exec(executeNonStream(chatInput())));

      assert.strictEqual(error.code, "spend_limit_reached");
      assert.strictEqual(meter.counted(), 0);
    }),
  );

  it.effect(
    "refuses a Free org's request at its limit with a 429 plan_limit_reached, before any work",
    () =>
      Effect.gen(function* () {
        const meter = metering(1);

        const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
          billing: meter.billing,
        });

        yield* run.exec(executeNonStream(chatInput()));

        const error = yield* failure(run.exec(executeNonStream(chatInput())));

        assert.strictEqual(error.status, 429);
        assert.strictEqual(error.code, "plan_limit_reached");
        assert.strictEqual(error.safeHeaders?.["retry-after"], "3600");
        assert.strictEqual(run.calls.length, 1);
        assert.strictEqual(meter.counted(), 1);

        const body = JSON.parse(error.message) as { error: Record<string, unknown> };

        assert.strictEqual(body.error["code"], "plan_limit_reached");
        assert.include(String(body.error["message"]), "https://app.example.com/o/acme/billing");

        // Streaming is refused the same way.
        const streamed = yield* failure(
          run.exec(
            Effect.scoped(
              executeStream({ ...chatInput(), body: { ...chatInput().body, stream: true } }),
            ),
          ),
        );

        assert.strictEqual(streamed.code, "plan_limit_reached");
      }),
  );

  it.effect("does not count a request that made no upstream attempt", () =>
    Effect.gen(function* () {
      const meter = metering();

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        billing: meter.billing,
      });

      // No credential serves this model: nothing was tried, so nothing is counted.
      yield* failure(run.exec(executeNonStream({ ...chatInput(), model: "no-such-model" })));
      assert.strictEqual(run.calls.length, 0);
      assert.strictEqual(meter.counted(), 0);
    }),
  );

  it.effect("does not meter token counting, even for an org at its limit", () =>
    Effect.gen(function* () {
      const meter = metering(0);

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        billing: meter.billing,
      });

      const result = yield* Effect.result(run.exec(executeCountTokens(chatInput())));

      if (Result.isFailure(result))
        assert.notStrictEqual(result.failure.code, "plan_limit_reached");
      assert.strictEqual(meter.counted(), 0);
    }),
  );

  it.effect("counts nothing on a self-hosted Commissary", () =>
    Effect.gen(function* () {
      const meter = metering(0);

      const run = yield* setup(config(group("a")), () => jsonResponse(CHAT_OK), {
        billing: { ...meter.billing, COMMISSARY_MODE: undefined },
      });

      yield* run.exec(executeNonStream(chatInput()));
      assert.strictEqual(meter.counted(), 0);
    }),
  );
});
