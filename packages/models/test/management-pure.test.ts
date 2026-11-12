// Pure helpers of the management API: config key ids, typed duplicate keys, credential entries, field patches, cooldown reset.
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { decodeConfig } from "../src/config/codec.ts";
import type { JsonObject } from "@commissary/json";
import { resetCooldownState } from "../src/credentials/cooldown-reset.ts";
import { synthesizeConfigCredentials } from "../src/credentials/synthesize.ts";
import { applyFieldPatch } from "../src/credentials/field-patch.ts";
import { emptyQuota, emptyState, type CredentialState } from "../src/credentials/model.ts";
import { configKeyIds } from "../src/credentials/key-ids.ts";
import { buildCredentialEntry, cooldownSnapshot } from "../src/management/credential-entry.ts";
import { typedDuplicates, withoutKeys } from "../src/management/key-duplicates.ts";
import { authIndexOf } from "./support/auth-index.ts";
import { cred, cooling, state } from "./support/credentials.ts";

const NOW = 1_800_000_000_000;

const unsignedJwt = (claims: JsonObject) =>
  `x.${btoa(JSON.stringify(claims)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}.y`;

describe("config key ids", () => {
  const document: JsonObject = {
    "api-keys": {
      claude: [
        { keys: [{ "api-key": "sk-ant-1" }, { "api-key": "sk-ant-2" }] },
        { "base-url": "https://claude.test", keys: [{ "api-key": "sk-ant-3" }] },
      ],
      vertex: [{ "base-url": "https://vertex.test", keys: [{ "api-key": "vx-1" }] }],
      "openai-compatibility": [
        { name: "empty", "base-url": "https://empty.test/v1", keys: [] },
        {
          name: "off",
          disabled: true,
          "base-url": "https://off.test/v1",
          keys: [{ "api-key": "off-1" }, { "api-key": "off-2" }],
        },
        {
          name: "on",
          "base-url": "https://on.test/v1",
          keys: [{ "api-key": "on-1" }, { "api-key": "on-2" }],
        },
      ],
    },
  };

  const config = Effect.runSync(decodeConfig(document));

  it("maps every key position to a credential the pool synthesises", () => {
    const ids = configKeyIds(config);
    const synthesised = new Set(synthesizeConfigCredentials(config, 0).map((entry) => entry.id));

    for (const family of ["claude", "vertex", "openai-compatibility"] as const)
      for (const id of ids[family].flatMap((group) => group.keys))
        if (id !== undefined) expect(synthesised).toContain(id);

    // Keys of one family are distinct, in config order across groups.
    const claude = ids.claude.flatMap((group) => group.keys);

    expect(new Set(claude).size).toBe(3);
    expect(claude.every((id) => id?.startsWith("claude:apikey:"))).toBe(true);
  });

  it("gives no id to the keys of an empty or disabled compat group", () => {
    const ids = configKeyIds(config);

    expect(ids["openai-compatibility"][0]?.keys).toEqual([]);
    expect(ids["openai-compatibility"][1]?.keys.every((id) => id === undefined)).toBe(true);
    expect(ids["openai-compatibility"][2]?.keys.every((id) => id !== undefined)).toBe(true);
  });

  it("includeDisabledGroups addresses the keys of a disabled group and changes nothing else", () => {
    const base = configKeyIds(config);
    const all = configKeyIds(config, { includeDisabledGroups: true });

    expect(all["openai-compatibility"][1]?.keys.every((id) => id !== undefined)).toBe(true);
    expect(all["openai-compatibility"][1]?.keys.length).toBe(2);
    expect(all["openai-compatibility"][0]).toEqual(base["openai-compatibility"][0]);
    expect(all["openai-compatibility"][2]).toEqual(base["openai-compatibility"][2]);
    expect(all.claude).toEqual(base.claude);
    expect(all.vertex).toEqual(base.vertex);
  });
});

