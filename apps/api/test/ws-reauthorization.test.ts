// The API Worker's client gate provides `RequestReauthorizer` (CLIProxyAPI b9bb031d) so a request that outlives its
// authentication, a Responses WebSocket, authenticates again before each turn. Through the real gate over the real
// ControlPlanes: a stand-in route runs the reauthorizer the way the socket does, and answers its outcome.
import { env } from "cloudflare:workers";
import { Effect, Layer, Option, Result } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { afterAll, describe, expect, it } from "vite-plus/test";
import {
  type AccessError,
  accessRefusal,
  RequestReauthorizer,
  resetApiKeyCaches,
} from "@commissary/auth";
import { controlPlaneOf } from "@commissary/state";
import { isolatedPlatform, issueKey, makeClientHarness, staffedOrg } from "./support/client.ts";

/** What the reauthorizer says: `ok`, or the refusal a socket would answer the frame with. */
const outcomeOf = (reauthorize: Effect.Effect<unknown, AccessError>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(reauthorize);

    return Result.isSuccess(result)
      ? { ok: true }
      : { ok: false, ...(yield* accessRefusal(result.failure)) };
  });

/** Set by the test: how the key is revoked while the request, a socket upgrade in real life, is still running. */
let revoke: () => Promise<void> = async () => undefined;

const recheck = Effect.gen(function* () {
  // Optional, as the socket reads it: the gate provides it next to the principal without the router requiring it.
  const reauthorize = Option.getOrThrow(yield* Effect.serviceOption(RequestReauthorizer));
  const before = yield* outcomeOf(reauthorize);

  // Revoked behind this isolate's verified-key cache, like another isolate's request.
  yield* Effect.promise(revoke);
  resetApiKeyCaches();
  const after = yield* outcomeOf(reauthorize);

  return HttpServerResponse.text(JSON.stringify({ before, after }), {
    contentType: "application/json",
  });
});

const registry = isolatedPlatform();

const harness = makeClientHarness(
  Layer.mergeAll(HttpRouter.add("GET", "/v1/reauthorize", recheck)),
  registry.bindings,
);

afterAll(harness.dispose);

describe("the client gate's RequestReauthorizer", () => {
  it("passes while the API key is live and refuses it once it is revoked", async () => {
    const { org, alice } = await staffedOrg(registry, "reauth");
    const created = await issueKey(org, alice);

    revoke = async () => {
      expect(
        (await controlPlaneOf(env, org).revokeApiKey(created.id, Date.now(), alice.id)).ok,
      ).toBe(true);
    };

    const answer = await harness.json("/v1/reauthorize", {
      headers: { authorization: `Bearer ${created.key}` },
      auth: false,
    });

    expect(answer.body).toEqual({
      before: { ok: true },
      after: { ok: false, status: 401, message: "Invalid API key" },
    });
  });
});
