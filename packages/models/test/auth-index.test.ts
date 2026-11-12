// Keyed `auth_index` (src/management/auth-index.ts): HMAC under the deployment key, failing closed without one, and the
// keys a deployed stage refuses. That no response carries a raw config credential id or an unkeyed hash:
// apps/app/test/auth-index-keyed.test.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import {
  AUTH_INDEX_LENGTH,
  AuthIndexKeyError,
  authIndexer,
  deploymentAuthIndexer,
} from "../src/management/auth-index.ts";
import { DEV_AUTH_INDEX_KEY } from "../src/management/auth-index-key.ts";
import { authIndexOf, unkeyedAuthIndexOf } from "./support/auth-index.ts";

/** `hex(HMAC-SHA256(key, "auth-index:" + id))[:16]` through WebCrypto: no state shared with the module's caches. */
const referenceIndex = async (key: string, id: string): Promise<string> => {
  const encoder = new TextEncoder();

  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(`auth-index:${id}`)),
  );

  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, AUTH_INDEX_LENGTH);
};

describe("authIndexer", () => {
  const ids = ["claude-a.json", "claude:apikey:0123456789ab", "openai-compatibility:mock:abc"];

  it("is HMAC-SHA256 under the key, truncated to 16 hex characters", async () => {
    for (const id of ids) {
      const index = authIndexOf(id);
      expect(index).toMatch(/^[0-9a-f]{16}$/);
      expect(index).toBe(await referenceIndex(env.AUTH_INDEX_KEY, id));
      expect(index).not.toBe(unkeyedAuthIndexOf(id));
    }
  });

  it("is stable across calls and isolates for the same key", async () => {
    // One indexer per key and isolate; a fresh computation elsewhere (WebCrypto, no shared cache) agrees.
    expect(authIndexer(env.AUTH_INDEX_KEY)).toBe(authIndexOf);

    for (const id of ids) {
      expect(authIndexOf(id)).toBe(authIndexOf(id));
      expect(authIndexer(env.AUTH_INDEX_KEY)(id)).toBe(authIndexOf(id));
      expect(await referenceIndex(env.AUTH_INDEX_KEY, id)).toBe(authIndexOf(id));
    }
  });

  it("differs under a different key", async () => {
    const other = authIndexer("another-deployment-key");

    for (const id of ids) {
      expect(other(id)).not.toBe(authIndexOf(id));
      expect(other(id)).toBe(await referenceIndex("another-deployment-key", id));
    }

    expect(new Set(ids.map(authIndexOf)).size).toBe(ids.length);
  });

  it("fails closed without a key, with an empty or a short one", () => {
    // node:crypto accepts a 0-byte HMAC key: a missing binding must throw, not hash under it.
    for (const secret of [undefined, "", "short-key", "x".repeat(15)])
      expect(() => authIndexer(secret), String(secret)).toThrow(AuthIndexKeyError);

    expect(authIndexer("x".repeat(16))("claude-a.json")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("deploymentAuthIndexer", () => {
  const minted = "a1".repeat(32);

  it("refuses the dev key and keys shorter than 64 characters once Access is configured", () => {
    for (const deployed of [
      { ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "aud-tag" },
    ]) {
      for (const key of [
        DEV_AUTH_INDEX_KEY,
        "short-but-valid-locally",
        "b".repeat(63),
        "",
        undefined,
      ])
        expect(
          () => deploymentAuthIndexer({ ...deployed, AUTH_INDEX_KEY: key }),
          String(key),
        ).toThrow(/refused because ACCESS_TEAM_DOMAIN\/ACCESS_AUD are set/);

      expect(deploymentAuthIndexer({ ...deployed, AUTH_INDEX_KEY: minted })("x")).toBe(
        authIndexer(minted)("x"),
      );
    }
  });

  it("accepts the dev and test keys while Access is not configured (alchemy dev, tests)", () => {
    const local = { ACCESS_TEAM_DOMAIN: " ", ACCESS_AUD: "" };

    expect(deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: DEV_AUTH_INDEX_KEY })("x")).toBe(
      authIndexer(DEV_AUTH_INDEX_KEY)("x"),
    );
    expect(deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: env.AUTH_INDEX_KEY })).toBe(
      authIndexOf,
    );
    expect(() => deploymentAuthIndexer({ ...local, AUTH_INDEX_KEY: "" })).toThrow(
      AuthIndexKeyError,
    );
  });
});
