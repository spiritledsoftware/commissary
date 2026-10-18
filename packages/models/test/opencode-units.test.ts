// OpenCode Zen/Go executor units: protocol resolution, gateway headers and error classification.
import { describe, expect, it } from "vitest";
import type { CredentialSnapshot } from "../src/executor/picker.ts";
import {
  OPENCODE_MODEL_COOLDOWN_MS,
  OPENCODE_PROTOCOL_COOLDOWN_MS,
  openCodeModelFault,
  openCodeStreamEventError,
  openCodeUpstreamError,
  reclassifyOpenCodeError,
} from "../src/executor/opencode/errors.ts";
import { ExecutionError } from "../src/executor/errors.ts";
import {
  OPENCODE_USER_AGENT,
  openCodeAuthHeaders,
  openCodeHeaders,
  openCodeSessionId,
} from "../src/executor/opencode/headers.ts";
import {
  findModelEntry,
  resolveOpenCodeKeyConfig,
  resolveOpenCodeProtocol,
} from "../src/executor/opencode/protocol.ts";
import { embeddedModelsDev } from "../src/registry/catalog.ts";
import type { ExecutorOptions } from "../src/executor/types.ts";
import { loadConfig } from "./support/pipeline.ts";

const credential = (
  provider: string,
  attributes: Record<string, string> = {},
): CredentialSnapshot => ({
  id: `${provider}-1`,
  provider,
  kind: "apikey",
  label: provider,
  attributes: { api_key: "k1", config_index: "0", ...attributes },
  metadata: {},
});

const options = (
  headers: Record<string, string> = {},
  metadata: Partial<ExecutorOptions["metadata"]> = {},
): ExecutorOptions =>
  // SAFETY: the header helpers read only `headers` and the session fields of `metadata`.
  ({
    stream: false,
    alt: "",
    headers: new Headers(headers),
    query: new URLSearchParams(),
    sourceFormat: "openai",
    metadata: { requestedModel: "", requestPath: "/v1/chat/completions", ...metadata },
  }) as unknown as ExecutorOptions;

const CONFIG = `api-keys:
  opencode-zen:
    - models:
        - name: gpt-5
          protocol: chat
        - name: claude-haiku-4-5
          alias: haiku
      keys:
        - api-key: k1
        - api-key: k2
          models:
            - name: deepseek-v4-flash
              protocol: messages
  opencode-go:
    - keys:
        - api-key: g1
          models:
            - name: deepseek-v4-flash
              protocol: gemini
        - api-key: g2
          models:
            - name: jev-1.13
              protocol: systemone
`;

describe("protocol resolution", () => {
  const catalog = embeddedModelsDev();

  it("finds the key behind a credential by config_index and secret; key models override group models", async () => {
    const config = await loadConfig(CONFIG);
    const first = resolveOpenCodeKeyConfig(config, credential("opencode-zen"), "opencode-zen");
    expect(first?.models.map((entry) => entry.name)).toEqual(["gpt-5", "claude-haiku-4-5"]);

    const second = resolveOpenCodeKeyConfig(
      config,
      credential("opencode-zen", { api_key: "k2", config_index: "1" }),
      "opencode-zen",
    );

    expect(second?.models.map((entry) => entry.name)).toEqual(["deepseek-v4-flash"]);

    // A stale index falls back to the secret.
    const stale = resolveOpenCodeKeyConfig(
      config,
      credential("opencode-zen", { api_key: "k2", config_index: "0" }),
      "opencode-zen",
    );

    expect(stale?.providerKey).toBe("k2");
  });

  it("matches model entries by name (suffix stripped) and then by alias", () => {
    const models = [
      { name: "gpt-5", protocol: "chat" as const },
      { name: "x", alias: "haiku" },
    ];

    expect(findModelEntry(models, "GPT-5(high)")?.name).toBe("gpt-5");
    expect(findModelEntry(models, "haiku")?.name).toBe("x");
    expect(findModelEntry(models, "nope")).toBeUndefined();
  });

  it("orders config override, catalog package, then chat fallback", async () => {
    const config = await loadConfig(CONFIG);

    const resolve = (provider: "opencode-zen" | "opencode-go", model: string, attrs = {}) =>
      resolveOpenCodeProtocol({
        config,
        credential: credential(provider, attrs),
        provider,
        model,
        catalog,
      });

    expect(resolve("opencode-zen", "gpt-5")).toMatchObject({ protocol: "chat", source: "config" });
    expect(resolve("opencode-zen", "gpt-5.1")).toMatchObject({
      protocol: "responses",
      source: "catalog",
    });
    expect(resolve("opencode-zen", "claude-haiku-4-5(8192)")).toMatchObject({
      protocol: "messages",
      source: "catalog",
    });
    expect(resolve("opencode-zen", "gemini-3-flash")).toMatchObject({
      protocol: "gemini",
      source: "catalog",
    });
    expect(resolve("opencode-zen", "mistral-large-4")).toMatchObject({ protocol: "chat" });
    expect(
      resolve("opencode-zen", "deepseek-v4-flash", { api_key: "k2", config_index: "1" }),
    ).toMatchObject({ protocol: "messages", source: "config" });

    const unknown = resolve("opencode-zen", "brand-new-model");
    expect(unknown).toMatchObject({ protocol: "chat", source: "fallback" });
    expect(unknown.warning).toContain("brand-new-model");

    const geminiOnGo = resolve("opencode-go", "deepseek-v4-flash", { api_key: "g1" });
    expect(geminiOnGo).toMatchObject({ protocol: "chat", source: "fallback" });
    expect(geminiOnGo.warning).toContain("gemini");
  });

  it("resolves Zen's System One models from the catalog additions, never falling back to chat; Go serves none", async () => {
    const config = await loadConfig(CONFIG);

    const resolve = (provider: "opencode-zen" | "opencode-go", model: string, attrs = {}) =>
      resolveOpenCodeProtocol({
        config,
        credential: credential(provider, attrs),
        provider,
        model,
        catalog,
      });

    for (const model of ["jev-1.13", "JEV-1.13-free"]) {
      const resolved = resolve("opencode-zen", model);
      expect(resolved).toMatchObject({ protocol: "systemone", source: "catalog" });
      expect(resolved.warning).toBeUndefined();
    }

    expect(resolve("opencode-go", "jev-1.13", { api_key: "g1" })).toMatchObject({
      protocol: "chat",
      source: "fallback",
    });

    const configuredOnGo = resolve("opencode-go", "jev-1.13", { api_key: "g2", config_index: "1" });
    expect(configuredOnGo).toMatchObject({ protocol: "chat", source: "fallback" });
    expect(configuredOnGo.warning).toContain("systemone");
  });
});

