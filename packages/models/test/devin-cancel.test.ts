// A Devin stream the client cancels mid-generation keeps the usage counted so far (CLIProxyAPI a9e3ddcf): the record the
// handler closes on the cancel carries the partial tokens, and no completion is synthesised.
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vite-plus/test";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import { ProtoWriter } from "../src/executor/devin/protobuf.ts";
import { ModelProviders } from "../src/handlers/model-providers.ts";
import { fixedPicker } from "./support/codex.ts";
import { loadConfig, makePipeline, postJson } from "./support/pipeline.ts";

const devin: CredentialSnapshot = {
  id: "devin-1",
  provider: "devin",
  kind: "oauth",
  label: "devin",
  attributes: {
    api_key: "devin-session-token$test",
    base_url: "https://devin.test",
    device_seed: "seed-1",
  },
  metadata: {},
};

const providers = Layer.succeed(
  ModelProviders,
  ModelProviders.of({
    providersFor: () => Effect.succeed(["devin"]),
    firstAvailableModel: Effect.succeed("swe-2"),
  }),
);

const envelope = (flag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flag;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);

  return out;
};

const textFrame = (text: string): Uint8Array =>
  envelope(0, new ProtoWriter().bytes(3, new TextEncoder().encode(text)).toBytes());

const usageFrame = (prompt: number, completion: number): Uint8Array =>
  envelope(
    0,
    new ProtoWriter()
      .bytes(7, new ProtoWriter().varint(2, prompt).varint(3, completion).toBytes())
      .toBytes(),
  );

/** Text and usage, then an upstream that never sends the EOS trailer. */
const hangingResponse = (): Response => {
  const first = new Uint8Array([...textFrame("partial"), ...usageFrame(7, 3)]);

  return new Response(
    new ReadableStream<Uint8Array>({
      start: (controller) => controller.enqueue(first),
    }),
    { status: 200, headers: { "content-type": "application/connect+proto" } },
  );
};

describe("Devin stream canceled by the client", () => {
  it("records the partial usage on the canceled attempt", async () => {
    const config = await loadConfig("requests: {}");

    const p = makePipeline({
      config,
      credentialPicker: fixedPicker([devin]),
      modelProviders: providers,
      respond: hangingResponse,
    });

    afterAll(p.dispose);

    const response = await p.call(
      "/v1/chat/completions",
      postJson({ model: "swe-2", stream: true, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    let seen = "";

    while (reader !== undefined && !seen.includes("partial")) {
      const chunk = await reader.read();

      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
    }

    expect(seen).toContain("partial");
    await reader?.cancel();

    for (let tries = 0; tries < 100 && p.records.length === 0; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(p.records).toHaveLength(1);
    expect(p.records[0]).toMatchObject({
      failed: true,
      detail: { inputTokens: 7, outputTokens: 3 },
    });
  });
});
