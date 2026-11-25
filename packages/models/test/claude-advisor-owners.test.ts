// Advisor block ownership across a credential rebind (Go: helps/claude_advisor_state_test.go, claude_issue7638_test.go;
// CLIProxyAPI 91a3f455): blocks another credential minted are stripped before upstream, the own ones stay.
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import {
  advisorCredentialOwner,
  makeMemoryAdvisorOwnerStore,
  stripForeignAdvisorBlocks,
} from "../src/executor/claude/advisor-owners.ts";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { collectStream, credential, execute, harness, options } from "./support/executor-run.ts";

const ADVISOR_ID = "srvtoolu_adv1";

const advisorCall: JsonObject = {
  type: "server_tool_use",
  id: ADVISOR_ID,
  name: "advisor",
  input: {},
};

const advisorResult: JsonObject = {
  type: "advisor_tool_result",
  tool_use_id: ADVISOR_ID,
  content: { type: "advisor_redacted_result", encrypted_content: "enc" },
};

describe("stripForeignAdvisorBlocks", () => {
  const conversation = (): JsonObject => ({
    messages: [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [{ type: "text", text: "thinking it over" }, advisorCall, advisorResult],
      },
      { role: "assistant", content: [{ ...advisorCall, id: "srvtoolu_other" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [
              { type: "text", text: "file" },
              { type: "advisor_redacted_result", encrypted_content: "x" },
            ],
          },
        ],
      },
      { role: "user", content: "next" },
    ],
  });

  const owners = new Map([
    [ADVISOR_ID, "id:a"],
    ["srvtoolu_other", "id:a"],
    ["toolu_1", "id:a"],
  ]);

  it("drops another credential's blocks and the turns they leave empty", () => {
    const body = conversation();
    const { stripped, unknownIds } = stripForeignAdvisorBlocks(body, owners, "id:b");

    expect(stripped).toBe(4);
    expect(unknownIds).toEqual([]);
    expect(body.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "thinking it over" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }],
      },
      // An ordinary tool's result keeps its pair and loses only the advisor part.
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "file" }],
          },
        ],
      },
      { role: "user", content: "next" },
    ]);
  });

  it("keeps the own credential's blocks and reports the unknown ones", () => {
    const own = conversation();

    expect(stripForeignAdvisorBlocks(own, owners, "id:a").stripped).toBe(0);
    expect(own).toEqual(conversation());

    const unknown = conversation();
    const result = stripForeignAdvisorBlocks(unknown, new Map(), "id:b");

    expect(result.stripped).toBe(0);
    expect(result.unknownIds).toEqual([ADVISOR_ID, "srvtoolu_other", "toolu_1"]);
    expect(unknown).toEqual(conversation());
  });
});

describe("credential rebind through the executor", () => {
  const yaml = `
api-keys:
  claude:
    - base-url: https://gateway.test
      keys: [{ api-key: key-a }, { api-key: key-b }]
`;

  const claudeCredential = (id: string, key: string) =>
    credential("claude", {
      id,
      kind: "apikey",
      attributes: { api_key: key, base_url: "https://gateway.test" },
    });

  const reply: JsonObject = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [advisorCall, advisorResult, { type: "text", text: "advised" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };

  const opts = () =>
    options({
      sourceFormat: "claude",
      metadata: { ...options().metadata, requestPath: "/v1/messages" },
    });

  const followUp = {
    model: "claude-opus-5-5",
    payload: {
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [advisorCall, advisorResult, { type: "text", text: "advised" }],
        },
        { role: "user", content: "and then?" },
      ],
    },
  };

  const sentMessages = (text: string | undefined): JsonObject[] =>
    (JSON.parse(text ?? "{}") as { messages: JsonObject[] }).messages;

  const first = {
    model: "claude-opus-5-5",
    payload: {
      model: "claude-opus-5-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "q" }],
    },
  };

  it("strips the advisor blocks a whole response minted once the conversation moves", async () => {
    const executor = makeClaudeExecutor({ advisorOwners: makeMemoryAdvisorOwnerStore() });

    const a = await harness(
      claudeCredential("claude-a", "key-a"),
      () => Response.json(reply),
      yaml,
    );

    const b = await harness(
      claudeCredential("claude-b", "key-b"),
      () => Response.json(reply),
      yaml,
    );

    await execute(executor, a, first, opts());

    await execute(executor, b, followUp, opts());
    expect(sentMessages(b.calls[0]?.text)[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "advised" }],
    });

    // The minting credential keeps its own advisor state.
    await execute(executor, a, followUp, opts());
    expect(sentMessages(a.calls[1]?.text)[1]?.content).toHaveLength(3);
  });

  it("records the advisor blocks of a stream as they start", async () => {
    const executor = makeClaudeExecutor({ advisorOwners: makeMemoryAdvisorOwnerStore() });

    const events = [
      { type: "message_start", message: { ...reply, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: advisorCall },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: advisorResult },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ];

    const sse = () =>
      new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } },
      );

    const a = await harness(claudeCredential("claude-a", "key-a"), sse, yaml, true);

    const b = await harness(
      claudeCredential("claude-b", "key-b"),
      () => Response.json(reply),
      yaml,
    );

    await collectStream(executor, a, first, { ...opts(), stream: true });
    await execute(executor, b, followUp, opts());

    expect(sentMessages(b.calls[0]?.text)[1]?.content).toEqual([{ type: "text", text: "advised" }]);
  });

  it("takes over the unknown blocks of a request the upstream accepted", async () => {
    const store = makeMemoryAdvisorOwnerStore();
    const executor = makeClaudeExecutor({ advisorOwners: store });
    const plain = { ...reply, content: [{ type: "text", text: "ok" }] };

    const b = await harness(
      claudeCredential("claude-b", "key-b"),
      () => Response.json(plain),
      yaml,
    );

    // History minted somewhere unknown (another instance, an expired owner): credential b sends and then owns it.
    await execute(executor, b, followUp, opts());
    expect(sentMessages(b.calls[0]?.text)[1]?.content).toHaveLength(3);

    const owners = await Effect.runPromise(
      store.lookup({ callerScope: "scope", provider: "claude" }, [ADVISOR_ID]),
    );

    expect(owners.get(ADVISOR_ID)).toBe(
      advisorCredentialOwner(claudeCredential("claude-b", "key-b")),
    );
  });
});
