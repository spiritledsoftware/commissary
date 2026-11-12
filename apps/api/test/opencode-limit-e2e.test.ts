// An OpenCode Go usage limit end to end: the production Worker (`exports.default.fetch`) with the real ControlPlane
// picker and `markResult`; only the gateway is mocked, through the global `fetch`. The key over its limit is cooled as a
// whole until the window resets (Retry-After), so later requests go to the other key without asking the first again,
// on a chat model and on a Messages model (whose key travels as `x-api-key`).
import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

const LIMITED_KEY = "sk-go-limited-0001";

const SPARE_KEY = "sk-go-spare-0002";

const MESSAGES_LIMITED_KEY = "sk-go-msg-limited-0003";

const MESSAGES_SPARE_KEY = "sk-go-msg-spare-0004";

const YAML = `
api-keys:
  opencode-go:
    - keys:
        - api-key: ${LIMITED_KEY}
        - api-key: ${SPARE_KEY}
      models:
        - name: open-model
          protocol: chat
    - keys:
        - api-key: ${MESSAGES_LIMITED_KEY}
        - api-key: ${MESSAGES_SPARE_KEY}
      models:
        - name: msg-model
          protocol: messages
`;

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "open-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

// The gateway's answer over a Go window (opencode console handler, see packages/models/src/executor/opencode/usage-limit.ts).
const LIMITED = JSON.stringify({
  type: "error",
  error: {
    type: "GoUsageLimitError",
    message:
      "5-hour usage limit reached. Resets in 2hr 13min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_1/go",
  },
  metadata: { workspace: "wrk_1", limitName: "5 hour" },
});

const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "msg-model",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
};

const RETRY_AFTER_SECONDS = 7980;

/** The key of each gateway call, in order. */
const calls: string[] = [];

const realFetch = globalThis.fetch;

const chat = () =>
  exports.default.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "open-model", messages: [{ role: "user", content: "hi" }] }),
    }),
  );

const claude = () =>
  exports.default.fetch(
    new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "msg-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

interface Account {
  readonly account?: string;
  readonly status: string;
  readonly unavailable: boolean;
  readonly cooldowns: ReadonlyArray<{
    readonly scope: string;
    readonly reason: string;
    readonly retry_at: string;
  }>;
}

/**
 * The listed account of a key, as `GET /v9/management/credentials` (the app Worker's) lists it to an org admin: the
 * Models part's `listCredentialEntries`, whose entries that route answers unchanged.
 */
const accountOf = async (key: string): Promise<Account | undefined> => {
  // SAFETY: the credential list contract (`@commissary/contract/credentials` CredentialEntry).
  const files = (await withModelsPart(controlPlane(), (part) =>
    part.listCredentialEntries(FULL_ACCESS),
  )) as unknown as ReadonlyArray<Account>;

  return files.find((file) => file.account?.endsWith(key.slice(-4)) === true);
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);

    const key =
      request.headers.get("x-api-key") ??
      (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");

    calls.push(key);

    if (key === LIMITED_KEY || key === MESSAGES_LIMITED_KEY)
      return new Response(LIMITED, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(RETRY_AFTER_SECONDS),
        },
      });

    return Response.json(key === MESSAGES_SPARE_KEY ? MESSAGE : COMPLETION);
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("OpenCode Go usage limit through the ControlPlane", () => {
  it("cools the limited key until the window resets and serves from the other key", async () => {
    const started = Date.now();

    for (let request = 0; request < 4; request += 1) {
      const response = await chat();
      expect(response.status).toBe(200);
      await response.text();
    }

    // Asked once; every other request went straight to the spare key.
    expect(calls.filter((key) => key === LIMITED_KEY)).toHaveLength(1);
    expect(calls.filter((key) => key === SPARE_KEY)).toHaveLength(4);

    const account = await accountOf(LIMITED_KEY);
    const cooldown = account?.cooldowns.find((entry) => entry.scope === "credential");

    expect(account?.unavailable).toBe(true);
    expect(cooldown).toBeDefined();

    const until = Date.parse(cooldown?.retry_at ?? "");

    expect(until - started).toBeGreaterThanOrEqual(RETRY_AFTER_SECONDS * 1000 - 5000);
    expect(until - started).toBeLessThanOrEqual(RETRY_AFTER_SECONDS * 1000 + 60_000);
  });

  it("keeps the cooldown across a ControlPlane eviction", async () => {
    await evictDurableObject(controlPlane());
    calls.length = 0;

    const response = await chat();
    expect(response.status).toBe(200);
    await response.text();

    expect(calls).toEqual([SPARE_KEY]);
  });

  it("cools a limited key of a Messages model the same way", async () => {
    calls.length = 0;
    const started = Date.now();

    for (let request = 0; request < 3; request += 1) {
      const response = await claude();
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(calls.filter((key) => key === MESSAGES_LIMITED_KEY)).toHaveLength(1);
    expect(calls.filter((key) => key === MESSAGES_SPARE_KEY)).toHaveLength(3);

    const account = await accountOf(MESSAGES_LIMITED_KEY);
    const cooldown = account?.cooldowns.find((entry) => entry.scope === "credential");

    expect(account?.unavailable).toBe(true);
    expect(Date.parse(cooldown?.retry_at ?? "") - started).toBeGreaterThanOrEqual(
      RETRY_AFTER_SECONDS * 1000 - 5000,
    );
  });
});