describe("credential entries", () => {
  it("describes a healthy file credential without secrets", () => {
    const credential = cred("codex.json", {
      provider: "codex",
      label: "me@x.com",
      priority: 2,
      weight: 3,
      createdAt: NOW - 1000,
      updatedAt: NOW,
      attributes: { websockets: "true" },
      metadata: {
        type: "codex",
        email: "me@x.com",
        access_token: "secret-access",
        id_token: unsignedJwt({
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acc",
            chatgpt_plan_type: "plus",
            chatgpt_subscription_active_until: "2030-01-01",
          },
        }),
        weight: 3,
        priority: "2",
        note: " n ",
        project_id: "p1",
        request_retry: 4,
        last_refresh: "2026-01-01T00:00:00Z",
      },
    });

    const entry = buildCredentialEntry(
      credential,
      state({ success: 5, failed: 1 }),
      NOW,
      authIndexOf,
    );

    expect(entry).toMatchObject({
      id: "codex.json",
      name: "codex.json",
      type: "codex",
      status: "active",
      unavailable: false,
      source: "file",
      email: "me@x.com",
      account: "me@x.com",
      account_type: "oauth",
      project_id: "p1",
      success: 5,
      failed: 1,
      priority: 2,
      note: "n",
      weight: 3,
      websockets: true,
      request_retry: 4,
      last_refresh: "2026-01-01T00:00:00Z",
      id_token: {
        chatgpt_account_id: "acc",
        plan_type: "plus",
        chatgpt_subscription_active_until: "2030-01-01",
      },
      modtime: new Date(NOW).toISOString(),
      cooldowns: [],
    });
    expect(JSON.stringify(entry)).not.toContain("secret-access");
    const buckets = entry.recent_requests as Array<{ time: string }>;
    expect(buckets).toHaveLength(20);
    // Buckets are contiguous ten-minute windows.
    expect(buckets[19]?.time.split("-")[0]).toBe(
      new Date(Math.floor(NOW / 600_000) * 600_000).toISOString().slice(11, 16),
    );
  });

  it("shows the account's own routing fields with every header value masked but safe ones", () => {
    const credential = cred("claude.json", {
      // The effective prefix (outer slashes dropped by derivation), not the raw metadata.
      prefix: "team",
      metadata: {
        type: "claude",
        access_token: "secret-access",
        prefix: " /team/ ",
        disable_cooling: "true",
        headers: {
          Authorization: "Bearer sk-ant-api-0123456789wxyz",
          "X-Api-Key": "tiny",
          // Secrets under names no pattern would catch.
          "Helicone-Auth": "Bearer sk-helicone-secret-1111",
          "X-Portkey-Virtual-Key": "pk-virtual-secret-2222",
          "Ocp-Apim-Subscription-Key": "apim-secret-3333",
          "X-Auth-Key": "auth-secret-4444",
          "X-Session-Id": "session-secret-5555",
          token_type: "bearer-secret-6666",
          // A template sends its literal text upstream: masked.
          "X-Trace": "$CPA-SESSION-ID:sk-template-secret-7777",
          // Copy-shaped, but the executor reads them as session templates and sends the suffix upstream.
          "X-Sid": "$CPA-SESSION-ID-sk-live-1234abcd",
          "X-Sid-Lower": "$cpa-session-idSECRET-8888",
          // Pure client copies and safe headers are shown.
          "X-Session": "$x-session",
          "X-Cpa": "$CPA-SESSION-ID",
          "X-Cpa-Spaced": "$ cpa-session-id",
          "User-Agent": "my-agent/1.0",
          "anthropic-beta": "context-1m",
          "X-Team": "blue",
          "X-Empty": " ",
        },
        excluded_models: [" Claude-3-* ", "claude-3-*", ""],
        model_aliases: [
          { name: "claude-opus-4-5", alias: "opus", fork: true },
          { name: "x", alias: "x" },
        ],
      },
    });

    const entry = buildCredentialEntry(credential, emptyState(), NOW, authIndexOf);

    expect(entry).toMatchObject({
      prefix: "team",
      disable_cooling: true,
      headers: {
        Authorization: "[redacted]\u2026wxyz",
        "X-Api-Key": "[redacted]",
        "Helicone-Auth": "[redacted]\u20261111",
        "X-Trace": "[redacted]\u20267777",
        "X-Sid": "[redacted]\u2026abcd",
        "X-Sid-Lower": "[redacted]\u20268888",
        token_type: "[redacted]\u20266666",
        "X-Session": "$x-session",
        "X-Cpa": "$CPA-SESSION-ID",
        "X-Cpa-Spaced": "$ cpa-session-id",
        "User-Agent": "my-agent/1.0",
        "anthropic-beta": "context-1m",
        "X-Team": "[redacted]",
      },
      excluded_models: ["claude-3-*"],
      model_aliases: [{ name: "claude-opus-4-5", alias: "opus", fork: true }],
    });
    expect(entry.headers).not.toHaveProperty("X-Empty");

    const raw = JSON.stringify(entry);

    for (const secret of [
      "sk-ant-api",
      "tiny",
      "secret-access",
      "sk-helicone",
      "pk-virtual",
      "apim-secret",
      "auth-secret",
      "session-secret",
      "bearer-secret",
      "sk-template",
      "sk-live",
      "SECRET-8888",
      "blue",
    ])
      expect(raw).not.toContain(secret);

    // Unset fields stay out of the entry, so the routing defaults apply.
    const plain = buildCredentialEntry(cred("plain.json"), emptyState(), NOW, authIndexOf);

    for (const key of ["prefix", "disable_cooling", "headers", "excluded_models", "model_aliases"])
      expect(plain).not.toHaveProperty(key);
  });

  it("shows cooldowns and the derived status", () => {
    const next = NOW + 90_500;
    const credential = cred("a.json");

    const cooling429: CredentialState = state({
      modelStates: {
        "gpt-5": {
          ...cooling(next, true),
          lastError: { message: "limit", retryable: true, httpStatus: 429 },
        },
      },
    });

    expect(cooldownSnapshot(cooling429, NOW)).toEqual([
      expect.objectContaining({
        scope: "model",
        model_key: "gpt-5",
        reason: "unknown",
        remaining_seconds: 91,
      }),
    ]);

    const credentialWide = state({
      unavailable: true,
      nextRetryAfter: NOW + 5000,
      lastError: { message: "x", retryable: true, httpStatus: 503 },
    });

    const entry = buildCredentialEntry(credential, credentialWide, NOW, authIndexOf);
    expect(entry).toMatchObject({
      unavailable: true,
      status: "error",
      next_retry_after: new Date(NOW + 5000).toISOString(),
    });
    expect(entry.cooldowns).toEqual([
      expect.objectContaining({
        scope: "credential",
        retry_at: new Date(NOW + 5000).toISOString(),
        http_status: 503,
      }),
    ]);
    // Expired timers disappear.
    expect(cooldownSnapshot(state({ unavailable: true, nextRetryAfter: NOW - 1 }), NOW)).toEqual(
      [],
    );
    expect(
      buildCredentialEntry(cred("d.json", { disabled: true }), emptyState(), NOW, authIndexOf),
    ).toMatchObject({
      disabled: true,
      status: "disabled",
    });

    const quota = cooldownSnapshot(
      state({
        quota: {
          ...emptyQuota(),
          exceeded: true,
          reason: "credential_quota",
          nextRecoverAt: NOW + 1000,
          backoffLevel: 2,
        },
      }),
      NOW,
    );

    expect(quota).toEqual([
      expect.objectContaining({ scope: "credential", reason: "credential_quota" }),
    ]);
  });
});

