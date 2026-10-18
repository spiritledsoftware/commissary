/**
 * Config schema: the v8 YAML/JSON layout, restricted to the keys that apply on Workers.
 *
 * Go source: internal/config/config_types.go, sdk_config.go, config_v8.go (layout), docs/research/
 * config-management-oauth.md §1. Keys that cannot exist on Workers (listener/TLS/mDNS, filesystem logging, pprof,
 * plugins, Home mode, WebRTC relay, outbound proxies, AI Studio relay) are not modelled and are dropped when a
 * document is decoded.
 *
 * The decoded value (`Config`) always has every section and every defaulted field present, so consumers never
 * handle missing values. Tri-state Go pointer fields (`*bool`, `*int`) stay optional. Keys keep their kebab-case YAML
 * spelling so the stored document is the same as the YAML/management representation.
 */
import { Effect, Schema } from "effect";
import { PayloadConfig } from "./payload/schema.ts";
import {
  PROVIDER_KEY_FAMILIES,
  ProviderKeyEntry,
  ProviderKeyFamily,
  ProviderKeyGroup,
  CloakConfig,
  ModelEntry,
  OpenAICompatGroup,
  OpenAICompatKey,
  isOpenCodeProtocol,
  OPENCODE_PROTOCOLS,
  OpenCodeProtocol,
  RequestScopedErrorRule,
  ThinkingSupport,
} from "@commissary/contract/provider-keys";
import { DisableImageGeneration, RoutingStrategy } from "@commissary/contract/settings";

// --- field helpers -------------------------------------------------------------------------------------------------

const flag = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const text = (value = "") =>
  Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const whole = (value: number) =>
  Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));

const section = <const Fields extends Schema.Struct.Fields>(fields: Fields) =>
  // SAFETY: `{}` is valid because every field of a section carries a decoding default.
  Schema.Struct(fields).pipe(Schema.withDecodingDefaultKey(Effect.succeed({} as never)));

const list = <S extends Schema.Constraint>(item: S) =>
  // SAFETY: an empty array is a valid value of every Schema.Array.
  Schema.Array(item).pipe(Schema.withDecodingDefaultKey(Effect.succeed([] as never)));

const optional = Schema.optionalKey;

const Strings = Schema.Array(Schema.String);

// --- shared pieces -------------------------------------------------------------------------------------------------

// The provider-key group schemas are browser-safe and shared with the control panel: they live in the management contract.
export {
  PROVIDER_KEY_FAMILIES,
  ProviderKeyEntry,
  ProviderKeyFamily,
  ProviderKeyGroup,
  CloakConfig,
  ModelEntry,
  OpenAICompatGroup,
  OpenAICompatKey,
  isOpenCodeProtocol,
  OPENCODE_PROTOCOLS,
  OpenCodeProtocol,
  RequestScopedErrorRule,
  ThinkingSupport,
};

export const OAuthModelAlias = Schema.Struct({
  name: Schema.String,
  alias: Schema.String,
  fork: optional(Schema.Boolean),
  "display-name": optional(Schema.String),
  "force-mapping": optional(Schema.Boolean),
});

export type OAuthModelAlias = typeof OAuthModelAlias.Type;

export const OAuthModelSetting = Schema.Struct({
  name: Schema.String,
  alias: optional(Schema.String),
  "max-context-length": optional(Schema.Int),
});

export type OAuthModelSetting = typeof OAuthModelSetting.Type;

// --- sections ------------------------------------------------------------------------------------------------------

// `routing.strategy` and `multimedia.disable-image-generation` are shared with the Settings page
// (@commissary/contract/settings).
export { DisableImageGeneration, RoutingStrategy };

const routing = section({
  strategy: RoutingStrategy.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("round-robin" as const)),
  ),
  "session-affinity": flag(false),
  /** Go duration string (`30m`, `1h`); invalid or non-positive values mean 1h (see accessors.ts). */
  "session-affinity-ttl": text("1h"),
  "session-affinity-subagents": flag(true),
  "force-model-prefix": flag(false),
  retry: section({
    "request-retry": whole(0),
    /** 0 = try every credential in a round. */
    "max-retry-credentials": whole(0),
    /** Seconds; non-positive never waits for a cooldown. */
    "max-retry-interval": whole(0),
  }),
  cooldown: section({
    "disable-cooling": flag(false),
    /** Persist cooldown state (in the ControlPlane DO on Workers). */
    "save-cooldown-status": flag(false),
    /** 0 = legacy 60 s, negative disables. */
    "transient-error-cooldown-seconds": whole(0),
  }),
});

