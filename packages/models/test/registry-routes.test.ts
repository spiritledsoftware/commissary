// /v1/models and /v1beta/models behind the client gate (support/client-gate.ts), with a faked registry and the real
// ControlPlane. CORS on these routes is the Worker's (apps/app/test/access-router.test.ts).
import { FULL_ACCESS } from "../src/credentials/ownership.ts";
import { env } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigReader } from "../src/config/reader.ts";
import { behindClientGate } from "./support/client-gate.ts";
import { requestContext } from "./support/context.ts";
import { CatalogStore } from "../src/registry/catalog-store.ts";
import { ModelRoutes } from "../src/registry/routes.ts";
import { ModelRegistry, ModelRegistryError, buildSnapshot } from "../src/registry/service.ts";
import {
  AUD,
  fakeJwksLayer,
  makeFakeJwks,
  makeKey,
  signToken,
  userClaims,
} from "@commissary/auth/testing";
import { catalogs } from "./support/registry.ts";
import { claudeKeySource, configOf, source } from "./support/registry-sources.ts";
import type { ModelSource } from "../src/registry/source.ts";

const key = await makeKey("models-kid");

const accessEnv = {
  ...env,
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_AUD: AUD,
  PLATFORM_ADMIN_EMAILS: "",
  ACCESS_DEV_BYPASS: "",
};

const ctx = {} as unknown as ExecutionContext;

const NOW = 1_800_000_000_000;

const makeHandler = (registryLayer: Layer.Layer<ModelRegistry>) => {
  return HttpRouter.toWebHandler(
    behindClientGate(
      ModelRoutes.pipe(Layer.provide(registryLayer)),
      fakeJwksLayer(makeFakeJwks([key])),
    ),
    { disableLogger: true },
  );
};

const token = async () =>
  await signToken({
    key,
    now: Math.floor(Date.now() / 1000),
    claims: userClaims("user@example.com"),
  });

const caller =
  (handler: ReturnType<typeof makeHandler>) =>
  async (path: string, headers: Record<string, string> = {}, auth = true) =>
    await handler.handler(
      new Request(`https://commissary.test${path}`, {
        headers: { ...(auth ? { "Cf-Access-Jwt-Assertion": await token() } : {}), ...headers },
      }),
      requestContext(accessEnv, ctx),
    );

