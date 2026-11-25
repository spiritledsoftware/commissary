/**
 * The Claude 5.5 model patterns of the forced tool-choice rewrite (`claude-tool-choice.ts`) and the Antigravity
 * structured-output prompt (`antigravity/structured-output.ts`): the two models that reject forced tool use.
 *
 * Go source: internal/runtime/executor/helps/claude_tool_choice.go (`claude55Model`, CLIProxyAPI 1d45a5f3) and
 * antigravity_structured_output.go (`antigravityClaude55Model`, c813f779). Haiku 5.5 is deliberately outside both, as in
 * Go.
 */
import { parseSuffix } from "@commissary/translation/thinking";

/** `claude55Model`: Opus/Sonnet 5.5 with an optional `-high`/`-reasoning` variant, 8-digit date and `[context]` suffix. */
const CLAUDE_55_MODEL =
  /^claude-(?:opus|sonnet)-5-5(?:-(?:high|reasoning))?(?:-[0-9]{8})?(?:\[[^[\]]+\])?$/;

/** The model (thinking `(suffix)` removed, lower case) is Claude Opus 5.5 or Sonnet 5.5. */
export const isClaude55Model = (model: string): boolean =>
  CLAUDE_55_MODEL.test(parseSuffix(model.trim()).modelName.toLowerCase());

/** `antigravityClaude55Model`: Antigravity also routes the `-low`, `-medium` and `-max` effort variants (c813f779). */
const ANTIGRAVITY_CLAUDE_55_MODEL =
  /^claude-(?:opus|sonnet)-5-5(?:-(?:low|medium|high|max|reasoning))?(?:-[0-9]{8})?(?:\[[^[\]]+\])?$/;

/** The Antigravity model (thinking `(suffix)` removed, lower case) is Claude Opus 5.5 or Sonnet 5.5, any effort. */
export const isAntigravityClaude55Model = (model: string): boolean =>
  ANTIGRAVITY_CLAUDE_55_MODEL.test(parseSuffix(model.trim()).modelName.toLowerCase());
