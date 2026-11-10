// Claude Code client detection through the Claude executor (CLIProxyAPI 6876a2eb, 20c9095c, 542a525f, 59304330,
// 6d4102f3, d2e61d19): `x-app: cli-bg`, the `sdk-ts` and configured `native-entrypoints` entrypoints, `(external, cli,
// <field>)` User-Agent extensions, and the caller's Stainless headers under `cloak_mode: never`.
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { collectForwardedBlocks } from "../src/executor/claude/cloaking.ts";
import {
  makeMemoryDeviceProfileStore,
  profileScopeKey,
  type DeviceProfileStore,
} from "../src/executor/claude/device-profile.ts";
import { makeClaudeExecutor } from "../src/executor/claude/executor.ts";
import { makeMemoryContinuityStore } from "../src/executor/claude/continuity.ts";
import type { JsonObject } from "@commissary/json";
import { credential, execute, harness, json, loadConfig, options } from "./support/executor-run.ts";

const USER_ID = JSON.stringify({
  device_id: "0".repeat(64),
  account_uuid: "",
  session_id: "11111111-2222-4333-8444-555555555555",
});

const oauth = (attributes: Record<string, string> = {}) =>
  credential("claude", {
    kind: "oauth",
    attributes,
    metadata: { access_token: "sk-ant-oat01-detect" },
  });

const NATIVE = {
  "user-agent": "claude-cli/2.1.321 (external, cli)",
  "x-app": "cli",
  "anthropic-beta": "claude-code-20250219",
  "x-stainless-os": "Linux",
  "x-stainless-arch": "x64",
  "x-stainless-package-version": "0.128.0",
  "x-stainless-runtime-version": "v26.12.1",
};

const body = (): JsonObject => ({
  messages: [{ role: "user", content: "hi" }],
  metadata: { user_id: USER_ID },
  max_tokens: 5,
});

const ok = () =>
  Response.json({
    id: "msg_1",
    type: "message",
    model: "claude-3-5-sonnet",
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });

/** NATIVE with `overrides` on top; an `undefined` override removes the header. */
const callerHeaders = (overrides: Record<string, string | undefined>): Headers => {
  const headers = new Headers(NATIVE);

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) headers.delete(name);
    else headers.set(name, value);
  }

  return headers;
};

/** Sends one request as `headers` (over NATIVE unless `bare`) and returns the upstream request headers. */
const send = async (
  headers: Record<string, string | undefined>,
  yaml = "",
  cred = oauth(),
  deviceProfiles: DeviceProfileStore = makeMemoryDeviceProfileStore(),
): Promise<Record<string, string>> => {
  const h = await harness(cred, () => ok(), yaml);

  await execute(
    makeClaudeExecutor({ continuity: makeMemoryContinuityStore(), deviceProfiles }),
    h,
    { model: "claude-3-5-sonnet-20241022", payload: json(body()) },
    options({ sourceFormat: "claude", headers: callerHeaders(headers) }),
  );

  return h.calls[0]?.headers ?? {};
};

const baselineProfile = (userAgent: string) => ({
  userAgent,
  packageVersion: "0.128.0",
  runtimeVersion: "v26.12.1",
  os: "MacOS",
  arch: "arm64",
});

const scope = (userAgent: string, native: readonly string[]) =>
  profileScopeKey({ id: "c" }, "k", baselineProfile(userAgent), native);

/** A confirmed client keeps its own platform headers; anything else gets the configured baseline (MacOS). */
const isNative = (sent: Record<string, string>): boolean => sent["x-stainless-os"] === "Linux";

describe("x-app of Claude Code background sessions (6876a2eb)", () => {
  it("treats cli-bg like cli: the native identity passes through", async () => {
    const sent = await send({ "x-app": "cli-bg" });

    expect(sent["x-app"]).toBe("cli-bg");
    expect(isNative(sent)).toBe(true);
  });

  it.each(["cli-other", "web", "sdk"])("does not accept x-app %s", async (app) => {
    const sent = await send({ "x-app": app });

    expect(sent["x-app"]).toBe("cli");
    expect(isNative(sent)).toBe(false);
  });
});

