// Google One AI credits fallback in the conductor: after the normal rotation failed with a capacity error, Claude models
// get one more pass over the Antigravity credentials (cooling ones included) with `enabledCreditTypes`.
import { Effect, Layer, Result } from "effect";
import type { HttpServerRequest } from "effect/http";
import { describe, expect, it } from "vite-plus/test";
import { AccessPrincipal } from "@commissary/auth";
import {
  antigravityCreditsScope,
  antigravityStateFor,
  resetMemoryAntigravityState,
} from "../src/executor/antigravity/state.ts";
import { CredentialRefresher } from "../src/executor/helps/credential-refresh.ts";
import { ExecutorRegistry } from "../src/executor/registry.ts";
import { Thinking } from "../src/executor/thinking.ts";
import { executeNonStream } from "../src/handlers/execute.ts";
import { ModelCapabilities } from "../src/handlers/model-capabilities.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { Formats } from "@commissary/translation/formats";
import type { UsageRecord } from "../src/usage/record.ts";
import { UsageSink } from "../src/usage/sink.ts";
import {
  jsonResponse,
  mockHttpClient,
  sseResponse,
  staticConfigReader,
  type UpstreamCall,
} from "./support/pipeline.ts";
import { makePool, poolPickerLayer } from "./support/pool.ts";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { envContext } from "./support/context.ts";

const identity = {
  principal: { kind: "user", email: "dev@example.com", sub: "sub" },
  principalId: "user:dev@example.com",
  callerScope: "scope-1",
  org: GLOBAL_ORG,
  platformAdmin: false,
} as const;

const request = {
  url: "/v1/messages",
  method: "POST",
  headers: {},
} as unknown as HttpServerRequest.HttpServerRequest;

const quotaExhausted = {
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "quota",
    details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
  },
};