describe("model routes with a fixed registry", () => {
  const snapshot = buildSnapshot({
    config: configOf(),
    catalogs,
    now: NOW,
    sources: [
      source("claude-a.json", "claude", { prefix: "team" }),
      source("gem.json", "gemini", { excludedModels: ["gemini-3*", "*preview*"] }),
    ],
  });

  const registry = Layer.succeed(
    ModelRegistry,
    ModelRegistry.of({ snapshot: Effect.succeed(snapshot), fresh: Effect.succeed(snapshot) }),
  );

  const handler = makeHandler(registry);
  afterAll(handler.dispose);
  const call = caller(handler);

  it("requires Access on all four routes", async () => {
    for (const path of ["/v1/models", "/v1/models/x", "/v1beta/models", "/v1beta/models/x"]) {
      const response = await call(path, {}, false);
      expect(response.status, path).toBe(401);
    }
  });

  it("lists OpenAI shape by default and Claude shape for Anthropic clients, with the JSON content type", async () => {
    const openai = await call("/v1/models");
    expect(openai.status).toBe(200);
    expect(openai.headers.get("content-type")).toBe("application/json; charset=utf-8");

    const body = (await openai.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };

    expect(body.object).toBe("list");
    const ids = body.data.map((model) => model.id);
    expect(ids).toContain("team/claude-sonnet-4-5-20250929");
    expect(ids).toContain("claude-sonnet-4-5-20250929");
    expect(ids).toContain("gemini-2.5-pro");
    expect(ids).not.toContain("gemini-3-pro-preview");
    expect(ids.toSorted()).toEqual(ids);

    for (const headers of [
      { "anthropic-version": "2023-06-01" },
      { "user-agent": "claude-cli/1.0" },
    ]) {
      const claude = await call("/v1/models", headers);

      const parsed = (await claude.json()) as {
        data: Array<{ id: string; type: string }>;
        has_more: boolean;
        first_id: string;
      };

      expect(parsed.has_more).toBe(false);
      expect(parsed.data[0]?.type).toBe("model");
      expect(parsed.data.some((model) => model.id.startsWith("claude-fable-5-dd-"))).toBe(true);
    }

    const grok = (await (await call("/v1/models", { "user-agent": "Grok-Shell/9" })).json()) as {
      data: Array<{ api_backend: string }>;
    };

    expect(grok.data[0]?.api_backend).toBe("responses");
  });

  it("serves model details for ids containing slashes, plain or percent-encoded", async () => {
    for (const path of [
      "/v1/models/team/claude-sonnet-4-5-20250929",
      "/v1/models/team%2Fclaude-sonnet-4-5-20250929",
    ]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "team/claude-sonnet-4-5-20250929",
        object: "model",
      });
    }

    for (const path of ["/v1/models/nope", "/v1/models/"]) {
      const response = await call(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({
        error: {
          code: "model_not_found",
          message: "Model not found",
          type: "invalid_request_error",
        },
      });
    }
  });

  it("answers client_version with the Codex client catalog (compact JSON, per-model entries, detail by slug)", async () => {
    const codexSnapshot = buildSnapshot({
      config: configOf(
        "client:\n  codex:\n    enable-apply-patch: true\n    optimize-multi-agent-v2: true\n",
      ),
      catalogs,
      now: NOW,
      sources: [
        source("codex-a.json", "codex", { planType: "pro" }),
        source("claude-a.json", "claude"),
      ],
    });

    const codexHandler = makeHandler(
      Layer.succeed(
        ModelRegistry,
        ModelRegistry.of({
          snapshot: Effect.succeed(codexSnapshot),
          fresh: Effect.succeed(codexSnapshot),
        }),
      ),
    );

    const codexCall = caller(codexHandler);
    const response = await codexCall("/v1/models?client_version=0.150.0");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    expect(text).not.toContain("\n");
    const body = JSON.parse(text) as { models: Array<Record<string, unknown>> };
    const gpt = body.models.find((entry) => String(entry.slug).startsWith("gpt-5"));
    const claude = body.models.find((entry) => String(entry.slug).startsWith("claude-"));
    expect(gpt).toMatchObject({ multi_agent_version: "v2", apply_patch_tool_type: "freeform" });
    // Non-Codex models get the compact fallback instructions and never advertise Codex-only features.
    expect(claude).toMatchObject({
      base_instructions: "You are Codex, a coding agent. You and the user share one workspace.",
      supports_search_tool: false,
      prefer_websockets: false,
      service_tiers: [],
      upgrade: null,
    });
    const detail = await codexCall(`/v1/models/${String(gpt?.slug)}?client_version=0.150.0`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ slug: gpt?.slug });
    expect((await codexCall("/v1/models?client_version=")).status).toBe(200);
  });

  it("lists Gemini models and serves details with or without the models/ prefix", async () => {
    const list = (await (await call("/v1beta/models")).json()) as {
      models: Array<{ name: string; supportedGenerationMethods: string[] }>;
    };

    expect(list.models.map((model) => model.name)).toContain("models/gemini-2.5-pro");

    for (const path of ["/v1beta/models/gemini-2.5-pro", "/v1beta/models/models/gemini-2.5-pro"]) {
      const response = await call(path);
      expect(response.status, path).toBe(200);
      expect(await response.json()).toMatchObject({ name: "models/gemini-2.5-pro" });
    }

    const missing = await call("/v1beta/models/nope");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('{"error":{"message":"Not Found","type":"not_found"}}');
  });
});

describe("model routes when the registry is unavailable", () => {
  const failure = Effect.fail(new ModelRegistryError({ message: "failed to read model sources" }));

  const handler = makeHandler(
    Layer.succeed(ModelRegistry, ModelRegistry.of({ snapshot: failure, fresh: failure })),
  );

  afterAll(handler.dispose);

  it("answers 500 with a generic error body", async () => {
    const call = caller(handler);

    for (const path of ["/v1/models", "/v1beta/models"]) {
      const response = await call(path);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(
        '{"error":{"message":"Model registry unavailable","type":"server_error"}}',
      );
    }
  });
});

