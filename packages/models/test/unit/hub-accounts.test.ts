// What the hub API lists of an account (src/hub/accounts.ts, ADR 0052): the fields allowance readers read, and never
// a token or the raw id token.
import { describe, expect, it } from "vite-plus/test";
import type { Credential } from "../../src/credentials/model.ts";
import { type HubAccount, hubAccount } from "../../src/hub/accounts.ts";

const jwt = (claims: Record<string, unknown>): string =>
  [
    btoa(JSON.stringify({ alg: "none" })),
    btoa(JSON.stringify(claims)).replace(/=+$/, ""),
    "signature",
  ].join(".");

const credential = (
  provider: string,
  metadata: Record<string, unknown>,
  attributes: Record<string, string> = {},
): Pick<Credential, "id" | "provider" | "label" | "metadata" | "attributes"> => ({
  id: `${provider}-me.json`,
  provider,
  label: "",
  // SAFETY: the test metadata is plain JSON.
  metadata: metadata as Credential["metadata"],
  attributes,
});

const SECRETS = ["secret-access", "secret-refresh", "secret-id-token"];

const leaksNothing = (value: HubAccount): void => {
  const text = JSON.stringify(value);

  for (const secret of SECRETS) expect(text).not.toContain(secret);
  expect(text).not.toContain("access_token");
  expect(text).not.toContain("refresh_token");
};

describe("a listed account", () => {
  it("carries a Codex account's id and plan from its id token", () => {
    const idToken = jwt({
      email: "me@x.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-1",
        chatgpt_plan_type: "pro",
        secret: "secret-id-token",
      },
    });

    const account = hubAccount(
      credential("codex", {
        type: "codex",
        email: "me@x.com",
        access_token: "secret-access",
        refresh_token: "secret-refresh",
        id_token: idToken,
      }),
      "0123456789abcdef",
    );

    expect(account).toEqual({
      id: "codex-me.json",
      auth_index: "0123456789abcdef",
      provider: "codex",
      email: "me@x.com",
      id_token: { chatgpt_account_id: "acct-1", plan_type: "pro" },
    });
    expect(JSON.stringify(account)).not.toContain(idToken);
    leaksNothing(account);
  });

  it("falls back to the stored Codex account id", () => {
    expect(hubAccount(credential("codex", { account_id: "acct-2" }), "0123456789abcdef")).toEqual({
      id: "codex-me.json",
      auth_index: "0123456789abcdef",
      provider: "codex",
      id_token: { chatgpt_account_id: "acct-2" },
    });
  });

  it("carries an Antigravity account's project", () => {
    expect(
      hubAccount(
        credential("antigravity", {
          email: "g@x.com",
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          project_id: "proj-1",
        }),
        "fedcba9876543210",
      ),
    ).toEqual({
      id: "antigravity-me.json",
      auth_index: "fedcba9876543210",
      provider: "antigravity",
      email: "g@x.com",
      project_id: "proj-1",
    });
  });

  it("leaves out what an account does not have", () => {
    const account = hubAccount(
      credential("claude", { access_token: "secret-access", refresh_token: "secret-refresh" }),
      "0123456789abcdef",
    );

    expect(account).toEqual({
      id: "claude-me.json",
      auth_index: "0123456789abcdef",
      provider: "claude",
    });
    leaksNothing(account);
  });
});
