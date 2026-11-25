// `/v1/models` relists a model once its bounded cooldown expired (CLIProxyAPI 69ed202a), end to end through the
// production Worker and the real ControlPlane; only the upstream is mocked, through the global `fetch`. The upstream
// answers 503, which with `transient-error-cooldown-seconds: 1` leaves the model's cooldown flags set with a one-second
// deadline. Each listing goes through a handler of its own, as a new isolate builds it, so no registry snapshot is
// cached: the model is hidden while it cools and listed again once the deadline passed, though no result cleared its
// flags. The wait is real time, the cooldown's deadline is the ControlPlane's clock.
import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";
import { makeWebHandler } from "../src/http/app.ts";
import { requestContext } from "../src/worker-env.ts";

const KEY = "sk-relist-0001";

const MODEL = "relist-model";

const YAML = `
routing:
  retry:
    request-retry: 0
    max-retry-interval: 0
  cooldown:
    transient-error-cooldown-seconds: 1
api-keys:
  openai-compatibility:
    - name: Relist
      base-url: https://relist.upstream.test/v1
      models:
        - name: upstream-model
          alias: ${MODEL}
      keys:
        - api-key: ${KEY}
`;

/** The cooldown (`transient-error-cooldown-seconds`) plus a margin. */
const COOLDOWN_WAIT_MS = 1_200;

const realFetch = globalThis.fetch;

let calls = 0;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** The ids `/v1/models` lists, from a fresh handler with no registry snapshot cached. */
interface ModelList {
  readonly data: ReadonlyArray<{ readonly id: string }>;
}

const listed = async (): Promise<string[]> => {
  const { handler, dispose } = makeWebHandler();

  try {
    const response = await handler(
      new Request("http://localhost/v1/models"),
      requestContext(env, createExecutionContext()),
    );

    expect(response.status).toBe(200);
    // SAFETY: `/v1/models` answers an OpenAI model list (`{ object: "list", data: [{ id, ... }] }`).
    const body = (await response.json()) as ModelList;

    return body.data.map((model) => model.id);
  } finally {
    await dispose();
  }
};

beforeAll(async () => {
  globalThis.fetch = async () => {
    calls += 1;

    return Response.json(
      { error: { type: "server_error", message: "Overloaded." } },
      { status: 503 },
    );
  };

  const stored = await withModelsPart(controlPlane(), (part) => part.importConfig(YAML, "test"));
  expect(stored.ok).toBe(true);
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await withModelsPart(controlPlane(), (part) => part.importConfig("", "test"));
});

describe("/v1/models around a bounded cooldown", () => {
  it("hides the model while it cools and lists it again once the deadline passed", async () => {
    expect(await listed()).toContain(MODEL);

    const response = await exports.default.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
      }),
    );

    expect(response.status).toBe(503);
    await response.text();
    expect(calls).toBe(1);
    expect(await listed()).not.toContain(MODEL);

    await new Promise((resolve) => setTimeout(resolve, COOLDOWN_WAIT_MS));

    // No result cleared the model's cooldown flags: only its deadline passed.
    const [credential] = await withModelsPart(controlPlane(), (part) =>
      part.listCredentials(FULL_ACCESS),
    );

    expect(Object.values(credential?.modelStates ?? {})).toEqual([
      expect.objectContaining({ unavailable: true }),
    ]);
    expect(await listed()).toContain(MODEL);
  });
});
