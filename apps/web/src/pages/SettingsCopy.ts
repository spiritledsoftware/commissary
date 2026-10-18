// What the Settings page says about each setting: its label, the checkbox sentence for a flag, the one-line meaning of
// each choice, and the hint under the control. Honest about Workers: a partly effective setting says what it does
// here (research: .scratch/p5-settings-research.md (a) 1).

export interface Option {
  readonly value: string;
  readonly name: string;
  readonly hint: string;
}

export interface FieldCopy {
  /** The control's label (a radio list's legend; a flag's label is `check`). */
  readonly label: string;
  /** A flag: the sentence beside its checkbox. */
  readonly check?: string;
  readonly hint?: string;
  readonly options?: ReadonlyArray<Option>;
  readonly placeholder?: string;
  /** Text and number inputs: how wide the value runs. */
  readonly size?: "short" | "medium" | "long";
  /** A radio list on one line, without per-choice hints (the section explains the choices once). */
  readonly inline?: boolean;
}

const flag = (check: string, hint?: string): FieldCopy => ({
  label: check,
  check,
  ...(hint === undefined ? {} : { hint }),
});

export const CATALOG_OPTIONS: ReadonlyArray<Option> = [
  { value: "official", name: "Official", hint: "Fetched from models.dev." },
  {
    value: "embed",
    name: "Embedded copy",
    hint: "The snapshot built into this deployment; never fetched.",
  },
  { value: "disabled", name: "Off", hint: "Not refreshed; the last catalog stays in use." },
  { value: "custom", name: "Custom address", hint: "Fetched from your own URL." },
];

/** Above the Claude cloak settings: what cloaking is, and who a Claude subscription is for. */
export const CLAUDE_CLOAKING_NOTE =
  "Cloaking makes a request on a Claude account look like Claude Code's own traffic, which a subscription needs. A Pro or Max subscription is for the person who owns it, sending their own requests: connect it as their private account, and don't share it or route other people's traffic through it. For anything shared, add a Claude provider key (Max and Team plans include monthly API credits). Anthropic's Usage Policy (from 12 November 2026) prohibits services that route requests through consumer subscriptions or misrepresent the client. Cloaking at either level misrepresents the client, so it is at your own risk.";

