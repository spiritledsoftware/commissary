/**
 * OpenCode Go subscription usage (`GET {base}/usage`, default `https://opencode.ai/inference/go/v1/usage`, `Authorization:
 * Bearer <key>`) as quota windows.
 *
 * Workers addition, no Go or panel counterpart (CLIProxyAPI has no OpenCode provider; see docs/ARCHITECTURE.md
 * "OpenCode Zen and OpenCode Go" and "Quota check"). The gateway answers
 * `{"usage":{"rolling":{status,percent,resetsAt},"weekly":{…},"monthly":{…}}}`: `rolling` is the 5-hour window and
 * `percent` the share used (0–100). Only `status: "ok"` has been seen; any other status is read as a used-up window
 * (100 %). Parsing is lenient: a window without a usable share (and without a
 * non-ok status) is left out, numeric strings are accepted, and a payload without any window is invalid.
 */
import type { Json } from "@commissary/json";
import type { QuotaWindow } from "@commissary/contract/credentials";
import { DAY, FIVE_HOURS, num, quotaWindow, record, resetIso, str, WEEK } from "./window.ts";

/** Appended to the credential's base URL. */
export const OPENCODE_GO_USAGE_PATH = "/usage";

/** The usage URL of a gateway base URL (`https://opencode.ai/inference/go/v1` → `…/v1/usage`). */
export const openCodeGoUsageUrl = (baseUrl: string): string =>
  `${baseUrl.trim().replace(/\/+$/, "")}${OPENCODE_GO_USAGE_PATH}`;

/** The gateway's windows in display order: key, window id, label and length (the month is nominal). */
export const OPENCODE_GO_WINDOWS = [
  { key: "rolling", id: "five_hour", label: "5-hour", seconds: FIVE_HOURS },
  { key: "weekly", id: "weekly", label: "Weekly", seconds: WEEK },
  { key: "monthly", id: "monthly", label: "Monthly", seconds: 30 * DAY },
] as const;

export type OpenCodeGoWindowKey = (typeof OPENCODE_GO_WINDOWS)[number]["key"];

const windowOf = (
  spec: (typeof OPENCODE_GO_WINDOWS)[number],
  raw: Json | undefined,
): QuotaWindow | undefined => {
  const data = record(raw);
  const status = str(data.status)?.toLowerCase();
  const share = num(data.percent);
  const limited = status !== undefined && status !== "ok";

  if (share === undefined && !limited) return undefined;
  const used = limited ? 100 : (share ?? 0);
  const resetsAt = resetIso([data.resetsAt, data.resets_at, data.resetAt]);

  return quotaWindow(spec.id, spec.label, used, resetsAt, spec.seconds);
};

/** Windows of a `/usage` payload; `undefined` when it has none (an invalid answer). */
export const parseOpenCodeGoUsage = (payload: Json): QuotaWindow[] | undefined => {
  const usage = record(record(payload).usage);

  const windows = OPENCODE_GO_WINDOWS.flatMap((spec) => {
    const window = windowOf(spec, usage[spec.key]);

    return window === undefined ? [] : [window];
  });

  return windows.length === 0 ? undefined : windows;
};
