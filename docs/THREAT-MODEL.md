# Threat model

What Commissary v1 defends, against whom, how, and which risks it accepts. It covers a self-hosted Commissary and Commissary Cloud alike: a self-hosted Commissary can serve many orgs too (ADR 0021), so one org's isolation from another matters in both. The few threats only Commissary Cloud has are in their own section. Decided in "What is Commissary's threat model for v1?" ([#243](https://github.com/spiritledsoftware/commissary/issues/243)); the choices that are hard to reverse are ADR 0044 and ADR 0045.

This is a living document: a change to what Commissary holds, who it trusts or what it exposes updates it. Reporting a vulnerability: `SECURITY.md`.

## What Commissary holds

From most to least sensitive:

1. **What grants access to outside services**: provider keys and logins, toolkit sign-ins (OAuth tokens, API keys, every credential type of ADR 0036), browser profiles with live logins (ADR 0039), the SSO identity provider's secret, webhook trigger secrets.
2. **The keys to Commissary itself**: API keys, management keys, Access service tokens, Commissary Cloud's sign-in sessions, `SECRETS_KEY` and `AUTH_INDEX_KEY`.
3. **An org's content**: agent transcripts and sandbox files (kept 30 days by default, ADR 0040), pending approvals' arguments (at most an hour, ADR 0038), what a browser session shows.
4. **An org's records and configuration**: usage records (no prompts, arguments or results, ADR 0027 and ADR 0038), grants, spend limits, members and teams.

## Who is trusted

