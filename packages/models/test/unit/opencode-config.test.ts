// `api-keys.opencode-zen` / `api-keys.opencode-go`: parser and encoded document round trip. The management `/config`
// paths are tested in the Worker (`apps/app/test/opencode-config.test.ts`).
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeConfig, encodeConfig, parseConfigYaml } from "../../src/config/codec.ts";
import { Config } from "../../src/config/schema.ts";

const YAML = `api-keys:
  opencode-zen:
    - prefix: zen
      priority: 2
      headers:
        X-Team: core
      excluded-models: ["*-mini"]
      models:
        - name: gpt-5
          alias: zen-gpt
          protocol: chat
      keys:
        - api-key: zen-key
        - api-key: zen-key-2
          models:
            - name: claude-haiku-4-5
              protocol: messages
    - base-url: https://zen.example/v1
      keys:
        - api-key: zen-key-3
  opencode-go:
    - keys:
        - api-key: go-key
`;

const parse = (text: string) => Effect.runPromise(parseConfigYaml(text));

describe("config sections", () => {
  it("parses both sections with per-model protocols", async () => {
    const config = await parse(YAML);
    const zen = config["api-keys"]["opencode-zen"][0];
    expect(zen).toMatchObject({ prefix: "zen", priority: 2, headers: { "X-Team": "core" } });
    expect(zen?.models).toEqual([{ name: "gpt-5", alias: "zen-gpt", protocol: "chat" }]);
    expect(zen?.keys[1]).toMatchObject({
      "api-key": "zen-key-2",
      models: [{ name: "claude-haiku-4-5", protocol: "messages" }],
    });
    expect(config["api-keys"]["opencode-zen"][1]?.["base-url"]).toBe("https://zen.example/v1");
    expect(config["api-keys"]["opencode-go"][0]?.keys[0]?.["api-key"]).toBe("go-key");
  });

  it("round-trips through the encoded document", async () => {
    const config = await parse(YAML);
    const encoded = encodeConfig(config);
    expect(Schema.decodeUnknownSync(Config)(encoded)).toEqual(config);
    expect(await Effect.runPromise(decodeConfig(JSON.parse(JSON.stringify(encoded))))).toEqual(
      config,
    );
  });

  it("rejects an unknown protocol in the OpenCode sections, naming the path, and drops keys without a secret", async () => {
    await expect(
      parse(`api-keys:
  opencode-go:
    - keys: [{ api-key: k }]
      models: [{ name: m, protocol: websocket }]
`),
    ).rejects.toMatchObject({
      message:
        'Expected one of "chat", "responses", "messages", "gemini", "systemone" at api-keys.opencode-go[0].models[0].protocol',
      path: "api-keys.opencode-go[0].models[0].protocol",
    });

    await expect(
      parse(`api-keys:
  opencode-zen:
    - keys:
        - api-key: k
          models: [{ name: m, protocol: Chat }]
`),
    ).rejects.toMatchObject({ path: "api-keys.opencode-zen[0].keys[0].models[0].protocol" });

    const config = await parse(`api-keys:
  opencode-go:
    - keys: [{ api-key: "" }]
`);

    expect(config["api-keys"]["opencode-go"]).toEqual([]);
  });
});

describe("protocol on other providers", () => {
  it("is ignored: any value parses and the normalised config drops it", async () => {
    const config = await parse(`api-keys:
  claude:
    - keys:
        - api-key: c
          models: [{ name: claude-x, protocol: carrier-pigeon }]
      models: [{ name: claude-y, protocol: "" }]
  openai-compatibility:
    - name: compat
      base-url: https://compat.test/v1
      keys: [{ api-key: k }]
      models: [{ name: gpt-z, protocol: messages }]
`);

    const claude = config["api-keys"].claude[0];
    expect(claude?.models).toEqual([{ name: "claude-y" }]);
    expect(claude?.keys[0]?.models).toEqual([{ name: "claude-x" }]);
    expect(config["api-keys"]["openai-compatibility"][0]?.models).toEqual([{ name: "gpt-z" }]);
  });
});
