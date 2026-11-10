// Claude parity backlog (#29): device-profile stabiliser, `rebuild-mid-system-message`, Thread continuation alias
// state, the post-payload Fable/Opus-5.5 and system-placement reconcilers, and the `experimental-cch-signing` key.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import {
  captureFableState,
  captureSystemPlacement,
  reconcileFableModelAfterPayload,
  reconcileSystemPlacementAfterPayload,
} from "../src/executor/claude/reconcile.ts";
import { makeMemoryDeviceProfileStore } from "../src/executor/claude/device-profile.ts";
import { makeMemoryToolAliasStore } from "../src/executor/claude/thread.ts";
import { makeMemoryContinuityStore } from "../src/executor/claude/continuity.ts";
import fixtures from "./fixtures/claude-profile.json";
import { rebuildMidSystemMessagesToTopLevel } from "../src/executor/claude/mid-system.ts";
import {
  threadAliasKeys,
  threadContinuationNeedsAliasState,
  threadNotFoundError,
} from "../src/executor/claude/thread.ts";
import { asString, type Json, type JsonObject } from "@commissary/json";
import { credential, execute, harness, json, loadConfig, options } from "./support/executor-run.ts";

const obj = (value: Json): JsonObject => value as JsonObject;

const ok = (extra: JsonObject = {}) =>
  Response.json({
    id: "msg_1",
    type: "message",
    model: "claude-3-5-sonnet",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  });

const NATIVE_HEADERS = {
  "user-agent": "claude-cli/2.1.321 (external, cli)",
  "x-app": "cli",
  "anthropic-beta": "claude-code-20250219",
};

const USER_ID = JSON.stringify({
  device_id: "0".repeat(64),
  account_uuid: "",
  session_id: "11111111-2222-4333-8444-555555555555",
});

const gatewayCredential = credential("claude", {
  kind: "apikey",
  attributes: { api_key: "key-123", base_url: "https://claude.test" },
});

const claudeKeyConfig = (extra = "") => `
api-keys:
  claude:
    - base-url: https://claude.test
      keys:
        - api-key: key-123
          ${extra}
`;

const run = async (
  yaml: string,
  payload: JsonObject,
  headers: Record<string, string> = NATIVE_HEADERS,
  cred = gatewayCredential,
) => {
  const h = await harness(cred, () => ok(), yaml);
  await execute(
    makeClaudeExecutor({
      continuity: makeMemoryContinuityStore(),
      deviceProfiles: makeMemoryDeviceProfileStore(),
    }),
    h,
    { model: "claude-3-5-sonnet-20241022", payload: json(payload) },
    options({ sourceFormat: "claude", headers: new Headers(headers) }),
  );

  return { calls: h.calls, body: JSON.parse(h.calls[0]?.text ?? "{}") as JsonObject };
};

