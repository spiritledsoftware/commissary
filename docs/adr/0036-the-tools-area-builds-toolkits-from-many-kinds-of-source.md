---
status: accepted, amended by ADR-0045 (a self-hosted Commissary signs MCP clients in through Access)
---

# The Tools area builds toolkits from MCP, OpenAPI, GraphQL and Discovery sources, with a catalog from integrations.sh

The Tools area is not a plain MCP proxy. Like Executor and Composio, it turns outside sources into tools behind Commissary's own MCP endpoint. Each source becomes a **toolkit**: a remote MCP server (Streamable HTTP), an OpenAPI document, a GraphQL endpoint or a Google Discovery document, given by URL or uploaded. Commissary writes no tools of its own for outside services. Tools that agents write themselves are left for later.

The toolkit catalog comes from integrations.sh (MIT, UsefulSoftwareCo) in the same way the model catalog comes from models.dev (ADR 0020). A trimmed snapshot ships with Commissary and a scheduled task refreshes it. Commissary adds what the registry lacks in toolkit catalog additions: Google Discovery URLs, Commissary Cloud's managed OAuth apps, a featured list and tool overrides. The catalog lists every service except CLIs and surfaces with nothing to build tools from. A domain the catalog lacks is looked up live: integrations.sh's quick `detect` runs when it is added, and its slower `discover` only when asked. The result goes into that org's toolkit, not the shared catalog.

Unlike a model catalog addition, a toolkit catalog addition may also correct a registry fact. integrations.sh's facts are partly read from docs by an agent, so some are wrong (a spec URL, an auth method), and Commissary cannot wait for every fix upstream. Each correction is also offered to integrations.sh.

Toolkits follow the credential model that already exists:

- An org admin adds a toolkit for the org. A member may add a private one, which works like a private credential.
- A toolkit's sign-in is an ordinary credential, shared or private. An org admin chooses which kinds each toolkit accepts, and it holds at most one shared credential and one private credential per member. A member's private credential wins over the shared one.
- A second identity on the same service means a second toolkit (`github_bot`, `github_release`), not load-balancing between credentials.
- Every credential type integrations.sh can run from data alone is supported: API key, bearer, basic, OAuth 2 authorization code and client credentials, OAuth 1 and TBA, signed JWT, GitHub App, token exchange, AWS SigV4 and compound secrets. Generic request signing and custom schemes need code for each service. mTLS is not supported.
- When a member calls a tool without the private credential it needs, the answer is a link to connect one: URL-mode elicitation where the client supports it, otherwise a tool result.

What a client sees narrows in two ways, and it gets what both allow:

- A client may name toolkits on the MCP endpoint (for example `?toolkits=github,linear`). Without that, it gets every tool its member may use.
- An API key can have a **tool scope**: the whole toolkits or single tools it may use, within what its member may use. When an MCP client signs in with OAuth, Commissary issues it an API key, whose tool scope the member picks on the consent page. One principal per client keeps usage, spend limits and revocation working as they already do.

## Considered Options

- Proxy remote MCP servers only. Simpler, but services without an MCP server, and private or partner APIs, would stay out of reach.
- Write Commissary's own tools for chosen services, as Composio does. That is a catalog business of its own.
- Look up integrations.sh live only. Toolkits would depend on its uptime and rate limits, and a self-hosted Commissary would behave differently.
- Let catalog additions only fill gaps, as ADR 0020 does for models.dev. Waiting for upstream to fix a wrong spec URL or auth method would leave a toolkit broken in the meantime.
- Give each OAuth sign-in a token principal of its own beside API keys. That would duplicate usage attribution, spend limits and revocation.
- Load-balance among several shared credentials per toolkit, as Models does per provider. For tools the upstream identity matters, so which credential a call used must be predictable.

## Consequences

- Commissary Cloud owns an OAuth app for each catalog toolkit that needs one, and an org may use its own app instead. A self-hosted Commissary always uses its own apps. Google's restricted scopes (Gmail, Drive) need Google's verification and a yearly security assessment for a public app, so v1 starts with org-supplied Google apps.
- MCP toolkits register Commissary as their OAuth client through a CIMD document under Commissary's domain, or through DCR, with one stable callback URL per deployment. Some services allow only clients they have approved (Vercel), or let their own admins approve apps (Notion, Atlassian).
- Each toolkit has one tool list, built from its spec or from its MCP server and refreshed on a schedule and on demand. An org admin can hide a tool, edit its description, or rename it to resolve a clash.
- Toolkits reach public HTTPS endpoints only. Reaching a private network is left for later.
