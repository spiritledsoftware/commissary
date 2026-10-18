// The provider keys page's model (src/lib/keys.ts): sections, key standing, group facts, and the group form's
// validation and the write it becomes (stored keys by auth_index, nothing the form does not show is lost).
import { describe, expect, it } from "vitest";
import type {
  ProviderKeysList,
  ProviderKeyView,
  CompatGroupView,
  GroupView,
  KeyRuntime,
} from "@commissary/contract/provider-keys";
import {
  changesIdentity,
  choosesProtocol,
  draftOf,
  groupFacts,
  groupTitle,
  keptSettings,
  keySections,
  keyStanding,
  keyTail,
  needsAttention,
  newKeyDraft,
  newModelDraft,
  PROTOCOL_CHOICES,
  isStaleWrite,
  parsePatterns,
  putGroupRequest,
  recentRequests,
  validateDraft,
  writeProblem,
} from "../src/lib/keys.ts";

const NOW = Date.parse("2026-10-11T12:00:00Z");

const runtime = (overrides: Partial<KeyRuntime> = {}): KeyRuntime => ({
  auth_index: "a1",
  status: "active",
  unavailable: false,
  success: 0,
  failed: 0,
  recent_requests: [],
  cooldowns: [],
  ...overrides,
});

const key = (overrides: Partial<ProviderKeyView> = {}): ProviderKeyView => ({
  auth_index: "a1",
  key_preview: "[redacted]…abcd",
  disabled: false,
  runtime: runtime(),
  ...overrides,
});

const group = (overrides: Partial<GroupView["group"]> = {}, index = 0): GroupView => ({
  id: `g${String(index)}`,
  revision: 3,
  index,
  group: { keys: [key()], ...overrides },
  effective_base_url: overrides["base-url"] ?? "https://api.anthropic.com",
  warnings: [],
});

const compat = (overrides: Partial<CompatGroupView["group"]> = {}): CompatGroupView => ({
  id: "c0",
  revision: 5,
  index: 0,
  group: {
    name: "openrouter",
    "base-url": "https://openrouter.ai/api/v1",
    keys: [{ auth_index: "c1", key_preview: "[redacted]…wxyz", disabled: false, runtime: null }],
    ...overrides,
  },
  effective_base_url: overrides["base-url"] ?? "https://openrouter.ai/api/v1",
  warnings: [],
});

const list = (families: Partial<ProviderKeysList["families"]>): ProviderKeysList => ({
  version: 7,
  families: {
    gemini: [],
    interactions: [],
    vertex: [],
    codex: [],
    claude: [],
    xai: [],
    meta: [],
    "opencode-zen": [],
    "opencode-go": [],
    typesafe: [],
    subq: [],
    "openai-compatibility": [],
    ...families,
  },
});

describe("keySections", () => {
  it("orders providers and gives each OpenAI-compatible endpoint its own section", () => {
    const sections = keySections(
      list({
        gemini: [group({}, 0)],
        claude: [group({}, 0), group({ name: "team" }, 1)],
        "openai-compatibility": [compat(), { ...compat({ name: "groq" }), index: 1 }],
      }),
    );

    expect(sections.map((section) => [section.title, section.groups.length])).toEqual([
      ["Claude", 2],
      ["Gemini", 1],
      ["openrouter", 1],
      ["groq", 1],
    ]);
    expect(sections[2]?.caption).toBe("OpenAI-compatible endpoint");
  });

  it("lists TypeSafe and skips a family the panel does not show yet", () => {
    const sections = keySections(
      list({ typesafe: [group({}, 0)], subq: [group({}, 0)], gemini: [group({}, 0)] }),
    );

    expect(sections.map((section) => section.title)).toEqual(["Gemini", "TypeSafe"]);
  });

  it("is empty without keys", () => {
    expect(keySections(list({}))).toEqual([]);
  });

  it("lists the caller's private groups after the shared ones, marked and never merged", () => {
    const own = list({ claude: [group({ name: "mine" }, 0)] }).families;
    const sections = keySections({ ...list({ claude: [group({}, 0)] }), own });

    expect(sections.map((section) => [section.id, section.caption])).toEqual([
      ["claude", undefined],
      ["own:claude", "Private to you"],
    ]);
    expect(sections[0]?.groups[0]?.private).toBeUndefined();
    expect(sections[1]?.groups[0]).toMatchObject({ family: "claude", index: 0, private: true });
  });
});