describe("field patch", () => {
  const meta = { type: "claude", access_token: "t", headers: { A: "1" }, keep: true };

  it("does not mutate the input and applies nested paths", () => {
    const result = applyFieldPatch(meta, {
      "a.b.c": 1,
      "excluded-models": [" X ", "x", "claude-3-*"],
      "model-aliases": [],
    });

    // Exclusions are stored as selection reads them; an empty alias list deletes the key.
    expect(result).toEqual({
      ok: true,
      metadata: { ...meta, a: { b: { c: 1 } }, excluded_models: ["x", "claude-3-*"] },
    });
    expect(meta).toEqual({ type: "claude", access_token: "t", headers: { A: "1" }, keep: true });
  });

  it("rejects duplicate spellings and empty names", () => {
    expect(applyFieldPatch(meta, { "api-key": "1", api_key: "2" })).toMatchObject({ ok: false });
    expect(applyFieldPatch(meta, { " ": 1 })).toEqual({
      ok: false,
      message: "field name is required",
    });
    expect(applyFieldPatch(meta, { request_retry: -1 })).toEqual({ ok: true, metadata: meta });
  });

  it("merges string-map headers, drops them when emptied and refuses anything else", () => {
    expect(applyFieldPatch(meta, { headers: { A: "" } })).toEqual({
      ok: true,
      metadata: { type: "claude", access_token: "t", keep: true },
    });
    expect(applyFieldPatch(meta, { headers: null })).toMatchObject({ ok: true });
    expect(applyFieldPatch(meta, { headers: { A: 1 } })).toEqual({
      ok: false,
      message: "header A must have a text value",
      path: "headers.A",
    });
    expect(applyFieldPatch(meta, { headers: ["A"] })).toMatchObject({ ok: false, path: "headers" });
    expect(applyFieldPatch(meta, { headers: { "Bad Name": "x" } })).toEqual({
      ok: false,
      message: "“Bad Name” is not a valid header name",
      path: "headers.Bad Name",
    });
    expect(applyFieldPatch(meta, { headers: { B: "x\ny" } })).toMatchObject({
      ok: false,
      path: "headers.B",
    });
    expect(applyFieldPatch(meta, { headers: { B: "x\u0000" } })).toEqual({
      ok: false,
      message: "header B cannot contain a NUL character",
      path: "headers.B",
    });
    expect(applyFieldPatch(meta, { headers: { "": "x" } })).toMatchObject({
      ok: false,
      path: "headers",
    });
  });

  it("keeps a masked header value only for the header it belongs to", () => {
    const secret = "Bearer sk-live-0123456789abcd";

    const stored = {
      type: "claude",
      headers: { Authorization: secret, "X-Api-Key": "short", "X-Team": "blue" },
    };

    // The masks GET /credentials shows: the secret's last four characters, a short secret fully hidden.
    const kept = applyFieldPatch(stored, {
      headers: { Authorization: "[redacted]…abcd", "X-Api-Key": "[redacted]", "X-Team": "red" },
    });

    expect(kept).toEqual({
      ok: true,
      metadata: {
        type: "claude",
        headers: { Authorization: secret, "X-Api-Key": "short", "X-Team": "red" },
      },
    });

    // Names match case-insensitively: the mask under another spelling keeps the value, under that spelling.
    expect(applyFieldPatch(stored, { headers: { authorization: "[redacted]…abcd" } })).toEqual({
      ok: true,
      metadata: {
        type: "claude",
        headers: { "X-Api-Key": "short", "X-Team": "blue", authorization: secret },
      },
    });

    // Moved to another header, not the stored value's mask, or a placeholder anywhere in the value: refused.
    for (const [name, value] of [
      ["X-Api-Key", "[redacted]…abcd"],
      ["X-Auth", "[redacted]…abcd"],
      ["Authorization", "[redacted]…zzzz"],
      ["Authorization", "Bearer [redacted]…abcd"],
      ["X-Team", "x[REDACTED]"],
      ["X-Team", "[new secret]"],
    ] as const) {
      expect(applyFieldPatch(stored, { headers: { [name]: value } })).toMatchObject({
        ok: false,
        path: `headers.${name}`,
      });
    }

    // A new value replaces the secret under any spelling; an empty one removes the header under any spelling.
    expect(
      applyFieldPatch(stored, { headers: { AUTHORIZATION: "Bearer new", "x-api-key": "" } }),
    ).toEqual({
      ok: true,
      metadata: { type: "claude", headers: { "X-Team": "blue", AUTHORIZATION: "Bearer new" } },
    });
  });

  it("renames a header's case with its value unchanged", () => {
    const stored = {
      type: "claude",
      headers: { "user-agent": "x", Authorization: "Bearer s-1234abcd" },
    };

    expect(applyFieldPatch(stored, { headers: { "User-Agent": "x" } })).toEqual({
      ok: true,
      metadata: {
        type: "claude",
        headers: { Authorization: "Bearer s-1234abcd", "User-Agent": "x" },
      },
    });
    // A hidden value sent back as its mask keeps the stored secret under the new spelling.
    expect(applyFieldPatch(stored, { headers: { AUTHORIZATION: "[redacted]\u2026abcd" } })).toEqual(
      {
        ok: true,
        metadata: {
          type: "claude",
          headers: { "user-agent": "x", AUTHORIZATION: "Bearer s-1234abcd" },
        },
      },
    );
  });

  it("removes a stored header whose name is not valid", () => {
    const stored = { type: "claude", headers: { "X Foo": "bar", "X-Team": "blue" } };

    expect(applyFieldPatch(stored, { headers: { "X Foo": "" } })).toEqual({
      ok: true,
      metadata: { type: "claude", headers: { "X-Team": "blue" } },
    });
    // Setting a value under an invalid name is still refused.
    expect(applyFieldPatch(stored, { headers: { "X Foo": "baz" } })).toMatchObject({
      ok: false,
      path: "headers.X Foo",
    });
  });

  it("type-checks the routing fields and names the refused one", () => {
    const base = { type: "codex", prefix: "old", websockets: true };

    expect(
      applyFieldPatch(base, {
        prefix: " team ",
        "disable-cooling": true,
        websockets: null,
        model_aliases: [
          { name: " gpt-5 ", alias: "fast", fork: true, extra: 1 },
          { name: "gpt-5-mini", alias: "mini", "force-mapping": true, "display-name": " Mini " },
        ],
      }),
    ).toEqual({
      ok: true,
      metadata: {
        type: "codex",
        prefix: "team",
        disable_cooling: true,
        model_aliases: [
          { name: "gpt-5", alias: "fast", fork: true },
          { name: "gpt-5-mini", alias: "mini", "force-mapping": true, "display-name": "Mini" },
        ],
      },
    });
    expect(applyFieldPatch(base, { prefix: "" })).toEqual({
      ok: true,
      metadata: { type: "codex", websockets: true },
    });
    expect(applyFieldPatch(base, { excluded_models: [] })).toEqual({ ok: true, metadata: base });
    // Outer slashes are dropped like Go's synthesizer.
    expect(applyFieldPatch(base, { prefix: "/team/" })).toEqual({
      ok: true,
      metadata: { ...base, prefix: "team" },
    });

    const refused: ReadonlyArray<readonly [JsonObject, string]> = [
      [{ prefix: "a/b" }, "prefix"],
      [{ prefix: "a b" }, "prefix"],
      [{ prefix: 1 }, "prefix"],
      [{ disable_cooling: "yes" }, "disable_cooling"],
      [{ websockets: 1 }, "websockets"],
      [{ excluded_models: "x" }, "excluded_models"],
      [{ excluded_models: ["a b"] }, "excluded_models"],
      [{ excluded_models: [1] }, "excluded_models"],
      [{ model_aliases: {} }, "model_aliases"],
      [{ model_aliases: [{ name: "a", alias: "" }] }, "model_aliases.0"],
      [{ model_aliases: [{ name: "a", alias: "A" }] }, "model_aliases.0"],
      [
        {
          model_aliases: [
            { name: "a", alias: "x" },
            { name: "b", alias: "X" },
          ],
        },
        "model_aliases.1",
      ],
      [{ model_aliases: [{ name: "a", alias: "x", fork: "yes" }] }, "model_aliases.0"],
      [{ weight: -1.5 }, "weight"],
    ];

    for (const [fields, path] of refused) {
      expect(applyFieldPatch(base, fields), JSON.stringify(fields)).toMatchObject({
        ok: false,
        path,
      });
    }

    // Nested paths into a typed field are malformed requests, not refused values.
    expect(applyFieldPatch(base, { "prefix.x": "a" })).toEqual({
      ok: false,
      message: "prefix does not support nested fields",
    });
    expect(applyFieldPatch(base, { "headers.X-Foo": "a" })).toEqual({
      ok: false,
      message: "headers does not support nested fields",
    });
  });
});

