// SPI-1415 (Go ed1c23f9): retry delays of Google 429s. Cases follow json_retry_helpers_test.go of that commit.
import type { JsonObject } from "@commissary/json";
import { describe, expect, it } from "vite-plus/test";
import {
  parseGoogleRetryAfterMs,
  parseGoogleRetryDelayMs,
} from "../../src/executor/helps/google-retry.ts";

const RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";

const ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";

const exhausted = (error: JsonObject): string =>
  JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", ...error } });

const retryInfo = (retryDelay: string) => ({ "@type": RETRY_INFO, retryDelay });

describe("ParseRetryDelay", () => {
  const cases: ReadonlyArray<readonly [string, string, number | undefined]> = [
    ["RetryInfo 2190s", exhausted({ details: [retryInfo("2190s")] }), 2_190_000],
    [
      "a fractional 'retry in' duration",
      exhausted({ message: "Resource has been exhausted. Please retry in 36m41.110635822s." }),
      2_201_110.635822,
    ],
    [
      "'retry in' after an earlier 'after'",
      exhausted({ message: "Quota exceeded after multiple requests. Please retry in 36m41.5s." }),
      2_201_500,
    ],
    ["uppercase units", exhausted({ message: "Quota will reset after 1H2M3S." }), 3_723_000],
    ["uppercase 'retry in' units", exhausted({ message: "Please retry in 36M41.5S." }), 2_201_500],
    ["an array-wrapped body", `[${exhausted({ details: [retryInfo("2190s")] })}]`, 2_190_000],
    [
      "a malformed RetryInfo falling back to ErrorInfo",
      exhausted({
        details: [
          retryInfo("not-a-duration"),
          { "@type": ERROR_INFO, metadata: { quotaResetDelay: "120s" } },
        ],
      }),
      120_000,
    ],
    ["a zero RetryInfo", exhausted({ details: [retryInfo("0s")] }), 0],
    [
      "a zero quotaResetDelay",
      exhausted({ details: [{ "@type": ERROR_INFO, metadata: { quotaResetDelay: "0s" } }] }),
      0,
    ],
    ["a zero message duration", exhausted({ message: "Your quota will reset after 0s." }), 0],
    ["a negative RetryInfo", exhausted({ details: [retryInfo("-5s")] }), undefined],
    [
      "a word starting with a unit letter",
      exhausted({ message: "Failed after 3models or retry in 2steps." }),
      undefined,
    ],
    ["no hint", "{}", undefined],
  ];

  for (const [name, body, want] of cases) {
    it(name, () => {
      const got = parseGoogleRetryDelayMs(body);

      if (want === undefined) expect(got).toBeUndefined();
      else expect(got).toBeCloseTo(want, 3);
    });
  }
});

describe("ParseGoogleRetryAfter", () => {
  const now = Date.parse("2026-11-15T08:00:00Z");
  const future = new Date(now + 2_190_000).toUTCString();
  const past = new Date(now - 60_000).toUTCString();

  const cases: ReadonlyArray<
    readonly [string, number, Record<string, string>, string, number | undefined]
  > = [
    [
      "a non-429 ignores every hint",
      503,
      { "retry-after": "2190" },
      JSON.stringify({ error: { code: 503, details: [retryInfo("2190s")] } }),
      undefined,
    ],
    [
      "RetryInfo wins over the header and the message",
      429,
      { "retry-after": "60" },
      JSON.stringify({
        error: { code: 429, message: "Please retry in 10s.", details: [retryInfo("2190s")] },
      }),
      2_190_000,
    ],
    [
      "a zero RetryInfo falls back to a positive header",
      429,
      { "retry-after": "2190" },
      JSON.stringify({ error: { code: 429, details: [retryInfo("0s")] } }),
      2_190_000,
    ],
    [
      "a zero RetryInfo alone is no hint",
      429,
      {},
      JSON.stringify({ error: { code: 429, details: [retryInfo("0s")] } }),
      undefined,
    ],
    [
      "the header wins over the message",
      429,
      { "Retry-After": "2190" },
      JSON.stringify({ error: { code: 429, message: "Please retry in 36m41.110635822s." } }),
      2_190_000,
    ],
    [
      "a future HTTP date",
      429,
      { "retry-after": future },
      JSON.stringify({ error: { code: 429 } }),
      2_190_000,
    ],
    [
      "a zero header without a body hint",
      429,
      { "retry-after": "0" },
      JSON.stringify({ error: { code: 429 } }),
      undefined,
    ],
    [
      "a past HTTP date falls back to the message",
      429,
      { "retry-after": past },
      JSON.stringify({ error: { code: 429, message: "Please retry in 1M30S." } }),
      90_000,
    ],
    [
      "an invalid header without a body hint",
      429,
      { "retry-after": "soon" },
      JSON.stringify({ error: { code: 429, message: "Rate limited." } }),
      undefined,
    ],
  ];

  for (const [name, status, headers, body, want] of cases) {
    it(name, () => {
      expect(parseGoogleRetryAfterMs(status, new Headers(headers), body, now)).toBe(want);
    });
  }
});
