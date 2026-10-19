---
status: accepted
---

# Commissary's names

The project becomes Commissary: one service through which an org reaches models, tools, a browser and hosted agents. "Proxy" stops being a term, because proxying models is now one area of four (Models, Tools, Browser, Agents), not the whole. **Commissary** names the product and any one deployment of it. A **self-hosted Commissary** signs people in through Cloudflare Access, and **Commissary Cloud** is the paid service run for anyone, with sign-up and personal orgs. The generic "hosted proxy" mode has no name of its own: it exists so that Commissary Cloud can, and a generic term waits until the license lets others run it.

The one key a member's clients send, which reaches every area, is now an **API key**, because that is the first thing a Cloud sign-up looks for. The provider secret that used to be called API key becomes a **provider key**, which the glossary had listed under _Avoid_. The paths clients call with it are the **client API**, which pairs with the management API; the API host is its hostname. The alternatives were "Commissary key", which is brand-bound and clunky in sentences, and "member key", which says whose key it is but not what it is for. "Agent key" clashes with hosted agents, "access key" with Cloudflare Access, and "client key" with the Go server's unenforced key. The management key stays separate: it acts for an admin's scripts with a role, and a leaked client key must never become an admin key. An agent Commissary runs is a **hosted agent**, never "agent" alone, because pi and Claude Code are agents too. **Credential** broadens to anything Commissary authenticates to an outside service with, so that tools and the browser share credentials and grants; **provider** still means a model provider alone.

## Consequences

- ADR 0039 makes the hosted browser a toolkit in Tools, so there are three areas: Models, Tools and Agents.

- This decides terms, not identifiers. #103 decided the identifiers: everything is renamed and nothing is frozen except the Go config keys (done in #121 and #122).
- Panel labels and docs swap "API key" and "provider key" at once; the two names must not drift apart mid-rename.
