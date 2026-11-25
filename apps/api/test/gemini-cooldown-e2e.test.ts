// SPI-1415 (Go ed1c23f9): Gemini credentials end to end, through the production Worker
// (`exports.default.fetch`) with the real ControlPlane picker and `markResult`; only the Gemini API is mocked, through
// the global `fetch`. A 429's RetryInfo hint sets the key's cooldown, so later requests go to the other key without
// asking the first again.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

const LIMITED_KEY = "AIza-limited-0001";

const SPARE_KEY = "AIza-spare-0002";

const MODEL = "gemini-2.5-flash";

const YAML = `
api-keys:
  gemini:
    - keys:
        - api-key: ${LIMITED_KEY}
        - api-key: ${SPARE_KEY}
`;

const RETRY_DELAY_SECONDS = 2190;

// Google's 429 with a google.rpc.RetryInfo detail (Go issue 7565).
const EXHAUSTED = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Resource has been exhausted.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: `${RETRY_DELAY_SECONDS}s`,
      },
    ],
  },
});

const GENERATED = {
  candidates: [
    { content: { role: "model", parts: [{ text: "hello" }] }, finishReason: "STOP", index: 0 },
  ],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
  modelVersion: MODEL,
};

/** The key of each Gemini API call, in order. */
const calls: string[] = [];

const realFetch = globalThis.fetch;

const chat = () =>
  exports.default.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

interface Summary {
  readonly label: string;
  readonly unavailable: boolean;
  readonly nextRetryAfter: number;
  readonly modelStates: Readonly<
    Record<string, { readonly unavailable: boolean; readonly nextRetryAfter: number }>
  >;
}

/** The pool's summaries of the Gemini keys (config keys share one label, so their order tells them apart). */
const summaries = async (): Promise<ReadonlyArray<Summary>> =>
  // SAFETY: `listCredentials` answers `CredentialSummary` objects, of which `Summary` is a subset.
  (await withModelsPart(controlPlane(), (part) =>
    part.listCredentials(FULL_ACCESS),
  )) as unknown as ReadonlyArray<Summary>;

/** The latest time the key or one of its models is cooled until. */
const cooledUntil = (summary: Summary | undefined): number =>
  Math.max(
    summary?.nextRetryAfter ?? 0,
    ...Object.values(summary?.modelStates ?? {}).map((state) => state.nextRetryAfter),
  );

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const key = request.headers.get("x-goog-api-key") ?? "";

    calls.push(key);

    if (key === LIMITED_KEY)
      return new Response(EXHAUSTED, {
        status: 429,
        headers: { "content-type": "application/json" },
      });

    return Response.json(GENERATED);
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  calls.length = 0;
});

describe("a Gemini 429's RetryInfo hint", () => {
  it("cools the key for the hinted delay and serves from the other key", async () => {
    const started = Date.now();

    for (let request = 0; request < 4; request += 1) {
      const response = await chat();
      expect(response.status).toBe(200);
      await response.text();
    }

    // Asked once; every other request went straight to the spare key.
    expect(calls.filter((key) => key === LIMITED_KEY)).toHaveLength(1);
    expect(calls.filter((key) => key === SPARE_KEY)).toHaveLength(4);

    const cooldowns = (await summaries()).map(cooledUntil).toSorted((a, b) => a - b);

    // The spare key is not cooled; the limited one is cooled for the RetryInfo delay.
    expect(cooldowns).toHaveLength(2);
    expect(cooldowns[0]).toBe(0);
    const until = cooldowns[1] ?? 0;

    expect(until - started).toBeGreaterThanOrEqual(RETRY_DELAY_SECONDS * 1000 - 5000);
    expect(until - started).toBeLessThanOrEqual(RETRY_DELAY_SECONDS * 1000 + 60_000);
  });
});
