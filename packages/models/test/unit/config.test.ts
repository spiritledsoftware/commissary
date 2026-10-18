import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { type ErrorCode, YAMLParseError } from "yaml";
import {
  codexStreamBootstrapTimeoutMs,
  gptImage2BaseModel,
  parseGoDuration,
  sessionAffinityTtlMs,
  videoResultAuthCacheTtlMs,
} from "../../src/config/accessors.ts";
import { decodeConfig, encodeConfig, parseConfigYaml } from "../../src/config/codec.ts";
import { ConfigValidationError } from "../../src/config/errors.ts";
import { yamlMessage } from "../../src/config/yaml-message.ts";
import { Config } from "../../src/config/schema.ts";
import { applyPayloadRules } from "../../src/config/payload/index.ts";
import { get } from "@commissary/json";
import { assertImportKeeps } from "../support/config-entries.ts";

// Every document these tests decode is also imported as config entries: the import must give the same config
// (modulo entry ids and the not-applied keys it drops).
const parse = (yaml: string) => parseConfigYaml(yaml).pipe(Effect.tap(assertImportKeeps));

const failure = <A>(effect: Effect.Effect<A, ConfigValidationError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

// A v8 document using the keys that apply on Workers.
const V8_YAML = `
config-version: 8
models:
  catalog: "https://example.com/models.json"
access:
  api-keys: ["k1", " k2 ", ""]
  admin-emails: ["Admin@Example.com"]
routing:
  strategy: "wrr"
  session-affinity: true
  session-affinity-ttl: "30m"
  force-model-prefix: true
  retry:
    request-retry: 3
    max-retry-credentials: -2
    max-retry-interval: 30
  cooldown:
    transient-error-cooldown-seconds: -1
requests:
  passthrough-headers: true
  streaming:
    keepalive-seconds: 15
  payload:
    default:
      - models: [{ name: "gpt-*", protocol: openai }]
        params: { "reasoning.effort": "high" }
    override-raw:
      - models: [{ name: "*" }]
        params: { tools: '[{"type":"web_search"}]' }
      - models: [{ name: "*" }]
        params: { broken: "{not json" }
    filter:
      - models: [{ name: "claude-*", "from-protocol": claude }]
        params: ["metadata.user_id"]
client:
  codex:
    enable-apply-patch: true
upstream:
  codex:
    stream-bootstrap-timeout: "20s"
  claude:
    header-defaults:
      user-agent: "  claude-cli/2.1.280  "
api-keys:
  claude:
    - name: anthropic
      base-url: " https://api.anthropic.com "
      prefix: "/a/b/"
      headers: { X-Trace: " yes ", Empty: "  " }
      excluded-models: ["Claude-3-*", "claude-3-*", " "]
      keys:
        - api-key: " sk-ant-1 "
          weight: 5
        - api-key: sk-ant-2
          priority: 10
          cloak: { mode: " always ", sensitive-words: [" a ", ""] }
  codex:
    - name: no-url
      keys: [{ api-key: x }]
    - name: codex-1
      base-url: https://codex.example.com
      keys: [{ api-key: c1, websockets: true }]
  openai-compatibility:
    - name: kimi
      base-url: https://kimi.example.com/v1
      prefix: kimi
      models: [{ name: kimi-k2, alias: k2, use-max-completion-tokens: true }]
      keys: [{ api-key: kk, weight: 2 }]
oauth:
  model-alias:
    Claude:
      - { name: claude-opus-4, alias: opus }
      - { name: claude-opus-4, alias: OPUS }
      - { name: same, alias: SAME }
  settings:
    codex:
      - { name: gpt-5, max-context-length: 1 }
      - { name: gpt-5, max-context-length: 2 }
  excluded-models:
    Gemini: ["Gemini-2.5-*", "gemini-2.5-*"]
    empty: []
  request-scoped-errors:
    claude:
      - { status: 400, match: [" too long "], action: " Stop " }
      - { status: 0, match: [x], action: stop }
multimedia:
  disable-image-generation: "chat"
observability:
  usage:
    redis-usage-queue-retention-seconds: 99999
`;

describe("config schema and normalisation", () => {
  it.effect("an empty document decodes to the documented defaults", () =>
    Effect.gen(function* () {
      const config = yield* parse("");
      assert.strictEqual(config["config-version"], 8);
      assert.strictEqual(config.routing.strategy, "round-robin");
      assert.strictEqual(config.routing["session-affinity-ttl"], "1h");
      assert.strictEqual(config.routing["session-affinity-subagents"], true);
      assert.strictEqual(config.routing.retry["request-retry"], 0);
      assert.strictEqual(config.multimedia["disable-image-generation"], false);
      assert.strictEqual(config.multimedia["video-result-auth-cache-ttl"], "3h");
      assert.strictEqual(config.observability.usage["redis-usage-queue-retention-seconds"], 60);
      assert.strictEqual(config.upstream.codex["stream-bootstrap-timeout"], "0");
      assert.deepStrictEqual(config.requests.payload.default, []);
      assert.deepStrictEqual(config["api-keys"].claude, []);
      assert.isUndefined(config.oauth.providers.antigravity["signature-cache-enabled"]);
    }),
  );

  it.effect("decodes and normalises a v8 document", () =>
    Effect.gen(function* () {
      const config = yield* parse(V8_YAML);
      assert.deepStrictEqual(config.access["api-keys"], ["k1", "k2"]);
      assert.deepStrictEqual(config.access["admin-emails"], ["admin@example.com"]);
      assert.strictEqual(config.routing.strategy, "weighted-round-robin");
      assert.strictEqual(config.routing["session-affinity"], true);
      assert.strictEqual(config.routing.retry["max-retry-credentials"], 0);
      assert.strictEqual(config.routing.cooldown["transient-error-cooldown-seconds"], -1);
      assert.strictEqual(config.client.codex["enable-apply-patch"], true);
      assert.strictEqual(config.upstream.codex["stream-bootstrap-timeout"], "20s");
      assert.strictEqual(
        config.upstream.claude["header-defaults"]["user-agent"],
        "claude-cli/2.1.280",
      );
      assert.strictEqual(config.multimedia["disable-image-generation"], "chat");
      assert.strictEqual(config.observability.usage["redis-usage-queue-retention-seconds"], 3600);

      const [anthropic] = config["api-keys"].claude;
      assert.strictEqual(anthropic?.["base-url"], "https://api.anthropic.com");
      assert.strictEqual(anthropic?.prefix, "");
      assert.deepStrictEqual(anthropic?.headers, { "X-Trace": "yes" });
      assert.deepStrictEqual(anthropic?.["excluded-models"], ["claude-3-*"]);
      assert.strictEqual(anthropic?.keys[0]?.["api-key"], "sk-ant-1");
      assert.strictEqual(anthropic?.keys[0]?.weight, 5);
      assert.strictEqual(anthropic?.keys[1]?.priority, 10);
      assert.deepStrictEqual(anthropic?.keys[1]?.cloak, {
        mode: "always",
        "sensitive-words": ["a"],
      });

      // codex groups without base-url are dropped (config_normalization.go sanitizeCodexKeyEntries)
      assert.deepStrictEqual(
        config["api-keys"].codex.map((group) => group.name),
        ["codex-1"],
      );
      assert.strictEqual(
        config["api-keys"]["openai-compatibility"][0]?.models?.[0]?.["use-max-completion-tokens"],
        true,
      );

      assert.deepStrictEqual(config.oauth["model-alias"], {
        claude: [{ name: "claude-opus-4", alias: "opus" }],
      });
      assert.deepStrictEqual(config.oauth.settings, {
        codex: [{ name: "gpt-5", alias: "", "max-context-length": 2 }],
      });
      assert.deepStrictEqual(config.oauth["excluded-models"], { gemini: ["gemini-2.5-*"] });
      assert.deepStrictEqual(config.oauth["request-scoped-errors"], {
        claude: [{ status: 400, match: ["too long"], "match-regexr": [], action: "stop" }],
      });
    }),
  );

  it.effect("drops raw payload rules whose params are not valid JSON", () =>
    Effect.gen(function* () {
      const config = yield* parse(V8_YAML);
      assert.strictEqual(config.requests.payload["override-raw"].length, 1);

      const out = applyPayloadRules(
        { requests: config.requests, multimedia: config.multimedia },
        { model: "gpt-5", protocol: "openai" },
        {},
      );

      assert.deepStrictEqual(get(out.payload, "reasoning.effort"), "high");
      assert.deepStrictEqual(get(out.payload, "tools"), [{ type: "web_search" }]);
    }),
  );

  it.effect("accepts the legacy flat layout and maps it onto v8", () =>
    Effect.gen(function* () {
      const legacy = yield* parse(`
api-keys: ["legacy-key"]
force-model-prefix: true
request-retry: 4
max-retry-credentials: 2
disable-cooling: true
proxy-url: "socks5://ignored"
passthrough-headers: true
streaming: { keepalive-seconds: 9 }
debug: true
disable-image-generation: on
codex: { response-steering: true, model-level-cooling: true }
claude: { model-level-cooling: true }
claude-code: { disable-cloaking-model-list: true }
claude-header-defaults: { user-agent: "ua" }
xai: { inject-x-search: true }
quota-exceeded: { antigravity-credits: true }
payload:
  override:
    - models: [{ name: "*" }]
      params: { temperature: null }
oauth-excluded-models: { gemini-cli: ["a"] }
claude-api-key:
  - api-key: sk-1
    base-url: https://claude.example.com
    prefix: p
    models: [{ name: m, alias: a }]
    cloak: { mode: always }
  - api-key: sk-2
gemini-api-key:
  - api-key: g1
    headers: { X: "1" }
  - api-key: g1
    headers: { X: "1" }
codex-api-key:
  - api-key: c1
    base-url: https://codex.example.com
openai-compatibility:
  - name: compat
    base-url: https://compat.example.com/v1
    api-key-entries: [{ api-key: ck }]
`);

      const v8 = yield* parse(`
access: { api-keys: ["legacy-key"] }
routing:
  force-model-prefix: true
  retry: { request-retry: 4, max-retry-credentials: 2 }
  cooldown: { disable-cooling: true }
requests:
  proxy-url: "socks5://ignored"
  passthrough-headers: true
  streaming: { keepalive-seconds: 9 }
  payload:
    override:
      - models: [{ name: "*" }]
        params: { temperature: null }
observability: { logs: { debug: true } }
multimedia: { disable-image-generation: true }
upstream:
  codex: { response-steering: true, model-level-cooling: true }
  claude:
    model-level-cooling: true
    disable-cloaking-model-list: true
    header-defaults: { user-agent: "ua" }
  xai: { inject-x-search: true }
oauth:
  excluded-models: { gemini-cli: ["a"] }
  providers: { antigravity: { antigravity-credits: true } }
api-keys:
  claude:
    - name: claude-1
      base-url: https://claude.example.com
      prefix: p
      models: [{ name: m, alias: a }]
      keys: [{ api-key: sk-1, cloak: { mode: always } }]
    - name: claude-2
      keys: [{ api-key: sk-2 }]
  gemini:
    - name: gemini-1
      headers: { X: "1" }
      keys: [{ api-key: g1 }]
    - name: gemini-2
      headers: { X: "1" }
      keys: [{ api-key: g1 }]
  codex:
    - name: codex-1
      base-url: https://codex.example.com
      keys: [{ api-key: c1 }]
  openai-compatibility:
    - name: compat
      base-url: https://compat.example.com/v1
      keys: [{ api-key: ck }]
`);

      assert.deepStrictEqual(encodeConfig(legacy), encodeConfig(v8));
      // null is a real value inside payload rules
      assert.deepStrictEqual(legacy.requests.payload.override[0]?.params, { temperature: null });
    }),
  );

  it.effect("the v8 value wins over a legacy spelling of the same key, even when false", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
routing: { force-model-prefix: false }
force-model-prefix: true
codex: { response-steering: true }
upstream: { codex: { response-steering: false } }
`);

      assert.strictEqual(config.routing["force-model-prefix"], false);
      assert.strictEqual(config.upstream.codex["response-steering"], false);
    }),
  );

  it.effect("historical v8 spellings map to their canonical paths", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
oauth:
  providers:
    codex: { optimize-multi-agent-v2: true, disable-codex-cloaking: true }
    claude: { model-level-cooling: true, header-defaults: { os: "Linux" } }
    xai: { inject-x-search: true }
`);

      assert.strictEqual(config.client.codex["optimize-multi-agent-v2"], true);
      assert.strictEqual(config.upstream.codex["disable-codex-cloaking"], true);
      assert.strictEqual(config.upstream.claude["model-level-cooling"], true);
      assert.strictEqual(config.upstream.claude["header-defaults"].os, "Linux");
      assert.strictEqual(config.upstream.xai["inject-x-search"], true);
    }),
  );

  it.effect("strips null values outside payload rules", () =>
    Effect.gen(function* () {
      const config = yield* parse(`
routing:
  strategy:
  retry:
requests:
  proxy-url:
api-keys:
  gemini:
    - name: g
      prefix: null
      keys: [{ api-key: k, weight: null }]
`);

      assert.strictEqual(config.routing.strategy, "round-robin");
      assert.isUndefined(config["api-keys"].gemini[0]?.prefix);
      assert.isUndefined(config["api-keys"].gemini[0]?.keys[0]?.weight);
    }),
  );

  it.effect("an unknown routing strategy falls back to round-robin like Go", () =>
    Effect.gen(function* () {
      const config = yield* parse("routing: { strategy: random }");
      assert.strictEqual(config.routing.strategy, "round-robin");
    }),
  );

  it.effect("accepts JSON text and JSON-shaped input", () =>
    Effect.gen(function* () {
      const fromJson = yield* parse('{"routing":{"strategy":"fill-first"}}');
      assert.strictEqual(fromJson.routing.strategy, "fill-first");
      const fromValue = yield* decodeConfig({ routing: { strategy: "ff" } });
      assert.strictEqual(fromValue.routing.strategy, "fill-first");
    }),
  );

  it.effect.each([
    { name: "non-mapping", yaml: "- a\n- b\n", message: "config must be a mapping" },
    { name: "wrong version", yaml: "config-version: 7\n", message: "unsupported config-version" },
    { name: "invalid YAML", yaml: "a: [1, 2\n", message: "invalid YAML" },
    { name: "duplicate keys", yaml: "routing: {}\nrouting: {}\n", message: "invalid YAML" },
    {
      name: "unknown provider",
      yaml: "api-keys:\n  nope: []\n",
      message: "api-keys.nope: unknown provider",
    },
    {
      name: "groups must be lists",
      yaml: "api-keys:\n  claude: {}\n",
      message: "api-keys.claude must be a list",
    },
    {
      name: "keys must be a list",
      yaml: "api-keys:\n  claude:\n    - name: x\n",
      message: "keys must be a list",
    },
    {
      name: "base-url at key level",
      yaml: "api-keys:\n  claude:\n    - keys: [{ api-key: a, base-url: 'https://x' }]\n",
      message: "base-url belongs to the group",
    },
    {
      name: "unsupported group field",
      yaml: "api-keys:\n  claude:\n    - bogus: 1\n      keys: []\n",
      message: "unsupported group field bogus",
    },
    {
      name: "weight above the maximum",
      yaml: "api-keys:\n  claude:\n    - keys: [{ api-key: a, weight: 1000001 }]\n",
      message: "1000000",
    },
    {
      name: "bad image mode",
      yaml: "multimedia: { disable-image-generation: sometimes }\n",
      message: "invalid multimedia.disable-image-generation",
    },
    {
      name: "wrong type",
      yaml: "routing: { retry: { request-retry: many } }\n",
      message: "request-retry",
    },
  ])("rejects $name", ({ yaml, message }) =>
    Effect.gen(function* () {
      const text = yield* failure(parse(yaml));
      assert.include(text, message);
    }),
  );

  it.effect("never quotes the document in an error (value-free messages)", () =>
    Effect.gen(function* () {
      const secret = "sk-VALUE-FREE-9182";

      for (const yaml of [
        `multimedia: { disable-image-generation: ${secret} }\n`,
        `routing: { retry: { request-retry: ${secret} } }\n`,
        `access:\n  api-keys: ${secret}\n`,
        `access:\n  api-keys: [${secret}\n`,
        `access:\n  api-keys: ["${secret}\\q"]\n`,
        `a: &x 1\nb: *${secret}\n`,
      ]) {
        const error = yield* Effect.flip(parse(yaml));

        assert.notInclude(error.message, secret, yaml);
        assert.notInclude(error.message, "got", yaml);
      }

      const syntax = yield* Effect.flip(parse(`access:\n  api-keys: [${secret}\n`));

      assert.isNumber(syntax.line);
      assert.isNumber(syntax.column);

      const typed = yield* Effect.flip(parse("routing: { retry: { request-retry: many } }\n"));

      assert.strictEqual(typed.path, "routing.retry.request-retry");
      assert.match(typed.message, /^Expected .+ at routing\.retry\.request-retry$/);
    }),
  );

  it("gives YAML errors a fixed sentence per error code, never the library's text", () => {
    const quoting = new YAMLParseError(
      [0, 1],
      "BAD_DQ_ESCAPE",
      "Invalid escape sequence \\q in sk-QUOTED-1",
    );

    assert.strictEqual(yamlMessage(quoting), "invalid escape sequence in a double-quoted string");
    assert.strictEqual(
      yamlMessage(
        new YAMLParseError([0, 1], "DUPLICATE_KEY", "Map keys must be unique sk-QUOTED-1"),
      ),
      "map keys must be unique",
    );
    // SAFETY: a code a later `yaml` release could add, outside the typed union on purpose.
    const unknown = new YAMLParseError([0, 1], "NEW_CODE" as ErrorCode, "sk-QUOTED-1");

    assert.strictEqual(yamlMessage(unknown), "invalid syntax");
  });

  it.effect("the defaults round-trip through the encoded document", () =>
    Effect.gen(function* () {
      const config = yield* parse("");
      assert.deepStrictEqual(Schema.decodeUnknownSync(Config)(encodeConfig(config)), config);
    }),
  );

  it.effect("keeps the Claude cloak level, global and per key, through the encoded document", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* parse("")).upstream.claude["cloak-level"], "full");

      const config = yield* parse(`
upstream: { claude: { cloak-level: minimal } }
api-keys:
  claude:
    - keys: [{ api-key: sk-1, cloak: { mode: always, level: " minimal " } }]
`);

      assert.strictEqual(config.upstream.claude["cloak-level"], "minimal");
      assert.deepStrictEqual(config["api-keys"].claude[0]?.keys[0]?.cloak, {
        mode: "always",
        level: "minimal",
      });
      assert.deepStrictEqual(Schema.decodeUnknownSync(Config)(encodeConfig(config)), config);

      const unknown = yield* Effect.flip(parse("upstream: { claude: { cloak-level: off } }"));
      assert.isDefined(unknown);
    }),
  );
});

