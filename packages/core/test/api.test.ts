import { describe, expect, it } from "vitest";
import {
  Agent,
  AgentRevision,
  ArtifactId,
  BranchId,
  CommitId,
  AgentInstallationError,
  Codec,
  Content,
  Context,
  MessageData,
  ExecutionClaimToken,
  ExecutionId,
  MessageEntryId,
  Model,
  ProviderOptions,
  ProviderData,
  Transcript,
  Tool,
  RunId,
  ThreadId,
  ToolAttemptId,
  ToolCallId,
  commissary,
  type JsonValue,
  type ModelSchema,
  type ThreadStore,
} from "@commissary/core";
import { isJsonValue } from "../src/runtime/protocol-parsing.js";
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

  it("decodes matching Message Data concurrently and preserves transcript order", async () => {
    let firstDecodeActive = false;
    let secondDecodeOverlapped = false;
    const item = MessageData.define({
      key: "example/concurrent",
      version: 1,
      codec: Codec.define({
        encode(value: string) {
          return value;
        },
        async decode(value) {
          if (typeof value !== "string") {
            throw new TypeError("invalid item");
          }
          if (value === "first") {
            firstDecodeActive = true;
            await new Promise((resolve) => setTimeout(resolve, 25));
            firstDecodeActive = false;
          } else {
            secondDecodeOverlapped = firstDecodeActive;
          }
          return value;
        },
      }),
    });

    await expect(
      item.collect([
        {
          role: "user",
          content: [Content.text("hello")],
          data: [
            { key: "example/concurrent", version: 1, value: "first" },
            { key: "example/concurrent", version: 1, value: "second" },
          ],
        },
      ]),
    ).resolves.toEqual(["first", "second"]);
    expect(secondDecodeOverlapped).toBe(true);
  });

  it("creates typed namespaced Provider Options", () => {
    const options = ProviderOptions.define("openai");
    expect(options.make({ reasoningEffort: "high" })).toEqual({
      namespace: "openai",
      value: { reasoningEffort: "high" },
    });
  });
});
describe("Runtime boundary values", () => {
  it("decodes every opaque ID from a non-empty external string", () => {
    const decoders = [
      AgentRevision,
      ThreadId,
      BranchId,
      MessageEntryId,
      RunId,
      ExecutionId,
      ExecutionClaimToken,
      ToolCallId,
      ToolAttemptId,
      ArtifactId,
      CommitId,
    ];

    for (const decoder of decoders) {
      expect(decoder.decode("id")).toBe("id");
      expect(decoder.is("id")).toBe(true);
      expect(decoder.is("")).toBe(false);
      expect(() => decoder.decode("")).toThrow("must be a non-empty string");
      expect(decoder["~standard"].validate(1)).toMatchObject({
        issues: [{ message: expect.stringContaining("must be a non-empty string") }],
      });
    }
  });

  it("accepts only finite acyclic JSON values with JSON prototypes", () => {
    const shared = { value: 1 };
    const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
      shared,
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const sparse: unknown[] = [];
    sparse.length = 2;
    sparse[0] = 1;
    const extra = [1] as number[] & { extra?: number };
    extra.extra = 2;
    class RecordInstance {
      readonly value = 1;
    }
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 20_000; index += 1) {
      const child: Record<string, unknown> = {};
      deep.child = child;
      deep = child;
    }

    expect(isJsonValue([shared, shared, nullPrototype, root])).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(1n)).toBe(false);
    expect(isJsonValue(Symbol("value"))).toBe(false);
    expect(isJsonValue(new Date())).toBe(false);
    expect(isJsonValue(new Map())).toBe(false);
    expect(isJsonValue(new Set())).toBe(false);
    expect(isJsonValue(new RecordInstance())).toBe(false);
    expect(isJsonValue(cycle)).toBe(false);
    expect(isJsonValue(sparse)).toBe(false);
    expect(isJsonValue(extra)).toBe(false);
  });
});

describe("Tool schema installation", () => {
  it("defers invalid input schema rejection until Agent installation", () => {
    const invalidInput = testSchema(
      (value): value is Record<string, JsonValue> => typeof value === "object" && value !== null,
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
  it("caches successful JSON Schema conversions by Model Schema identity", () => {
    let successfulConversions = 0;
    const sharedInput: ModelSchema<string> = {
      "~standard": {
        version: 1,
        vendor: "schema-cache-test",
        validate(value) {
          return typeof value === "string"
            ? { value }
            : { issues: [{ message: "Expected string" }] };
        },
        jsonSchema: {
          input() {
            successfulConversions += 1;
            return { type: "string" };
          },
          output() {
            return { type: "string" };
          },
        },
      },
    };

    const first = Tool.define({
      name: "schema-cache-first",
      input: sharedInput,
      output: stringSchema,
      handler: (value) => value,
    });
    const second = Tool.define({
      name: "schema-cache-second",
      input: sharedInput,
      output: stringSchema,
      handler: (value) => value,
    });
    commissary({ threadStore: unusedStore }).agent(
      Agent.define({
        id: "schema-cache-agent",
        fragments: Agent.combine(model, first, second),
      }),
    );
    expect(successfulConversions).toBe(1);

    let failedConversions = 0;
    const invalidInput: ModelSchema<string> = {
      "~standard": {
        ...sharedInput["~standard"],
        jsonSchema: {
          input() {
            failedConversions += 1;
            return { type: "string", invalid: undefined };
          },
          output() {
            return { type: "string" };
          },
        },
      },
    };
    for (const name of ["schema-cache-invalid-first", "schema-cache-invalid-second"]) {
      const invalidTool = Tool.define({
        name,
        input: invalidInput,
        output: stringSchema,
        handler: (value) => value,
      });
      expect(() =>
        commissary({ threadStore: unusedStore }).agent(
          Agent.define({
            id: `${name}-agent`,
            fragments: Agent.combine(model, invalidTool),
          }),
        ),
      ).toThrow("invalid input JSON Schema");
    }
    expect(failedConversions).toBe(2);
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

  it("reuses the client and its subscription registry for one Agent definition", () => {
    const agent = Agent.define({ id: "assistant", fragments: model });
    const app = commissary({ threadStore: unusedStore });

    expect(app.agent(agent)).toBe(app.agent(agent));
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
