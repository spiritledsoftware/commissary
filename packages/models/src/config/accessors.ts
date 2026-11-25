/**
 * Derived runtime settings with the fallback rules of the Go code.
 *
 * Go source: sdk/cliproxy/service_config.go (session affinity TTL), internal/config/config_types.go
 * (CodexConfig.StreamBootstrapTimeoutDuration), sdk/api/handlers/openai/openai_videos_handlers.go
 * (videoAuthBindingTTL), internal/runtime/executor/codex_openai_images.go (resolveGPTImage2BaseModel).
 */
import { isTosPauseOff } from "@commissary/contract/settings";
import type { Config } from "./schema.ts";

const UNITS = new Map<string, number>([
  ["ns", 1e-6],
  ["us", 1e-3],
  ["µs", 1e-3],
  ["μs", 1e-3],
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
]);

/** Go `time.ParseDuration` in milliseconds (`1h30m`, `1.5s`, `300ms`, `0`); `undefined` when invalid. */
export const parseGoDuration = (input: string): number | undefined => {
  const text = input.trim();
  const match = /^([+-]?)((?:\d+\.?\d*|\.\d+)[a-zµμ]+)+$/.exec(text);

  if (text === "0" || text === "+0" || text === "-0") return 0;

  if (match === null) return undefined;
  const sign = match[1] === "-" ? -1 : 1;
  let total = 0;

  for (const part of text.replace(/^[+-]/, "").matchAll(/(\d+\.?\d*|\.\d+)([a-zµμ]+)/g)) {
    const [, amount = "", unitName = ""] = part;
    const unit = UNITS.get(unitName);

    if (unit === undefined) return undefined;
    total += Number.parseFloat(amount) * unit;
  }

  return sign * total;
};

const DEFAULT_SESSION_AFFINITY_TTL_MS = 3_600_000;

const DEFAULT_VIDEO_AUTH_CACHE_TTL_MS = 3 * 3_600_000;

const DEFAULT_GPT_IMAGE_BASE_MODEL = "gpt-5.4-mini";

/** `routing.session-affinity-ttl`: invalid or non-positive -> 1h, values below 1s are raised to 1s. */
export const sessionAffinityTtlMs = (config: Config): number => {
  const parsed = parseGoDuration(config.routing["session-affinity-ttl"]);

  if (parsed === undefined || parsed <= 0) return DEFAULT_SESSION_AFFINITY_TTL_MS;

  return Math.max(parsed, 1000);
};

/** `upstream.codex.stream-bootstrap-timeout`: 0 means unlimited (also `none`, `unlimited`, `off`, ...). */
export const codexStreamBootstrapTimeoutMs = (config: Config): number => {
  const raw = config.upstream.codex["stream-bootstrap-timeout"].trim();

  if (["", "0", "none", "unlimited", "disabled", "off", "never"].includes(raw.toLowerCase()))
    return 0;
  const duration = parseGoDuration(raw);

  if (duration !== undefined && duration >= 0) return duration;

  if (/^\d+$/.test(raw)) return Number(raw) * 1000;

  return 0;
};

/** `multimedia.video-result-auth-cache-ttl`: empty, invalid or non-positive -> 3h. */
export const videoResultAuthCacheTtlMs = (config: Config): number => {
  const parsed = parseGoDuration(config.multimedia["video-result-auth-cache-ttl"]);

  return parsed !== undefined && parsed > 0 ? parsed : DEFAULT_VIDEO_AUTH_CACHE_TTL_MS;
};

/**
 * `antigravityTOSPauseWindow` (CLIProxyAPI e96d4c48): the pool-wide pause after a TOS_VIOLATION, in ms; `0` (off) when
 * empty, an off keyword, invalid or not positive.
 */
export const antigravityTosPauseWindowMs = (config: Config): number => {
  const raw = config.oauth.providers.antigravity["tos-pause-window"];

  if (isTosPauseOff(raw)) return 0;
  const parsed = parseGoDuration(raw.trim());

  return parsed !== undefined && parsed > 0 ? parsed : 0;
};

/** `multimedia.gpt-image-2-base-model`: must start with `gpt-` (case-insensitive), else `gpt-5.4-mini`. */
export const gptImage2BaseModel = (config: Config): string => {
  const model = config.multimedia["gpt-image-2-base-model"].trim();

  return model.toLowerCase().startsWith("gpt-") ? model : DEFAULT_GPT_IMAGE_BASE_MODEL;
};