describe("derived settings", () => {
  it("parseGoDuration follows time.ParseDuration", () => {
    assert.strictEqual(parseGoDuration("1h30m"), 5_400_000);
    assert.strictEqual(parseGoDuration("1.5s"), 1500);
    assert.strictEqual(parseGoDuration("300ms"), 300);
    assert.strictEqual(parseGoDuration("-2m"), -120_000);
    assert.strictEqual(parseGoDuration("0"), 0);
    assert.strictEqual(parseGoDuration(" 10s "), 10_000);
    assert.isUndefined(parseGoDuration("10"));
    assert.isUndefined(parseGoDuration("abc"));
    assert.isUndefined(parseGoDuration(""));
    assert.isUndefined(parseGoDuration("5x"));
  });

  it.effect("applies the Go fallbacks", () =>
    Effect.gen(function* () {
      const defaults = yield* parse("");
      assert.strictEqual(sessionAffinityTtlMs(defaults), 3_600_000);
      assert.strictEqual(codexStreamBootstrapTimeoutMs(defaults), 0);
      assert.strictEqual(videoResultAuthCacheTtlMs(defaults), 10_800_000);
      assert.strictEqual(gptImage2BaseModel(defaults), "gpt-5.4-mini");

      const custom = yield* parse(`
routing: { session-affinity-ttl: "500ms" }
upstream: { codex: { stream-bootstrap-timeout: "15" } }
multimedia: { video-result-auth-cache-ttl: "30m", gpt-image-2-base-model: " GPT-6 " }
`);

      assert.strictEqual(sessionAffinityTtlMs(custom), 1000);
      assert.strictEqual(codexStreamBootstrapTimeoutMs(custom), 15_000);
      assert.strictEqual(videoResultAuthCacheTtlMs(custom), 1_800_000);
      assert.strictEqual(gptImage2BaseModel(custom), "GPT-6");

      const invalid = yield* parse(`
routing: { session-affinity-ttl: "soon" }
upstream: { codex: { stream-bootstrap-timeout: "Unlimited" } }
multimedia: { video-result-auth-cache-ttl: "-1h", gpt-image-2-base-model: "claude" }
`);

      assert.strictEqual(sessionAffinityTtlMs(invalid), 3_600_000);
      assert.strictEqual(codexStreamBootstrapTimeoutMs(invalid), 0);
      assert.strictEqual(videoResultAuthCacheTtlMs(invalid), 10_800_000);
      assert.strictEqual(gptImage2BaseModel(invalid), "gpt-5.4-mini");
    }),
  );
});
