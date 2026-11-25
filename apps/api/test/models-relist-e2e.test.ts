// `/v1/models` relists a model once its bounded cooldown expired (CLIProxyAPI 69ed202a), end to end through the
// production Worker and the real ControlPlane; only the upstream is mocked, through the global `fetch`. The upstream
// answers 503, which with `transient-error-cooldown-seconds: 1` leaves the model's cooldown flags set with a one-second
// deadline. No later
// result clears them, yet once the deadline and the registry's snapshot (`SNAPSHOT_TTL_MS`) have passed the model is
// listed again. The wait is real time: the API Worker's registry cache runs on the isolate's clock.
import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { FULL_ACCESS, withModelsPart } from "@commissary/models/testing";

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

/** The registry snapshot's lifetime (`SNAPSHOT_TTL_MS`) plus a margin. */
const SNAPSHOT_WAIT_MS = 5_500;

const realFetch = globalThis.fetch;

let calls = 0;

const controlPlane = () => env.CONTROL_PLANE.getByName("global");

/** The ids `/v1/models` lists. */
interface ModelList {
  readonly data: ReadonlyArray<{ readonly id: string }>;
}

const listed = async (): Promise<string[]> => {
  const response = await exports.default.fetch(new Request("http://localhost/v1/models"));
  expect(response.status).toBe(200);
  // SAFETY: `/v1/models` answers an OpenAI model list (`{ object: "list", data: [{ id, ... }] }`).
  const body = (await response.json()) as ModelList;

  return body.data.map((model) => model.id);
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

describe("/v1/models after a bounded cooldown", () => {
  it(
    "lists the model again once its deadline passed, while its flags are still set",
    async () => {
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

      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS));

      // No result cleared the model's cooldown flags: only its deadline passed.
      const [credential] = await withModelsPart(controlPlane(), (part) =>
        part.listCredentials(FULL_ACCESS),
      );

      expect(Object.values(credential?.modelStates ?? {})).toEqual([
        expect.objectContaining({ unavailable: true }),
      ]);
      expect(await listed()).toContain(MODEL);
    },
    SNAPSHOT_WAIT_MS + 10_000,
  );
});