const reply = {
  response: {
    candidates: [{ content: { role: "model", parts: [{ text: "paid" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  },
};

/** The credits key of the harness credential `name` (its grant is its access token). */
const scopeOf = (name: string): string =>
  antigravityCreditsScope(`antigravity-${name}.json`, { refresh_token: `refresh-${name}` });

const bearer = (call: UpstreamCall): string =>
  (call.headers["authorization"] ?? "").replace("Bearer ", "");

const hasCredits = (call: UpstreamCall): boolean =>
  JSON.parse(call.body).enabledCreditTypes !== undefined;

const run = async (
  yaml: string,
  model: string,
  respond: (call: UpstreamCall) => Response,
  options: {
    names?: ReadonlyArray<string>;
    seed?: (state: ReturnType<typeof antigravityStateFor>) => Promise<void>;
    /** A pool of an earlier run: a later request of the same deployment (no reset, no new credentials). */
    harness?: Awaited<ReturnType<typeof makePool>>;
  } = {},
) => {
  if (options.harness === undefined) resetMemoryAntigravityState();

  if (options.seed !== undefined) await options.seed(antigravityStateFor({}, GLOBAL_ORG));
  const harness = options.harness ?? (await makePool(yaml));

  for (const name of options.harness === undefined ? (options.names ?? ["a", "b"]) : []) {
    harness.store.upsert(`antigravity-${name}.json`, "antigravity", {
      type: "antigravity",
      access_token: `tok-${name}`,
      refresh_token: `refresh-${name}`,
      project_id: `proj-${name}`,
      expired: new Date(harness.clock.now() + 3_600_000).toISOString(),
    });
  }

  const calls: UpstreamCall[] = [];
  const records: UsageRecord[] = [];

  const layer = Layer.mergeAll(
    poolPickerLayer(harness.pool),
    Layer.succeed(
      ModelProviders,
      ModelProviders.of({
        providersFor: () => Effect.succeed(["antigravity"]),
        firstAvailableModel: Effect.succeed(undefined),
      }),
    ),
    ModelCapabilities.configLayer,
    ExecutorRegistry.layer,
    CredentialRefresher.none,
    UsageSink.memory(records),
    mockHttpClient(calls, respond),
    Thinking.live,
  ).pipe(Layer.provideMerge(staticConfigReader(harness.config)));

  const result = await Effect.runPromise(
    executeNonStream({
      entryProtocol: Formats.Claude,
      model,
      body: { model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
      alt: "",
      request,
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(AccessPrincipal, identity),
      Effect.provideContext(envContext({} as Cloudflare.Env)),
      Effect.provideService(CurrentOrg, GLOBAL_ORG),
      Effect.result,
    ),
  );

  return { calls, records, result, harness };
};

describe("antigravity credits fallback", () => {
  it("retries Claude models with enabledCreditTypes once the normal rotation is exhausted", async () => {
    const outcome = await run(
      "oauth:\n  providers:\n    antigravity:\n      antigravity-credits: true\n",
      "claude-sonnet-4-5",
      (call) =>
        hasCredits(call)
          ? sseResponse([`data: ${JSON.stringify(reply)}\n\n`])
          : jsonResponse(quotaExhausted, { status: 429 }),
    );

    expect(outcome.result._tag).toBe("Success");
    expect(Result.isSuccess(outcome.result) ? outcome.result.success.payload : undefined).toContain(
      "paid",
    );
    // Normal rotation: both credentials fail without credits; then the credits pass uses a (cooling) credential.
    const plain = outcome.calls.filter((call) => !hasCredits(call));
    const credited = outcome.calls.filter(hasCredits);
    expect(plain.map(bearer).toSorted()).toEqual(["tok-a", "tok-b"]);
    expect(credited).toHaveLength(1);
    expect(JSON.parse(credited[0]?.body ?? "{}").enabledCreditTypes).toEqual(["GOOGLE_ONE_AI"]);
    expect(outcome.records.filter((record) => !record.failed)).toHaveLength(1);
  });

  it("is disabled by default and never applies to non-Claude models", async () => {
    const off = await run("", "claude-sonnet-4-5", () =>
      jsonResponse(quotaExhausted, { status: 429 }),
    );

    expect(off.result._tag).toBe("Failure");
    expect(off.calls.some(hasCredits)).toBe(false);

    const gemini = await run(
      "oauth:\n  providers:\n    antigravity:\n      antigravity-credits: true\n",
      "gemini-3-pro-high",
      () => jsonResponse(quotaExhausted, { status: 429 }),
    );

    expect(gemini.result._tag).toBe("Failure");
    expect(gemini.calls.some(hasCredits)).toBe(false);
  });

  it("skips credentials whose credits are known to be exhausted and keeps the original error", async () => {
    resetMemoryAntigravityState();

    const exhausted = {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "INSUFFICIENT_G1_CREDITS_BALANCE",
          },
        ],
      },
    };

    const outcome = await run(
      "oauth:\n  providers:\n    antigravity:\n      antigravity-credits: true\n",
      "claude-sonnet-4-5",
      (call) => jsonResponse(hasCredits(call) ? exhausted : quotaExhausted, { status: 429 }),
    );

    expect(outcome.result._tag).toBe("Failure");
    expect(Result.isFailure(outcome.result) ? outcome.result.failure.status : undefined).toBe(429);
    // One credits attempt marks that credential as out of credits; the other credential is tried next, then both are skipped.
    expect(outcome.calls.filter(hasCredits).length).toBeLessThanOrEqual(2);
  });

  it("walks known-available credentials first, then unknown ones, each sorted by id; known-empty ones are skipped", async () => {
    const record = (amount: number, updatedAt = Date.now()) => ({
      creditAmount: amount,
      minCreditAmount: 1,
      paidTierId: "",
      updatedAt,
    });

    const outcome = await run(
      "oauth:\n  providers:\n    antigravity:\n      antigravity-credits: true\n",
      "claude-sonnet-4-5",
      // Only the credits pass of the last credential in the order succeeds; everything else is rate limited.
      (call) =>
        hasCredits(call) && bearer(call) === "tok-d"
          ? sseResponse([`data: ${JSON.stringify(reply)}\n\n`])
          : jsonResponse(quotaExhausted, { status: 429 }),
      {
        names: ["a", "b", "c", "d", "e"],
        seed: async (state) => {
          await state.setCredits(scopeOf("a"), record(0)); // known empty: skipped
          // Out of credits for longer than the 10 min refresh interval: unknown again, so it is retried.
          await state.setCredits(scopeOf("b"), record(0, Date.now() - 10 * 60_000 - 1000));
          await state.setCredits(scopeOf("e"), record(5)); // known available
          await state.setCredits(scopeOf("c"), record(9)); // known available
          // A balance stored under the bare id (an older key, or another grant) is not read (CLIProxyAPI 16bf182f).
          await state.setCredits("antigravity-d.json", record(0));
        },
      },
    );

    expect(outcome.result._tag).toBe("Success");
    // Order of the credits pass: c, e (known, sorted), then b, d (unknown, sorted); a never runs with credits.
    expect(outcome.calls.filter(hasCredits).map(bearer)).toEqual([
      "tok-c",
      "tok-e",
      "tok-b",
      "tok-d",
    ]);
    // The skipped credential is not an attempt: it was only tried in the normal rotation.
    expect(
      outcome.calls.filter((call) => !hasCredits(call)).filter((call) => bearer(call) === "tok-a"),
    ).toHaveLength(1);
  });

  it("isolates a credential's credits balance by its grant (CLIProxyAPI 16bf182f)", async () => {
    const empty = { creditAmount: 0, minCreditAmount: 0, paidTierId: "", updatedAt: Date.now() };

    // A balance recorded for an earlier login of `antigravity-a.json` (another refresh token) is not this one's.
    const outcome = await run(
      CREDITS,
      "claude-sonnet-4-5",
      (call) =>
        hasCredits(call)
          ? sseResponse([`data: ${JSON.stringify(reply)}\n\n`])
          : jsonResponse(quotaExhausted, { status: 429 }),
      {
        names: ["a"],
        seed: async (state) => {
          await state.setCredits(
            antigravityCreditsScope("antigravity-a.json", { refresh_token: "refresh-old" }),
            empty,
          );
        },
      },
    );

    expect(outcome.result._tag).toBe("Success");
    expect(outcome.calls.filter(hasCredits).map(bearer)).toEqual(["tok-a"]);

    // The same balance under the current grant keeps the credential out of the credits pass.
    const known = await run(
      CREDITS,
      "claude-sonnet-4-5",
      () => jsonResponse(quotaExhausted, { status: 429 }),
      {
        names: ["a"],
        seed: async (state) => {
          await state.setCredits(scopeOf("a"), empty);
        },
      },
    );

    expect(known.calls.some(hasCredits)).toBe(false);
  });

  it("runs the credits pass only for credentials whose route reaches a Claude model", async () => {
    // A rate limit with a short wait is no quota exhaustion: no credits pass (CLIProxyAPI e0a1e93d).
    const rateLimited = await run(CREDITS, "claude-sonnet-4-5", () =>
      jsonResponse(
        {
          error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Too many requests per minute",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "RATE_LIMIT_EXCEEDED",
              },
            ],
          },
        },
        { status: 429 },
      ),
    );

    expect(rateLimited.calls.some(hasCredits)).toBe(false);
  });
});

/** A 403 TOS_VIOLATION as Cloud Code answers it. */
const tosViolation = {
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    message: "This service has been disabled for violating the Terms of Service.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TOS_VIOLATION",
        metadata: {
          appeal_url: "https://support.google.com/appeal?case=1",
          appeal_url_link_text: "Appeal",
        },
      },
    ],
  },
};

