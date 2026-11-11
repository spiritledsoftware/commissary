// End-to-end (workerd, real SessionState Durable Object): replay and continuation state written while serving one
// request is found by the next request, which is a separate Worker invocation with its own request context.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.ts";
import { credential, makeGeminiHarness } from "./support/gemini.ts";
import { nativeGeminiSignature } from "./support/gemini-signatures.ts";
import { jsonResponse, loadConfig, postJson, sseResponse } from "./support/pipeline.ts";

let config: Config;

beforeAll(async () => {
  config = await loadConfig("");
});

const SIG = "CiQBsignature-from-upstream-0001";

describe("Antigravity reasoning replay across invocations", () => {
  const cred = credential("antigravity", `antigravity-replay-${crypto.randomUUID()}.json`, {
    kind: "oauth",
    metadata: { access_token: "ya29.token", project_id: "proj-1" },
  });

  const models = { "gemini-2.5-flash": ["antigravity"] };

  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "read",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
  ];

  it("re-attaches the thought signature the client dropped (non-stream)", async () => {
    let turn = 0;

    const h = makeGeminiHarness({
      config,
      credential: cred,
      models,
      respond: () => {
        turn++;

        return turn === 1
          ? jsonResponse({
              response: {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: { name: "read_file", args: { path: "a.txt" } },
                          thoughtSignature: SIG,
                        },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
              },
            })
          : jsonResponse({
              response: {
                candidates: [
                  { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
                ],
                usageMetadata: {
                  promptTokenCount: 9,
                  candidatesTokenCount: 1,
                  totalTokenCount: 10,
                },
              },
            });
      },
    });

    afterAll(h.dispose);
    const user = `read the file ${crypto.randomUUID()}`;

    const first = await h.call(
      "/v1/chat/completions",
      postJson({ model: "gemini-2.5-flash", tools, messages: [{ role: "user", content: user }] }),
    );

    expect(first.status).toBe(200);

    const call = (
      (await first.json()) as { choices: Array<{ message: { tool_calls: Array<{ id: string }> } }> }
    ).choices[0]?.message.tool_calls[0];

    expect(call).toBeDefined();

    // Signatures never reach OpenAI clients: the second turn arrives without one.
    const second = await h.call(
      "/v1/chat/completions",
      postJson({
        model: "gemini-2.5-flash",
        tools,
        messages: [
          { role: "user", content: user },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call?.id ?? "",
                type: "function",
                function: { name: "read_file", arguments: '{"path":"a.txt"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: call?.id ?? "", content: "file contents" },
        ],
      }),
    );

    expect(second.status).toBe(200);

    const sent = JSON.parse(h.calls[1]?.body ?? "{}") as {
      request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    };

    const modelTurn = sent.request.contents.find((content) => content.role === "model");
    expect(modelTurn?.parts[0]?.["thoughtSignature"]).toBe(SIG);
  });

  it("commits the ledger before a Responses stream completes", async () => {
    let turn = 0;

    const h = makeGeminiHarness({
      config,
      credential: cred,
      models,
      respond: () => {
        turn++;

        return turn === 1
          ? sseResponse([
              `data: ${JSON.stringify({
                response: {
                  candidates: [
                    {
                      content: {
                        role: "model",
                        parts: [
                          {
                            functionCall: { name: "read_file", args: { path: "b.txt" } },
                            thoughtSignature: SIG,
                          },
                        ],
                      },
                      finishReason: "STOP",
                    },
                  ],
                  usageMetadata: {
                    promptTokenCount: 5,
                    candidatesTokenCount: 2,
                    totalTokenCount: 7,
                  },
                },
              })}\n\n`,
            ])
          : jsonResponse({
              response: {
                candidates: [
                  { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
                ],
              },
            });
      },
    });

    afterAll(h.dispose);
    const prompt = `read b ${crypto.randomUUID()}`;

    const responsesTools = [
      {
        type: "function",
        name: "read_file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    const first = await h.call(
      "/v1/responses",
      postJson({ model: "gemini-2.5-flash", stream: true, tools: responsesTools, input: prompt }),
    );

    const text = await first.text();
    expect(text).toContain("response.completed");
    const callId = /"call_id":"([^"]+)"/.exec(text)?.[1];
    expect(callId).toBeDefined();

    const second = await h.call(
      "/v1/responses",
      postJson({
        model: "gemini-2.5-flash",
        tools: responsesTools,
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
          {
            type: "function_call",
            call_id: callId ?? "",
            name: "read_file",
            arguments: '{"path":"b.txt"}',
          },
          { type: "function_call_output", call_id: callId ?? "", output: "contents" },
        ],
      }),
    );

    expect(second.status).toBe(200);

    const sent = JSON.parse(h.calls[1]?.body ?? "{}") as {
      request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    };

    expect(
      sent.request.contents.find((content) => content.role === "model")?.parts[0]?.[
        "thoughtSignature"
      ],
    ).toBe(SIG);
  });
});

