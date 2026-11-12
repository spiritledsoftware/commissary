// The secrets of `secrets/` without a Durable Object: the sealed value format (`SecretCipher`, AES-256-GCM with the
// value's context as additional data) and the stage's secrets keys (`deploymentSecretsKeys`). The ControlPlane that
// stores sealed values and starts from each state it can find is tested with an area's part in the Worker
// (packages/models/test/secrets.test.ts).
import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vite-plus/test";
import {
  deploymentSecretsKeys,
  DEV_SECRETS_KEY,
  isSealed,
  SealedValueError,
  SecretCipher,
  SecretsKeyError,
} from "../src/index.ts";

const ACCESS_TOKEN = "sk-ant-oat-plain-access-4f1d";

const API_KEY = "sk-ant-api-plain-key-77ab";

describe("SecretCipher", () => {
  const raw = () => crypto.getRandomValues(new Uint8Array(32));

  it("seals with a fresh nonce per value and opens to the original", () => {
    const cipher = SecretCipher.fromRawKey(raw());
    const first = cipher.seal(ACCESS_TOKEN, "credentials/a");
    const second = cipher.seal(ACCESS_TOKEN, "credentials/a");

    expect(isSealed(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first).not.toContain(ACCESS_TOKEN);
    expect(cipher.open(first, "credentials/a")).toBe(ACCESS_TOKEN);
    expect(cipher.open(second, "credentials/a")).toBe(ACCESS_TOKEN);
  });

  it("is AES-256-GCM: WebCrypto opens it with the key, a 96-bit nonce and the context as additional data", async () => {
    const key = raw();
    const copy = key.slice();
    const sealed = SecretCipher.fromRawKey(key).seal(API_KEY, "config_provider_keys/k1");

    // The caller wipes its copy of the key; the cipher keeps its own.
    key.fill(0);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    const bytes = Buffer.from(sealed.slice("enc:v1:".length), "base64url");
    const imported = await crypto.subtle.importKey("raw", copy, "AES-GCM", false, ["decrypt"]);

    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(0, 12),
        additionalData: new TextEncoder().encode("enc:v1\u0000config_provider_keys/k1"),
        tagLength: 128,
      },
      imported,
      bytes.subarray(12),
    );

    expect(new TextDecoder().decode(opened)).toBe(API_KEY);
  });

  it("refuses another key, another context, a changed value and a plain one, instead of returning garbage", () => {
    const cipher = SecretCipher.fromRawKey(raw());
    const sealed = cipher.seal(API_KEY, "credentials/a");
    const bytes = Buffer.from(sealed.slice("enc:v1:".length), "base64url");

    bytes[20] = (bytes[20] ?? 0) ^ 1;
    const changed = `enc:v1:${bytes.toString("base64url")}`;

    expect(() => SecretCipher.fromRawKey(raw()).open(sealed, "credentials/a")).toThrow(
      SealedValueError,
    );
    expect(() => cipher.open(sealed, "credentials/b")).toThrow(SealedValueError);
    expect(() => cipher.open(changed, "credentials/a")).toThrow(SealedValueError);
    expect(() => cipher.open(API_KEY, "credentials/a")).toThrow(SealedValueError);
    expect(() => cipher.open("enc:v1:AAAA", "credentials/a")).toThrow(SealedValueError);
  });

  it("names the context in an error, never the value", () => {
    const cipher = SecretCipher.fromRawKey(raw());

    expect(() => cipher.open(API_KEY, "credentials/a")).toThrow(/credentials\/a/);
    expect(() => cipher.open(API_KEY, "credentials/a")).not.toThrow(API_KEY);
  });
});

describe("deploymentSecretsKeys", () => {
  const minted = "a".repeat(64);
  const deployed = { ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "aud" };

  it("reads SECRETS_KEY and, during a rotation, SECRETS_KEY_PREVIOUS", () => {
    expect(deploymentSecretsKeys({ SECRETS_KEY: env.SECRETS_KEY })).toEqual({
      current: env.SECRETS_KEY,
    });
    expect(
      deploymentSecretsKeys({
        ...deployed,
        SECRETS_KEY: minted,
        SECRETS_KEY_PREVIOUS: "b".repeat(64),
      }),
    ).toEqual({ current: minted, previous: "b".repeat(64) });
    // An empty previous key, or the current one again, is no rotation.
    expect(deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: "" })).toEqual({
      current: minted,
    });
    expect(deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: minted })).toEqual({
      current: minted,
    });
  });

  it("fails closed without a key or with a short one, deployed or not", () => {
    for (const SECRETS_KEY of [undefined, "", "short-key"]) {
      expect(() => deploymentSecretsKeys({ SECRETS_KEY })).toThrow(SecretsKeyError);
      expect(() => deploymentSecretsKeys({ ...deployed, SECRETS_KEY })).toThrow(SecretsKeyError);
    }

    expect(() =>
      deploymentSecretsKeys({ SECRETS_KEY: minted, SECRETS_KEY_PREVIOUS: "short" }),
    ).toThrow(SecretsKeyError);
  });

  it("refuses the development key and keys under 256 bits on a deployed stage", () => {
    // `alchemy dev` and tests may use the development key...
    expect(deploymentSecretsKeys({ SECRETS_KEY: DEV_SECRETS_KEY })).toEqual({
      current: DEV_SECRETS_KEY,
    });

    // ...a stage with Access configured may not, nor a key shorter than the 64 hex characters the deploy mints.
    for (const access of [{ ACCESS_TEAM_DOMAIN: "team" }, { ACCESS_AUD: "aud" }]) {
      expect(() => deploymentSecretsKeys({ ...access, SECRETS_KEY: DEV_SECRETS_KEY })).toThrow(
        /refused because ACCESS_TEAM_DOMAIN\/ACCESS_AUD are set/,
      );
      expect(() => deploymentSecretsKeys({ ...access, SECRETS_KEY: "c".repeat(63) })).toThrow(
        SecretsKeyError,
      );
      expect(() =>
        deploymentSecretsKeys({
          ...access,
          SECRETS_KEY: minted,
          SECRETS_KEY_PREVIOUS: DEV_SECRETS_KEY,
        }),
      ).toThrow(/SECRETS_KEY_PREVIOUS is refused/);
    }
  });

  it("never puts a key into its error", () => {
    expect(() => deploymentSecretsKeys({ ...deployed, SECRETS_KEY: "c".repeat(40) })).not.toThrow(
      "c".repeat(40),
    );
  });
});