| Level                       | Who                                                                                                                                                                                                    | What follows                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Fully trusted               | Cloudflare; the operator (Spirit-Led Software on Commissary Cloud, whoever runs a self-hosted Commissary), its secrets and its platform admins                                                         | Not defended against. The operator can unseal every org's secrets (see "Accepted risks").                                            |
| Trusted within their org    | Org owners and admins                                                                                                                                                                                  | Not defended against inside their org: they already see and change its credentials, grants and rules.                                |
| Trusted as far as grants go | Members, and the clients and hosted agents acting for them                                                                                                                                             | Assumed to try to reach beyond their grants, tool scopes and spend limits. Every gate holds against them.                            |
| Untrusted                   | Other orgs; anyone without a key; every piece of content (tool results, web pages, MCP servers' tool descriptions, files in a sandbox, model output, webhook bodies); third-party MCP servers and APIs | Other orgs and strangers get nothing. Content is data that may carry instructions. Third parties are trusted with what is sent them. |

## Threats and mitigations

### A leak of sealed secrets or the key that seals them

- What grants access is **sealed** (AES-256-GCM, `enc:v1:`, bound to its table and row): credentials, toolkit sign-ins, browser profiles, private key groups, config entries, the SSO secret, webhook trigger secrets. A sealed value copied to another row or org does not open.
- Each org has its own data key, stored only wrapped by a key derived from the deployment's `SECRETS_KEY`, which only the state Worker holds. `SECRETS_KEY` rotates by re-wrapping (`docs/DEPLOY.md`).
- Content (transcripts, sandbox files) is **not** sealed: only the Worker holding the key ever reads it, and Cloudflare encrypts storage at rest, so sealing it would add nothing against a reader who has the Worker (ADR 0044). Pending approvals' arguments are the exception: they are sealed with the org's data key for their row, as #201 decided (ADR 0044 amended, `tools/approvals/store.ts`), and deleted with the decision or with the approval an hour after the call.
- API keys and management keys are stored as unsalted SHA-256 hashes, compared in constant time; they are random secrets, so a salt adds nothing.
- Secrets never reach the browser (ADR 0013), the logs (`redactHeaders`, `packages/core/src/logging.ts`), a sandbox (ADR 0041) or the model (handoff, ADR 0039).

### One org reaching another's data

- Each org's state lives in its own ControlPlane Durable Object, the only writer of it (ADR 0021). A key names its org, and the Platform registry confirms the org before a Durable Object is addressed.
- Shared stores are partitioned: D1 rows by `org_id`, KV by an org-scoped name (`OrgKv`), Worker caches by org and name (`OrgCache`), SessionState by org and caller. KV and cache access goes through an org-scoped helper, so an unscoped KV name is a type or lint error (`boundaries/org-scoped-kv`), and a cross-org test suite covers every store. The `global` org's unprefixed KV names are the one documented exception.
- In Tools and Agents nothing crosses an org or an owner: a sandbox session, its files and its computer belong to one member and key or one agent run; a browser session belongs to one member and key or one run, and another owner's id answers as unknown; a browser profile opens only in its own org, a private one only for its member.
- Containers run in their own microVM; Dynamic Workers and Browser Run sessions are isolated by Cloudflare. Commissary relies on those boundaries and adds the ownership checks above.

### Prompt injection

Commissary assumes any content an agent or client reads can steer it, and does not try to detect injection (ADR 0044). Security comes from limiting what a steered agent or client can do:

- **Reach**: grants, tool scopes, `?toolkits=` and each tool's class. A tool with no sign of reading writes; upstream annotations are hints an admin overrides (ADR 0038).
- **Approval rules**: an org admin can make write tools, or any tool, wait for an approver who is not the agent (ADR 0038). A steered client cannot answer for its person: an answer to the approve-or-deny form counts only with the `requestState` sealed for that form and that very call (tool and arguments), once and within the hour; a pending approval is decided only in the panel, by a person its rule names, and goes once its hour is over or its rule is removed or narrowed.
- **Spend limits**, and on Commissary Cloud plan limits and the billing cap.
- **The sandbox's network**: none by default (ADR 0041), enforced at one point (below).
- **The browser**: passwords are typed by a person through handoff and never reach the model; password and handoff fields are masked; no tool runs JavaScript in the page; there is no raw CDP endpoint (ADR 0039).

### Exfiltration

- **Through a chain of tools.** An agent or client that can read private data, reads untrusted content, and can call a tool that reaches outside can be made to leak the data. v1 does not track taint or force approvals: the combination is the admin's choice. The panel warns about a hosted agent with a webhook or schedule trigger (no person watching when it starts) that can call write tools without an approval rule.
- **Through the sandbox.** Both backends' traffic goes through one filtering Worker entrypoint: the Dynamic Worker's `globalOutbound` and the computer's outbound handler, with `enableInternet` always set explicitly. It applies the sandbox's network setting (none, an allowlist of hosts, or the open internet) and the outbound guard. The Dynamic Worker gets no bindings beyond its files.
- **Through the browser.** The browser toolkit reaches the open web: a navigation can carry data in its URL. Accepted for v1, as with chains of tools.

### Outbound requests to places they shouldn't reach (SSRF)

Every URL an org or member supplies passes one **outbound guard** (ADR 0044): toolkit sources (MCP, OpenAPI, GraphQL, Discovery), OAuth discovery and metadata (CIMD, DCR), a provider's `base_url`, and any other URL a person types in. The guard:

- allows only `https:` (loopback too, in local development);
- refuses IP literals in private, loopback, link-local, metadata and other non-public ranges, IPv4 and IPv6;
- refuses Commissary's own hosts;
- follows redirects itself and checks each hop.

Every Worker sets the `global_fetch_strictly_public` compatibility flag, so a fetch to a hostname in Commissary's own zone goes through the internet, not straight to its origin. The guard does not resolve names: it relies on Cloudflare's network not routing to private addresses, which a test of a deployed Worker confirms.

### Agents acting with more than their starter's reach

- A private hosted agent acts as its member; a shared one acts as itself, with exactly the reach its definition names and a spend limit of its own (ADR 0040). A member granted a shared agent can make it act beyond their own reach: the admin's deliberate choice. Each run records who started it.
- Child runs are at most three deep, and a call to an agent already in the chain is refused.
- Webhook triggers need their secret (a bearer or an HMAC-SHA256 signature) on an unguessable URL.

### Clients signing in to the MCP endpoint

- Commissary never passes tokens through: a client's token never goes upstream, and an upstream token never reaches a client.
- On Commissary Cloud, Commissary is the OAuth server: a signed-in client gets an API key with a tool scope, chosen on a consent page that shows the client's name and redirect host and asks again for each new client. Redirect URIs match exactly, PKCE is required, and `state` is kept server-side. CIMD and DCR fetches go through the outbound guard.
- On a self-hosted Commissary, Cloudflare Access is the OAuth server (Managed OAuth) for the MCP endpoint on the app host, and Commissary sees the person's Access JWT (ADR 0045). Static API keys reach the API host's MCP endpoint.
- Signing in to a toolkit (#202), Commissary is the OAuth client: PKCE S256, a single-use `state` kept server-side in the org that started it, the authorization server's `iss` checked when its issuer is known (before an error in the answer is read), and the tokens sealed in the ControlPlane, as is the sign-in's flow. Every metadata URL and endpoint passes the outbound guard. The callback is bound to the member who started the sign-in: the app Worker's gate signs the request in as a member of the org the state names, and the ControlPlane finishes the sign-in only for its starter, so a login CSRF (getting someone to open the callback of the attacker's own authorization) finishes nothing and leaves the sign-in pending. A dynamic registration made for a sign-in is kept only once that sign-in completes, so an abandoned one cannot retire the client other credentials refresh with.
- An OAuth 1.0a sign-in to a toolkit (#206) has no PKCE and no `state` parameter: the sign-in's `state` rides in the `oauth_callback` URL Commissary signs into its temporary credential request, and the callback goes through the same gate, bound to the member who started the sign-in. Its `oauth_token` must be the temporary token that sign-in got (kept sealed in its flow with the token's secret), so a callback with another token finishes nothing; the verifier is used once. The consumer's secret is the toolkit's OAuth app's, sealed.
- A toolkit's **credential settings** (#206: OAuth 1.0a's signature method and realm, a NetSuite account, a JWT's algorithm, claims and token endpoint, a GitHub App's API, a token exchange's endpoint, AWS's region and service, a compound credential's template) are not secret: they are stored in the clear, shown to everyone who reads the toolkit (members connecting their own credential need them) and kept in its export. A manager who puts a literal secret into a template or a claim makes it visible to those readers; the secret belongs in the credential's fields. Their URLs pass the outbound guard on save and on use, and a compound template's fields are percent-encoded into a base URL, so a field cannot change its host.

### Watching and taking over a browser

A Live View link is a bearer link. Commissary mints it only for the session's member, with the shortest lifetime (60 seconds to open the connection), shows it only in the panel, and never gives it to the model or a log.

### Running up costs and exhausting resources

- Cloudflare absorbs volumetric attacks.
- Spend limits bound members, keys and shared agents. On Commissary Cloud, plan limits, the billing cap and a per-org request-rate ceiling bound orgs; the ceiling covers the client API, the MCP endpoint and webhook triggers. The management API has no ceiling: it serves people and management keys.
- A hosted agent's webhook trigger (#231) is a public URL that starts runs. A delivery proves it holds the trigger's secret (sealed, checked in the org's ControlPlane): as a bearer, or as an HMAC-SHA256 signature of its delivery id, timestamp and body (Standard Webhooks' scheme), refused more than 5 minutes from that timestamp, so a captured signed delivery cannot be replayed later, and within the 5 minutes a replay finds the run its signed id started or proves nothing. A malformed address or an org that does not exist is refused before the body is read or a ControlPlane is reached; on Commissary Cloud every delivery to an existing org counts against a webhook bucket of the org's (the size of its ceiling) before the proof is checked, so a flood of unproven deliveries cannot load the org's ControlPlane, nor use up the ceiling its API keys count against; proven deliveries count against that ceiling.
- A self-hosted Commissary has no default caps (ADR 0041): a member can run up the operator's Cloudflare bill within their grants.

### Supply chain

- `@earendil-works/pi-durable` (experimental) and `@cloudflare/computer` (preview) are pinned behind adapters (ADR 0040, ADR 0041). Dependabot watches dependencies.
- MCP servers' tool descriptions and the toolkit catalog are untrusted content. The catalog, and a live lookup of a domain it lacks, only say where a source is: nothing acts until someone adds a toolkit from it (an org admin an org toolkit, a member a private one), and its source passes the outbound guard when it is saved, as a typed URL does. A bad entry reaches only those who add it, with the credential they connect.

## Commissary Cloud only

- **Strangers sign up**: anyone may. Turnstile guards sign-in and sign-up; Better Auth's own limiter is off.
- **Abuse of free usage and billing**: plan limits, the billing cap, the owned-org limit and suspension (ADR 0042).
- **Forged billing webhooks**: Polar's webhooks reach a public route on the app host; only those signed with the
  deployment's `POLAR_WEBHOOK_SECRET` (Standard Webhooks, within 5 minutes) change an org's plan, and they name the org
  through the Polar customer Commissary created for it. Only org owners start a checkout, open the billing portal or
  switch plans; Polar holds the payment details, Commissary never sees them.
- The per-org request-rate ceiling fails open: a failing rate-limit binding lets a request through, logged.

## Accepted risks

- The operator can unseal every org's secrets: one `SECRETS_KEY` per deployment unwraps every org's data key. There are no customer-managed keys.
- Data keys never rotate; only `SECRETS_KEY` does, by re-wrapping. Losing `SECRETS_KEY` loses every secret, so self-hosters back it up (`docs/DEPLOY.md`).
- A revoked key works for up to 30 seconds (ADR 0022).
- Prompt injection can steer an agent or a client within its reach; exfiltration through a chain of tools or a browser navigation is the admin's choice to allow.
- A member granted a shared agent can act beyond their own reach through it.
- A self-hosted Commissary has no rate limits or caps.
- On Commissary Cloud the request-rate ceiling fails open, and Turnstile alone guards sign-up.
- On a self-hosted Commissary, an MCP client signed in through Access has its member's whole reach, narrowed only by `?toolkits=`, and is cut off by revoking the person's Access session (ADR 0045).

## Not in v1

- Customer-managed keys or per-org keys a customer controls.
- A domain allowlist on the browser toolkit (Browser Run's Guardrails).
- An audit log: whether v1 keeps one is its own question on the v1 map.