describe("rebuild-mid-system-message (TestClaudeExecutor_RebuildMidSystemMessage*)", () => {
  const payload = (system: Json) => ({
    system,
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "system", content: "Mid string rule" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "system",
        content: [{ type: "text", text: "Mid array rule", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: [{ type: "text", text: "continue" }] },
    ],
    metadata: { user_id: USER_ID },
  });

  it("is disabled by default: the mid-conversation system message is forwarded", async () => {
    const { body } = await run(
      claudeKeyConfig(),
      obj({
        system: [{ type: "text", text: "Top rule", cache_control: { type: "ephemeral" } }],
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "system", content: "Mid rule" },
          { role: "user", content: [{ type: "text", text: "continue" }] },
        ],
        metadata: { user_id: USER_ID },
      }),
    );

    expect((body.system as JsonObject[])[0]?.text).toBe("Top rule");
    expect(
      (body.messages as JsonObject[]).find((message) => message.role === "system")?.content,
    ).toBe("Mid rule");
  });

  it("opt-in moves the system messages into the top-level system field in order", async () => {
    const { body } = await run(
      claudeKeyConfig("rebuild-mid-system-message: true"),
      obj(payload("Top rule")),
    );

    const system = body.system as JsonObject[];
    expect(system.map((block) => block.text)).toEqual([
      "Top rule",
      "Mid string rule",
      "Mid array rule",
    ]);
    expect(system[2]?.cache_control).toEqual({ type: "ephemeral" });
    expect((body.messages as JsonObject[]).some((message) => message.role === "system")).toBe(
      false,
    );
    expect(body.messages).toHaveLength(3);
  });

  it("the credential attribute enables it as well", async () => {
    const h = await harness(
      credential("claude", {
        kind: "apikey",
        attributes: {
          api_key: "key-x",
          base_url: "https://claude.test",
          rebuild_mid_system_message: "TRUE",
        },
      }),
      () => ok(),
    );

    await execute(
      makeClaudeExecutor({ continuity: makeMemoryContinuityStore() }),
      h,
      { model: "claude-3-5-sonnet-20241022", payload: json(payload("Top")) },
      options({ sourceFormat: "claude", headers: new Headers(NATIVE_HEADERS) }),
    );
    const sent = JSON.parse(h.calls[0]?.text ?? "{}") as JsonObject;
    expect((sent.system as JsonObject[]).map((block) => block.text)).toEqual([
      "Top",
      "Mid string rule",
      "Mid array rule",
    ]);
  });

  it("leaves the body alone when the moved messages carry no text", () => {
    const body = obj({
      system: "S",
      messages: [
        { role: "user", content: "a" },
        { role: "system", content: "  " },
      ],
    });

    const before = JSON.stringify(body);
    rebuildMidSystemMessagesToTopLevel(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it("keeps string, blank and non-text items like claudeSystemTextParts", () => {
    const body = obj({
      system: [{ type: "text", text: "A" }, { type: "image" }, { type: "text", text: " " }],
      messages: [
        {
          role: "System",
          content: ["B", " ", { type: "text", text: "C" }, { type: "tool_addition" }],
        },
        { role: "user", content: "u" },
      ],
    });

    rebuildMidSystemMessagesToTopLevel(body);
    expect(body.system).toEqual([
      { type: "text", text: "A" },
      { type: "text", text: "B" },
      { type: "text", text: "C" },
    ]);
    expect(body.messages).toEqual([{ role: "user", content: "u" }]);
  });
});

describe("device profile stabiliser (stabilize-device-profile)", () => {
  const STABLE =
    "upstream:\n  claude:\n    header-defaults:\n      stabilize-device-profile: true\n";

  const withSdk = (extra: Record<string, string>) => ({
    ...NATIVE_HEADERS,
    "x-stainless-package-version": "0.128.0",
    "x-stainless-runtime-version": "v26.12.1",
    ...extra,
  });

  const body = (): JsonObject =>
    obj({
      messages: [{ role: "user", content: "hi" }],
      metadata: { user_id: USER_ID },
      max_tokens: 5,
    });

  const oauthCredential = credential("claude", {
    kind: "oauth",
    metadata: { access_token: "sk-ant-oat01-profile" },
  });

  const sentProfile = async (
    headers: Record<string, string>,
    config = STABLE + claudeKeyConfig(),
    cred = gatewayCredential,
  ) => {
    const { calls } = await run(config, body(), headers, cred);
    const sent = calls[0]?.headers ?? {};

    return {
      userAgent: sent["user-agent"],
      os: sent["x-stainless-os"],
      arch: sent["x-stainless-arch"],
      packageVersion: sent["x-stainless-package-version"],
      runtimeVersion: sent["x-stainless-runtime-version"],
    };
  };

  it("a confirmed client's profile is pinned to the configured platform and kept for the credential", async () => {
    const store = makeMemoryDeviceProfileStore();

    const resolve = (...args: Parameters<typeof store.resolve>) =>
      Effect.runPromise(store.resolve(...args));

    const config = await loadConfig(STABLE + claudeKeyConfig());
    const baseline = await resolve({ id: "c1" }, "k", new Headers(), config);
    expect(baseline).toEqual({
      userAgent: "claude-cli/2.1.321 (external, cli)",
      packageVersion: "0.128.0",
      runtimeVersion: "v26.12.1",
      os: "MacOS",
      arch: "arm64",
    });

    const headers = new Headers(
      withSdk({
        "user-agent": "claude-cli/2.1.321 (external, sdk-cli)",
        "x-stainless-os": "Linux",
        "x-stainless-arch": "x64",
      }),
    );

    const sdk = await resolve({ id: "c1" }, "k", headers, config);
    expect(sdk).toMatchObject({
      userAgent: "claude-cli/2.1.321 (external, sdk-cli)",
      os: "MacOS",
      arch: "arm64",
    });
    // The sdk-cli client has its own scope, the plain CLI scope keeps resolving to the baseline.
    expect(await resolve({ id: "c1" }, "k", new Headers(), config)).toEqual(baseline);
    // The sdk scope is found again by a candidate of the same scope, but never by a request without one.
    expect(await resolve({ id: "c2" }, "k", new Headers(), config)).toEqual(baseline);
  });

  it("candidates that differ from the baseline software tuple are ignored", async () => {
    const store = makeMemoryDeviceProfileStore();

    const resolve = (...args: Parameters<typeof store.resolve>) =>
      Effect.runPromise(store.resolve(...args));

    const config = await loadConfig(STABLE);

    for (const headers of [
      withSdk({ "user-agent": "claude-cli/2.1.322 (external, cli)" }),
      withSdk({ "x-stainless-package-version": "0.200.0" }),
      withSdk({ "x-stainless-runtime-version": "v99.0.0" }),
      { ...NATIVE_HEADERS, "user-agent": "curl/8.0" },
    ]) {
      const resolved = await resolve({ id: "c" }, "k", new Headers(headers), config);
      expect(resolved.userAgent).toBe("claude-cli/2.1.321 (external, cli)");
    }
  });

  it("invalid Stainless versions fall back to the baseline tuple", async () => {
    const store = makeMemoryDeviceProfileStore();

    const resolve = (...args: Parameters<typeof store.resolve>) =>
      Effect.runPromise(store.resolve(...args));

    const config = await loadConfig(STABLE);

    const resolved = await resolve(
      { id: "c" },
      "k",
      new Headers(
        withSdk({
          "x-stainless-package-version": "not-a-version",
          "x-stainless-runtime-version": "node20",
        }),
      ),
      config,
    );

    expect(resolved).toMatchObject({ packageVersion: "0.128.0", runtimeVersion: "v26.12.1" });
  });

  it("the executor sends the stabilised profile to the upstream, the baseline to unconfirmed clients", async () => {
    const confirmed = await sentProfile(
      withSdk({
        "user-agent": "claude-cli/2.1.321 (external, sdk-cli)",
        "x-stainless-os": "Linux",
        "x-stainless-arch": "x64",
      }),
    );

    expect(confirmed).toEqual({
      userAgent: "claude-cli/2.1.321 (external, sdk-cli)",
      os: "MacOS",
      arch: "arm64",
      packageVersion: "0.128.0",
      runtimeVersion: "v26.12.1",
    });

    const unconfirmed = await sentProfile(
      { "user-agent": "my-app/1.0", "x-stainless-os": "Linux" },
      STABLE + claudeKeyConfig(),
      oauthCredential,
    );

    expect(unconfirmed).toMatchObject({
      userAgent: "claude-cli/2.1.321 (external, cli)",
      os: "MacOS",
      arch: "arm64",
    });
  });

  it("without the feature the legacy rules copy the confirmed client's platform", async () => {
    const legacy = await sentProfile(
      withSdk({ "x-stainless-os": "Linux", "x-stainless-arch": "x64" }),
      claudeKeyConfig(),
    );

    expect(legacy).toMatchObject({ os: "Linux", arch: "x64" });
  });

  it("honours a configured baseline", async () => {
    const store = makeMemoryDeviceProfileStore();

    const resolve = (...args: Parameters<typeof store.resolve>) =>
      Effect.runPromise(store.resolve(...args));

    const config = await loadConfig(
      "upstream:\n  claude:\n    header-defaults:\n      stabilize-device-profile: true\n      user-agent: claude-cli/2.2.0 (external, cli)\n      os: Linux\n",
    );

    expect(await resolve({ id: "x" }, "k", new Headers(), config)).toMatchObject({
      userAgent: "claude-cli/2.2.0 (external, cli)",
      os: "Linux",
    });
  });
});

describe("device profile stabiliser (Go parity, helps.ResolveClaudeDeviceProfile)", () => {
  for (const scenario of fixtures) {
    it(scenario.name, async () => {
      const defaults = scenario.defaults as Record<string, unknown>;

      const yamlKeys = Object.entries({
        "stabilize-device-profile":
          defaults.stabilize_device_profile ?? defaults["stabilize-device-profile"],
        "user-agent": defaults.user_agent ?? defaults["user-agent"],
        "package-version": defaults.package_version ?? defaults["package-version"],
        "runtime-version": defaults.runtime_version ?? defaults["runtime-version"],
        os: defaults.os,
        arch: defaults.arch,
      }).filter(([, value]) => value !== undefined && value !== "");

      const config = await loadConfig(
        `upstream:\n  claude:\n    header-defaults:\n${yamlKeys.map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`).join("\n")}\n`,
      );

      const store = makeMemoryDeviceProfileStore();
      const results: unknown[] = [];

      for (const step of scenario.steps) {
        const headers = new Headers((step.headers ?? {}) as Record<string, string>);

        const resolved = await Effect.runPromise(
          store.resolve({ id: step.authId }, step.apiKey, headers, config),
        );

        results.push(resolved);
      }

      expect(results).toEqual(
        scenario.steps.map((step) => ({
          userAgent: step.want.userAgent,
          packageVersion: step.want.packageVersion,
          runtimeVersion: step.want.runtimeVersion,
          os: step.want.os,
          arch: step.want.arch,
        })),
      );
    });
  }
});

describe("Thread continuation alias state", () => {
  it("builds the alias keys and detects tool-less continuations", () => {
    expect(
      threadAliasKeys(obj({ thread: { type: "continue", previous_message_id: "msg-1" } }), "msg-2"),
    ).toEqual(["message:msg-1", "message:msg-2"]);
    expect(threadAliasKeys(obj({ thread: { type: "create" } }), "msg-2")).toEqual([
      "message:msg-2",
    ]);
    const needs = (body: Json) => threadContinuationNeedsAliasState(obj(body));
    expect(needs({ thread: { type: "continue", previous_message_id: "m" } })).toBe(true);
    expect(needs({ thread: { type: "continue", previous_message_id: "m" }, tools: [] })).toBe(true);
    expect(
      needs({ thread: { type: "continue", previous_message_id: "m" }, tools: [{ name: "a" }] }),
    ).toBe(false);
    expect(needs({ thread: { type: "continue", previous_message_id: "" } })).toBe(false);
    expect(needs({ thread: { type: "create" } })).toBe(false);
  });

  it("answers a missing thread with a request-scoped Anthropic 404", () => {
    const error = threadNotFoundError();
    expect(error).toMatchObject({ status: 404, requestScoped: true, direct: true });
    expect(JSON.parse(error.message)).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
  });

  it("keeps the newest 1024 messages per caller and isolates callers", async () => {
    const store = makeMemoryToolAliasStore();
    const runIt = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);
    await runIt(store.save("caller", ["message:first"], new Map([["alias", "Read"]])));

    for (let index = 0; index < 1024; index += 1) {
      await runIt(store.save("caller", [`message:m-${index}`], new Map()));
    }

    expect(await runIt(store.load("caller", ["message:first"]))).toBeUndefined();
    expect(await runIt(store.load("caller", ["message:m-1023"]))).toEqual(new Map());
    await runIt(store.save("other", ["message:x"], new Map([["a", "b"]])));
    expect(await runIt(store.load("caller", ["message:x"]))).toBeUndefined();
    expect(await runIt(store.load("other", ["message:missing", "message:x"]))).toEqual(
      new Map([["a", "b"]]),
    );
  });

  const oauth = credential("claude", {
    kind: "oauth",
    metadata: { access_token: "sk-ant-oat01-thread" },
  });

  const createBody = obj({
    model: "claude-sonnet-4-5",
    max_tokens: 64,
    thread: { type: "create" },
    tools: [{ name: "Read", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "read it" }],
  });

  it("restores the client tool name of a continuation without declarations (TestClaudeOAuthToolAliasRestoresContinuationWithoutDeclarations)", async () => {
    const toolAliases = makeMemoryToolAliasStore();

    const executor = makeClaudeExecutor({
      continuity: makeMemoryContinuityStore(),
      toolAliases,
      deviceProfiles: makeMemoryDeviceProfileStore(),
    });

    let upstreamAlias = "";

    const h = await harness(oauth, (call) => {
      const sent = JSON.parse(call.text) as JsonObject;
      const tools = sent.tools as JsonObject[] | undefined;

      if (tools !== undefined && tools.length > 0) upstreamAlias = asString(tools[0]?.name);

      return ok({
        id: `msg_${h.calls.length === 1 ? "one" : "two"}`,
        content: [{ type: "tool_use", id: "toolu_1", name: upstreamAlias, input: {} }],
      });
    });

    const opts = () =>
      options({ sourceFormat: "claude", headers: new Headers({ "user-agent": "my-app/1.0" }) });

    const first = await execute(
      executor,
      h,
      { model: "claude-sonnet-4-5", payload: json(createBody) },
      opts(),
    );

    expect(upstreamAlias).not.toBe("");
    expect(upstreamAlias).not.toBe("Read");
    expect(JSON.parse(h.calls[0]?.text ?? "{}")).toMatchObject({ thread: { type: "create" } });
    expect(await Effect.runPromise(toolAliases.load("scope", ["message:msg_one"]))).toBeDefined();
    expect(JSON.parse(first.payload)).toMatchObject({
      content: [{ type: "tool_use", name: "Read" }],
    });

    const second = await execute(
      executor,
      h,
      {
        model: "claude-sonnet-4-5",
        payload: json({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          thread: { type: "continue", previous_message_id: "msg_one" },
          messages: [
            {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
            },
          ],
        }),
      },
      opts(),
    );

    expect(h.calls).toHaveLength(2);
    // The continuation declares no tools, so no remap happened and the saved aliases restored the name.
    expect((JSON.parse(h.calls[1]?.text ?? "{}") as JsonObject).tools).toBeUndefined();
    expect(JSON.parse(second.payload)).toMatchObject({
      content: [{ type: "tool_use", name: "Read" }],
    });
  });

  it("a continuation of an unknown message is a request-scoped 404 (…MissingContinuationState…)", async () => {
    const executor = makeClaudeExecutor({
      continuity: makeMemoryContinuityStore(),
      toolAliases: makeMemoryToolAliasStore(),
      deviceProfiles: makeMemoryDeviceProfileStore(),
    });

    const h = await harness(oauth, () => ok());

    const failure = await execute(
      executor,
      h,
      {
        model: "claude-sonnet-4-5",
        payload: json({
          model: "claude-sonnet-4-5",
          max_tokens: 64,
          thread: { type: "continue", previous_message_id: "missing-message" },
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      options({ sourceFormat: "claude", headers: new Headers({ "user-agent": "my-app/1.0" }) }),
    ).then(
      () => undefined,
      (error: Json) => error,
    );

    expect(failure).toMatchObject({ status: 404, requestScoped: true });
    expect(h.calls).toHaveLength(0);
  });
});

describe("Fable / Opus-5.5 reconcilers (TestClaudeOpus55FallbackReconcilesAfterModelOverride, ...DisplayAfterThinkingOverride)", () => {
  const before = obj({ model: "claude-opus-5-5", system: [{ type: "text", text: "billing" }] });

  const cloaked = obj({
    model: "claude-opus-5-5",
    fallbacks: [{ model: "claude-opus-4-8" }],
    system: [{ type: "text", text: "billing" }],
  });

  const state = captureFableState(before, cloaked, true);

  it("captures what cloaking injected", () => {
    expect(state).toEqual({
      injectedFallbacks: true,
      injectedDisplay: false,
      injectedReporting: false,
    });
    expect(captureFableState(before, cloaked, false)).toEqual({
      injectedFallbacks: false,
      injectedDisplay: false,
      injectedReporting: false,
    });
  });

  for (const [name, model, probe, want] of [
    ["switch to Sonnet", "claude-sonnet-5", false, undefined],
    ["switch to Fable", "claude-fable-5-1", false, "claude-opus-5"],
    ["same Opus", "claude-opus-5-5", false, "claude-opus-4-8"],
    ["Opus probe", "claude-opus-5-5", true, undefined],
  ] as const) {
    it(`fallback after ${name}`, () => {
      const body = obj({ ...cloaked, model, fallbacks: [{ model: "claude-opus-4-8" }] });
      reconcileFableModelAfterPayload(body, state, false, false, true, probe);
      expect((body.fallbacks as JsonObject[] | undefined)?.[0]?.model).toBe(want);
    });
  }

  it("a Sonnet rewritten to Opus 5.5 gets the Opus fallback", () => {
    const body = obj({ model: "claude-opus-5-5", system: [] });
    reconcileFableModelAfterPayload(
      body,
      { injectedFallbacks: false, injectedDisplay: false, injectedReporting: false },
      false,
      false,
      true,
      false,
    );
    expect(body.fallbacks).toEqual([{ model: "claude-opus-4-8" }]);
  });

  describe("thinking display", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1"]) {
      for (const [name, thinking, injected, touched, want] of [
        [
          "disabled removes synthetic display",
          { type: "disabled", display: "updates" },
          true,
          false,
          undefined,
        ],
        ["missing type removes synthetic display", { display: "updates" }, true, false, undefined],
        [
          "adaptive keeps synthetic display",
          { type: "adaptive", display: "updates" },
          true,
          false,
          "updates",
        ],
        [
          "enabled keeps synthetic display",
          { type: "enabled", budget_tokens: 2048, display: "updates" },
          true,
          false,
          "updates",
        ],
        [
          "caller display stays caller owned",
          { type: "disabled", display: "summarized" },
          false,
          false,
          "summarized",
        ],
        [
          "payload display stays operator owned",
          { type: "disabled", display: "omitted" },
          true,
          true,
          "omitted",
        ],
        ["payload deletion is not refilled", { type: "adaptive" }, true, true, undefined],
      ] as const) {
        it(`${model}: ${name}`, () => {
          const body = obj({ model, thinking });
          reconcileFableModelAfterPayload(
            body,
            { injectedFallbacks: false, injectedDisplay: injected, injectedReporting: false },
            false,
            touched,
            true,
            false,
          );
          expect((body.thinking as JsonObject).display).toBe(want);
        });
      }
    }

    it("removes a synthetic display for a non-progress model", () => {
      const body = obj({
        model: "claude-opus-4-8",
        thinking: { type: "adaptive", display: "updates" },
      });

      reconcileFableModelAfterPayload(
        body,
        { injectedFallbacks: false, injectedDisplay: true, injectedReporting: false },
        false,
        false,
        true,
        false,
      );
      expect((body.thinking as JsonObject).display).toBeUndefined();
    });
  });

  it("moves the reporting block with the model (Fable adds it, anything else drops an injected one)", () => {
    const reporting = (body: JsonObject): boolean =>
      JSON.stringify(body.system ?? "").includes("# Reporting outcomes");

    const fable = obj({ model: "claude-fable-5-1", system: "Caller prompt" });
    reconcileFableModelAfterPayload(
      fable,
      { injectedFallbacks: false, injectedDisplay: false, injectedReporting: false },
      false,
      false,
      true,
      false,
    );
    expect(reporting(fable)).toBe(true);
    expect((fable.system as JsonObject[])[0]).toEqual({ type: "text", text: "Caller prompt" });
    expect(fable.fallbacks).toEqual([{ model: "claude-opus-5" }]);

    const injected = captureFableState(obj({ model: "claude-fable-5-1", system: [] }), fable, true);
    expect(injected.injectedReporting).toBe(true);
    const rewritten = obj({ ...fable, model: "claude-sonnet-5" });
    reconcileFableModelAfterPayload(rewritten, injected, false, false, true, false);
    expect(reporting(rewritten)).toBe(false);
    const probe = obj({ ...fable });
    reconcileFableModelAfterPayload(probe, injected, false, false, true, true);
    expect(reporting(probe)).toBe(false);
  });

  it("does nothing for uncloaked requests", () => {
    const body = obj({ model: "claude-fable-5-1", system: "x" });
    reconcileFableModelAfterPayload(body, state, false, false, false, false);
    expect(body).toEqual({ model: "claude-fable-5-1", system: "x" });
  });
});

describe("system placement reconciler", () => {
  const original = obj({
    model: "claude-sonnet-5",
    system: "Caller rules",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ],
  });

  const cloaked = obj({
    model: "claude-sonnet-5",
    system: [{ type: "text", text: "billing" }],
    messages: [
      { role: "user", content: "hello" },
      {
        role: "system",
        content: [{ type: "text", text: "Caller rules", cache_control: { type: "ephemeral" } }],
      },
      { role: "assistant", content: "hi" },
    ],
  });

  it("captures only the turns cloaking inserted", () => {
    const state = captureSystemPlacement(original, cloaked, true);
    expect(state.texts).toEqual(["Caller rules"]);
    expect(state.insertAt).toBe(1);
    expect(captureSystemPlacement(original, cloaked, false).insertedRaw).toEqual([]);
    expect(
      captureSystemPlacement(obj({ ...original, model: "claude-haiku-4-5" }), cloaked, true)
        .insertedRaw,
    ).toEqual([]);
    // A caller-owned turn (message count unchanged) is not captured.
    expect(captureSystemPlacement(cloaked, cloaked, true).insertedRaw).toEqual([]);
  });

  it("replays the captured turns as a system reminder when the model becomes legacy", () => {
    const state = captureSystemPlacement(original, cloaked, true);
    const body = obj(JSON.parse(JSON.stringify({ ...cloaked, model: "claude-haiku-4-5" })));
    reconcileSystemPlacementAfterPayload(body, state);
    const messages = body.messages as JsonObject[];
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(messages[0])).toContain(
      "<system-reminder>\\nCaller rules\\n</system-reminder>",
    );
  });

  it("fails closed when payload rules touched the turns or the model is still modern", () => {
    const state = captureSystemPlacement(original, cloaked, true);
    const modern = obj(JSON.parse(JSON.stringify(cloaked)));
    reconcileSystemPlacementAfterPayload(modern, state);
    expect(modern).toEqual(cloaked);

    const touched = obj(JSON.parse(JSON.stringify({ ...cloaked, model: "claude-haiku-4-5" })));

    ((touched.messages as JsonObject[])[1] as JsonObject).content = "rewritten";
    const snapshot = JSON.stringify(touched);
    reconcileSystemPlacementAfterPayload(touched, state);
    expect(JSON.stringify(touched)).toBe(snapshot);
  });
});

describe("experimental-cch-signing", () => {
  it("is accepted as a no-op key on Claude provider keys (CCH signing is automatic)", async () => {
    const config = await loadConfig(claudeKeyConfig("experimental-cch-signing: true"));
    expect(config["api-keys"].claude[0]?.keys[0]?.["experimental-cch-signing"]).toBe(true);

    const { body } = await run(
      claudeKeyConfig("experimental-cch-signing: true"),
      obj({
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 5,
      }),
    );

    expect(body.messages).toBeDefined();
  });
});
