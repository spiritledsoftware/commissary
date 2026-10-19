---
status: accepted, amended by ADR-0041 (Browser Run is the first browser provider) and below (no session caps)
---

# The hosted browser is a built-in toolkit, not an area

ADR 0029 named four areas, Browser among them. Commissary's hosted browser is instead the **browser toolkit**, a toolkit that the Tools area provides itself. It runs on the deployment's own Cloudflare Browser Run binding, and clients reach it on the MCP endpoint like any other toolkit. That leaves three areas: Models, Tools and Agents.

Other browser services need nothing from it. Browser Use, Firecrawl, Kernel and Cloudflare's own hosted browser MCP server all publish remote MCP servers and are listed on integrations.sh, so an org adds them from the toolkit catalog under its own keys (ADR 0036). Only Commissary's own Browser Run browser needs to be built, and as a toolkit it inherits everything decided for tools:

- the flat list and `browser_*` names (ADR 0037);
- grants, tool scope, tool class, prices, approval rules and usage records (ADR 0038).

## What it offers

- **Quick Actions.** Browser Run's stateless calls (page as markdown or HTML, screenshot, PDF, links, JSON, scrape, crawl), made through the binding.
- **Interactive sessions.** Open, navigate, snapshot, click, type, tabs and close. `@cloudflare/playwright-mcp` is archived, so these are Commissary's own code on `@cloudflare/playwright`.
  - MCP calls are stateless, so opening a session returns its id, and the other tools take that id.
  - A session belongs to the member and API key that opened it.
  - A Durable Object holds each session, which closes after ten idle minutes or when asked.

There is no raw CDP endpoint. Through one, a script could read whatever the page holds, including passwords a person typed.

## Who may use it

The org connects nothing for the browser toolkit. Its shared credential is Commissary's own binding, a credential of kind `none`, so grants decide who reaches it, as for any shared credential, and there is no default grant. A self-hosted Commissary has the toolkit only when its deployment has a `browser` binding.

## Logins

- **Browser profiles.** Browser Run keeps nothing between sessions. A browser profile is a saved set of cookies and site storage (Playwright's storage state), sealed with the org data key, that a session can start from.
  - A profile is shared or private, like a credential, and grants decide who may use a shared one. It is not a credential, since one profile holds logins to many sites, and a toolkit has a single shared credential (ADR 0036).
  - A session saves back to its profile only when asked. A member may save into their own private profiles; only an org admin may save into a shared profile, so a member with a grant cannot replace Marketing's login with their own.
  - When two sessions save to one profile, the later save wins.
- **Handoff.** Logins happen through Browser Run's handoff: the session asks a person to act in its Live View, and they type the password or solve the CAPTCHA themselves. The secret never reaches the model or Commissary.
  - The model asks with `browser_ask_human`. The client gets a URL-mode elicitation or a link to the panel, as for approval rules, and the call returns when the person finishes, after at most thirty minutes.
  - The Live View link is a bearer token. Commissary mints it on demand in the panel and never gives it to the model.
- **Who may watch.** Only the member whose session it is may watch it or take it over. Org admins see that sessions exist and may end them.
- **Masking.** The toolkit's snapshots and screenshots mask password fields and every field a person filled during a handoff, and no tool runs arbitrary JavaScript in the page. Playwright's accessibility snapshot otherwise includes password values.
- **1Password.** Filling logins from 1Password is not part of the browser toolkit. 1Password will serve more than the browser, and its SDK runs on Workers only with a patch to its loader and a 4 MB WASM module.

## Cost and retention

The cost of Browser Run time lands on the deployment's Cloudflare account, and Cloudflare's concurrency cap is account-wide.

- Each Quick Action and each session writes a usage record with its browser seconds and no URLs.
- An org admin may set a price per browser hour, which counts toward the dollar spend limits like a price per call.
- Nothing is recorded: no session recordings, and no page content or screenshots outside the tool results that carry them.
- Browser profiles are kept until deleted.

## Considered Options

- **Browser as an area of its own,** with its own gating and records. It would repeat Tools' grants, scopes, prices, approval rules and records for one toolkit.
- **A hosted browser vendor behind the area** (Browserbase, Steel, Hyperbrowser, Anchor). These offer profiles and credential injection built in, but add a second vendor to Commissary Cloud. Orgs that want them can add them as toolkits.
- **Quick Actions only.** This is the least code, but agents could not log in or fill in forms without a second vendor.
- **Filling logins from 1Password** with a service account. It works only with the SDK patched, and it would tie 1Password to the browser.

## Consequences

- ADR 0029's four areas become three. Panel sections, docs and plans speak of the browser toolkit, not a Browser area.
- The kind `none` credential is still awaiting triage on the toolkit issue (#196). If it changes, this toolkit's gating changes with it.
- How a hosted agent's sessions are watched, and who answers its handoffs, is decided with the hosted agent.

## Amendment: no session caps

The decision first capped concurrent sessions per org and per member with a deployment setting, because Cloudflare's concurrency cap is account-wide. The cap is dropped, along with the limits on agent runs and computers (ADR 0040, ADR 0041). Spend limits, Cloudflare's plans and Commissary Cloud's billing tiers limit use, and fairness between orgs on Commissary Cloud is left to its plans. Limits that org admins configure may come later.
