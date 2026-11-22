// The hub API's relayed calls (src/hub/calls.ts, ADR 0052): seven method and URL pairs, matched exactly, with the
// bodies Commissary rebuilds itself. Anything else is refused before an RPC or a fetch.
import { describe, expect, it } from "vite-plus/test";
import { HUB_CALLS, matchHubCall } from "../../src/hub/calls.ts";

const CONSUME = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

const CREDIT = { redeem_request_id: "6f1c1c86-35c5-4f77-9a5f-0d1d7f3a6b10", credit_id: "credit_1" };

describe("the relayed calls", () => {
  it("are exactly the seven of today's allowance readers", () => {
    expect(HUB_CALLS.map((entry) => [entry.provider, entry.method, entry.url])).toEqual([
      ["codex", "GET", "https://chatgpt.com/backend-api/wham/usage"],
      ["codex", "GET", "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"],
      ["codex", "POST", CONSUME],
      ["claude", "GET", "https://api.anthropic.com/api/oauth/usage"],
      ["xai", "GET", "https://cli-chat-proxy.grok.com/v1/billing?format=credits"],
      [
        "antigravity",
        "POST",
        "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      ],
      ["antigravity", "GET", "https://www.googleapis.com/oauth2/v2/userinfo"],
    ]);
    expect(new Set(HUB_CALLS.map((entry) => entry.id)).size).toBe(7);
  });

  it("match each entry by method and URL", () => {
    for (const entry of HUB_CALLS) {
      const data =
        entry.url === CONSUME
          ? JSON.stringify(CREDIT)
          : entry.method === "POST"
            ? '{"project":"ignored"}'
            : undefined;

      const matched = matchHubCall(entry.method, entry.url, data);

      expect(matched.ok, entry.id).toBe(true);
      expect(matched.ok && matched.call.entry.id).toBe(entry.id);
    }
  });

  it("refuse anything else", () => {
    const usage = "https://chatgpt.com/backend-api/wham/usage";

    for (const [method, url] of [
      ["POST", usage],
      ["DELETE", usage],
      ["GET", "https://chatgpt.example.com/backend-api/wham/usage"],
      ["GET", "https://evil.com/backend-api/wham/usage"],
      ["GET", "https://chatgpt.com/backend-api/wham/usage2"],
      ["GET", "https://chatgpt.com/backend-api/wham/"],
      ["GET", `${usage}/`],
      ["GET", `${usage}?x=1`],
      ["GET", "https://cli-chat-proxy.grok.com/v1/billing"],
      ["GET", "https://cli-chat-proxy.grok.com/v1/billing?format=credits&x=1"],
      ["GET", "https://cli-chat-proxy.grok.com/v1/billing?format=usd"],
      ["GET", "https://chatgpt.com:443/backend-api/wham/usage"],
      ["GET", "https://chatgpt.com:8443/backend-api/wham/usage"],
      ["GET", "https://user:pass@chatgpt.com/backend-api/wham/usage"],
      ["GET", "https://user@chatgpt.com/backend-api/wham/usage"],
      ["GET", "http://chatgpt.com/backend-api/wham/usage"],
      ["GET", `${usage}#frag`],
      ["GET", `${usage}#`],
      ["GET", "not a url"],
      ["GET", ""],
    ] as const) {
      const matched = matchHubCall(method, url, undefined);

      expect(matched, `${method} ${url}`).toEqual({ ok: false, error: "call not allowed" });
    }
  });

  it("refuse a body on a GET", () => {
    expect(
      matchHubCall("GET", "https://chatgpt.com/backend-api/wham/usage", '{"a":1}'),
    ).toMatchObject({ ok: false });
    expect(
      matchHubCall("GET", "https://chatgpt.com/backend-api/wham/usage", { a: 1 }),
    ).toMatchObject({ ok: false });
    expect(matchHubCall("GET", "https://chatgpt.com/backend-api/wham/usage", "").ok).toBe(true);
    expect(matchHubCall("GET", "https://chatgpt.com/backend-api/wham/usage", null).ok).toBe(true);
  });

  it("rebuild a reset credit's redemption from its two fields only", () => {
    for (const data of [JSON.stringify(CREDIT), CREDIT]) {
      const matched = matchHubCall("POST", CONSUME, data);

      expect(matched.ok).toBe(true);
      expect(matched.ok && matched.call.body).toEqual({ kind: "json", value: CREDIT });
    }

    for (const data of [
      undefined,
      "",
      "not json",
      "[]",
      JSON.stringify({ ...CREDIT, extra: true }),
      JSON.stringify({ credit_id: "c" }),
      JSON.stringify({ redeem_request_id: CREDIT.redeem_request_id }),
      JSON.stringify({ ...CREDIT, redeem_request_id: "not-a-uuid" }),
      JSON.stringify({ ...CREDIT, credit_id: 42 }),
      JSON.stringify({ ...CREDIT, credit_id: "x".repeat(201) }),
    ]) {
      const matched = matchHubCall("POST", CONSUME, data);

      expect(matched.ok, String(data)).toBe(false);
      expect(!matched.ok && matched.error).not.toBe("call not allowed");
    }

    expect(matchHubCall("POST", CONSUME, { ...CREDIT, credit_id: "x".repeat(200) }).ok).toBe(true);
  });

  it("build the Antigravity quota summary's body from the stored project, whatever the caller sends", () => {
    const matched = matchHubCall(
      "POST",
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      '{"project":"someone-elses"}',
    );

    expect(matched.ok && matched.call.body).toEqual({ kind: "project" });
  });
});
