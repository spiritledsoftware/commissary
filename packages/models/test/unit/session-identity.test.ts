// Header-based session identities (CLIProxyAPI f9ac9ffc).
import { describe, expect, it } from "vite-plus/test";
import type { Json } from "@commissary/json";
import { encodeSessionSegment, extractSessionInfo } from "../../src/handlers/session.ts";

const info = (headers: Record<string, string>, body?: Json) =>
  extractSessionInfo(new Headers(headers), body);

describe("header sessions isolate subagent identities (CLIProxyAPI f9ac9ffc)", () => {
  it.each([
    ["X-Session-ID", "header"],
    ["X-Http-Session-Id", "agy"],
    ["X-Session-Affinity", "affinity"],
    ["X-Slot-Session-Id", "slot"],
    ["X-Task-ID", "task"],
    ["X-Conversation-Id", "conv"],
    ["X-Thread-Id", "thread"],
    ["X-Client-Request-Id", "clientreq"],
  ])("%s with an agent id gives the agent its own session", (name, prefix) => {
    const one = info({ [name]: "s1", "X-Agent-Id": "worker-1" });
    const two = info({ [name]: "s1", "X-Agent-Id": "worker-2" });

    expect(one).toMatchObject({
      sessionId: `${prefix}:s1:agent:worker-1`,
      parentSessionId: `${prefix}:s1`,
      agentName: "worker-1",
      isSubagent: true,
    });
    expect(two?.sessionId).toBe(`${prefix}:s1:agent:worker-2`);
  });

  it("a body agent id outranks the header one, and `main` is no subagent", () => {
    expect(
      info(
        { "X-Session-ID": "s1", "X-Claude-Code-Agent-Id": "from-header" },
        { metadata: { agent_id: "from-body" } },
      )?.sessionId,
    ).toBe("header:s1:agent:from-body");

    expect(
      info(
        { "X-Session-ID": "s1", "X-Claude-Code-Agent-Id": "from-header" },
        { metadata: { agent_id: "main" } },
      )?.sessionId,
    ).toBe("header:s1:agent:from-header");

    expect(info({ "X-Session-ID": "s1", "X-Agent-Id": "main" })).toMatchObject({
      sessionId: "header:s1",
      agentName: "main",
      isSubagent: false,
    });
  });

  it("a parent agent id makes the parent agent's session the parent", () => {
    expect(
      info({ "X-Session-ID": "s1", "X-Agent-Id": "child", "X-Parent-Agent-Id": "lead" }),
    ).toMatchObject({
      sessionId: "header:s1:agent:child",
      parentSessionId: "header:s1:agent:lead",
    });
  });

  it("an explicit parent session header keeps the session and names the agent", () => {
    expect(
      info({ "X-Session-ID": "child", "X-Parent-Session-ID": "lead", "X-Agent-Id": "w" }),
    ).toMatchObject({
      sessionId: "header:child",
      parentSessionId: "header:lead",
      agentName: "w",
      isSubagent: true,
    });
  });

  it("escapes the reserved delimiter so a raw id cannot collide with a composed one", () => {
    expect(encodeSessionSegment("plain")).toBe("plain");
    expect(encodeSessionSegment("a:agent:b")).toBe("a:agent~;b");
    expect(encodeSessionSegment("a:agent~b")).toBe("a:agent~~b");

    const composed = info({ "X-Session-ID": "s1", "X-Agent-Id": "w" })?.sessionId;
    const raw = info({ "X-Session-ID": "s1:agent:w" })?.sessionId;

    expect(composed).toBe("header:s1:agent:w");
    expect(raw).toBe("header:s1:agent~;w");

    expect(info({}, { session_id: "s1:agent:w" })?.sessionId).toBe("session:s1:agent~;w");
    expect(info({}, { session_id: "s1", metadata: { agent_id: "w" } })?.sessionId).toBe(
      "session:s1:agent:w",
    );
  });
});
