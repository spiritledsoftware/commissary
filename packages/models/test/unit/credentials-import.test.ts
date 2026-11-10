// Credential import/synthesis parity with the Go server (golden fixtures from `go run ./tools/fixturegen/credentials`)
// plus merge, expiry, redaction and weight rules.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../../src/config/codec.ts";
import { deriveFileCredential } from "../../src/credentials/derive.ts";
import { accessTokenExpiry, parseJwtExp } from "../../src/credentials/expiry.ts";
import { parseAuthFile } from "../../src/credentials/import.ts";
import { credentialsChanged, mergeExistingMetadata } from "../../src/credentials/merge.ts";
import { executorKey } from "../../src/credentials/model.ts";
import { redactSecrets } from "../../src/credentials/redact.ts";
import {
  StableIdGenerator,
  synthesizeConfigCredentials,
} from "../../src/credentials/synthesize.ts";
import { redactMetadata, summarizeCredential } from "../../src/credentials/summary.ts";
import { parseWeightValue } from "../../src/credentials/weight.ts";
import type { JsonObject } from "@commissary/json";
import fixtures from "../fixtures/credentials.json";
import { cred, state } from "../support/credentials.ts";

interface GoAuth {
  id: string;
  provider: string;
  label: string;
  prefix: string;
  proxyUrl: string;
  disabled: boolean;
  attributes: Record<string, string>;
  metadata?: JsonObject;
}

const config = (yaml: string) => Effect.runSync(parseConfigYaml(yaml));

const withoutHeaders = (attributes: Record<string, string>, drop: string[]) =>
  Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !key.startsWith("header:") && !drop.includes(key)),
  );

const goHeaders = (attributes: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([key]) => key.startsWith("header:"))
      .map(([key, value]) => [key.slice("header:".length), value]),
  );

describe("provider keys -> credentials (parity with the Go synthesizer)", () => {
  for (const fixture of fixtures.config) {
    it(fixture.name, () => {
      const credentials = synthesizeConfigCredentials(config(fixture.yaml), 0);
      const expected = fixture.auths as GoAuth[];
      expect(credentials.map((c) => c.id)).toEqual(expected.map((a) => a.id));

      for (const [index, go] of expected.entries()) {
        const ts = credentials[index]!;
        expect(ts.provider).toBe(go.provider);
        expect(ts.label).toBe(go.label);
        expect(ts.prefix ?? "").toBe(go.prefix);
        expect(ts.proxyUrl ?? "").toBe(go.proxyUrl);
        expect(ts.attributes).toEqual(
          withoutHeaders(go.attributes, ["models_hash", "excluded_models_hash"]),
        );
        expect(ts.headers).toEqual(goHeaders(go.attributes));
        expect(ts.metadata).toEqual(go.metadata ?? {});
        expect(ts.source).toBe("config");
        expect(ts.disabled).toBe(false);
        const weight = go.attributes.weight;
        expect(ts.weight).toBe(weight === undefined ? 1 : Number(weight));
        expect(ts.priority).toBe(Number(go.attributes.priority ?? 0));
      }
    });
  }

  it("generates stable ids: hash of kind and trimmed parts, duplicates get a counter", () => {
    const first = new StableIdGenerator();
    expect(first.next("gemini:apikey", " k ", "b").id).toBe(
      new StableIdGenerator().next("gemini:apikey", "k", "b").id,
    );
    const a = first.next("gemini:apikey", "k", "b");
    const b = first.next("gemini:apikey", "k", "b");
    expect(a.id).toMatch(/^gemini:apikey:[0-9a-f]{12}-1$/); // second use of the same hash in this generator
    expect(b.id).toBe(`${a.id.slice(0, -2)}-2`);
    expect(first.next("gemini:apikey", "other", "b").id).not.toContain("-");
  });

  it("flattens groups: key settings override the group's, missing ones inherit", () => {
    const cfg = config(`
api-keys:
  claude:
    - name: g
      base-url: https://api.anthropic.com
      prefix: team
      priority: 4
      headers: { X-G: group }
      keys:
        - { api-key: k1 }
        - { api-key: k2, priority: 9, prefix: other }
`);

    const [one, two] = synthesizeConfigCredentials(cfg, 0);
    expect(one).toMatchObject({ prefix: "team", priority: 4, headers: { "X-G": "group" } });
    expect(two).toMatchObject({ prefix: "other", priority: 9, headers: { "X-G": "group" } });
    expect(one!.id).not.toBe(two!.id);
    expect(one!.attributes.base_url).toBe("https://api.anthropic.com");
  });

  // Go ae33711c: a Claude key's `native-tool-search` is the `native_tool_search` attribute the executor and catalog read.
  it("writes the native_tool_search attribute of a Claude key that sets native-tool-search", () => {
    const [flagged, plain] = synthesizeConfigCredentials(
      config(`
claude-api-key:
  - api-key: k1
    base-url: https://gateway.example
    native-tool-search: true
  - api-key: k2
    base-url: https://gateway.example
`),
      0,
    );

    expect(flagged!.attributes.native_tool_search).toBe("true");
    expect(plain!.attributes.native_tool_search).toBeUndefined();
  });

  it("changes the identity when a hashed field changes", () => {
    const yaml = (extra: string) =>
      `claude-api-key:\n  - api-key: k\n    base-url: https://a.example\n${extra}`;

    const id = (extra: string) => synthesizeConfigCredentials(config(yaml(extra)), 0)[0]!.id;
    expect(id("")).toBe(id(""));
    expect(id("    prefix: p\n")).not.toBe(id(""));
    expect(id("    headers: { X-A: b }\n")).not.toBe(id(""));
    expect(id("    proxy-url: http://p\n")).not.toBe(id(""));
    // priority/weight are not part of the identity
    expect(id("    priority: 3\n")).toBe(id(""));
  });
});