describe("gateway headers", () => {
  it("authenticates with each protocol's native header", () => {
    expect(openCodeAuthHeaders("chat", "k")).toEqual({ authorization: "Bearer k" });
    expect(openCodeAuthHeaders("responses", "k")).toEqual({ authorization: "Bearer k" });
    expect(openCodeAuthHeaders("messages", "k")).toEqual({
      "x-api-key": "k",
      "anthropic-version": "2023-06-01",
    });
    expect(openCodeAuthHeaders("gemini", "k")).toEqual({ "x-goog-api-key": "k" });
    expect(openCodeAuthHeaders("systemone", "k")).toEqual({ authorization: "Bearer k" });
  });

  it("forwards the client headers a protocol names, before the custom headers", () => {
    const headers = openCodeHeaders({
      credential: credential("opencode-zen", {
        "header:TypeSafe-Danger-Zone-Long-Context": "false",
      }),
      options: options({
        "TypeSafe-Danger-Zone-Images": "true",
        "TypeSafe-Danger-Zone-Long-Context": "true",
        "x-other": "no",
      }),
      protocol: "systemone",
      providerKey: "k",
      stream: false,
      forward: ["TypeSafe-Danger-Zone-Images", "TypeSafe-Danger-Zone-Long-Context", "X-Absent"],
    });

    expect(headers).toMatchObject({
      authorization: "Bearer k",
      accept: "application/json",
      "typesafe-danger-zone-images": "true",
      "TypeSafe-Danger-Zone-Long-Context": "false",
    });
    expect(headers["typesafe-danger-zone-long-context"]).toBeUndefined();
    expect(headers["x-other"]).toBeUndefined();
    expect(headers["x-absent"]).toBeUndefined();
  });

  it("derives the session from the client header, then the session identities, else a random UUID", () => {
    expect(openCodeSessionId(options({ "x-opencode-session": " ses_1 " }))).toBe("ses_1");

    const explicit = openCodeSessionId(options({}, { sessionId: "claude:abc" }));
    expect(explicit).toMatch(/^[0-9a-f-]{36}$/);
    expect(explicit).toBe(openCodeSessionId(options({}, { sessionId: "claude:abc" })));
    expect(explicit).not.toBe(openCodeSessionId(options({}, { sessionId: "claude:abd" })));

    const derived = openCodeSessionId(options({}, { derivedSessionId: "d1" }));
    expect(derived).not.toBe(explicit);
    expect(derived).toBe(openCodeSessionId(options({}, { derivedSessionId: "d1" })));

    const random = openCodeSessionId(options());
    expect(random).toMatch(/^[0-9a-f-]{36}$/);
    expect(random).not.toBe(openCodeSessionId(options()));
  });

  it("applies custom headers last", () => {
    const headers = openCodeHeaders({
      credential: credential("opencode-go", {
        "header:User-Agent": "mine/1",
        "header:X-Opencode-Session": "fixed",
      }),
      options: options(),
      protocol: "chat",
      providerKey: "k",
      stream: true,
    });

    expect(headers).toMatchObject({
      authorization: "Bearer k",
      "x-opencode-client": "commissary",
      accept: "text/event-stream",
      "User-Agent": "mine/1",
      "X-Opencode-Session": "fixed",
    });
    expect(headers["user-agent"]).toBeUndefined();
    expect(OPENCODE_USER_AGENT).toBe("commissary");
  });
});

