// Keyed `auth_index` (`@commissary/models`; the indexer itself: packages/models/test/auth-index.test.ts) on the API
// Worker: no raw config credential id or unkeyed hash of key material in any client API response or log line. End to
// end through `exports.default.fetch` (dev bypass on localhost, see vitest.config.ts); only the upstream provider is
// mocked, through the global `fetch`. The management reads, and the views that join on the index, are the app Worker's
// (apps/app/test/auth-index-keyed.test.ts).
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import {
  authIndexOf,
  emptyKeyAuthIndexOf,
  FULL_ACCESS,
  resetUsageDb,
  unkeyedAuthIndexOf,
} from "@commissary/models/testing";

/** Known keys, one deliberately low-entropy (the brute-forceable case of a self-hosted endpoint). */
const KEYS = { claude: "sk-ant-leakcheck-0001", codex: "sk-codex-leakcheck-0002", compat: "1234" };

const YAML = `
api-keys:
  claude:
    - keys:
        - api-key: ${KEYS.claude}
  codex:
    - base-url: https://codex.upstream.test/v1
      keys:
        - api-key: ${KEYS.codex}
  openai-compatibility:
    - name: Mock
      base-url: https://upstream.test/v1
      models:
        - name: upstream-model
          alias: leak-model
      keys:
        - api-key: "${KEYS.compat}"
`;

/** OpenAI chat completion chunks, for `stream: true`. */
const STREAM = [
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
  },
  {
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "upstream-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .concat("data: [DONE]\n\n")
  .join("");

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "upstream-model",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

const realFetch = globalThis.fetch;

let upstreamStatus = 200;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

const call = async (path: string, init?: RequestInit) =>
  await exports.default.fetch(new Request(`http://localhost${path}`, init));

const chat = (model: string, stream = false) =>
  call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
  });

/** Every console line written while `run` runs (the Worker shares the test isolate), as JSON. */
const captureConsole = async (run: () => Promise<void>): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];

  const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    // The arguments as one JSON array: structured log objects stay JSON, strings are quoted (escaped quotes inside).
    vi.spyOn(console, method).mockImplementation((...args) => {
      try {
        lines.push(JSON.stringify(args));
      } catch {
        lines.push("[unserialisable console arguments]");
      }
    }),
  );

  try {
    await run();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }

  return lines;
};

/** Everything a client can see of a response: status line, headers and body. */
const visible = async (response: Response): Promise<string> =>
  `${response.status}\n${[...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await response.text()}`;

let configIds: ReadonlyArray<string> = [];

beforeAll(async () => {
  // Effect's FetchHttpClient resolves `globalThis.fetch` once: one stable fetch for every upstream call.
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (upstreamStatus !== 200)
      return Response.json({ error: { message: "upstream exploded" } }, { status: upstreamStatus });

    const body = await new Request(input, init).text();

    return body.includes('"stream":true')
      ? new Response(STREAM, { headers: { "content-type": "text/event-stream" } })
      : Response.json(COMPLETION);
  };

  await resetUsageDb();
  const stored = await controlPlane().models().importConfig(YAML, "test");
  expect(stored.ok).toBe(true);
  configIds = (await controlPlane().models().listCredentials(FULL_ACCESS))
    .filter((entry) => entry.source === "config")
    .map((entry) => entry.id);
  expect(configIds).toHaveLength(3);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await controlPlane().models().importConfig("", "test");
});

describe("no raw config id or unkeyed hash in any response", () => {
  /**
   * The strings that must never reach a client: ids, their hash part, the unkeyed index, the index under an empty key
   * (a missing binding) and the keys themselves.
   */
  const forbidden = (): ReadonlyArray<string> =>
    configIds
      .flatMap((id) => [unkeyedAuthIndexOf(id), emptyKeyAuthIndexOf(id)])
      .concat(configIds.flatMap((id) => [id, id.slice(id.lastIndexOf(":") + 1)]))
      .concat([KEYS.claude, KEYS.codex]);

  it("client API responses (success, streaming, upstream failure, unknown model) and the logs", async () => {
    const seen: Array<{ readonly what: string; readonly text: string }> = [];

    const record = async (what: string, response: Promise<Response>) =>
      seen.push({ what, text: await visible(await response) });

    const compatId = configIds.find((id) => id.startsWith("openai-compat")) ?? "";

    const logs = await captureConsole(async () => {
      upstreamStatus = 200;
      await record("chat ok", chat("leak-model"));
      await record("chat stream", chat("leak-model", true));
      upstreamStatus = 500;
      await record("chat upstream 500", chat("leak-model"));
      upstreamStatus = 200;
      await record("chat unknown model", chat("no-such-model"));
      await record("models", call("/v1/models"));
      // Commissary really served (streamed, and failed) through the config credential.
      expect(seen.map(({ text }) => text.slice(0, 3))).toEqual(["200", "200", "500", "400", "200"]);
      expect(seen[1]?.text).toContain("data: [DONE]");

      // The usage rows keep the credential id, which every management read answers with the keyed index instead.
      await vi.waitFor(
        async () => {
          const rows = await env.USAGE.prepare(
            "SELECT COUNT(*) AS n FROM usage_records WHERE auth_id = ?",
          )
            .bind(compatId)
            .first<{ n: number }>();

          expect(rows?.n).toBeGreaterThanOrEqual(2);
        },
        { timeout: 5_000 },
      );
    });

    for (const { what, text } of seen)
      for (const secret of forbidden())
        expect(text, `${what} leaks ${secret}`).not.toContain(secret);

    // Logs carry keyed indexes only (and saw the proxied requests: the capture works).
    const keyed = new Set(configIds.map(authIndexOf));

    const logged = logs.flatMap((line) =>
      [...line.matchAll(/\\?"authIndex\\?":\\?"([^"\\]*)/g)].map((m) => m[1]),
    );

    expect(logged).toContain(authIndexOf(compatId));

    for (const index of logged) expect(keyed.has(index ?? ""), `log authIndex ${index}`).toBe(true);

    expect(logs).not.toContain("[unserialisable console arguments]");

    for (const line of logs)
      for (const secret of forbidden()) expect(line, `log leaks ${secret}`).not.toContain(secret);
  });
});