describe("auth files -> credentials (parity with the Go file synthesizer)", () => {
  for (const fixture of fixtures.files) {
    it(fixture.name, () => {
      const parsed = parseAuthFile(fixture.file, fixture.content);
      const expected = fixture.auths as GoAuth[];

      if (fixture.error !== undefined) {
        expect(parsed).toMatchObject({ ok: false, reason: "invalid_weight" });

        return;
      }

      if (expected.length === 0) {
        expect(parsed.ok).toBe(false);

        return;
      }

      if (!parsed.ok) throw new Error(parsed.message);
      const go = expected[0]!;
      const cfg = config(fixture.config ?? "debug: false");

      const credential = deriveFileCredential(
        {
          id: parsed.id,
          provider: parsed.provider,
          metadata: parsed.metadata,
          credentialVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        },
        { config: cfg },
      );

      expect(credential.id).toBe(go.id.split("/").pop());
      expect(credential.provider).toBe(go.provider);
      expect(credential.label).toBe(go.label);
      expect(credential.prefix ?? "").toBe(go.prefix);
      expect(credential.proxyUrl ?? "").toBe(go.proxyUrl);
      expect(credential.disabled).toBe(go.disabled);
      const dropped = ["source", "path", "excluded_models_hash", "model_aliases"];
      const attributes = withoutHeaders(credential.attributes, ["email", ...dropped]);
      expect(attributes).toEqual(withoutHeaders(go.attributes, dropped));
      expect(credential.headers).toEqual(goHeaders(go.attributes));
      expect(parsed.metadata).toEqual(go.metadata);
      const aliases = go.attributes.model_aliases;
      expect(credential.modelAliases).toEqual(aliases === undefined ? [] : JSON.parse(aliases));
      expect(credential.authKind).toBe("oauth");
      expect(credential.priority).toBe(Number(go.attributes.priority ?? 0));
    });
  }

  it("rejects unusable files with a reason", () => {
    expect(parseAuthFile("a.json", "")).toMatchObject({ ok: false, reason: "empty" });
    expect(parseAuthFile("a.json", "{")).toMatchObject({ ok: false, reason: "invalid_json" });
    expect(parseAuthFile("a.json", "[]")).toMatchObject({ ok: false, reason: "not_object" });
    expect(parseAuthFile("a.json", "{}")).toMatchObject({ ok: false, reason: "empty" });
    expect(parseAuthFile("a.json", '{"type":"gemini-cli"}')).toMatchObject({
      ok: false,
      reason: "unsupported_type",
    });
    expect(parseAuthFile("../evil.json", '{"type":"claude"}')).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
    expect(parseAuthFile("/", '{"type":"claude"}')).toMatchObject({
      ok: false,
      reason: "invalid_name",
    });
  });

  it("normalises legacy dashed keys and keeps unknown keys; an explicit canonical key wins", () => {
    const parsed = parseAuthFile(
      "a.json",
      '{"type":"Claude","api-key":"x","base_url":"https://b","base-url":"https://legacy","custom":{"k":1}}',
    );

    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.provider).toBe("claude");
    expect(parsed.metadata).toEqual({
      type: "Claude",
      api_key: "x",
      base_url: "https://b",
      custom: { k: 1 },
    });
  });

  it("maps provider types to executor keys", () => {
    const key = (provider: string) => executorKey({ provider, label: provider, attributes: {} });
    expect(key("kimi.com")).toBe("kimi");
    expect(key("kimi.ai")).toBe("kimi-ai");
    expect(key("Claude")).toBe("claude");
    expect(
      executorKey({
        provider: "openai-compatible-x",
        label: "X",
        attributes: { compat_name: "X", provider_key: "openai-compatible-x" },
      }),
    ).toBe("openai-compatible-x");
  });
});

describe("weight validation", () => {
  it("accepts integers, normalises non-positive values to zero and rejects the rest", () => {
    expect(parseWeightValue(7)).toEqual({ ok: true, value: 7 });
    expect(parseWeightValue("3")).toEqual({ ok: true, value: 3 });
    expect(parseWeightValue("")).toEqual({ ok: true, value: 1 });
    expect(parseWeightValue(-4)).toEqual({ ok: true, value: 0 });

    for (const bad of [
      1.5,
      "1.5",
      "abc",
      true,
      null,
      1_000_001,
      "9223372036854775808",
      Number.NaN,
    ]) {
      expect(parseWeightValue(bad).ok).toBe(false);
    }
  });
});

