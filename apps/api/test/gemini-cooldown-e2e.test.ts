// SPI-1415 (Go ed1c23f9, cf07c78a, 7e82d0d1): Gemini credentials end to end, through the production Worker
// (`exports.default.fetch`) with the real ControlPlane picker and `markResult`; only the Gemini API is mocked, through
// the global `fetch`. A 429's RetryInfo hint sets the key's cooldown, so later requests go to the other key without
// asking the first again. A zero-output abnormal finish fails before the response commits, so the request moves on to
// the other key, and the key is not cooled for it.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

const LIMITED_KEY = "AIza-limited-0001";

const SPARE_KEY = "AIza-spare-0002";

const MODEL = "gemini-2.5-flash";

/** The model the first key answers with a zero-output MALFORMED_FUNCTION_CALL. */
const MALFORMED_MODEL = "gemini-2.5-pro";

/** The model both keys answer with a zero-output MALFORMED_FUNCTION_CALL. */
const ALWAYS_MALFORMED_MODEL = "gemini-2.5-flash-lite";

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

const usageMetadata = { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 };

// A finish with nothing visible: an empty part list, then MALFORMED_FUNCTION_CALL (Go issue 7513).
const SHELL = { candidates: [{ content: { role: "model", parts: [] }, index: 0 }] };

const MALFORMED = {
  candidates: [
    {
      content: { role: "model", parts: [] },
      finishReason: "MALFORMED_FUNCTION_CALL",
      index: 0,
    },
  ],
  usageMetadata,
};

const TEXT_CHUNK = {
  candidates: [{ content: { role: "model", parts: [{ text: "hello" }] }, index: 0 }],
};

const STOP_CHUNK = {
  candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
  usageMetadata,
};

const sse = (frames: ReadonlyArray<object>): Response =>
  new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

/** The key of each Gemini API call, in order. */
const calls: string[] = [];

const realFetch = globalThis.fetch;

const chat = (model = MODEL, stream = false) =>
  exports.default.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
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
    const url = new URL(request.url);
    const stream = url.pathname.endsWith(":streamGenerateContent");

    calls.push(key);

    const malformed =
      url.pathname.includes(ALWAYS_MALFORMED_MODEL) ||
      (key === LIMITED_KEY && url.pathname.includes(MALFORMED_MODEL));

    if (malformed) return stream ? sse([SHELL, MALFORMED]) : Response.json(MALFORMED);

    if (key === LIMITED_KEY)
      return new Response(EXHAUSTED, {
        status: 429,
        headers: { "content-type": "application/json" },
      });

    return stream ? sse([TEXT_CHUNK, STOP_CHUNK]) : Response.json(GENERATED);
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

describe("a zero-output MALFORMED_FUNCTION_CALL", () => {
  /** The model state of `model` on every key: none may be cooled for a zero-output failure. */
  const modelCooldowns = async (model: string): Promise<ReadonlyArray<number>> =>
    (await summaries()).map((summary) => summary.modelStates[model]?.nextRetryAfter ?? 0);

  for (const stream of [false, true]) {
    it(`moves on to the other key without cooling the first (stream: ${String(stream)})`, async () => {
      for (let request = 0; request < 3; request += 1) {
        const response = await chat(MALFORMED_MODEL, stream);
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(text).toContain("hello");
        expect(text).not.toContain("MALFORMED_FUNCTION_CALL");
      }

      // Not cooled: the first key is asked again on every request, and each time the spare answers.
      expect(calls.filter((key) => key === LIMITED_KEY)).toHaveLength(3);
      expect(calls.filter((key) => key === SPARE_KEY)).toHaveLength(3);
      expect(await modelCooldowns(MALFORMED_MODEL)).toEqual([0, 0]);
    });
  }

  it("answers 502 when every key finishes that way, cooling none", async () => {
    const response = await chat(ALWAYS_MALFORMED_MODEL, true);

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("MALFORMED_FUNCTION_CALL");
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(await modelCooldowns(ALWAYS_MALFORMED_MODEL)).toEqual([0, 0]);
  });
});