describe("cooldown reset", () => {
  it("clears timers and errors, keeps counters, and keeps terminal 401 failures", () => {
    const blocked = state({
      status: "error",
      statusMessage: "cooling",
      unavailable: true,
      nextRetryAfter: NOW + 1000,
      success: 3,
      failed: 2,
      quota: { ...emptyQuota(), exceeded: true, nextRecoverAt: NOW + 1000 },
      lastError: { message: "limit", retryable: true, httpStatus: 429 },
      modelStates: { "m-a": cooling(NOW + 1000), "  ": cooling(NOW + 1000) },
    });

    const reset = resetCooldownState(blocked, NOW);
    expect(reset.models).toEqual(["m-a"]);
    expect(reset.state).toMatchObject({
      status: "active",
      unavailable: false,
      nextRetryAfter: 0,
      success: 3,
      failed: 2,
      modelStates: {},
      updatedAt: NOW,
    });
    expect(reset.state.lastError).toBeUndefined();
    expect(reset.state.statusMessage).toBeUndefined();
    expect(reset.state.quota).toEqual(emptyQuota());

    const terminal = resetCooldownState(
      state({
        status: "error",
        lastError: { message: "unauthorized", retryable: false, httpStatus: 401 },
      }),
      NOW,
    );

    expect(terminal.state).toMatchObject({ status: "error", lastError: { httpStatus: 401 } });
  });
});

