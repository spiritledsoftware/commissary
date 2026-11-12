// A Claude reset grant claim (`claimResetGrant`) that Anthropic never answers, with the real ControlPlane and mocked
// Anthropic endpoints. The management routes around it are tested in the Worker
// (`apps/app/test/reset-grants.test.ts`); the pure status parsing, grant choice and claim journal in
// `unit/reset-grants.test.ts`.
import { assert, describe, it } from "@effect/vitest";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, expect } from "vite-plus/test";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { CLAUDE_PROFILE_URL } from "../src/quota/claude.ts";
import { claimResetGrant } from "../src/quota/reset-grant-flow.ts";
import { RESET_GRANT_STATUS_URL, resetGrantClaimUrl } from "../src/quota/reset-grants.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { envContext } from "./support/context.ts";
import { claudeFile, controlPlane, resetControlPlane } from "./support/control-plane.ts";
import { mockHttp, type MockReply, routes } from "./support/refresh.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const ORGANIZATION = "abcdef01-2345-6789-abcd-ef0123456789";

const CLAIM_URL = resetGrantClaimUrl(ORGANIZATION);

const INDEX = authIndexOf("claude-a.json");

const usage = {
  five_hour: { utilization: 100 },
  cedar_ember: {
    eligible: true,
    at_limit: true,
    weekly_resets_at: "2026-10-14T00:00:00Z",
    grants: [
      {
        id: "g1",
        label: "Launch week",
        resets_total: 3,
        resets_left: 2,
        starts_at: "2026-01-01T00:00:00Z",
        ends_at: "2999-01-01T00:00:00Z",
        clears: ["five_hour", "seven_day"],
        paused: false,
        usable_now: true,
        use_requires_limit: false,
      },
    ],
  },
};

beforeEach(async () => {
  await resetControlPlane();
  // A claim left in flight by a test outlives the removal of its credential (`forget`) and would hold its organization.
  await runInDurableObject(controlPlane(), (_instance, state) => {
    state.storage.sql.exec("UPDATE credential_reset_grants SET claim = NULL");
  });
});

const seed = async () => {
  const result = await controlPlane()
    .models()
    .importAuthFile("claude-a.json", JSON.stringify(claudeFile()), {}, FULL_ACCESS);

  expect(result.ok).toBe(true);
};

describe("claimResetGrant", () => {
  it.effect("gives up on an unanswered claim after 25 s and keeps it open for a resend", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seed());
      yield* TestClock.setTime(NOW);

      const outbound = mockHttp(
        routes({
          [`GET ${RESET_GRANT_STATUS_URL}`]: { status: 200, body: usage },
          [`GET ${CLAUDE_PROFILE_URL}`]: {
            status: 200,
            body: { organization: { uuid: ORGANIZATION } },
          },
          // Never answers.
          [`POST ${CLAIM_URL}`]: () => new Promise<MockReply>(() => undefined),
        }),
      );

      const fiber = yield* Effect.forkChild(
        claimResetGrant({ authIndex: INDEX }, FULL_ACCESS).pipe(
          Effect.provide(outbound.layer),
          Effect.provideContext(envContext(env)),
        ),
      );

      while (!outbound.requests.some((request) => request.url === CLAIM_URL))
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 5)));

      yield* TestClock.adjust("24 seconds");
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(fiber);

      assert.deepInclude(result, { kind: "claimed", outcome: "unknown", retried: false });
      assert.deepInclude(result.kind === "claimed" ? result.pending : undefined, {
        grant_id: "g1",
        in_flight: false,
      });
    }).pipe(Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );
});
