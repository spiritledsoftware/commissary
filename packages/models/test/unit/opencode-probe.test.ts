// Key test of OpenCode Zen/Go config keys (`management/provider-keys-probe.ts`): an authenticated chat call, since the
// gateways' model listing is public.
import { Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe, expect, it } from "vitest";
import {
  type ProviderKeyProbeTarget,
  OPENCODE_PROBE_MODEL,
  probeProviderKey,
} from "../../src/management/provider-keys-probe.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const gateway = (status: number, body: string, seen: Seen[]) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const text = Predicate.isTagged(request.body, "Uint8Array")
          ? new TextDecoder().decode(request.body.body)
          : "";

        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: text,
        });

        return HttpClientResponse.fromWeb(request, new Response(body, { status }));
      }),
    ),
  );

const target = (family: "opencode-zen" | "opencode-go"): ProviderKeyProbeTarget => ({
  id: `${family}:apikey:1`,
  family,
  baseUrl:
    family === "opencode-zen"
      ? "https://opencode.ai/inference/v1"
      : "https://opencode.ai/inference/go/v1",
  providerKey: "sk-probe",
  headers: { "x-team": "a" },
  models: [],
});

const probe = (family: "opencode-zen" | "opencode-go", status: number, body = "{}") => {
  const seen: Seen[] = [];

  return Effect.runPromise(
    probeProviderKey(target(family)).pipe(Effect.provide(gateway(status, body, seen))),
  ).then((result) => ({ result, seen }));
};

describe("OpenCode key test", () => {
  it.each(["opencode-zen", "opencode-go"] as const)(
    "%s: POSTs chat/completions with Bearer, the session header and a model that bills nothing",
    async (family) => {
      const { result, seen } = await probe(
        family,
        400,
        '{"error":{"message":"Model is unavailable"}}',
      );

      expect(result).toMatchObject({ ok: true, status_code: 400 });
      expect(seen).toHaveLength(1);

      const [call] = seen;
      expect(call?.method).toBe("POST");
      expect(call?.url).toBe(`${target(family).baseUrl}/chat/completions`);
      expect(call?.headers).toMatchObject({
        authorization: "Bearer sk-probe",
        "x-opencode-client": "commissary",
        "x-team": "a",
      });
      expect(call?.headers["x-opencode-session"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
        model: OPENCODE_PROBE_MODEL,
        max_tokens: 1,
      });
    },
  );

  it("a 401 is a bad key", async () => {
    const { result } = await probe("opencode-zen", 401, '{"error":{"message":"Invalid API key."}}');
    expect(result).toMatchObject({ ok: false, status_code: 401, error: "upstream answered 401" });
  });

  it("a 2xx passes, other statuses fail", async () => {
    expect((await probe("opencode-go", 200, '{"choices":[]}')).result).toMatchObject({ ok: true });
    expect((await probe("opencode-go", 500, "oops")).result).toMatchObject({
      ok: false,
      status_code: 500,
    });
  });
});
