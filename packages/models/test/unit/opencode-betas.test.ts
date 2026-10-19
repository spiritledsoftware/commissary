// The `anthropic-beta` value of an OpenCode Messages request: the client's betas minus the Claude Code / Anthropic
// account identity ones, plus the beta its body needs.
import { describe, expect, it } from "vitest";
import type { Json } from "@commissary/json";
import {
  MID_CONVERSATION_OUTPUT_CONFIG_BETA as MID_CONVERSATION,
  messagesBetaHeader,
} from "../../src/executor/opencode/betas.ts";

const plain: Json = { model: "m", messages: [{ role: "user", content: "hi" }] };

const withEffort: Json = {
  model: "m",
  messages: [
    { role: "user", content: "hi" },
    { role: "system", content: [], output_config: { effort: "low" } },
  ],
};

describe("messagesBetaHeader", () => {
  it("sends nothing without client betas or a body that needs one", () => {
    expect(messagesBetaHeader(undefined, plain)).toBeUndefined();
    expect(messagesBetaHeader(null, plain)).toBeUndefined();
    expect(messagesBetaHeader("", plain)).toBeUndefined();
  });

  it("forwards client betas trimmed and deduplicated, in the client's order", () => {
    expect(messagesBetaHeader(" b-2 , a-1,,b-2,c-3 ", plain)).toBe("b-2,a-1,c-3");
  });

  it("strips the identity betas (claude-code-*, oauth-*)", () => {
    expect(messagesBetaHeader("claude-code-20250219,oauth-2025-04-20", plain)).toBeUndefined();
    expect(
      messagesBetaHeader(
        "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20",
        plain,
      ),
    ).toBe("interleaved-thinking-2025-05-14");
  });

  it("strips identity betas whatever their case, keeping the other betas as sent", () => {
    expect(messagesBetaHeader("Claude-Code-20250219,OAuth-2025-04-20,Custom-Beta-1", plain)).toBe(
      "Custom-Beta-1",
    );
  });

  it("adds the mid-conversation output_config beta when a system message carries output_config", () => {
    expect(messagesBetaHeader(undefined, withEffort)).toBe(MID_CONVERSATION);
  });

  it("does not repeat the beta when the client already sent it, keeping the client's order", () => {
    expect(messagesBetaHeader(`a-1,${MID_CONVERSATION},b-2`, withEffort)).toBe(
      `a-1,${MID_CONVERSATION},b-2`,
    );
  });

  it("appends the body-derived beta after the forwarded ones", () => {
    expect(messagesBetaHeader("claude-code-20250219,a-1", withEffort)).toBe(
      `a-1,${MID_CONVERSATION}`,
    );
  });

  it("ignores output_config on the body or on non-system messages", () => {
    expect(
      messagesBetaHeader(undefined, {
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "hi", output_config: { effort: "low" } }],
      }),
    ).toBeUndefined();
  });

  it("ignores a system message whose output_config is null", () => {
    expect(
      messagesBetaHeader(undefined, {
        messages: [{ role: "system", content: [], output_config: null }],
      }),
    ).toBeUndefined();
  });

  it("ignores a system message without output_config", () => {
    expect(
      messagesBetaHeader(undefined, { messages: [{ role: "system", content: "be brief" }] }),
    ).toBeUndefined();
  });
});
