// Grants apply to an API key like to an Access sign-in (ADR 0022, ADR 0023): the key resolves to its member, and the
// member's reach decides what the request may pick. An ungranted model answers like an unknown one (same 400 body),
// and a request without a member (a service token) is served by the default grant only, so upgrading changes nothing.
// Through the API Worker's gate; the org, its members, keys, credential and grants are set up straight through the
// ControlPlane (the management routes that do it are the app Worker's, tested in apps/app/test/grants-routes.test.ts).
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { AccessPrincipal } from "@commissary/auth";
import { type OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { claudeFile, FULL_ACCESS, unknownModelBody } from "@commissary/models/testing";
import { isolatedPlatform, issueKey, makeClientHarness, staffedOrg } from "./support/client.ts";

/** Picks the model in `?model=` for the caller the way Commissary handlers do (the identity's org and member). */
const pickForCaller = Effect.gen(function* () {
  const identity = yield* AccessPrincipal;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const model = new URL(request.url, "https://commissary.test").searchParams.get("model") ?? "";

  const answer = yield* Effect.promise(
    async () =>
      await controlPlaneOf(env, identity.org)
        .models()
        .pick({
          providers: ["claude"],
          model,
          ...(identity.memberId === undefined ? {} : { memberId: identity.memberId }),
        }),
  );

  const body = answer.ok
    ? { credential: answer.credential.id }
    : {
        refused: answer.failure.code,
        status: answer.failure.httpStatus,
        body: answer.failure.body,
      };

  return HttpServerResponse.text(JSON.stringify(body), { contentType: "application/json" });
});

const registry = isolatedPlatform();

const harness = makeClientHarness(
  Layer.mergeAll(HttpRouter.add("POST", "/v1/chat/completions", pickForCaller)),
  registry.bindings,
);

afterAll(harness.dispose);

const SONNET = "claude-sonnet-4-5";

const OPUS = "claude-opus-4-1";

/** An org with a shared Claude subscription, an admin and two plain members each holding an API key. */
const org = async () => {
  const staff = await staffedOrg(registry, "grants-key");

  const imported = await controlPlaneOf(env, staff.org)
    .models()
    .importAuthFile("shared.json", claudeFile(), {}, FULL_ACCESS);

  expect(imported.ok).toBe(true);

  return {
    org: staff.org,
    alice: { id: staff.alice.id, key: (await issueKey(staff.org, staff.alice)).key },
    bob: { id: staff.bob.id, key: (await issueKey(staff.org, staff.bob)).key },
  };
};

/**
 * Replaces the default grant of `org` with the example grant: `member` may use Sonnet models of `shared.json`. As the
 * management routes write grants.
 */
const grantSonnetTo = async (org: OrgId, member: string) => {
  const models = controlPlaneOf(env, org).models();
  const [fallback] = (await models.grantEntries()).grants;

  if (fallback === undefined) throw new Error("a new org has the default grant");

  const removed = await models.writeGrant(
    { id: fallback.id, revision: fallback.revision, value: null },
    "test",
  );

  expect(removed.ok).toBe(true);

  const granted = await models.writeGrant(
    {
      revision: 0,
      value: {
        subject: { kind: "member", id: member },
        scope: { kind: "credential", id: "shared.json" },
        models: ["claude-sonnet-*"],
      },
    },
    "test",
  );

  expect(granted.ok).toBe(true);
};

const pick = async (key: string, model: string) =>
  (
    await harness.json(`/v1/chat/completions?model=${model}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      auth: false,
    })
  ).body;

describe("grants and API keys", () => {
  it("serves any model to every key under the default grant", async () => {
    const { alice, bob } = await org();

    for (const { key } of [alice, bob])
      for (const model of [SONNET, OPUS])
        expect(await pick(key, model)).toEqual({ credential: "shared.json" });
  });

  it("serves Sonnet and refuses Opus to the member the example grant names, like an unknown model", async () => {
    const { org: id, alice, bob } = await org();

    await grantSonnetTo(id, alice.id);

    expect(await pick(alice.key, SONNET)).toEqual({ credential: "shared.json" });

    expect(await pick(alice.key, OPUS)).toEqual({
      refused: "model_not_found",
      status: 400,
      body: unknownModelBody(OPUS),
    });

    expect(await pick(bob.key, SONNET)).toMatchObject({ refused: "model_not_found", status: 400 });
  });
});