describe("stored keys win over typed ones (group writes)", () => {
  it("drops a typed copy of a stored key in any group, and a later typed copy of a typed key", () => {
    const identities = [["a", "b", "c"], ["a"], ["d", "d"]];
    const typed = [[true, false, true], [false], [true, true]];

    expect(typedDuplicates(identities, typed)).toEqual([
      [true, false, false],
      [false],
      [false, true],
    ]);
  });

  it("never drops a key that is not typed, even a duplicate", () => {
    expect(typedDuplicates([["a"], ["a"]], [[false], [false]])).toEqual([[false], [false]]);
  });

  it("removes the marked keys from a copy and leaves the document alone when nothing is marked", () => {
    const document: JsonObject = {
      "api-keys": {
        gemini: [
          { keys: [{ "api-key": "x" }, { "api-key": "y" }] },
          { keys: [{ "api-key": "z" }] },
        ],
      },
    };

    expect(withoutKeys(document, "gemini", [[false, false], [false]])).toBe(document);
    const out = withoutKeys(document, "gemini", [[true, false], [true]]);

    expect(out).toEqual({
      "api-keys": { gemini: [{ keys: [{ "api-key": "y" }] }, { keys: [] }] },
    });
    expect(document["api-keys"]).toEqual({
      gemini: [{ keys: [{ "api-key": "x" }, { "api-key": "y" }] }, { keys: [{ "api-key": "z" }] }],
    });
  });
});
