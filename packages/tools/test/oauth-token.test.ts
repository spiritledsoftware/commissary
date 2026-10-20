// An access token of Commissary Cloud's OAuth server on the MCP endpoint (#200): a token that is none of the server's
// live tokens stands for no API key (the gate refuses it with a `401`), while a store that cannot be read is a failure
// of its own (the gate answers `503`), so a client retries instead of sending its member through a sign-in again.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { McpOAuthConfig } from "../src/oauth/config.ts";
import { resolveAccessToken } from "../src/oauth/server.ts";

/** A stored token record as the store answers it: none, here. */
type StoredToken = null;

/** A store whose reads answer `get`; the library reads tokens with `get` only. */
const configWith = (get: () => Promise<StoredToken>): McpOAuthConfig => ({
  issuer: "https://app.example.com",
  resource: "https://api.example.com/mcp",
  // SAFETY: `validateToken` reads the store with `get` alone, which the fake answers.
  kv: { get } as unknown as McpOAuthConfig["kv"],
});

describe("resolveAccessToken", () => {
  it("stands for no key for a token not in the server's format, without reading the store", async () => {
    const config = configWith(() => Promise.reject(new Error("not read")));

    expect(await Effect.runPromise(resolveAccessToken(config, "not-a-token"))).toBeUndefined();
  });

  it("stands for no key for a token the store does not know", async () => {
    const config = configWith(() => Promise.resolve(null));

    expect(
      await Effect.runPromise(resolveAccessToken(config, "org/member:grant:secret")),
    ).toBeUndefined();
  });

  it("fails, rather than refusing the token, when the store cannot be read", async () => {
    const config = configWith(() => Promise.reject(new Error("KV GET failed: 503")));

    const error = await Effect.runPromise(
      Effect.flip(resolveAccessToken(config, "org/member:grant:secret")),
    );

    expect(error._tag).toBe("McpTokenUnavailable");
  });
});
