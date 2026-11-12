// `ForAPIKey` scoping (oauth_scope_executor.go) and the executor registry wiring of the Kimi/Meta/Devin providers.
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { makeDevinExecutor } from "../src/executor/devin/executor.ts";
import {
  configForProviderKey,
  scopeContext,
  withProviderKeyScope,
} from "../src/executor/helps/oauth-scope.ts";
import { makeExecutorRegistry } from "../src/executor/registry.ts";
import type { ExecutionContext, ProviderExecutor } from "../src/executor/types.ts";
import { credential, harness, loadConfig } from "./support/executor-run.ts";

const YAML = `
oauth:
  providers:
    codex:
      header-defaults:
        user-agent: codex-oauth-ua
    devin:
      sensitive-words: [secretword]
upstream:
  claude:
    model-level-cooling: true
`;

describe("configForProviderKey", () => {
  it("zeroes the OAuth-only provider settings and leaves everything else", async () => {
    const config = await loadConfig(YAML);
    expect(config.oauth.providers.codex["header-defaults"]["user-agent"]).toBe("codex-oauth-ua");
    const scoped = configForProviderKey(config);
    expect(scoped.oauth.providers.codex["header-defaults"]["user-agent"]).toBe("");
    expect(scoped.oauth.providers.devin["sensitive-words"]).toEqual([]);
    expect(scoped.upstream.claude["model-level-cooling"]).toBe(true);
    // The shared snapshot is never modified.
    expect(config.oauth.providers.codex["header-defaults"]["user-agent"]).toBe("codex-oauth-ua");
  });

  it("only scopes provider-key credentials", async () => {
    const config = await loadConfig(YAML);
    const usage = (await harness(credential("meta"), () => new Response(""))).usage;
    const base = { config, usage };
    expect(
      scopeContext({ ...base, credential: credential("meta", { kind: "oauth" }) }).config,
    ).toBe(config);
    expect(
      scopeContext({ ...base, credential: credential("meta", { kind: "apikey" }) }).config.oauth
        .providers.codex["header-defaults"]["user-agent"],
    ).toBe("");
  });
});

describe("withProviderKeyScope", () => {
  const seen: ExecutionContext[] = [];

  const probe: ProviderExecutor = {
    identifier: "probe",
    execute: (context) =>
      Effect.sync(() => (seen.push(context), { payload: "", headers: new Headers() })),
    executeStream: () => Effect.die("unused"),
    countTokens: () => Effect.die("unused"),
  };

  it("wraps the providers whose Go executors implement ForAPIKey (not Devin)", async () => {
    const config = await loadConfig(YAML);
    const h = await harness(credential("meta"), () => new Response(""));
    const usage = h.usage;

    for (const provider of [
      "codex",
      "claude",
      "meta",
      "kimi",
      "kimi-ai",
      "xai",
      "openai-compatible-x",
    ]) {
      seen.length = 0;
      await Effect.runPromise(
        withProviderKeyScope(provider, probe)
          .execute(
            { config, usage, credential: credential(provider, { kind: "apikey" }) },
            { model: "m", payload: {} },
            {} as never,
          )
          .pipe(Effect.provide(h.layers)),
      );
      expect(seen[0]?.config.oauth.providers.devin["sensitive-words"]).toEqual([]);
    }

    const devin = makeDevinExecutor();
    expect(withProviderKeyScope("devin", devin)).toBe(devin);
  });
});

describe("executor registry", () => {
  it("serves Kimi (both domains), Meta and Devin", () => {
    const registry = makeExecutorRegistry();
    expect(registry.get("kimi")?.identifier).toBe("kimi");
    expect(registry.get("kimi-ai")?.identifier).toBe("kimi");
    expect(registry.get("meta")?.identifier).toBe("meta");
    expect(registry.get("devin")?.identifier).toBe("devin");
    expect(registry.get("devin")).toBe(registry.get("DEVIN"));
    expect(registry.get("unknown")).toBeUndefined();
  });
});
