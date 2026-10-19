---
status: accepted
---

# Tool calls follow grants, prices and approval rules, and keep no content

Tool calls reuse the Models area's grants, spend limits and usage records (ADR 0023, ADR 0024, ADR 0027) rather than getting rules of their own. Tools add three things: a tool class, a price per call and approval rules.

## Grants

A grant may give a member, a team or everyone the tools of a toolkit's shared credential: all of them, its read tools, or named tools by stable id (ADR 0037). It is the same grant as for models: access is the union of a member's grants, and there is no deny. A tool outside a member's reach is missing from their list, and calling it gets the same answer as an unknown tool.

As in ADR 0023, grants protect the org's identity, not the toolkit. A member who connects their own private credential to an org toolkit acts as themselves, so they may use every tool of it that an admin has not hidden, with no grant. Gating the toolkit itself would add little, since the member could add a private toolkit for the same service. An org can forbid private toolkits, with a setting separate from the one for private credentials.

There is no default grant for tools. When an org admin connects a toolkit's shared credential, the panel asks who may use it (everyone by default) and creates that grant. A shared Stripe key that lets anyone issue refunds should be a choice made when it's connected, not something an org inherits.

## Tool class

Every tool is read or write. Commissary takes the class from the tool's source: an MCP tool's `readOnlyHint`, GET or HEAD for OpenAPI and Discovery operations, and query versus mutation for GraphQL. A tool with no sign of reading is a write tool, which is also the MCP spec's default. An org admin can override a tool's class by stable id. Upstream annotations are untrusted hints, and an OpenAPI or GraphQL toolkit has none, so the admin's word decides.

Grants and tool scopes can both select a toolkit's read tools. Commissary's own `tools/list` reports the class: read tools carry `readOnlyHint: true` and `destructiveHint: false`, while write tools carry no hint. Clients that skip their approval prompt for read tools then treat every kind of toolkit the same way.

## Spend

A tool call costs nothing unless an org admin sets a price per call on its toolkit or on the tool, as for paid search or scraping APIs. A priced call counts toward the same dollar spend limits as model attempts: on members, teams, the org, the toolkit's shared credential and API keys. It is checked before the call. A free call goes ahead even when a limit is used up. Unlike a model without a price, a tool without one is not flagged, because most tools cost nothing. Calls on private credentials count as ADR 0024 says. There are no call-count or rate limits.

## Records

Each tool call writes a usage record with:

- its org, principal and credential;
- the toolkit and the tool's stable id;
- its outcome, latency and the sizes of the request and the answer;
- its cost and the outcome of any approval.

It holds no arguments and no results, and it is pruned after the org's retention period like every usage record. Calls on private credentials and private toolkits stay out of org-wide usage. Tool calls are not part of the usage export, which keeps the Go server's shape. Session state with an upstream MCP server is kept only as long as serving needs it, at most seven days, like replay state.

## Approval rules

An org admin may make calls wait for approval, with a toolkit-wide rule ("write tools require approval", which follows each tool's class) or by marking single tools. A rule applies to every call on the toolkit, whatever the credential. A member may mark tools of their own private toolkits.

Each rule names its approver: by default the member who made the call, or a team or list of members, any of whom may approve except the caller. The call then reaches the approver in one of two ways:

- When the caller is the approver and the client supports MCP elicitation, the call waits on an approve-or-deny form and finishes in the same call.
- Otherwise the call answers that it is pending, with a link to the approval page in the panel. Once approved, the same call (same tool, same arguments) goes through once.

The panel lists pending approvals for each approver set. There are no email or Slack notices.

A pending approval holds the call's arguments so the approver can see them. It is the one place tool-call content is kept. The arguments are deleted when the call is decided or after one hour, when the approval expires. The repeated call is matched by a hash of its arguments.

## Considered Options

- Grants that gate an org toolkit whatever the credential. They add little security while private toolkits exist, and they would break the rule of ADR 0023 that private credentials need no grant.
- A default grant for tools like the one for models. It would hand every shared toolkit credential to everyone the moment it's connected.
- Leaving approval to clients, which already ask before tool calls. Some clients run with approval off, and an org cannot rely on what a member's client asks. Asking twice is the cost.
- Keeping arguments and results for audit, as Composio (a year) and Obot do. It goes against ADR 0027. Whether an org may opt in to it belongs to the audit log.
- A `resume` meta-tool for approved calls, as in Executor. ADR 0037 rules out meta-tools, and repeating the same call needs none.

## Consequences

- An approval that is not the caller's own takes at least two calls, and the client or its agent has to make the call again after approval.
- Approvals for hosted agents, which have no human at the client, are decided with their runtime.
