// Devin tool description rewrites (CLIProxyAPI e25b7daf, `TestSanitizeDevinToolDescription`): embedded exec_command and
// write_stdin phrases are rewritten whatever the tool is called.
import { describe, expect, it } from "vitest";
import { get } from "@commissary/json";
import { sanitizeDevinToolDescription } from "../src/translator/openai/common/devin-tools.ts";
import { convertOpenAIResponsesRequestToInteractions } from "../src/translator/openai/interactions/responses/request-responses-to-interactions.ts";

const codeModeExecDescription =
  "Run JavaScript code to orchestrate/compose tool calls\n" +
  "### exec_command\nRuns a command in a PTY, returning output or a session ID for ongoing interaction.\n" +
  "### write_stdin\nWrites characters to an existing unified exec session and returns recent output.\n";

describe("sanitizeDevinToolDescription", () => {
  it("rewrites phrases embedded in another tool's description", () => {
    const sanitized = sanitizeDevinToolDescription(codeModeExecDescription);

    expect(sanitized).toContain("returning output or an session ID for ongoing interaction");
    expect(sanitized).toContain("to a existing unified exec session and returns recent output.");
    expect(sanitized).not.toContain("a session ID");
    expect(sanitized).not.toContain("to an existing unified");
  });

  it("rewrites every occurrence of a mixed description", () => {
    const sanitized = sanitizeDevinToolDescription(
      "First occurrence: returning output or an session ID for ongoing interaction.\n" +
        "Second occurrence: returning output or a session ID for ongoing interaction.\n" +
        "First stdin: Writes characters to a existing unified exec session and returns recent output.\n" +
        "Second stdin: Writes characters to an existing unified exec session and returns recent output.",
    );

    expect(sanitized).not.toContain("a session ID");
    expect(sanitized).not.toContain("to an existing unified");
  });

  it("leaves unrelated descriptions alone", () => {
    expect(sanitizeDevinToolDescription("Writes arbitrary input to a process")).toBe(
      "Writes arbitrary input to a process",
    );
    expect(sanitizeDevinToolDescription("")).toBe("");
  });

  it.each(["exec", "functions__exec", "other_tool"])(
    "rewrites the phrases of a Responses tool named %s",
    (name) => {
      const out = convertOpenAIResponsesRequestToInteractions(
        "devin/claude-opus-5-5",
        {
          model: "devin/claude-opus-5-5",
          tools: [{ type: "custom", name, description: codeModeExecDescription }],
          input: "Reply with exactly: OK",
        },
        false,
      );

      const description = get(out, "tools.0.description");
      expect(description).toContain("an session ID");
      expect(description).toContain("to a existing unified");
      expect(description).not.toContain("a session ID for");
    },
  );
});
