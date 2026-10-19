---
status: accepted
---

# OpenCode Zen's free models are cloaked as OpenCode

OpenCode Zen serves its free models only to requests that look like OpenCode's own client; anything else gets 403 `FreeTierError`, with or without a key. The proxy already cloaks as Claude Code for Claude OAuth credentials, and does the same here: requests for free models on an `opencode-zen` key carry the markers Zen checks, so those models can be registered and served like any other. Paid models and OpenCode Go keep the plain `commissary` identity: they work without cloaking.

The cloak changes as little as it can. The User-Agent still names Commissary first and adds an OpenCode client token (`commissary opencode/latest/<version>/commissary`), `x-opencode-client` stays `commissary`, the session id takes OpenCode's `ses_` format (still derived per conversation), the upstream request always streams, and a stub `read` tool marked unavailable is added when the client has none (its calls are removed from the answer). Injecting one of OpenCode's system prompts would also pass the check, but it changes what the model answers, so it was rejected.

## Consequences

- Zen's check is undocumented and can change at any time; the pinned OpenCode version must be raised when Zen answers 426 `UpgradeRequired`.
- A key needs its workspace's Privacy setting to allow free endpoints (free models may train on request data); until then those models cool down like any model the key cannot use.
- Cloaking follows the Claude convention for the per-key mode (`cloak.mode` `auto`/`always`/`never`), but the global switch (`upstream.opencode.disable-cloaking`) overrides every key, unlike Claude's; with cloaking off, free models are not registered.
