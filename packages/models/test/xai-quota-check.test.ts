// xAI quota check (`src/quota/probe.ts`): the billing calls carry the Grok CLI identity at the version the chat proxy
// accepts (it answers 426 below `XAI_CLIENT_VERSION_FLOOR`), the same version the executor sends.
import { assert, describe, it } from "@effect/vitest";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach } from "vite-plus/test";
import {
  acceptableXaiClientVersion,
  resetXaiClientVersionCache,
  XAI_FALLBACK_CLIENT_VERSION,
  XAI_VERSION_KV_KEY,
} from "../src/executor/xai/version.ts";
import { probeQuota } from "../src/quota/probe.ts";
import { XAI_BILLING_MONTHLY_URL, XAI_BILLING_WEEKLY_URL } from "../src/quota/xai.ts";
import { envContext } from "./support/context.ts";

interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

const BILLING = {
  config: {
    creditUsagePercent: 25,
    currentPeriod: { start: "2026-10-06T00:00:00Z", end: "2026-10-13T00:00:00Z" },
  },
};

/** The billing endpoints answering `BILLING`; every request lands in `seen`. */
const billing = (seen: Seen[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push({ url: request.url, headers: request.headers });

        return HttpClientResponse.fromWeb(request, Response.json(BILLING));
      }),
    ),
  );

const checkXai = Effect.fnUntraced(function* (seen: Seen[]) {
  const outcome = yield* probeQuota({
    id: "xai-1",
    provider: "xai",
    token: "xai-access",
    userId: "user-1",
  }).pipe(Effect.provide(billing(seen)));

  assert.isTrue(outcome.ok);
  assert.deepStrictEqual(
    seen.map((request) => request.url).sort(),
    [XAI_BILLING_MONTHLY_URL, XAI_BILLING_WEEKLY_URL].sort(),
  );
});

/** Both billing calls sent Grok CLI `version`, in the version header and the user-agent alike. */
const assertSentVersion = (seen: ReadonlyArray<Seen>, version: string): void => {
  for (const request of seen) {
    assert.strictEqual(request.headers["x-grok-client-version"], version);
    assert.strictEqual(
      request.headers["user-agent"],
      `grok-pager/${version} grok-shell/${version} (macos; aarch64)`,
    );
    assert.strictEqual(request.headers["x-xai-token-auth"], "xai-grok-cli");
    assert.strictEqual(request.headers.authorization, "Bearer xai-access");
    assert.strictEqual(request.headers["x-userid"], "user-1");
  }
};

/** Stores `version` where the cron task keeps the Grok CLI version. */
const storeVersion = (version: string) =>
  Effect.promise(() => env.CACHE.put(XAI_VERSION_KV_KEY, version)).pipe(
    Effect.andThen(Effect.sync(resetXaiClientVersionCache)),
  );

afterEach(async () => {
  await env.CACHE.delete(XAI_VERSION_KV_KEY);
  resetXaiClientVersionCache();
});

describe("xAI quota check", () => {
  it.effect("without a KV binding, sends the fallback version, which the chat proxy accepts", () =>
    Effect.gen(function* () {
      const seen: Seen[] = [];
      yield* checkXai(seen);

      assertSentVersion(seen, XAI_FALLBACK_CLIENT_VERSION);
      // At or above the chat proxy's 1.0.13 floor (0.2.91 was answered 426).
      assert.isTrue(acceptableXaiClientVersion(XAI_FALLBACK_CLIENT_VERSION));
    }),
  );

  it.effect("sends the Grok CLI version the cron task stored in KV", () =>
    Effect.gen(function* () {
      yield* storeVersion("1.0.99");
      const seen: Seen[] = [];
      yield* checkXai(seen).pipe(Effect.provideContext(envContext(env)));

      assertSentVersion(seen, "1.0.99");
    }),
  );

  it.effect("ignores a stored version below the floor and sends the fallback", () =>
    Effect.gen(function* () {
      yield* storeVersion("0.2.91");
      const seen: Seen[] = [];
      yield* checkXai(seen).pipe(Effect.provideContext(envContext(env)));

      assertSentVersion(seen, XAI_FALLBACK_CLIENT_VERSION);
    }),
  );
});
