---
status: accepted, amended by #201 for pending approvals' arguments, which are sealed
---

# Commissary limits what a steered agent can do, rather than detecting injection

Commissary now holds an org's credentials for outside services, browser profiles with live logins, and runs agents with a sandbox, so content that steers an agent or a client is the threat that grows most with v1. Commissary assumes any content an agent or client reads (tool results, web pages, MCP servers' tool descriptions, sandbox files, webhook bodies, model output) can steer it, and does not try to detect injection: no classifier and no scanning of tool results. Security comes from bounding what a steered agent or client can do: grants, tool scopes and tool classes, approval rules, spend limits, the sandbox's network, and the browser's handoff and masking. The whole threat model is `docs/THREAT-MODEL.md`.

## Decisions

- **No taint tracking and no forced approvals.** An agent or client that can read private data, reads untrusted content and can call a tool that reaches outside can be made to leak the data. Whether to allow that combination is the org admin's choice; approval rules stay opt-in (ADR 0038). The panel warns about a hosted agent with a webhook or schedule trigger that can call write tools without an approval rule, since no person is watching when such a run starts.
- **One outbound guard for every user-supplied URL**: toolkit sources, OAuth discovery and metadata (CIMD, DCR), a provider's `base_url`, and any other URL a person types in. It allows only `https:` (and loopback in local development), refuses IP literals in non-public ranges (IPv4 and IPv6) and Commissary's own hosts, and follows redirects itself, checking each hop. Every Worker sets `global_fetch_strictly_public`. The guard does not resolve names; it relies on Cloudflare's network not routing to private addresses, which a test of a deployed Worker confirms.
- **One egress point for the sandbox.** Both backends' traffic goes through one filtering Worker entrypoint: just-bash through its Dynamic Worker's `globalOutbound`, the computer through its outbound handler with `enableInternet` always set explicitly, never left to a default. The entrypoint applies the sandbox's network setting (ADR 0041) and the outbound guard. The Dynamic Worker gets no bindings beyond its files.
- **The browser toolkit reaches the open web.** Browsing is its point, so v1 has no domain allowlist; a navigation can carry data in its URL, accepted as with chains of tools. Browser navigation is exempt from the outbound guard, because Browser Run fetches from Cloudflare's network, not from Commissary's Workers. Live View links are minted only for the session's member, with the shortest lifetime (60 seconds).
- **Seal what grants access, not content.** Credentials, toolkit sign-ins, browser profiles and webhook trigger secrets are sealed. Transcripts and sandbox files are not: only the Worker holding the key reads them, and Cloudflare encrypts storage at rest, so sealing would add nothing against a reader who has the Worker, and would fight `pi-durable`'s storage. Pending approvals' arguments are the exception, sealed with the org's data key for their row (amended by #201): they are a tool call's content, kept for at most an hour in the ControlPlane's own SQLite, where sealing is cheap and fights no other storage, and a copy of that storage does not show them.
- **Org isolation is enforced in code.** KV and cache access goes through an org-scoped helper, so an unscoped name is a type error, and a cross-org test suite covers every store, including Tools' and Agents'. The `global` org's unprefixed KV names stay the one exception.

## Considered Options

- **Detect injection** with a classifier or by scanning tool results. Detection is probabilistic and an attacker iterates against it; a miss is silent. Bounding reach holds whether or not the content is caught.
- **Approvals on every write tool by default.** Safer, but it would make every toolkit unusable until an admin tuned it, and some clients run with approvals off anyway; the notice on unattended agents covers the riskiest case.
- **Track taint** (mark a run that read untrusted content and restrict it afterwards). Too coarse for agents, which read untrusted content almost always, and a large design of its own.
- **Rely on Cloudflare's defaults** for egress. The Containers documentation contradicts itself on whether a container reaches the internet by default, and a fetch to a hostname in Commissary's own zone goes straight to its origin without `global_fetch_strictly_public`.

## Consequences

- Accepted: the operator can unseal every org's secrets (one `SECRETS_KEY` per deployment, no customer-managed keys); data keys never rotate; a member granted a shared agent can act beyond their own reach through it (ADR 0040). Customer-managed keys and a browser domain allowlist are out of v1.
- An existing provider `base_url` that is `http:` or an IP literal in a private range stops working when the guard lands.
