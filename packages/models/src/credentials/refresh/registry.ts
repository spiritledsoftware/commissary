/**
 * Refresh protocol lookup by executor key (`executorKey`: `kimi.com` -> `kimi`).
 *
 * Providers without an entry (gemini provider keys, openai-compatible, devin, aistudio) have no token refresh. Vertex is
 * handled separately by the manager (minted access tokens are cached, not persisted in the auth file).
 */
import { refreshAntigravity } from "./antigravity.ts";
import { refreshClaude } from "./claude.ts";
import { refreshCodex } from "./codex.ts";
import { refreshCopilot } from "./copilot.ts";
import { refreshKimi } from "./kimi.ts";
import { refreshMeta } from "./meta.ts";
import type { RefreshProtocol } from "./types.ts";
import { refreshXai } from "./xai.ts";

const PROTOCOLS = new Map<string, RefreshProtocol>([
  ["claude", refreshClaude],
  ["codex", refreshCodex],
  ["antigravity", refreshAntigravity],
  ["xai", refreshXai],
  ["copilot", refreshCopilot],
  ["kimi", refreshKimi],
  ["kimi-ai", refreshKimi],
  ["meta", refreshMeta],
]);

export const refreshProtocolFor = (executor: string): RefreshProtocol | undefined =>
  PROTOCOLS.get(executor);
