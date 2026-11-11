// C9 PR B (Go 7a0b7563, 674dbe8f, cc5682c5, a68c7d8e, 772df04b): the signature a Codex-format upstream may be sent for a
// target model, and the Claude -> Codex request translator that uses it. Expected values come from
// translator/common/codex_replay_signature_test.go and codex_claude_request_test.go.
import { get, type Json } from "@commissary/json";
import { describe, expect, it } from "vitest";
import {
  codexReplaySignatureForTarget,
  resolveCodexReplayTargetModel,
} from "../src/translator/common/codex-replay-signature.ts";
import { convertClaudeRequestToCodex } from "../src/translator/codex/claude/request.ts";

/** Go `testCodexReplayMetaSignature`: `Q-PaDgE` pins the header, 1426 chars decode to 45 + 1024 bytes. */
const META = `Q-PaDgE${"A".repeat(1419)}`;

const ROUTED_META = `${META}.${"Ab3".repeat(23).slice(0, 67)}`;

/** Go `testCodexReplayGPTSignature`: version 0x80, 89 bytes. */
const GPT = (() => {
  const bytes = Array.from({ length: 89 }, (_, i) => (i >= 9 ? i : 0));

  bytes[0] = 0x80;

  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
})();

const ROUTED_GPT = `${GPT}.${"Ab3".repeat(27).slice(0, 79)}`;

const GROK =
  "HmlYdr2aCAqCYP/m9mr8PS6KOsdMs72FGDigmydR+Jsmuv8KX97yWPlbOwmXJgWn0CbHaCacdQD3+n5EvpgLfPNmafS3kdICBjRuDf4bzHy7uBiUhNVhqPtp/ee1y9q4imPE4LYgD1VZ4J+bp9mTeqA1+nC9Oue58CiNEMV9SVaGenCD+aBnVuSTzQhD32Y+68i6HLJW0Dx6ifaRfb8hxYtA/sPM+/FTvAMW11nRho5a2BBSkpnzfqqAz/e/vGJ77/bygpXM823QA9wL9i0X";

describe("codexReplaySignatureForTarget (Go common.CodexReplaySignatureForTarget)", () => {
  it.each([
    ["native meta on muse target", "muse-spark-1.3", META, META],
    ["routed meta on muse target", "meta/muse-wonder", ROUTED_META, ROUTED_META],
    ["gpt on gpt target", "gpt-5.4", GPT, GPT],
    [
      "routed gpt on openrouter gpt target",
      "openrouter/openai/gpt-5.6-luna-pro",
      ROUTED_GPT,
      ROUTED_GPT,
    ],
    ["gpt cache prefix normalized", "gpt-5.4", `gpt#${GPT}`, GPT],
    ["meta sig on gpt target rejected", "gpt-5.4", META, undefined],
    ["routed meta on gpt target rejected", "gpt-5.4", ROUTED_META, undefined],
    ["gpt sig on meta target rejected", "muse-spark-1.3", GPT, undefined],
    // An unmapped target defaults to the Codex GPT family.
    ["gpt on unmapped target", "deepseek-v4", GPT, GPT],
    ["meta on unmapped target rejected", "deepseek-v4", META, undefined],
    ["grok on grok target", "grok-4.5", GROK, GROK],
    ["grok on gpt target rejected", "gpt-5.4", GROK, undefined],
    ["empty signature", "gpt-5.4", "", undefined],
    ["unknown format", "gpt-5.4", "opaque-blob-xyz", undefined],
  ])("%s", (_name, model, signature, expected) => {
    expect(codexReplaySignatureForTarget(model, signature)).toBe(expected);
  });
});

describe("resolveCodexReplayTargetModel (Go common.ResolveCodexReplayTargetModel)", () => {
  const payload = (model: string): Json => ({ model });

  it("keeps a model that names a family", () => {
    expect(resolveCodexReplayTargetModel("gpt-5.4", payload("muse-spark-1.3"))).toBe("gpt-5.4");
  });

  it.each(["muse-spark-1.3", "grok-4.5", "gpt-5.4(high)"])(
    "falls back to the requested %s for an unmapped deployment alias",
    (requested) => {
      expect(resolveCodexReplayTargetModel("deployment-123", payload(requested))).toBe(requested);
    },
  );

  it("does not fall back to a family without Responses-native signatures", () => {
    expect(resolveCodexReplayTargetModel("deployment-123", payload("claude-sonnet-4-6"))).toBe(
      "deployment-123",
    );
    expect(resolveCodexReplayTargetModel("deployment-123", undefined)).toBe("deployment-123");
  });
});

const claudeRequest = (model: string | undefined, signature: string): Json => ({
  ...(model === undefined ? {} : { model }),
  messages: [
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "summary", signature },
        { type: "text", text: "answer" },
      ],
    },
    { role: "user", content: "next" },
  ],
});

const reasoningItems = (out: Json): Json[] => {
  const input = get(out, "input");

  return Array.isArray(input) ? input.filter((item) => get(item, "type") === "reasoning") : [];
};

describe("Claude -> Codex request signatures (Go 7a0b7563, 674dbe8f, a68c7d8e)", () => {
  const encrypted = (model: string, signature: string, requested = model): Json | undefined =>
    get(
      reasoningItems(
        convertClaudeRequestToCodex(model, claudeRequest(requested, signature), false),
      )[0] ?? {},
      "encrypted_content",
    );

  it("replays a Meta signature to a Meta target", () => {
    expect(encrypted("muse-spark-1.3", META)).toBe(META);
  });

  it("replays a router-suffixed Meta signature verbatim to a Meta target and drops it for GPT", () => {
    expect(encrypted("meta/muse-wonder", ROUTED_META)).toBe(ROUTED_META);
    expect(encrypted("gpt-5.4", ROUTED_META, "meta/muse-wonder")).toBeUndefined();
  });

  it.each(["gpt-5.4", "claude-sonnet-4-6", "grok-4.5"])(
    "drops a Meta signature for %s",
    (model) => {
      expect(
        reasoningItems(convertClaudeRequestToCodex(model, claudeRequest(undefined, META), false)),
      ).toHaveLength(0);
    },
  );

  it("drops a GPT signature for a Meta target", () => {
    expect(encrypted("muse-spark-1.3", GPT)).toBeUndefined();
  });

  it("replays a Meta signature to an unmapped deployment alias of a Meta model", () => {
    expect(encrypted("deployment-123", META, "muse-spark-1.3")).toBe(META);
  });

  it("replays a Grok signature to a Grok target only", () => {
    expect(encrypted("grok-4.5", GROK)).toBe(GROK);
    expect(
      reasoningItems(convertClaudeRequestToCodex("gpt-5.4", claudeRequest(undefined, GROK), false)),
    ).toHaveLength(0);
  });

  it("keeps a router-suffixed GPT signature", () => {
    expect(encrypted("gpt-5.4", ROUTED_GPT)).toBe(ROUTED_GPT);
  });
});
