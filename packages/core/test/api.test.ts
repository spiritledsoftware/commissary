import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentInstallationError,
  Codec,
  Content,
  Context,
  MessageData,
  Model,
  ProviderOptions,
  ProviderData,
  Transcript,
  Tool,
  commissary,
  type ThreadStore,
} from "../src/index.js";
import { stringSchema, testSchema } from "./support.js";

const model = Model.define({
  id: "test-model",
  async *invoke() {
    yield {
      type: "finish" as const,
      response: {
        message: { role: "assistant" as const, content: [Content.text("ok")] },
        finishReason: "stop" as const,
      },
    };
  },
});

const unusedStore = {} as ThreadStore;

describe("canonical protocol", () => {
  it("renders Message Data after content using deterministic JSON", () => {
    const messages = Transcript.toModelMessages([
      {
        role: "user",
        content: [Content.text("hello")],
        data: [
          {
            key: "example/profile",
            version: 2,
            value: { z: 2, a: 1 },
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "text",
            text: '{"key":"example/profile","value":{"a":1,"z":2},"version":2}',
          },
        ],
      },
    ]);
  });

  it("preserves Provider Data on its Content Part without rendering it", async () => {
    const anthropic = ProviderData.define({
      namespace: "anthropic",
      version: 1,
      codec: Codec.define({
        encode(value: { readonly signature: string }) {
          return { signature: value.signature };
        },
        decode(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("signature" in value) ||
            typeof value.signature !== "string"
          ) {
            throw new TypeError("invalid signature");
          }
          return { signature: value.signature };
        },
      }),
    });
    const reasoning = await anthropic.attach(Content.reasoning("summary"), {
      signature: "signed",
    });
    const messages = Transcript.toModelMessages([
      {
        role: "assistant",
        content: [reasoning],
      },
    ]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "summary",
            providerData: [
              {
                namespace: "anthropic",
                version: 1,
                value: { signature: "signed" },
              },
            ],
          },
        ],
      },
    ]);
    await expect(anthropic.decode(reasoning)).resolves.toEqual({ signature: "signed" });
  });

  it("creates normalized URL and document Source Parts", () => {
    expect(
      Content.source({
        sourceType: "url",
        id: "source-1",
        url: "https://example.com/reference",
        title: "Reference",
      }),
    ).toEqual({
      type: "source",
      sourceType: "url",
      id: "source-1",
      url: "https://example.com/reference",
      title: "Reference",
    });
    expect(
      Content.source({
        sourceType: "document",
        id: "document-1",
        mediaType: "application/pdf",
        title: "Manual",
        fileName: "manual.pdf",
      }),
    ).toEqual({
      type: "source",
      sourceType: "document",
      id: "document-1",
      mediaType: "application/pdf",
      title: "Manual",
      fileName: "manual.pdf",
    });
  });

  it("attaches, decodes, and collects typed Message Data", async () => {
    const profile = MessageData.define({
      key: "example/profile",
      version: 1,
      codec: Codec.define({
        encode(value: { readonly name: string }) {
          return { name: value.name };
        },
        decode(value) {
          if (
            typeof value !== "object" ||
            value === null ||
            !("name" in value) ||
            typeof value.name !== "string"
          ) {
            throw new TypeError("invalid profile");
          }
          return { name: value.name };
        },
      }),
    });

    const message = await profile.attach(
      { role: "user", content: [Content.text("hello")] },
      { name: "Ada" },
    );
    await expect(profile.collect([message])).resolves.toEqual([{ name: "Ada" }]);
  });

  it("creates typed namespaced Provider Options", () => {
    const options = ProviderOptions.define("openai");
    expect(options.make({ reasoningEffort: "high" })).toEqual({
      namespace: "openai",
      value: { reasoningEffort: "high" },
    });
  });
});

describe("Tool schema installation", () => {
  it("defers invalid input schema rejection until Agent installation", () => {
    const invalidInput = testSchema(
      (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      { type: "object", invalid: undefined },
    );
    const invalidTool = Tool.define({
      name: "invalid-schema",
      input: invalidInput,
      output: stringSchema,
      handler: () => "unused",
    });
    const agent = Agent.define({
      id: "invalid-schema-agent",
      fragments: Agent.combine(model, invalidTool),
    });
    const app = commissary({ threadStore: unusedStore });

    expect(() => app.agent(agent)).toThrowError(
      "Tool 'invalid-schema' has an invalid input JSON Schema",
    );
  });
});

describe("Agent composition", () => {
  it("preserves contribution order across parenthesization", () => {
    const first = Context.define({ id: "first", render: () => [] });
    const second = Context.define({ id: "second", render: () => [] });
    const left = Agent.define({
      id: "assistant",
      fragments: Agent.combine(Agent.combine(first, second), model),
    });
    const right = Agent.define({
      id: "assistant",
      fragments: Agent.combine(first, Agent.combine(second, model)),
    });

    const leftApp = commissary({ threadStore: unusedStore });
    const rightApp = commissary({ threadStore: unusedStore });

    expect(leftApp.agent(left).reference.revision).toBe(rightApp.agent(right).reference.revision);
  });

  it("reports duplicate contribution positions during installation", () => {
    const duplicate = Context.define({ id: "duplicate", render: () => [] });
    const agent = Agent.define({
      id: "assistant",
      fragments: Agent.combine(duplicate, duplicate, model),
    });

    const app = commissary({ threadStore: unusedStore });
    expect(() => app.agent(agent)).toThrow(AgentInstallationError);
  });

  it("rejects a different Agent definition with an installed ID", () => {
    const first = Agent.define({ id: "assistant", fragments: model });
    const second = Agent.define({ id: "assistant", fragments: model });
    const app = commissary({ threadStore: unusedStore });

    app.agent(first);
    expect(() => app.agent(second)).toThrowError(
      "Agent ID 'assistant' is installed by a different Agent definition",
    );
  });
});
