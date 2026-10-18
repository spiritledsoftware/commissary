// The System One key families (`api-keys.typesafe` / `api-keys.subq`): normalisation, credential synthesis, the key
// test and the write rule (`management/provider-keys-probe.ts`, `provider-keys-write.ts`).
import { Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import { parseConfigYaml } from "../../src/config/codec.ts";
import { synthesizeConfigCredentials } from "../../src/credentials/synthesize.ts";
import { structuralDropReason } from "../../src/management/provider-keys-write.ts";
import {
  buildProviderKeyProbeTarget,
  type ProviderKeyProbeTarget,
  probeProviderKey,
} from "../../src/management/provider-keys-probe.ts";

const parse = (text: string) => Effect.runPromise(parseConfigYaml(text));

describe("System One config sections", () => {
  it("drops a key without a secret and a group left without keys", async () => {
    const config = await parse(`api-keys:
  typesafe:
    - keys: [{ api-key: "" }]
    - keys: [{ api-key: ts-key }, { api-key: "" }]
  subq:
    - keys: [{ api-key: "" }]
`);

    expect(config["api-keys"].typesafe.map((group) => group.keys.length)).toEqual([1]);
    expect(config["api-keys"].subq).toEqual([]);
  });

  it("synthesises a typesafe credential that leaves the default base URL to the executor", async () => {
    const config = await parse(`api-keys:
  typesafe:
    - keys: [{ api-key: ts-key }]
`);

    const [credential] = synthesizeConfigCredentials(config, 0);
    expect(credential?.provider).toBe("typesafe");
    expect(credential?.id.startsWith("typesafe:apikey:")).toBe(true);
    expect(credential?.attributes).toMatchObject({ api_key: "ts-key", auth_kind: "apikey" });
    expect(credential?.attributes.base_url).toBeUndefined();
  });
});

describe("System One key writes", () => {
  it.each(["typesafe", "subq"] as const)("%s: a key needs an api-key", (family) => {
    expect(structuralDropReason(family, { keys: [{ "api-key": "" }] })).toBe(
      `${family} keys need an api-key`,
    );
    expect(structuralDropReason(family, { keys: [{ "api-key": "k" }] })).toBeUndefined();
  });
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const upstream = (status: number, body: string, seen: Seen[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Predicate.isTagged(request.body, "Uint8Array")
            ? new TextDecoder().decode(request.body.body)
            : "",
        });

        return HttpClientResponse.fromWeb(request, new Response(body, { status }));
      }),
    ),
  );

const target = (family: "typesafe" | "subq", baseUrl: string): ProviderKeyProbeTarget => ({
  id: `${family}:apikey:1`,
  family,
  baseUrl,
  providerKey: "sk-probe",
  headers: {},
  models: [],
});

describe("System One key test", () => {
  it("typesafe: GET {base}/models with Bearer, listing the models by name", async () => {
    const seen: Seen[] = [];

    const result = await Effect.runPromise(
      probeProviderKey(target("typesafe", "https://api.typesafe.ai/v1/")).pipe(
        Effect.provide(
          upstream(
            200,
            '{"models":[{"name":"jev-latest","description":"Jev","release_date":"2026-01-01"}]}',
            seen,
          ),
        ),
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(seen[0]?.headers).toMatchObject({ authorization: "Bearer sk-probe" });
    expect(result).toMatchObject({ ok: true, models: [{ id: "jev-latest" }] });
  });

  it("typesafe: a base without /v1 still gets {base}/models", async () => {
    const seen: Seen[] = [];

    await Effect.runPromise(
      probeProviderKey(target("typesafe", "https://proxy.example")).pipe(
        Effect.provide(upstream(200, "{}", seen)),
      ),
    );

    expect(seen[0]?.url).toBe("https://proxy.example/models");
  });

  it("subq: POST {base}/systemone with Bearer and the smallest valid request; a 2xx is a working key", async () => {
    const seen: Seen[] = [];

    const result = await Effect.runPromise(
      probeProviderKey(target("subq", "https://api.subq.ai/v1/")).pipe(
        Effect.provide(
          upstream(
            200,
            '{"model":"subq-snap-preview","answers":{"key_check":{"type":"noul","noul":0.1}},"usage":{"input_tokens":40,"output_tokens":0}}',
            seen,
          ),
        ),
      ),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("https://api.subq.ai/v1/systemone");
    expect(seen[0]?.headers).toMatchObject({
      authorization: "Bearer sk-probe",
      "content-type": "application/json",
    });
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
      model: "subq-snap-preview",
      state: "",
      questions: { key_check: { type: "noul", instructions: "Is this a key check?" } },
    });
    expect(result).toMatchObject({ ok: true, status_code: 200 });
    expect(result).not.toHaveProperty("models");
  });

  it("subq: tests the group's first configured model", async () => {
    const seen: Seen[] = [];

    await Effect.runPromise(
      probeProviderKey({
        ...target("subq", "https://api.subq.ai/v1"),
        models: ["subq-snap-next"],
      }).pipe(Effect.provide(upstream(200, "{}", seen))),
    );

    expect(JSON.parse(seen[0]?.body ?? "")).toMatchObject({ model: "subq-snap-next" });
  });

  it.each([401, 402, 403, 422])("subq: a %i fails the test with its status", async (status) => {
    const result = await Effect.runPromise(
      probeProviderKey(target("subq", "https://api.subq.ai/v1")).pipe(
        Effect.provide(
          upstream(status, '{"detail":{"error_type":"x","message":"sk-probe is bad"}}', []),
        ),
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      status_code: status,
      error: `upstream answered ${status}`,
    });
  });

  it("builds a target from a System One credential with the default base URL", () => {
    expect(
      buildProviderKeyProbeTarget({
        id: "typesafe:apikey:1",
        provider: "typesafe",
        attributes: { api_key: "k" },
        headers: {},
        models: [],
      }),
    ).toMatchObject({ family: "typesafe", baseUrl: "https://api.typesafe.ai/v1" });
  });
});