describe("groups", () => {
  it("titles a group by name, then host, then position", () => {
    expect(groupTitle("claude", group({ name: " team " }))).toBe("team");
    expect(groupTitle("claude", group({ "base-url": "https://proxy.example.com/v1" }))).toBe(
      "proxy.example.com",
    );
    expect(groupTitle("claude", group({}, 2))).toBe("Group 3");
  });

  it("prints the host (marking a default), prefix, priority, models and exclusions", () => {
    expect(groupFacts("claude", group())).toEqual([
      "api.anthropic.com (default)",
      "Provider catalog",
    ]);
    expect(
      groupFacts(
        "claude",
        group({
          "base-url": "https://proxy.example.com",
          prefix: "team",
          priority: 5,
          models: [{ name: "a" }, { name: "b", alias: "c" }],
          "excluded-models": ["claude-3-*", "*"],
        }),
      ),
    ).toEqual(["proxy.example.com", "Prefix team/", "Priority 5", "2 models", "1 exclusion"]);
    expect(groupFacts("openai-compatibility", compat())).toEqual([
      "openrouter.ai",
      "No models listed",
    ]);
  });

  it("names what the form keeps without showing", () => {
    expect(keptSettings(undefined)).toEqual([]);
    expect(keptSettings(group())).toEqual([]);
    expect(
      keptSettings({
        ...group({
          headers: { "x-team": "a" },
          "request-retry": 2,
          keys: [
            key({ websockets: true }),
            key({ auth_index: "a2", "excluded-models": ["*"], disabled: true }),
          ],
        }),
        warnings: ["proxy-url is set: outbound proxies do not exist on Workers"],
      }),
    ).toEqual([
      "headers",
      "request retry",
      "settings of 1 key",
      "proxy-url, which has no effect on Workers",
    ]);
  });
});

describe("keyStanding", () => {
  it("reads disabled, key-less and healthy keys", () => {
    expect(keyStanding(key({ disabled: true }), NOW).tone).toBe("disabled");
    expect(keyStanding(key({ runtime: null }), NOW)).toMatchObject({
      tone: "unused",
      label: "Makes no credential",
    });
    expect(keyStanding(key(), NOW)).toMatchObject({ tone: "ok", label: "Taking requests" });
  });

  it("closes a key resting as a whole until its last cooldown ends", () => {
    const standing = keyStanding(
      key({
        runtime: runtime({
          cooldowns: [
            {
              scope: "credential",
              reason: "quota",
              retry_at: "2026-10-11T12:30:00Z",
              remaining_seconds: 1800,
            },
            {
              scope: "credential",
              reason: "unknown",
              retry_at: "2026-10-11T11:00:00Z",
              remaining_seconds: 0,
            },
          ],
        }),
      }),
      NOW,
    );

    expect(standing).toEqual({
      tone: "closed",
      label: "Resting: Rate limit",
      backAt: Date.parse("2026-10-11T12:30:00Z"),
    });
  });

  it("notes resting models without closing the key", () => {
    const resting = key({
      runtime: runtime({
        cooldowns: [
          {
            scope: "model",
            model_key: "claude-opus",
            reason: "quota",
            retry_at: "2026-10-11T12:05:00Z",
            remaining_seconds: 300,
          },
        ],
      }),
    });

    expect(keyStanding(resting, NOW)).toMatchObject({ tone: "resting", label: "1 model resting" });
    expect(needsAttention(resting, NOW)).toBe(true);
    expect(needsAttention(resting, Date.parse("2026-10-11T12:10:00Z"))).toBe(false);
  });

  it("shows a failing key's last error", () => {
    const standing = keyStanding(
      key({
        runtime: runtime({
          status: "error",
          last_error: { http_status: 401, message: "invalid x-api-key" },
        }),
      }),
      NOW,
    );

    expect(standing).toMatchObject({
      tone: "closed",
      label: "Failing: HTTP 401, invalid x-api-key",
    });
  });

  it("counts requests and failures over the ring", () => {
    expect(
      recentRequests(
        key({
          runtime: runtime({
            recent_requests: [
              { time: "11:50-12:00", success: 3, failed: 1 },
              { time: "11:40-11:50", success: 2, failed: 0 },
            ],
          }),
        }),
      ),
    ).toEqual([6, 1]);
    expect(keyTail("[redacted]…abcd")).toBe("…abcd");
    expect(keyTail("")).toBe("");
  });
});