const CREDITS = "oauth:\n  providers:\n    antigravity:\n      antigravity-credits: true\n";

const PAUSE = `${CREDITS}      tos-pause-window: 1h\n`;

describe("antigravity TOS_VIOLATION (CLIProxyAPI 5a351d95)", () => {
  it("disables the credential with its appeal link, ends the request and keeps the credits pass out", async () => {
    const first = await run(
      CREDITS,
      "claude-sonnet-4-5",
      (call) =>
        bearer(call) === "tok-a"
          ? jsonResponse(tosViolation, { status: 403 })
          : sseResponse([`data: ${JSON.stringify(reply)}\n\n`]),
      { names: ["a"] },
    );

    expect(first.result._tag).toBe("Failure");
    expect(Result.isFailure(first.result) ? first.result.failure.status : undefined).toBe(403);
    // One attempt, no rotation, no credits pass.
    expect(first.calls).toHaveLength(1);
    expect(first.calls.some(hasCredits)).toBe(false);

    const stored = first.harness.store.get("antigravity-a.json");

    expect(stored?.metadata).toMatchObject({
      disabled: true,
      tos_appeal_url: "https://support.google.com/appeal?case=1",
      tos_appeal_url_text: "Appeal",
    });

    const summary = first.harness.pool.list().find((item) => item.id === "antigravity-a.json");

    expect(summary).toMatchObject({ status: "disabled", statusMessage: "tos_violation" });

    // The disabled credential is never picked again; enabling it starts it afresh.
    first.harness.store.upsert("antigravity-b.json", "antigravity", {
      type: "antigravity",
      access_token: "tok-b",
      project_id: "proj-b",
      expired: new Date(first.harness.clock.now() + 3_600_000).toISOString(),
    });
    first.harness.pool.invalidate();

    const next = await run(
      CREDITS,
      "claude-sonnet-4-5",
      () => sseResponse([`data: ${JSON.stringify(reply)}\n\n`]),
      {
        harness: first.harness,
      },
    );

    expect(next.result._tag).toBe("Success");
    expect(next.calls.map(bearer)).toEqual(["tok-b"]);

    first.harness.pool.setDisabled("antigravity-a.json", false);
    const enabled = first.harness.pool.list().find((item) => item.id === "antigravity-a.json");

    expect(enabled).toMatchObject({ disabled: false, status: "active", unavailable: false });
  });

  it("keeps a late failure from changing the disabled state", async () => {
    const first = await run(
      CREDITS,
      "claude-sonnet-4-5",
      () => jsonResponse(tosViolation, { status: 403 }),
      {
        names: ["a"],
      },
    );

    const lease = {
      id: "late",
      credentialId: "antigravity-a.json",
      credentialVersion: 1,
      provider: "antigravity",
      model: "claude-sonnet-4-5",
      issuedAt: 0,
    };

    first.harness.pool.report(lease, {
      success: false,
      httpStatus: 429,
      error: { message: "quota", retryable: false, httpStatus: 429 },
      retryAfterMs: 60_000,
    });

    expect(first.harness.pool.list()[0]).toMatchObject({
      status: "disabled",
      statusMessage: "tos_violation",
      nextRetryAfter: 0,
    });
  });

  it("pauses the org's Antigravity pool for the configured window, without touching the other credentials", async () => {
    const first = await run(
      PAUSE,
      "claude-sonnet-4-5",
      (call) =>
        bearer(call) === "tok-a"
          ? jsonResponse(tosViolation, { status: 403 })
          : sseResponse([`data: ${JSON.stringify(reply)}\n\n`]),
      { names: ["a"] },
    );

    expect(first.result._tag).toBe("Failure");

    first.harness.store.upsert("antigravity-b.json", "antigravity", {
      type: "antigravity",
      access_token: "tok-b",
      project_id: "proj-b",
      expired: new Date(first.harness.clock.now() + 3_600_000).toISOString(),
    });
    first.harness.pool.invalidate();

    const paused = await run(
      PAUSE,
      "claude-sonnet-4-5",
      () => sseResponse([`data: ${JSON.stringify(reply)}\n\n`]),
      {
        harness: first.harness,
      },
    );

    // A request-scoped 503: no upstream call, and the healthy credential is not cooled.
    expect(paused.calls).toHaveLength(0);
    expect(Result.isFailure(paused.result) ? paused.result.failure : undefined).toMatchObject({
      status: 503,
      message: "antigravity pool paused after TOS_VIOLATION",
    });

    expect(
      first.harness.pool.list().find((item) => item.id === "antigravity-b.json"),
    ).toMatchObject({
      status: "active",
      unavailable: false,
      nextRetryAfter: 0,
      modelStates: {},
    });
  });

  it("never pauses by default", async () => {
    const first = await run(
      CREDITS,
      "claude-sonnet-4-5",
      (call) =>
        bearer(call) === "tok-a"
          ? jsonResponse(tosViolation, { status: 403 })
          : sseResponse([`data: ${JSON.stringify(reply)}\n\n`]),
      { names: ["a"] },
    );

    expect(await antigravityStateFor({}, GLOBAL_ORG).tosPauseRemaining(Date.now())).toBe(0);
    expect(first.result._tag).toBe("Failure");
  });
});
