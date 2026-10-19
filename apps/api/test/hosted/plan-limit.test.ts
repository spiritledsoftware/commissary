// Free usage and the plan limit of Commissary Cloud (ADR 0042, `@commissary/billing`) through the production Worker
// (`exports.default.fetch`) with the real ControlPlane picker and Billing part; only the upstream is mocked, through the
// global `fetch`. A request counts once when Models starts serving it, whatever the credential, outcome or number of
// attempts; a Free org's request over 25,000 a month is refused with `429 plan_limit_reached`; a request a spend limit
// refuses is not counted. (Each org is on Free with 5 requests a minute here, vitest.config.ts: the tests seed the month's
// count instead of sending 25,000 requests. The month turning is tested with `TestClock` in packages/billing.)
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FREE_USAGE, requestsUsed, seedRequestsUsed, setPlan } from "@commissary/billing/testing";
import type { OrgId } from "@commissary/core";
import { resetUsageDb, withModelsPart } from "@commissary/models/testing";
import { call, keyedOrg } from "./support.ts";

const FIRST_KEY = "sk-first-0001";

const SECOND_KEY = "sk-second-0002";

const ONLY_KEY = "sk-only-0003";

const YAML = `
api-keys:
  openai-compatibility:
    - name: pool
      base-url: https://pool.example/v1
      models: [{ name: pool-model }]
      keys: [{ api-key: ${FIRST_KEY} }, { api-key: ${SECOND_KEY} }]
    - name: solo
      base-url: https://solo.example/v1
      models: [{ name: solo-model }]
      keys: [{ api-key: ${ONLY_KEY} }]
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "pool-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

/** The credential of each upstream call, in order. */
const upstream: string[] = [];

/** How many of the next upstream calls fail with a 500 (the credential that fails first is the picker's choice). */
let failing = 0;

const realFetch = globalThis.fetch;

const chat = (key: string, model = "pool-model") =>
  call("/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });

/** A new Cloud org with the two upstream configurations and an API key. */
const configuredOrg = async (email: string) => {
  const org = await keyedOrg(email);

  const stored = await withModelsPart(env.CONTROL_PLANE.getByName(org.org), (part) =>
    part.importConfig(YAML, "test"),
  );

  expect(stored.ok).toBe(true);

  return org;
};

const used = (org: OrgId) => requestsUsed(env, org, Date.now());

beforeAll(async () => {
  await resetUsageDb();

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const credential = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

    upstream.push(credential);

    if (failing > 0) {
      failing -= 1;

      return new Response("upstream failure", { status: 500 });
    }

    return Response.json(COMPLETION);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("counting requests", () => {
  it("starts a new org at zero and counts each request it serves once", async () => {
    const { org, key } = await configuredOrg("counting@example.com");

    expect(await used(org)).toBe(0);

    expect((await chat(key, "solo-model")).status).toBe(200);
    expect(await used(org)).toBe(1);

    expect((await chat(key, "solo-model")).status).toBe(200);
    expect(await used(org)).toBe(2);
  });

  it("counts a request that fails over across credentials once", async () => {
    const { org, key } = await configuredOrg("failover@example.com");

    upstream.length = 0;
    failing = 1;

    expect((await chat(key)).status).toBe(200);

    // The first credential failed and the other served it.
    expect([...upstream].sort()).toEqual([FIRST_KEY, SECOND_KEY]);
    expect(await used(org)).toBe(1);
  });

  it("counts a request whatever its outcome", async () => {
    const { org, key } = await configuredOrg("outcome@example.com");

    // No credential serves this model: the request still reached Models.
    expect((await chat(key, "no-such-model")).status).toBeGreaterThanOrEqual(400);
    expect(await used(org)).toBe(1);
  });

  it("does not count a request a spend limit refuses", async () => {
    const { org, key, member } = await configuredOrg("spend@example.com");

    const limited = await withModelsPart(env.CONTROL_PLANE.getByName(org), (part) =>
      part.createSpendLimit(
        { member, admin: true },
        { kind: "org", subject: "", period: "day", amountMicros: 0 },
        "test@example.com",
      ),
    );

    expect(limited.ok).toBe(true);

    const refused = await chat(key, "solo-model");

    expect(refused.status).toBe(429);
    expect(await refused.json<{ error: { code: string } }>()).toMatchObject({
      error: { code: "spend_limit_reached" },
    });
    expect(await used(org)).toBe(0);
  });

  it("does not count a request refused by the rate ceiling or by authentication", async () => {
    const { org, key } = await configuredOrg("refused@example.com");

    expect((await chat("not-a-key", "solo-model")).status).toBe(401);
    expect(await used(org)).toBe(0);

    // Free's ceiling is 5 a minute in these tests: the 6th request is refused before Models serves it.
    for (let sent = 0; sent < 5; sent += 1)
      expect((await chat(key, "solo-model")).status).toBe(200);

    expect((await chat(key, "solo-model")).status).toBe(429);
    expect(await used(org)).toBe(5);
  });
});

describe("the Free plan's limit", () => {
  it("refuses the 25,001st request of the month with 429 plan_limit_reached and a Retry-After to the next month", async () => {
    const { org, slug, key } = await configuredOrg("limit@example.com");

    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests - 1);

    expect((await chat(key, "solo-model")).status).toBe(200);

    upstream.length = 0;

    const refused = await chat(key, "solo-model");
    const now = new Date();
    const nextMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1);
    const retryAfter = Number(refused.headers.get("retry-after"));

    expect(refused.status).toBe(429);
    expect(retryAfter).toBeGreaterThan(0);
    expect(Math.abs(retryAfter * 1000 - (nextMonth - Date.now()))).toBeLessThan(5_000);

    const body = await refused.json<{
      error: { code: string; message: string; resets_at: string };
    }>();

    expect(body.error.code).toBe("plan_limit_reached");
    expect(body.error.resets_at).toBe(new Date(nextMonth).toISOString());
    expect(body.error.message).toContain("25,000 requests and tool calls");
    expect(body.error.message).toContain(`/orgs/${slug}/billing`);

    // No work was done and nothing was counted.
    expect(upstream).toEqual([]);
    expect(await used(org)).toBe(FREE_USAGE.requests);
  });

  it("does not stop a Pay as you go org at its free usage", async () => {
    const { org, key } = await configuredOrg("paying@example.com");

    await setPlan(env, org, "payg");
    await seedRequestsUsed(env, org, Date.now(), FREE_USAGE.requests);

    expect((await chat(key, "solo-model")).status).toBe(200);
    expect(await used(org)).toBe(FREE_USAGE.requests + 1);
  });
});