describe("the group form", () => {
  it("requires what the server would refuse or drop", () => {
    const empty = draftOf(undefined);
    const codex = validateDraft("codex", empty);

    expect(codex.baseUrl).toBe("Codex keys need a base URL.");
    expect(Object.values(codex.keyErrors)).toEqual([
      { field: "secret", text: "Enter the provider key, or remove this row." },
    ]);
    expect(validateDraft("claude", { ...empty, keys: [] }).keys).toBe("Add at least one key.");
    expect(validateDraft("openai-compatibility", { ...empty, keys: [] }).name).toBeDefined();
    expect(validateDraft("claude", { ...empty, baseUrl: "api.example.com" }).baseUrl).toBe(
      "Enter a URL starting with https://.",
    );
    expect(
      validateDraft("vertex", {
        ...empty,
        models: [{ name: "gemini-pro", alias: "", protocol: "", stored: undefined }],
      }).models,
    ).toBe("Vertex AI models need an alias.");
  });

  it("writes stored keys by auth_index and keeps what the form does not show", () => {
    const view = group({
      name: "team",
      headers: { "x-team": "[redacted]…1234" },
      models: [{ name: "claude-opus", alias: "opus", "max-context-length": 200_000 }],
      keys: [key({ weight: 3, cloak: { mode: "always" } })],
    });

    const draft = draftOf(view);

    const request = putGroupRequest("claude", view, {
      ...draft,
      prefix: "team",
      excluded: "claude-3-*\n claude-3-* , haiku",
      keys: [...draft.keys, { ...newKeyDraft(), secret: " sk-new " }],
    });

    expect(request).toEqual({
      family: "claude",
      id: "g0",
      revision: 3,
      group: {
        name: "team",
        headers: { "x-team": "[redacted]…1234" },
        prefix: "team",
        models: [{ name: "claude-opus", alias: "opus", "max-context-length": 200_000 }],
        "excluded-models": ["claude-3-*", "haiku"],
        keys: [{ auth_index: "a1", cloak: { mode: "always" }, weight: 3 }, { "api-key": "sk-new" }],
      },
    });
    expect(JSON.stringify(request)).not.toContain("redacted]…abcd");
  });

  it("marks a write to the caller's private group", () => {
    const view = group();

    expect(putGroupRequest("claude", view, draftOf(view), true)).toMatchObject({
      id: "g0",
      private: true,
    });
    expect(putGroupRequest("claude", undefined, draftOf(view), true)).toMatchObject({
      revision: 0,
      private: true,
    });
    expect(putGroupRequest("claude", view, draftOf(view))).not.toHaveProperty("private");
  });

  it("writes a replaced key's new secret with its auth_index", () => {
    const view = group();
    const [stored] = draftOf(view).keys;

    const request = putGroupRequest("claude", view, {
      ...draftOf(view),
      keys: stored === undefined ? [] : [{ ...stored, secret: "sk-replaced" }],
    });

    expect(request.group.keys).toEqual([{ auth_index: "a1", "api-key": "sk-replaced" }]);
    expect(changesIdentity("claude", view, draftOf(view))).toBe(false);
    expect(
      changesIdentity("claude", view, {
        ...draftOf(view),
        keys: stored === undefined ? [] : [{ ...stored, secret: "sk-replaced" }],
      }),
    ).toBe(true);
    expect(
      changesIdentity("claude", view, { ...draftOf(view), baseUrl: "https://x.example" }),
    ).toBe(true);
  });

  it("writes an OpenAI-compatible endpoint with its switches", () => {
    const view = compat({ "request-retry": 2 });

    const request = putGroupRequest("openai-compatibility", view, {
      ...draftOf(view),
      disabled: true,
      models: [{ name: "meta-llama/llama-4", alias: "llama", protocol: "", stored: undefined }],
    });

    expect(request).toEqual({
      family: "openai-compatibility",
      id: "c0",
      revision: 5,
      group: {
        name: "openrouter",
        "base-url": "https://openrouter.ai/api/v1",
        "request-retry": 2,
        models: [{ name: "meta-llama/llama-4", alias: "llama" }],
        disabled: true,
        keys: [{ auth_index: "c1" }],
      },
    });
    expect(changesIdentity("openai-compatibility", view, { ...draftOf(view), name: "or" })).toBe(
      true,
    );
  });

  it("round-trips an OpenCode model's protocol, and auto drops it", () => {
    const view = group({
      models: [
        { name: "claude-haiku-4-5", protocol: "messages", "max-context-length": 200_000 },
        { name: "gpt-5", protocol: "chat" },
      ],
    });

    const draft = draftOf(view);
    expect(draft.models.map((model) => model.protocol)).toEqual(["messages", "chat"]);
    expect(choosesProtocol("opencode-zen")).toBe(true);
    expect(choosesProtocol("claude")).toBe(false);
    expect(PROTOCOL_CHOICES[0]).toEqual({ value: "", label: "Auto (catalog)" });

    const [haiku, gpt] = draft.models;

    const request = putGroupRequest("opencode-zen", view, {
      ...draft,
      models: [
        ...(haiku === undefined ? [] : [haiku]),
        ...(gpt === undefined ? [] : [{ ...gpt, protocol: "" }]),
        { ...newModelDraft("glm-5"), protocol: "responses" },
      ],
    });

    expect(request.group.models).toEqual([
      { name: "claude-haiku-4-5", protocol: "messages", "max-context-length": 200_000 },
      { name: "gpt-5" },
      { name: "glm-5", protocol: "responses" },
    ]);
  });

  it("adds a new group without an id, at revision 0", () => {
    const request = putGroupRequest("gemini", undefined, {
      ...draftOf(undefined),
      keys: [{ ...newKeyDraft(), secret: "AIza-1" }],
    });

    expect(request).toEqual({
      family: "gemini",
      revision: 0,
      group: { keys: [{ "api-key": "AIza-1" }] },
    });
  });

  it("names the group's id and revision from the list it was read from, so a reload retargets the write", () => {
    const stale = group({ name: "team" });
    const reloaded: GroupView = { ...stale, revision: stale.revision + 1 };
    const edit = { ...draftOf(stale), prefix: "team" };

    expect(putGroupRequest("claude", stale, edit)).toMatchObject({ id: "g0", revision: 3 });
    expect(putGroupRequest("claude", reloaded, edit)).toMatchObject({ id: "g0", revision: 4 });
  });

  it("treats a conflict or an unknown key as a stale view to reload", () => {
    expect(isStaleWrite("conflict")).toBe(true);
    expect(isStaleWrite("unknown_auth_index")).toBe(true);
    expect(isStaleWrite("invalid_group")).toBe(false);
    expect(isStaleWrite(undefined)).toBe(false);
  });

  it("splits patterns and explains write conflicts", () => {
    expect(parsePatterns(" a, b\n\na ,*")).toEqual(["a", "b", "*"]);
    expect(writeProblem("conflict", "Conflict.")).toMatch(
      /changed or was removed since this page loaded/,
    );
    expect(writeProblem("unknown_auth_index", "x")).toMatch(/Reload/);
    expect(writeProblem(undefined, "Codex needs a base-url.")).toBe("Codex needs a base-url.");
  });
});