describe("metadata merge (credentials.md §11)", () => {
  it("carries user settings over on re-login but never old token material", () => {
    const existing: JsonObject = {
      type: "claude",
      access_token: "old",
      refresh_token: "old-r",
      expired: "2020-01-01T00:00:00Z",
      prefix: "team",
      priority: 5,
      headers: { "X-A": "1" },
      disabled: true,
    };

    const merged = mergeExistingMetadata(
      "claude",
      { type: "claude", access_token: "new", priority: 9 },
      existing,
    );

    expect(merged).toEqual({
      type: "claude",
      access_token: "new",
      priority: 9,
      prefix: "team",
      headers: { "X-A": "1" },
      disabled: true,
    });
    expect(
      mergeExistingMetadata("claude", { type: "claude", disabled: false }, existing).disabled,
    ).toBe(false);
  });

  it("never carries Meta api keys / DCA tokens over", () => {
    const merged = mergeExistingMetadata(
      "meta",
      { type: "meta", access_token: "n" },
      { api_key: "k", dca_token: "d", email: "e" },
    );

    expect(merged).toEqual({ type: "meta", access_token: "n", email: "e" });
  });

  it("detects credential changes", () => {
    expect(credentialsChanged({ access_token: "a" }, { access_token: "a", prefix: "x" })).toBe(
      false,
    );
    expect(credentialsChanged({ access_token: "a" }, { access_token: "b" })).toBe(true);
    expect(credentialsChanged({ refreshToken: "a" }, { refresh_token: "a" })).toBe(false);
    expect(credentialsChanged({ api_key: "a" }, { api_key: "b" })).toBe(true);
  });
});

describe("access token expiry", () => {
  const jwt = (claims: JsonObject) =>
    `h.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.s`;

  const NOW_S = 1_800_000_000;

  it("JWT exp outranks metadata keys", () => {
    const meta = { access_token: jwt({ exp: NOW_S + 100 }), expired: "2000-01-01T00:00:00Z" };
    expect(parseJwtExp(meta.access_token)).toBe((NOW_S + 100) * 1000);
    expect(accessTokenExpiry(meta)).toBe((NOW_S + 100) * 1000);
  });

  it("understands the metadata formats", () => {
    const at = (extra: JsonObject) => accessTokenExpiry({ access_token: "opaque", ...extra });
    const ms = Date.UTC(2030, 0, 1);
    expect(at({ expired: "2030-01-01T00:00:00Z" })).toBe(ms);
    expect(at({ expires_at: "2030-01-01 00:00:00" })).toBe(ms);
    expect(at({ expiry: ms / 1000 })).toBe(ms);
    expect(at({ expires: String(ms) })).toBe(ms);
    expect(at({ expires_in: 3600, timestamp: ms })).toBe(ms + 3_600_000);
    expect(at({ token: { expired: "2030-01-01T00:00:00Z" } })).toBe(ms);
    expect(at({})).toBeUndefined();
    expect(accessTokenExpiry({ expired: "2030-01-01T00:00:00Z" })).toBeUndefined(); // no token, no expiry
  });

  it("a rejected token counts as expired", () => {
    expect(accessTokenExpiry({ access_token: "t", expired: "2999-01-01T00:00:00Z" }, "t")).toBe(0);
  });
});

describe("redaction", () => {
  it("masks secrets in metadata and summaries", () => {
    const metadata = {
      type: "codex",
      email: "me@x.com",
      access_token: "super-secret-token",
      token_type: "Bearer",
      service_account: { client_email: "sa@x", private_key: "-----BEGIN-----" },
      nested: [{ refresh_token: "r" }],
    };

    const redacted = JSON.stringify(redactMetadata(metadata));
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("BEGIN");
    expect(redacted).toContain("me@x.com");
    expect(redacted).toContain("Bearer");

    const summary = summarizeCredential(
      cred("a", { attributes: { api_key: "sk-abcdefghijklmnop" }, metadata }),
      state(),
    );

    expect(JSON.stringify(summary)).not.toContain("abcdefghijklm");
    expect(JSON.stringify(summary)).not.toContain("super-secret");
    expect(summary.attributes.api_key).toMatch(/…mnop$/);
  });

  it("redacts token shapes in upstream error text and truncates", () => {
    const text = redactSecrets(
      "bad Bearer abcdefghijkl and sk-live1234567890 plus api_key=hunter22 url https://user:pw@host/x token: abc.def",
    );

    for (const secret of ["abcdefghijkl", "sk-live1234567890", "hunter22", "user:pw", "abc.def"]) {
      expect(text).not.toContain(secret);
    }

    expect(redactSecrets("x".repeat(1000)).length).toBe(256);
  });
});
