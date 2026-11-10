/**
 * Claude subscription usage (`GET https://api.anthropic.com/api/oauth/usage`) and plan
 * (`GET https://api.anthropic.com/api/oauth/profile`) as quota windows.
 *
 * Upstream panel source: .repos/Cli-Proxy-API-Management-Center/src/features/quota/providers/claude/data.ts
 * (`buildClaudeQuotaWindows`, `resolveClaudePlanType`), src/utils/quota/constants.ts (`CLAUDE_REQUEST_HEADERS`,
 * `CLAUDE_USAGE_WINDOW_KEYS`), src/utils/quota/resetInstants.ts (`claudePeriodHours`).
 *
 * Differences from the panel: window ids are the payload keys (`five_hour`, `seven_day`, …) and labels are English;
 * unknown top-level windows (`{utilization, resets_at}` objects) are listed too; dollar-denominated pools
 * (`limit_dollars`/`used_dollars`/`remaining_dollars`) are skipped; `limits[]` entries of kind `weekly_scoped` become
 * `seven_day_<model>` windows (the panel only reads the Fable one). The plan is the panel's `plan_*` key without the
 * prefix (`team`, `max`, `pro`, `free`).
 */
import type { Json, JsonObject } from "@commissary/json";
import type { QuotaWindow } from "@commissary/contract/credentials";
import {
  FIVE_HOURS,
  WEEK,
  isoInstant,
  num,
  quotaWindow,
  record,
  slug,
  str,
  uniqueIds,
} from "./window.ts";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

/** `CLAUDE_REQUEST_HEADERS` without the bearer token. */
export const CLAUDE_HEADERS = {
  "user-agent": "claude-cli/2.1.321 (external, cli)",
  "content-type": "application/json",
  "anthropic-beta": "oauth-2025-04-20",
} as const;

/** Known keys in the panel's order, with their labels. */
const KNOWN_WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["seven_day_oauth_apps", "Weekly OAuth apps"],
  ["seven_day_opus", "Weekly Opus"],
  ["seven_day_sonnet", "Weekly Sonnet"],
  ["seven_day_cowork", "Weekly Cowork"],
  // The "Fable" pool: a weekly model window, or a dollar credit pool on older payloads.
  ["iguana_necktie", "Weekly Fable"],
];

const KNOWN_LABELS = new Map(KNOWN_WINDOWS);

const titleCase = (key: string): string =>
  key
    .split(/[_\s]+/)
    .filter((part) => part !== "")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");

/** Label of an unknown key: `seven_day_foo` → "Weekly Foo", `five_hour_foo` → "5-hour Foo". */
const labelOf = (key: string): string => {
  const known = KNOWN_LABELS.get(key);

  if (known !== undefined) return known;

  if (key.startsWith("seven_day_")) return `Weekly ${titleCase(key.slice("seven_day_".length))}`;

  if (key.startsWith("five_hour_")) return `5-hour ${titleCase(key.slice("five_hour_".length))}`;

  return titleCase(key);
};

/** The panel derives the period from the key: `five_hour` is rolling 5 hours, `seven_day*` is weekly. */
const secondsOf = (key: string): number | undefined => {
  if (key === "five_hour" || key.startsWith("five_hour_")) return FIVE_HOURS;

  return key === "seven_day" || key.startsWith("seven_day_") || key === "iguana_necktie"
    ? WEEK
    : undefined;
};

const isDollarPool = (window: JsonObject): boolean =>
  num(window.limit_dollars) !== undefined ||
  num(window.used_dollars) !== undefined ||
  num(window.remaining_dollars) !== undefined;

const isFable = (name: string): boolean => name === "fable" || name === "fable 5";

/** `weekly_scoped` model limits (`limits[]`), the active entry first per model. */
const scopedLimits = (payload: JsonObject): QuotaWindow[] => {
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  const byModel = new Map<string, { active: boolean; window: QuotaWindow }>();

  for (const item of limits) {
    const limit = record(item);
    const kind = str(limit.kind)?.toLowerCase();
    const model = str(record(record(limit.scope).model).display_name);
    const used = num(limit.percent);

    if (kind !== "weekly_scoped" || model === undefined || used === undefined) continue;
    const id = isFable(model.toLowerCase()) ? "seven_day_fable" : `seven_day_${slug(model)}`;
    const active = limit.is_active === true;
    const previous = byModel.get(id);

    if (previous !== undefined && (previous.active || !active)) continue;
    byModel.set(id, {
      active,
      window: quotaWindow(id, `Weekly ${model}`, used, isoInstant(limit.resets_at), WEEK),
    });
  }

  return [...byModel.values()].map((entry) => entry.window);
};

/** Windows of an `/api/oauth/usage` payload (`utilization` is a percentage). */
export const parseClaudeUsage = (payload: Json): QuotaWindow[] => {
  const root = record(payload);
  const scoped = scopedLimits(root);
  const hasFableLimit = scoped.some((window) => window.id === "seven_day_fable");
  const known = KNOWN_WINDOWS.map(([key]) => key);
  const others = Object.keys(root).filter((key) => !KNOWN_LABELS.has(key));
  const windows: QuotaWindow[] = [];

  for (const key of [...known, ...others]) {
    const value = root[key];

    if (value === undefined || value === null) continue;
    const window = record(value);
    const used = num(window.utilization);

    if (used === undefined || isDollarPool(window)) continue;

    // The scoped limit replaces the legacy Fable key (panel behaviour).
    if (key === "iguana_necktie" && hasFableLimit) continue;
    windows.push(
      quotaWindow(key, labelOf(key), used, isoInstant(window.resets_at), secondsOf(key)),
    );
  }

  const ids = new Set(windows.map((window) => window.id));

  return uniqueIds([...windows, ...scoped.filter((window) => !ids.has(window.id))]);
};

const flag = (value: Json | undefined): boolean | undefined => {
  if (typeof value === "boolean") return value;

  if (typeof value === "number") return value !== 0;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";

  if (["true", "1", "yes", "y", "on"].includes(text)) return true;

  return ["false", "0", "no", "n", "off"].includes(text) ? false : undefined;
};

/** `resolveClaudePlanType` of an `/api/oauth/profile` payload: `team`, `max`, `pro`, `free` or nothing. */
export const parseClaudePlan = (payload: Json): string | undefined => {
  const root = record(payload);
  const organization = record(root.organization);
  const account = record(root.account);

  if (
    str(organization.organization_type)?.toLowerCase() === "claude_team" &&
    str(organization.subscription_status)?.toLowerCase() === "active"
  )
    return "team";
  const max = flag(account.has_claude_max);

  if (max === true) return "max";
  const pro = flag(account.has_claude_pro);

  if (pro === true) return "pro";

  return max === false && pro === false ? "free" : undefined;
};