describe("gateway errors", () => {
  const body = (type: string, message: string) =>
    JSON.stringify({ type: "error", error: { type, message } });

  it("recognises the model-scoped failures", () => {
    expect(
      openCodeModelFault(
        400,
        body("ModelProtocolUnsupported", "Model does not support this protocol."),
      ),
    ).toBe("protocol");
    expect(openCodeModelFault(400, body("ModelError", "Model is unavailable."))).toBe(
      "unavailable",
    );
    expect(openCodeModelFault(403, body("AuthError", "Model access is disabled"))).toBe("disabled");
    expect(openCodeModelFault(403, body("FreeTierError", "free tier"))).toBe("free-tier");
    expect(openCodeModelFault(400, body("invalid_request_error", "bad tools"))).toBeUndefined();
    expect(openCodeModelFault(500, body("ModelProtocolUnsupported", "x"))).toBeUndefined();
  });

  it("classifies statuses per gateway", () => {
    const error = (
      provider: "opencode-zen" | "opencode-go",
      status: number,
      text: string,
      headers = {},
    ) =>
      openCodeUpstreamError({
        provider,
        status,
        body: text,
        headers: new Headers(headers),
        nowMs: 0,
      });

    const protocol = error("opencode-go", 400, body("ModelProtocolUnsupported", "x"));
    expect(protocol).toMatchObject({
      code: "model_not_found",
      retryAfterMs: OPENCODE_PROTOCOL_COOLDOWN_MS,
    });
    expect(error("opencode-zen", 403, body("FreeTierError", "x"))).toMatchObject({
      code: "model_not_found",
      retryAfterMs: OPENCODE_MODEL_COOLDOWN_MS,
    });
    expect(error("opencode-zen", 401, "{}").credentialScoped).toBe(true);
    expect(error("opencode-zen", 403, "{}").credentialScoped).toBeUndefined();
    expect(error("opencode-go", 429, "{}", { "retry-after": "3" })).toMatchObject({
      retryAfterMs: 3000,
      credentialScoped: true,
    });
    expect(error("opencode-zen", 429, "{}").credentialScoped).toBeUndefined();
    expect(error("opencode-zen", 503, "{}", { "retry-after": "9" }).retryAfterMs).toBe(9000);
    expect(error("opencode-zen", 402, "{}").credentialScoped).toBe(true);
    expect(error("opencode-go", 402, "{}").credentialScoped).toBe(true);
    // An HTTP-date Retry-After on a 5xx (relative to `nowMs`, here the epoch).
    expect(
      error("opencode-go", 502, "{}", { "retry-after": "Thu, 01 Jan 1970 00:00:30 GMT" })
        .retryAfterMs,
    ).toBe(30_000);
    expect(error("opencode-go", 500, "{}", { "retry-after": "soon" }).retryAfterMs).toBeUndefined();
    expect(error("opencode-zen", 400, "{}").code).toBeUndefined();
  });

  it("re-classifies only upstream answers of the delegated engine", () => {
    const upstream = new ExecutionError({
      status: 403,
      message: body("AuthError", "Model access is disabled"),
      headers: {},
    });

    expect(reclassifyOpenCodeError("opencode-zen", upstream, 0).code).toBe("model_not_found");
    const local = new ExecutionError({ status: 400, message: "bad", requestScoped: true });
    expect(reclassifyOpenCodeError("opencode-zen", local, 0)).toBe(local);
  });

  it("turns Responses error events into upstream errors", () => {
    const toError = openCodeStreamEventError("opencode-go");
    expect(toError({ type: "response.output_text.delta" }, "{}", 0)).toBeUndefined();
    expect(toError({ type: "error", error: { code: 429 } }, "{}", 0)).toMatchObject({
      status: 429,
      credentialScoped: true,
    });
    expect(
      toError({ type: "response.failed", response: { error: { code: "x" } } }, "{}", 0)?.status,
    ).toBe(502);
  });
});