describe("Antigravity Interactions continuation across invocations", () => {
  const cred = credential("gemini-interactions", `gemini-interactions:${crypto.randomUUID()}`, {
    attributes: { api_key: "AIza-native", base_url: "https://gl.test" },
  });

  const models = { "antigravity-preview-05-2026": ["gemini-interactions"] };

  it("continues a requires_action interaction with only the tool results (non-stream and stream)", async () => {
    let turn = 0;

    const h = makeGeminiHarness({
      config,
      credential: cred,
      models,
      respond: () => {
        turn++;

        if (turn === 1) {
          return jsonResponse({
            id: "int_1",
            environment_id: "env_1",
            status: "requires_action",
            steps: [{ type: "function_call", id: "call_1", name: "f", arguments: {} }],
          });
        }

        return jsonResponse({ id: "int_2", status: "completed", steps: [] });
      },
    });

    afterAll(h.dispose);
    const prompt = `hello ${crypto.randomUUID()}`;
    const user = { type: "user_input", content: [{ type: "text", text: prompt }] };

    const first = await h.call(
      "/v1beta/interactions",
      postJson({ model: "antigravity-preview-05-2026", input: [user] }),
    );

    expect(first.status).toBe(200);

    const second = await h.call(
      "/v1beta/interactions",
      postJson({
        model: "antigravity-preview-05-2026",
        input: [
          user,
          { type: "function_call", id: "call_1", name: "f", arguments: {} },
          { type: "function_result", call_id: "call_1", result: "ok" },
        ],
      }),
    );

    expect(second.status).toBe(200);
    const sent = JSON.parse(h.calls[1]?.body ?? "{}") as Record<string, unknown>;
    expect(sent["previous_interaction_id"]).toBe("int_1");
    expect(sent["environment_id"]).toBe("env_1");
    expect(sent["input"]).toEqual([{ type: "function_result", call_id: "call_1", result: "ok" }]);
  });

  it("leaves other models alone", async () => {
    const h = makeGeminiHarness({
      config,
      credential: cred,
      models: { "gemini-2.5-pro": ["gemini-interactions"] },
      respond: () =>
        jsonResponse({
          id: "int_x",
          status: "requires_action",
          steps: [{ type: "function_call", id: "c" }],
        }),
    });

    afterAll(h.dispose);

    const user = {
      type: "user_input",
      content: [{ type: "text", text: `x ${crypto.randomUUID()}` }],
    };

    await h.call("/v1beta/interactions", postJson({ model: "gemini-2.5-pro", input: [user] }));
    await h.call(
      "/v1beta/interactions",
      postJson({
        model: "gemini-2.5-pro",
        input: [user, { type: "function_result", call_id: "c", result: "ok" }],
      }),
    );
    expect(
      (JSON.parse(h.calls[1]?.body ?? "{}") as Record<string, unknown>)["previous_interaction_id"],
    ).toBeUndefined();
  });
});

// Go cc95661c: the Gemini API and Vertex executors keep the signature of a tool call in their own SessionState store, so
// an OpenAI chat client (which never carries it) gets it back on the next turn, from a separate Worker invocation.
describe.each([
  [
    "gemini",
    "https://gl.test/v1beta/models/gemini-3-pro-preview:generateContent",
    { api_key: "AIza-test", base_url: "https://gl.test" },
  ],
  [
    "vertex",
    "https://vx.test/v1/publishers/google/models/gemini-3-pro-preview:generateContent",
    { api_key: "vk-1", base_url: "https://vx.test" },
  ],
])("%s reasoning replay across invocations", (provider, url, attributes) => {
  const cred = credential(provider, `${provider}-replay-${crypto.randomUUID()}`, {
    attributes,
  });

  it("re-attaches the thought signature the client dropped", async () => {
    const signature = nativeGeminiSignature();

    const h = makeGeminiHarness({
      config,
      credential: cred,
      models: { "gemini-3-pro-preview": [provider] },
      respond: (call) =>
        jsonResponse(
          call.body.includes("functionResponse")
            ? {
                candidates: [
                  { content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" },
                ],
              }
            : {
                candidates: [
                  {
                    content: {
                      role: "model",
                      parts: [
                        {
                          functionCall: { name: "read_file", args: { path: "a.txt" } },
                          thoughtSignature: signature,
                        },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
              },
        ),
    });

    afterAll(h.dispose);

    const user = `read the file ${crypto.randomUUID()}`;
    const session = { "Session-Id": crypto.randomUUID() };

    const tools = [
      {
        type: "function",
        function: { name: "read_file", parameters: { type: "object", properties: {} } },
      },
    ];

    const first = await h.call(
      "/v1/chat/completions",
      postJson(
        { model: "gemini-3-pro-preview", tools, messages: [{ role: "user", content: user }] },
        session,
      ),
    );

    expect(first.status).toBe(200);

    const id =
      (
        (await first.json()) as {
          choices: Array<{ message: { tool_calls: Array<{ id: string }> } }>;
        }
      ).choices[0]?.message.tool_calls[0]?.id ?? "";

    const second = await h.call(
      "/v1/chat/completions",
      postJson(
        {
          model: "gemini-3-pro-preview",
          tools,
          messages: [
            { role: "user", content: user },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id,
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            { role: "tool", tool_call_id: id, content: "file contents" },
          ],
        },
        session,
      ),
    );

    expect(second.status).toBe(200);
    expect(h.calls[1]?.url).toBe(url);

    const sent = JSON.parse(h.calls[1]?.body ?? "{}") as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };

    const modelTurn = sent.contents.find((content) => content.role === "model");
    expect(modelTurn?.parts[0]?.["thoughtSignature"]).toBe(signature);
  });
});
