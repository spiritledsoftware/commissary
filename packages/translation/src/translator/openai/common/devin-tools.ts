/** Go source: internal/translator/common/devin_tools.go. */

const EXEC_TARGET = "returning output or a session ID for ongoing interaction";

const EXEC_OBFUSCATED = "returning output or an session ID for ongoing interaction";

const STDIN_TARGET =
  "Writes characters to an existing unified exec session and returns recent output.";

const STDIN_OBFUSCATED =
  "Writes characters to a existing unified exec session and returns recent output.";

const equalFold = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** `IsDevinCodexAppAutomationUpdate`: the `automation_update` method of the `mcp__codex_app` namespace. */
export const isDevinCodexAppAutomationUpdate = (namespace: string, toolName: string): boolean => {
  const cleanNamespace = namespace.trim();
  const cleanTool = toolName.trim();

  if (equalFold(cleanNamespace, "mcp__codex_app") && equalFold(cleanTool, "automation_update"))
    return true;

  return equalFold(cleanTool, "mcp__codex_app__automation_update");
};

export const obfuscateExecCommandDescription = (description: string): string => {
  const desc = description.includes(EXEC_TARGET)
    ? description.replaceAll(EXEC_TARGET, EXEC_OBFUSCATED)
    : description;

  return desc.replace(
    /returning output or a session ID for ongoing interaction/gi,
    EXEC_OBFUSCATED,
  );
};

export const obfuscateWriteStdinDescription = (description: string): string => {
  const desc = description.includes(STDIN_TARGET)
    ? description.replaceAll(STDIN_TARGET, STDIN_OBFUSCATED)
    : description;

  return desc.replace(
    /Writes characters to an existing unified exec session and returns recent output(\.?)/gi,
    "Writes characters to a existing unified exec session and returns recent output$1",
  );
};

/**
 * `SanitizeDevinToolDescription`. Clients embed exec_command and write_stdin descriptions inside other tools (the Codex
 * code-mode `exec` tool), and Devin rejects those phrases whatever the tool is called, so every description is rewritten.
 */
export const sanitizeDevinToolDescription = (desc: string): string =>
  desc === "" ? desc : obfuscateWriteStdinDescription(obfuscateExecCommandDescription(desc));