const COPY = {
  "routing.strategy": {
    label: "Strategy",
    options: [
      {
        value: "round-robin",
        name: "Round robin",
        hint: "Each request goes to the next available credential in turn.",
      },
      {
        value: "weighted-round-robin",
        name: "Weighted",
        hint: "Credentials take turns in proportion to their weight; a weight of 0 takes none.",
      },
      {
        value: "fill-first",
        name: "Fill first",
        hint: "Use one credential until it cools down, then move to the next.",
      },
    ],
  },
  "routing.session-affinity": flag(
    "Keep a session on the credential it started with",
    "A bound session stays on its credential even when one with a higher priority recovers.",
  ),
  "routing.session-affinity-ttl": {
    label: "Forget a session's credential after",
    hint: "Such as 30m or 1h30m.",
    placeholder: "1h",
    size: "short",
  },
  "routing.session-affinity-subagents": flag(
    "Subagents share their session's credential",
    "Off spreads subagents across the pool for more parallel requests.",
  ),
  "routing.force-model-prefix": flag(
    "Model names without a prefix use only credentials without one",
    "Accounts and keys with a prefix then answer only prefix/model.",
  ),

  "routing.retry.request-retry": {
    label: "Retry rounds",
    hint: "0 = no extra rounds. Rounds follow 403, 408, 429 and 5xx failures; keys and accounts can set their own.",
    size: "short",
  },
  "routing.retry.max-retry-credentials": {
    label: "Credentials tried per round",
    hint: "0 = every available credential.",
    size: "short",
  },
  "routing.retry.max-retry-interval": {
    label: "Longest wait for a cooldown, in seconds",
    hint: "0 = never wait. Workers waits at most 30 s; a longer cooldown answers Retry-After instead.",
    size: "short",
  },
  "routing.cooldown.disable-cooling": flag(
    "Never cool a credential down after a failure",
    "Keys and accounts with their own setting keep it.",
  ),
  "routing.cooldown.transient-error-cooldown-seconds": {
    label: "Cooldown after a provider error",
    options: [
      { value: "default", name: "60 seconds", hint: "After a 408, 5xx or 52x answer." },
      { value: "off", name: "Off", hint: "Provider errors never cool a credential down." },
      { value: "custom", name: "Custom", hint: "A length of your own." },
    ],
  },
  "upstream.claude.model-level-cooling": flag(
    "Claude: cool down only the model that hit its quota",
    "Off cools the whole account down.",
  ),
  "upstream.codex.model-level-cooling": flag(
    "Codex: cool down only the model that hit its usage limit",
    "Off cools the whole account down.",
  ),

  "requests.passthrough-headers": flag(
    "Pass the provider's response headers to clients",
    "Hop-by-hop headers and cookies never pass.",
  ),
  "requests.nonstream-keepalive-interval": {
    label: "Blank line every N seconds while a whole response is pending",
    hint: "0 = off. Keeps idle connections from timing out.",
    size: "short",
  },
  "requests.streaming.keepalive-seconds": {
    label: "Keep-alive every N seconds in a stream",
    hint: "0 = off. Server-sent events only; WebSocket clients get no pings on Workers.",
    size: "short",
  },
  "requests.streaming.bootstrap-retries": {
    label: "Retries before the first byte of a stream",
    hint: "0 = off. Safe: nothing has reached the client yet.",
    size: "short",
  },

  "multimedia.disable-image-generation": {
    label: "Image generation",
    options: [
      {
        value: "false",
        name: "On",
        hint: "Codex requests get the image tool; the image endpoints answer.",
      },
      {
        value: "chat",
        name: "Image endpoints only",
        hint: "No image tool in chat requests; the image endpoints still answer.",
      },
      {
        value: "passthrough",
        name: "Pass the client's tools through",
        hint: "Chat requests keep exactly the tools the client sent; the image endpoints answer.",
      },
      {
        value: "true",
        name: "Off",
        hint: "No image tool anywhere; the image endpoints answer 404.",
      },
    ],
  },
  "multimedia.gpt-image-2-base-model": {
    label: "Model behind the hosted image tool",
    hint: "Starts with gpt-. Empty = gpt-5.4-mini.",
    placeholder: "gpt-5.4-mini",
    size: "medium",
  },
  "multimedia.video-result-auth-cache-ttl": {
    label: "A video stays with the credential that made it for",
    hint: "Such as 3h. Later requests about the video use that credential.",
    placeholder: "3h",
    size: "short",
  },

  "upstream.claude.disable-claude-cloak-mode": flag(
    "Turn off cloaking for Claude accounts",
    "On by default for clients other than Claude Code. Keys and accounts with their own mode keep it.",
  ),
  "upstream.claude.cloak-level": {
    label: "How much a cloaked request looks like Claude Code",
    hint: "Keys and accounts with their own level keep it. Neither level turns cloaking on.",
    options: [
      {
        value: "full",
        name: "Full",
        hint: "Everything Claude Code sends: its headers, billing block, tool names and metadata.",
      },
      {
        value: "minimal",
        name: "Minimal",
        hint: "Only what a Claude subscription checks: the Claude Code identity line, with the client's system prompt moved out of the system field.",
      },
    ],
  },
  "upstream.claude.disable-cloaking-model-list": flag(
    "List Claude's own model ids instead of cloaked ones",
  ),
  "upstream.claude.header-defaults.user-agent": { label: "User-Agent", size: "long" },
  "upstream.claude.header-defaults.package-version": { label: "Package version", size: "medium" },
  "upstream.claude.header-defaults.runtime-version": { label: "Runtime version", size: "medium" },
  "upstream.claude.header-defaults.os": { label: "Operating system", size: "medium" },
  "upstream.claude.header-defaults.arch": { label: "Architecture", size: "medium" },
  "upstream.claude.header-defaults.timeout": { label: "Timeout", size: "medium" },
  "upstream.claude.header-defaults.timezone": {
    label: "Time zone",
    hint: "An IANA zone such as Europe/Berlin, or Local. Empty = UTC.",
    size: "medium",
  },
  "upstream.claude.header-defaults.stabilize-device-profile": flag(
    "Pin one device profile per account",
  ),
  "upstream.codex.disable-codex-cloaking": flag(
    "Send the client's own User-Agent and Originator to Codex",
    "Off sends the official Codex ones.",
  ),
  "upstream.codex.stream-bootstrap-buffering": flag(
    "Hold the start of a Codex stream until it is safe to retry",
  ),
  "upstream.codex.stream-bootstrap-timeout": {
    label: "Hold the start for at most",
    hint: "Such as 45s, or whole seconds. 0 = no time limit; the size budget still applies.",
    placeholder: "0",
    size: "short",
  },
  "upstream.codex.orphan-delegation-compatibility": flag(
    "Turn orphaned subagent messages into user messages",
    "For requests that send X-Openai-Subagent: collab_spawn.",
  ),
  "upstream.codex.response-steering": flag(
    "Steer Codex responses over the WebSocket",
    "Experimental. One account and model per socket; accepted input is never replayed.",
  ),
  "oauth.providers.codex.header-defaults.user-agent": {
    label: "Account User-Agent",
    hint: "Codex accounts only, not provider keys.",
    size: "long",
  },
  "oauth.providers.codex.header-defaults.beta-features": {
    label: "Account beta features",
    hint: "WebSocket requests from Codex accounts only.",
    size: "medium",
  },
  "client.codex.enable-apply-patch": flag(
    "Offer freeform apply_patch on every model that can route it",
    "Off offers it only on models that declare it.",
  ),
  "client.codex.optimize-multi-agent-v2": flag(
    "Rewrite multi-agent v2 messages for other providers",
    "For every provider other than Codex, accounts and provider keys alike.",
  ),
  "upstream.xai.inject-x-search": flag("Add the x_search tool when a request has none"),
  "oauth.providers.antigravity.sensitive-words": {
    label: "Sensitive words",
    hint: "One per line. Obfuscated in requests to Antigravity.",
  },
  "oauth.providers.antigravity.antigravity-credits": flag(
    "Use credits once the free Claude quota runs out",
  ),
  "oauth.providers.antigravity.signature-cache-enabled": flag(
    "Check thinking signatures against the cache",
    "Off uses the client's signatures as sent.",
  ),
  "oauth.providers.antigravity.signature-bypass-strict": flag(
    "Check the full signature structure when the cache is off",
  ),
  "oauth.providers.devin.sensitive-words": {
    label: "Sensitive words",
    hint: "One per line. Obfuscated in requests to Devin.",
  },

  "models.catalog": { label: "Models", options: CATALOG_OPTIONS, inline: true },

  "oauth.auth-auto-refresh-workers": {
    label: "Accounts refreshed at once",
    hint: "0 = 16. How many account tokens one refresh run renews in parallel.",
    size: "short",
  },
} satisfies Readonly<Record<string, FieldCopy>>;

const BY_PATH = new Map<string, FieldCopy>(Object.entries(COPY));

/** What the page says about the setting at `path` (`fallback` names one without copy). */
export const copyOf = (path: string, fallback: string): FieldCopy =>
  BY_PATH.get(path) ?? { label: fallback };
