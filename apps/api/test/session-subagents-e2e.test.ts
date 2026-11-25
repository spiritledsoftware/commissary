// Header sessions isolate subagent identities (CLIProxyAPI f9ac9ffc), end to end through the production Worker and the
// real ControlPlane with session affinity on; only the upstream is mocked, through the global `fetch`. Two subagents of
// one `X-Session-ID` are two sessions, so round-robin gives them different keys and affinity keeps each on its own.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { withModelsPart } from "@commissary/models/testing";

const KEY_A = "sk-subagent-a-0001";

const KEY_B = "sk-subagent-b-0002";

const MODEL = "subagent-model";

const YAML = `
routing:
  strategy: round-robin
  session-affinity: true
api-keys:
  openai-compatibility:
    - name: Subagents
      base-url: https://subagents.upstream.test/v1
      models:
        - name: upstream-model
          alias: ${MODEL}
      keys:
        - api-key: ${KEY_A}
        - api-key: ${KEY_B}
`;

const realFetch = globalThis.fetch;

const keys: string[] = [];

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** One chat request of `agent` in session `s1`; resolves to the key the upstream saw. */
const ask = async (agent: string): Promise<string | undefined> => {
  const before = keys.length;

  const response = await exports.default.fetch(
    new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-session-id": "s1", "x-agent-id": agent },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    }),
  );

  expect(response.status).toBe(200);
  await response.text();
  expect(keys.length).toBe(before + 1);

  return keys.at(-1);
};

beforeAll(async () => {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    keys.push((request.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

    return Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "upstream-model",
      choices: [
        { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await withModelsPart(controlPlane(), (part) => part.importConfig("", "test"));
});

describe("subagents of one header session", () => {
  it("are pinned to different credentials, each keeping its own", async () => {
    const first = await ask("worker-1");
    const second = await ask("worker-2");

    expect(new Set([first, second])).toEqual(new Set([KEY_A, KEY_B]));

    // Twice in a row: round-robin alone would move on to the other key, affinity keeps the subagent's own.
    expect(await ask("worker-1")).toBe(first);
    expect(await ask("worker-1")).toBe(first);
    expect(await ask("worker-2")).toBe(second);
    expect(await ask("worker-2")).toBe(second);
  });
});
