---
status: accepted, supersedes ADR-0040
---

# Commissary is a model and tool proxy

Commissary stops running agents. The hosted agents of ADR 0040 are removed whole: the Agents area, its definitions (private and shared), their grants, watchers, triggers and runs, the agents toolkit and the run principal. What is left is what ADR 0029 first named as one service: Models and Tools, with the browser and sandbox toolkits inside Tools, and Billing on Commissary Cloud. Clients such as pi, Claude Code and Codex run the agents; Commissary gives them models, tools, a browser and a sandbox, under the org's credentials, grants, approval rules and spend limits.

## What goes

- The Agents area (`packages/agents`), its management routes, its part of the ControlPlane, its panel pages and the `boundaries/agents-imports` lint rule.
- The `run` principal and everything that handled it: the run gateway on the API Worker, a run's reach in Models and Tools, the run-only calls (gated sandbox calls, run waits), and the watchers who decided a run's approvals and watched its browser sessions.
- The agents toolkit and the trigger paths (schedules, webhooks at `/agent-webhooks`).
- The Spend subject kind `agent`, the usage filters and fields that named an agent or a run, the org setting `private_agents` and the run retention period.

## What stays

- The browser toolkit, with `browser_ask_human` handoffs for clients and members, and the sandbox toolkit with its sessions and computer time.
- Approvals and approval rules for members and API keys; Spend limits for every other subject; the MCP endpoint and its OAuth; Billing.
- Wording about other agents: Codex's multi-agent v2 and subagent handling, and every `User-Agent` in Models and translation, which were never about hosted agents.

## Data and deploy

The removal ships in one release, but two pieces of it cannot be undone in the same deploy, so each waits for a follow-up.

- **The Durable Object classes `AgentRun` and `AgentSchedule`** are defined by the API Worker (ADR 0030's amendment). Cloudflare refuses to delete a class another Worker still binds, and the API Worker deploys before the app Worker, so deleting them with the app Worker's bindings fails the deploy. This release keeps both as tombstones: small classes that answer nothing and delete their alarm and all their storage when woken (a finished run has no alarm and nothing wakes it, so its data stays until the follow-up), with the API Worker's own bindings; the app Worker drops its bindings. A follow-up release removes the classes and bindings, which deletes the namespaces and the old runs' data (ADR 0027); it must not be skipped.
- **The D1 usage columns** `agent_id`, `run_id` and `starter`, and the index `usage_records_org_run`, stay. D1 migrations apply before the Workers deploy, so dropping them in this release would break the previous API Worker's inserts while the deploy is half done. They are no longer written or read, and a follow-up migration drops them, and it must drop the index first, because SQLite refuses to drop an indexed column. Existing migrations are not edited.
- **State the state Worker owns** is dropped once: each ControlPlane drops the Agents tables when it starts, and deletes the Spend limits and counters of kind `agent`; the Platform registry drops its run retention column. No data is exported first.
- **Stored values that mention agents** are harmless: an API key's tool scope naming the agents toolkit shows as a missing toolkit (`tool_scope_missing`), like any removed toolkit, and the `private_agents` setting is ignored. A run's sandbox sessions are ordinary sessions now: the Tools part's alarm forgets them eight days after their last use, 50 at a time, and sets itself at startup when it keeps one.

## Considered Options

- **Keeping the Agents area behind a setting.** It would leave the whole surface to maintain, and the run principal in every gate, for deployments that do not use it.
- **Exporting agents and runs before deleting them.** The area never had an export of its own, and a run's transcript is content that Commissary otherwise keeps no longer than it must (ADR 0027).

## Consequences

- Commissary has two areas, not three. ADR 0029's and ADR 0039's counts change (their amendments), and the glossary loses the Agents terms.
- A member's client that called the agents toolkit, or a webhook that started a run, gets an unknown tool or a `404`. There is no migration for them.
- Org deletion and member removal have no Agents step; a member's leaving still deletes their keys, private credentials and private toolkits.
- The API Worker carries two empty classes, and the usage table three unused columns, until the follow-ups remove them (`docs/DEPLOY.md`, "Retired hosted agents").
- The decisions ADR 0038, ADR 0039, ADR 0041, ADR 0042, ADR 0043 and ADR 0044 left to hosted agents (who decides their approvals, who watches their browser sessions, their uncapped use, their reach) no longer arise.
