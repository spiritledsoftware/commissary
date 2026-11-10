/**
 * Devin tool naming/description rules.
 *
 * Go source: internal/translator/common/devin_tools.go (IsDevinCodexAppAutomationUpdate; the description rewrites of
 * `SanitizeDevinToolDescription` are `@commissary/translation`'s), internal/runtime/executor/helps/devin_wire.go (the
 * `task_id` -> `taskId` description rewrite).
 */

import { sanitizeDevinToolDescription } from "@commissary/translation";

/** `IsDevinCodexAppAutomationUpdate`: the Codex desktop `automation_update` tool is never sent to Devin. */
export const isCodexAppAutomationUpdate = (namespace: string, toolName: string): boolean => {
  const ns = namespace.trim().toLowerCase();
  const tool = toolName.trim().toLowerCase();

  return (
    (ns === "mcp__codex_app" && tool === "automation_update") ||
    tool === "mcp__codex_app__automation_update"
  );
};

const TASK_ID_PHRASE = "Takes a task_id parameter identifying the task";

/** The wire description: Claude Code's `task_id` becomes the `taskId` Devin's tool environment expects. */
export const devinWireToolDescription = (description: string): string =>
  sanitizeDevinToolDescription(
    description.includes(TASK_ID_PHRASE)
      ? description.replaceAll(TASK_ID_PHRASE, "Takes a taskId parameter identifying the task")
      : description,
  );
