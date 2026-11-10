/**
 * Devin tool naming/description rules.
 *
 * Go source: internal/translator/common/devin_tools.go (IsDevinCodexAppAutomationUpdate, ObfuscateExecCommandDescription,
 * ObfuscateWriteStdinDescription, SanitizeDevinToolDescription), internal/runtime/executor/helps/devin_wire.go (the
 * `task_id` -> `taskId` description rewrite).
 */

/** `IsDevinCodexAppAutomationUpdate`: the Codex desktop `automation_update` tool is never sent to Devin. */
export const isCodexAppAutomationUpdate = (namespace: string, toolName: string): boolean => {
  const ns = namespace.trim().toLowerCase();
  const tool = toolName.trim().toLowerCase();

  return (
    (ns === "mcp__codex_app" && tool === "automation_update") ||
    tool === "mcp__codex_app__automation_update"
  );
};

const EXEC_TARGET = "returning output or a session ID for ongoing interaction";

const EXEC_OBFUSCATED = "returning output or an session ID for ongoing interaction";

const STDIN_TARGET =
  "Writes characters to an existing unified exec session and returns recent output.";

const STDIN_OBFUSCATED =
  "Writes characters to a existing unified exec session and returns recent output.";

const obfuscateExecCommand = (description: string): string => {
  const desc = description.includes(EXEC_TARGET)
    ? description.replaceAll(EXEC_TARGET, EXEC_OBFUSCATED)
    : description;

  return desc.replace(
    /returning output or a session ID for ongoing interaction/gi,
    EXEC_OBFUSCATED,
  );
};

const obfuscateWriteStdin = (description: string): string => {
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
export const sanitizeDevinToolDescription = (description: string): string =>
  description === "" ? description : obfuscateWriteStdin(obfuscateExecCommand(description));

const TASK_ID_PHRASE = "Takes a task_id parameter identifying the task";

/** The wire description: Claude Code's `task_id` becomes the `taskId` Devin's tool environment expects. */
export const devinWireToolDescription = (description: string): string =>
  sanitizeDevinToolDescription(
    description.includes(TASK_ID_PHRASE)
      ? description.replaceAll(TASK_ID_PHRASE, "Takes a taskId parameter identifying the task")
      : description,
  );