describe("native entrypoints (20c9095c, 6d4102f3)", () => {
  const SDK_TS = "claude-cli/2.1.321 (external, sdk-ts, agent-sdk/0.3.276)";
  const T3_CODE = "claude-cli/2.1.321 (external, t3-code, agent-sdk/0.3.276)";

  it("sdk-ts is native and keeps its own User-Agent", async () => {
    const sent = await send({ "user-agent": SDK_TS });

    expect(isNative(sent)).toBe(true);
    expect(sent["user-agent"]).toBe(SDK_TS);
  });

  it("an entrypoint outside the list is not native, even with the strong signals", async () => {
    const sent = await send({ "user-agent": "claude-cli/2.1.321 (external, sdk-py)" });

    expect(isNative(sent)).toBe(false);
    expect(sent["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
  });

  it("header-defaults.native-entrypoints adds labels, case-insensitively", async () => {
    const yaml =
      'upstream:\n  claude:\n    header-defaults:\n      native-entrypoints: [" T3-Code "]\n';

    expect(isNative(await send({ "user-agent": T3_CODE }))).toBe(false);

    const sent = await send({ "user-agent": T3_CODE }, yaml);
    expect(isNative(sent)).toBe(true);
    expect(sent["user-agent"]).toBe(T3_CODE);

    // The strong signals are still required.
    expect(isNative(await send({ "user-agent": T3_CODE, "anthropic-beta": undefined }, yaml))).toBe(
      false,
    );
  });

  it("the device profile of an entrypoint is scoped by name, a configured one apart from the others", () => {
    expect(scope("claude-cli/2.1.321 (external, cli)", [])).toBe("auth:c");
    expect(scope(SDK_TS, [])).toBe("auth:c|subclient:sdk-ts");
    expect(scope(T3_CODE, [])).toBe("auth:c|subclient:other");
    expect(scope(T3_CODE, ["t3-code"])).toBe("auth:c|subclient:t3-code");
  });
});

describe("User-Agent extension fields (542a525f, 59304330)", () => {
  it.each([
    "claude-cli/2.1.321 (external, cli, workload/cron)",
    "claude-cli/2.1.321 (external, cli, workload/cron, agent-sdk/0.2.133)",
    "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133, workload/cron)",
    "claude-cli/2.1.321 (external, cli, future-feature/value, workload/background)",
    "claude-cli/2.1.321 (external, cli, future_field.v2/value/path)",
  ])("%s is native and reaches the upstream unchanged", async (userAgent) => {
    const sent = await send({ "user-agent": userAgent });

    expect(isNative(sent)).toBe(true);
    expect(sent["user-agent"]).toBe(userAgent);
  });

  it.each([
    "claude-cli/2.1.321(external, cli)",
    "claude-cli/2.1.321-extra (external, cli)",
    "claude-cli/2.1.321 (external, )",
    "claude-cli/2.1.321 (external, cli, foo)",
    "claude-cli/2.1.321 (external, cli, /cron)",
    "claude-cli/2.1.321 (external, cli, workload/)",
    "claude-cli/2.1.321 (external, cli, bad name/value)",
    "claude-cli/2.1.321 (external, cli, workload/(cron))",
    "claude-cli/2.1.321 (external, cli, workload/cron, WORKLOAD/background)",
    "claude-cli/2.1.321 (external, cli, agent-sdk/dev)",
    "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133, agent-sdk/0.2.134)",
    "claude-cli/2.1.321 (external, cli, workload/cron) trailing",
    "claude-cli/2.1.320 (external, cli, workload/cron)",
    "claude-cli/2.2.0 (external, cli, workload/cron)",
  ])("%s is not native", async (userAgent) => {
    const sent = await send({ "user-agent": userAgent });

    expect(isNative(sent)).toBe(false);
    expect(sent["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
  });

  describe("with stabilize-device-profile", () => {
    const STABLE =
      "upstream:\n  claude:\n    header-defaults:\n      stabilize-device-profile: true\n";

    it("the stored identity keeps agent-sdk only, the request keeps its own fields", async () => {
      const store = makeMemoryDeviceProfileStore();

      const cases: ReadonlyArray<readonly [string, string]> = [
        [
          "claude-cli/2.1.321 (external, cli, workload/cron, agent-sdk/0.2.133, future-feature/value)",
          "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133, workload/cron, future-feature/value)",
        ],
        [
          "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133)",
          "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133)",
        ],
        [
          "claude-cli/2.1.321 (external, cli, future-feature/next)",
          "claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133, future-feature/next)",
        ],
      ];

      for (const [incoming, upstream] of cases) {
        const sent = await send({ "user-agent": incoming }, STABLE, oauth(), store);
        expect(sent["user-agent"]).toBe(upstream);
      }

      // A request without a candidate resolves to the stored stable identity.
      const config = await loadConfig(STABLE);

      const stored = await Effect.runPromise(
        store.resolve({ id: "claude-1" }, "sk-ant-oat01-detect", new Headers(), config),
      );

      expect(stored.userAgent).toBe("claude-cli/2.1.321 (external, cli, agent-sdk/0.2.133)");
    });

    it("an ordinary UA leaves the profile's User-Agent as it is", async () => {
      const sent = await send({}, STABLE);

      expect(sent["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    });
  });
});

describe("Stainless versions of a confirmed client (20c9095c)", () => {
  const NEWER = {
    "user-agent": "claude-cli/2.1.325 (external, cli)",
    "x-stainless-package-version": "0.130.0",
    "x-stainless-runtime-version": "v26.13.0",
  };

  it("keeps newer package and runtime versions", async () => {
    const sent = await send(NEWER);

    expect(sent["x-stainless-package-version"]).toBe("0.130.0");
    expect(sent["x-stainless-runtime-version"]).toBe("v26.13.0");
    expect(sent["user-agent"]).toBe("claude-cli/2.1.325 (external, cli)");
  });

  it("replaces older versions with the baseline", async () => {
    const sent = await send({
      "x-stainless-package-version": "0.100.0",
      "x-stainless-runtime-version": "v26.1.0",
    });

    expect(sent["x-stainless-package-version"]).toBe("0.128.0");
    expect(sent["x-stainless-runtime-version"]).toBe("v26.12.1");
  });

  it("requires the configured value when header-defaults sets one", async () => {
    const sent = await send(
      NEWER,
      'upstream:\n  claude:\n    header-defaults:\n      package-version: "0.128.0"\n      runtime-version: "v26.12.1"\n',
    );

    expect(sent["x-stainless-package-version"]).toBe("0.128.0");
    expect(sent["x-stainless-runtime-version"]).toBe("v26.12.1");
  });
});

describe("cloak_mode never (20c9095c, d2e61d19)", () => {
  const NEVER = oauth({ cloak_mode: "never" });
  const SDK_PY = "claude-cli/2.1.325 (external, sdk-py, agent-sdk/0.3.276)";

  const CALLER = {
    "user-agent": SDK_PY,
    "x-stainless-package-version": "0.130.0",
    "x-stainless-runtime-version": "v26.13.0",
  };

  it("keeps the caller's headers when it has the confirmed shape, even for an entrypoint outside the list", async () => {
    const sent = await send(CALLER, "", NEVER);

    expect(sent["user-agent"]).toBe(SDK_PY);
    expect(sent["x-stainless-package-version"]).toBe("0.130.0");
    expect(sent["x-stainless-runtime-version"]).toBe("v26.13.0");
    expect(isNative(sent)).toBe(true);
  });

  it("keeps them ahead of stabilize-device-profile pinning", async () => {
    const sent = await send(
      CALLER,
      "upstream:\n  claude:\n    header-defaults:\n      stabilize-device-profile: true\n",
      NEVER,
    );

    expect(sent["user-agent"]).toBe(SDK_PY);
    expect(sent["x-stainless-package-version"]).toBe("0.130.0");
    expect(sent["x-stainless-os"]).toBe("Linux");
  });

  it("without the strong signals the request gets the baseline identity", async () => {
    const sent = await send({ ...CALLER, "anthropic-beta": undefined }, "", NEVER);

    expect(sent["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    expect(isNative(sent)).toBe(false);
  });

  it("a credential that is not set to never does not keep an unlisted entrypoint", async () => {
    const sent = await send(CALLER);

    expect(sent["user-agent"]).toBe("claude-cli/2.1.321 (external, cli)");
    expect(isNative(sent)).toBe(false);
  });

  it("validates the versions against the configured baseline: newer kept, older replaced by it", async () => {
    const yaml = `upstream:
  claude:
    header-defaults:
      user-agent: "claude-cli/2.2.0 (external, cli)"
      package-version: "0.95.0"
      runtime-version: "v26.4.0"
`;

    const plausible = await send(
      {
        "user-agent": "claude-cli/2.2.5 (external, cli)",
        "x-stainless-package-version": "0.128.0",
        "x-stainless-runtime-version": "v26.5.0",
      },
      yaml,
      NEVER,
    );

    expect(plausible["user-agent"]).toBe("claude-cli/2.2.5 (external, cli)");
    expect(plausible["x-stainless-package-version"]).toBe("0.128.0");
    expect(plausible["x-stainless-runtime-version"]).toBe("v26.5.0");

    const fallback = await send(
      {
        "user-agent": "claude-cli/2.2.5 (external, cli)",
        "x-stainless-package-version": "0.80.0",
        "x-stainless-runtime-version": undefined,
      },
      yaml,
      NEVER,
    );

    expect(fallback["x-stainless-package-version"]).toBe("0.95.0");
    expect(fallback["x-stainless-runtime-version"]).toBe("v26.4.0");
  });
});

describe("Claude Agent SDK identity blocks (20c9095c)", () => {
  it.each([
    "You are Claude Code, Anthropic's official CLI for Claude.",
    "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    " You are a Claude agent, built on Anthropic's Claude Agent SDK.\n",
  ])("%j is not forwarded as caller system text", (identity) => {
    const blocks = collectForwardedBlocks([
      { type: "text", text: identity },
      { type: "text", text: "Caller rules" },
    ]);

    expect(blocks.map((block) => block.text)).toEqual(["Caller rules"]);
  });
});
