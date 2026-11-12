// Small hardening helpers: config keys that do nothing on Workers, shared hashing.
import { createHash } from "node:crypto";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { notAppliedSettings } from "../src/config/not-applied.ts";
import { sha256Hex } from "@commissary/core";
import { sha256Hex as oauthSha256Hex } from "../src/oauth/encoding.ts";
import { loadConfig } from "./support/pipeline.ts";

const GO_CONFIG = `
access:
  api-keys: [legacy-key]
requests:
  nonstream-keepalive-interval: 15
upstream:
  codex:
    response-steering: true
  claude:
    header-defaults:
      stabilize-device-profile: true
api-keys:
  claude:
    - keys:
        - api-key: sk-ant
          experimental-cch-signing: true
observability:
  logs:
    request-log: true
  usage:
    usage-statistics-enabled: true
    redis-usage-queue-retention-seconds: 120
`;

describe("notAppliedSettings", () => {
  it("names the accepted keys that have no effect on Workers", async () => {
    expect(notAppliedSettings(await loadConfig(GO_CONFIG))).toEqual([
      "access.api-keys",
      "api-keys.claude[].keys[].experimental-cch-signing",
      "observability.logs.request-log",
      "observability.usage.usage-statistics-enabled",
      "observability.usage.redis-usage-queue-retention-seconds",
    ]);
    expect(notAppliedSettings(await loadConfig("routing:\n  strategy: fill-first\n"))).toEqual([]);
  });

  it("names the catalog keys that no longer fetch anything", async () => {
    expect(
      notAppliedSettings(
        await loadConfig(
          "models:\n  codex-catalog: embed\n  devin-catalog: https://x.test/d.json\n",
        ),
      ),
    ).toEqual(["models.codex-catalog", "models.devin-catalog"]);
  });

  it("is reported by the config import", async () => {
    const result = await env.CONTROL_PLANE.getByName(`hardening-${crypto.randomUUID().slice(0, 8)}`)
      .models()
      .importConfig(GO_CONFIG, "test");

    expect(result.ok && result.notApplied).toContain("access.api-keys");
    // Response steering is ported: an effective key, not reported.
    expect(result.ok && result.notApplied).not.toContain("upstream.codex.response-steering");
  });
});

describe("sha256Hex", () => {
  it("is shared by the sync and async callers", async () => {
    const expected = createHash("sha256").update("héllo", "utf8").digest("hex");
    expect(sha256Hex("héllo")).toBe(expected);
    expect(await oauthSha256Hex("héllo")).toBe(expected);
    expect(await oauthSha256Hex("héllo", 8)).toBe(expected.slice(0, 16));
  });
});