describe("model routes with the real ControlPlane", () => {
  const registry = ModelRegistry.layer.pipe(
    Layer.provide(Layer.mergeAll(ConfigReader.layerControlPlane(), CatalogStore.layer)),
  );

  it("lists models of imported credentials (prefix, plan tier, exclusions) and hides disabled ones", async () => {
    const stub = env.CONTROL_PLANE.getByName("global");
    await stub.models().importConfig(
      `
oauth:
  excluded-models:
    codex: ["gpt-image-*"]
  model-alias:
    claude:
      - { name: claude-sonnet-4-5-20250929, alias: sonnet, fork: true }
`,
      "test",
    );
    await stub.models().importAuthFile(
      "claude-a.json",
      JSON.stringify({
        type: "claude",
        email: "a@x.com",
        access_token: "tok-secret-a",
        refresh_token: "ref-secret-a",
        prefix: "team",
      }),
      {},
      FULL_ACCESS,
    );
    await stub.models().importAuthFile(
      "codex-a.json",
      JSON.stringify({
        type: "codex",
        email: "c@x.com",
        access_token: "tok-secret-c",
        plan_type: "free",
      }),
      {},
      FULL_ACCESS,
    );
    await stub
      .models()
      .importAuthFile(
        "claude-off.json",
        JSON.stringify({ type: "claude", email: "off@x.com", access_token: "t", disabled: true }),
        {},
        FULL_ACCESS,
      );

    const sources = await stub.models().listModelSources(FULL_ACCESS);
    expect(JSON.stringify(sources)).not.toContain("secret");
    expect(sources.find((candidate) => candidate.id === "codex-a.json")).toMatchObject({
      provider: "codex",
      executor: "codex",
      planType: "free",
      authKind: "oauth",
      compat: false,
    });

    const handler = makeHandler(registry);

    try {
      const response = await caller(handler)("/v1/models");
      expect(response.status).toBe(200);

      const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map(
        (model) => model.id,
      );

      expect(ids).toEqual(
        expect.arrayContaining([
          "team/sonnet",
          "sonnet",
          "team/claude-sonnet-4-5-20250929",
          "claude-sonnet-4-5-20250929",
          "gpt-5.5",
          "gpt-6-luna",
        ]),
      );
      expect(ids).not.toContain("gpt-6-astra");
      expect(ids.some((id) => id.startsWith("gpt-image-"))).toBe(false);
    } finally {
      await handler.dispose();
    }
  });
});

describe("native tool search in the Codex catalog through the Worker", () => {
  const GATE = "upstream:\n  claude:\n    tool-search: true\n";

  const SONNET = "claude-sonnet-4-5-20250929";

  const GATEWAY = { base_url: "https://gateway.test" };

  /** The snapshot's own answer, and the answer of `/v1/models?client_version=` to a caller. */
  const searchFlag = async (
    sources: ModelSource[],
    yaml = GATE,
    slug = SONNET,
  ): Promise<{ readonly snapshot: boolean; readonly route: boolean | undefined }> => {
    const snapshot = buildSnapshot({ config: configOf(yaml), catalogs, now: NOW, sources });

    const handler = makeHandler(
      Layer.succeed(
        ModelRegistry,
        ModelRegistry.of({ snapshot: Effect.succeed(snapshot), fresh: Effect.succeed(snapshot) }),
      ),
    );

    try {
      const response = await caller(handler)("/v1/models?client_version=0.150.0");
      expect(response.status).toBe(200);
      const body = (await response.json()) as { models: Array<Record<string, unknown>> };

      return {
        snapshot: snapshot.nativeToolSearchCapability(slug),
        route: body.models.find((model) => model.slug === slug)?.supports_search_tool === true,
      };
    } finally {
      await handler.dispose();
    }
  };

  it("is true for a caller reaching only native credentials, whose origin comes from a real base URL", async () => {
    expect((await searchFlag([claudeKeySource("claude-a")])).route).toBe(true);

    const anthropic = claudeKeySource("claude-a", { base_url: "https://api.anthropic.com" });
    expect((await searchFlag([anthropic])).route).toBe(true);

    const flagged = claudeKeySource("gw", { ...GATEWAY, native_tool_search: "true" });
    expect((await searchFlag([flagged])).route).toBe(true);
  });

  it("is false for a caller who also reaches a non-native custom-base-URL key", async () => {
    const sources = [claudeKeySource("claude-a"), claudeKeySource("claude-gw", GATEWAY)];
    expect((await searchFlag(sources)).route).toBe(false);
  });

  it("is false for a model that predates tool search, judged after aliasing", async () => {
    const yaml = `${GATE}oauth:
  model-alias:
    claude:
      - { name: claude-opus-4-1-20250805, alias: legacy-fast }
      - { name: ${SONNET}, alias: modern-fast }
`;

    // Aliases are an OAuth account's (`oauth.model-alias`).
    const sources = [claudeKeySource("claude-a", {}, { authKind: "oauth" })];
    expect((await searchFlag(sources, yaml, "legacy-fast")).route).toBe(false);
    expect((await searchFlag(sources, yaml, "modern-fast")).route).toBe(true);
  });

  it("answers within the caller's view: another member's private non-native credential does not change it", async () => {
    const sources = [
      claudeKeySource("claude-a"),
      claudeKeySource("claude-private", GATEWAY, { owner: "someone-else" }),
    ];

    const answer = await searchFlag(sources);
    // The unfiltered snapshot knows the private credential and says false; the route answers from the caller's view.
    expect(answer.snapshot).toBe(false);
    expect(answer.route).toBe(true);

    const snapshot = buildSnapshot({ config: configOf(GATE), catalogs, now: NOW, sources });
    expect(snapshot.visibleTo(undefined).nativeToolSearchCapability(SONNET)).toBe(true);
    // Its owner does reach it, so for them the answer is false.
    expect(snapshot.visibleTo("someone-else").nativeToolSearchCapability(SONNET)).toBe(false);
  });
});
