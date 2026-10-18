// Display names of provider keys (`claude`, `codex`, `openai-compatible-<name>`, ...).
const NAMES = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["gemini-cli", "Gemini CLI"],
  ["vertex", "Vertex AI"],
  ["antigravity", "Antigravity"],
  ["kimi", "Kimi"],
  ["xai", "xAI"],
  ["devin", "Devin"],
  ["meta", "Meta"],
  ["opencode-zen", "OpenCode Zen"],
  ["opencode-go", "OpenCode Go"],
  ["typesafe", "TypeSafe"],
  ["subq", "SubQ"],
]);

export const providerName = (provider: string): string => {
  const known = NAMES.get(provider);

  if (known !== undefined) return known;

  if (provider.startsWith("openai-compatible-")) return provider.slice("openai-compatible-".length);

  return provider === "" ? "Unknown provider" : provider;
};