const requests = section({
  /** Accepted for compatibility; outbound proxies are not available on Workers and the value is ignored. */
  "proxy-url": text(),
  "passthrough-headers": flag(false),
  "nonstream-keepalive-interval": whole(0),
  streaming: section({
    "keepalive-seconds": whole(0),
    "bootstrap-retries": whole(0),
  }),
  // SAFETY: `{}` is valid because every field of PayloadConfig carries a decoding default.
  payload: PayloadConfig.pipe(Schema.withDecodingDefaultKey(Effect.succeed({} as never))),
});

const claudeHeaderDefaults = section({
  "user-agent": text(),
  "package-version": text(),
  "runtime-version": text(),
  os: text(),
  arch: text(),
  timeout: text(),
  timezone: text(),
  "stabilize-device-profile": optional(Schema.Boolean),
});

const upstream = section({
  codex: section({
    "response-steering": flag(false),
    "disable-codex-cloaking": flag(false),
    "stream-bootstrap-buffering": flag(false),
    /** Go duration or integer seconds; `0`/`none`/`unlimited`/... mean unlimited. */
    "stream-bootstrap-timeout": text("0"),
    "orphan-delegation-compatibility": flag(false),
    "model-level-cooling": flag(false),
  }),
  claude: section({
    "model-level-cooling": flag(false),
    "disable-claude-cloak-mode": flag(false),
    "disable-cloaking-model-list": flag(false),
    "header-defaults": claudeHeaderDefaults,
  }),
  xai: section({
    "inject-x-search": flag(false),
  }),
});

const providerKeys = section({
  gemini: list(ProviderKeyGroup),
  interactions: list(ProviderKeyGroup),
  vertex: list(ProviderKeyGroup),
  codex: list(ProviderKeyGroup),
  claude: list(ProviderKeyGroup),
  xai: list(ProviderKeyGroup),
  meta: list(ProviderKeyGroup),
  "opencode-zen": list(ProviderKeyGroup),
  "opencode-go": list(ProviderKeyGroup),
  typesafe: list(ProviderKeyGroup),
  subq: list(ProviderKeyGroup),
  "openai-compatibility": list(OpenAICompatGroup),
});

const oauth = section({
  "auth-auto-refresh-workers": whole(0),
  /** channel -> aliases */
  "model-alias": Schema.Record(Schema.String, Schema.Array(OAuthModelAlias)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  settings: Schema.Record(Schema.String, Schema.Array(OAuthModelSetting)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  "excluded-models": Schema.Record(Schema.String, Strings).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  "request-scoped-errors": Schema.Record(Schema.String, Schema.Array(RequestScopedErrorRule)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
  providers: section({
    codex: section({
      "header-defaults": section({
        "user-agent": text(),
        "beta-features": text(),
      }),
    }),
    antigravity: section({
      "sensitive-words": list(Schema.String),
      "antigravity-credits": flag(false),
      /** Go pointer: missing means enabled. */
      "signature-cache-enabled": optional(Schema.Boolean),
      "signature-bypass-strict": optional(Schema.Boolean),
    }),
    devin: section({
      "sensitive-words": list(Schema.String),
    }),
  }),
});

const multimedia = section({
  "disable-image-generation": DisableImageGeneration.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  "gpt-image-2-base-model": text(),
  "video-result-auth-cache-ttl": text("3h"),
});

const observability = section({
  logs: section({
    debug: flag(false),
    "request-log": flag(false),
  }),
  usage: section({
    "usage-statistics-enabled": flag(false),
    /** Clamped to 1..3600 (<= 0 means 60). */
    "redis-usage-queue-retention-seconds": whole(60),
  }),
});

export const Config = Schema.Struct({
  "config-version": Schema.Literal(8).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8 as const)),
  ),
  models: section({
    /**
     * Source of the models.dev catalog: an http(s) URL; empty = the official source (`https://models.dev/api.json`).
     * File paths are not usable on Workers.
     */
    catalog: text(),
    /** No effect (accepted so existing documents import unchanged): the Codex client catalog is bundled. */
    "codex-catalog": text(),
    /** No effect (accepted so existing documents import unchanged): Devin models are catalog additions. */
    "devin-catalog": text(),
  }),
  access: section({
    /** Legacy client API keys (migration only; Cloudflare Access is the real authentication). */
    "api-keys": list(Schema.String),
    /** Access user emails allowed to call the management API. */
    "admin-emails": list(Schema.String),
    /** Access service token client ids (`common_name`) allowed to call the management API. */
    "admin-service-tokens": list(Schema.String),
  }),
  routing,
  requests,
  client: section({
    codex: section({
      "enable-apply-patch": flag(false),
      "optimize-multi-agent-v2": flag(false),
    }),
  }),
  upstream,
  "api-keys": providerKeys,
  oauth,
  multimedia,
  observability,
});

export type Config = typeof Config.Type;

export type ConfigEncoded = typeof Config.Encoded;
