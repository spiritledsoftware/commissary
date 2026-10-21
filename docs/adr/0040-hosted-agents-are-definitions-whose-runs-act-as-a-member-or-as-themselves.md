---
status: accepted, amended below (no default limits; who sees a child run)
---

# Hosted agents are definitions whose runs act as a member or as themselves

The Agents area runs **hosted agents** for an org on `@earendil-works/pi-durable`. A hosted agent is a saved definition, not a running process:

- its name and description;
- its instructions;
- one model, reached through Models like any client's;
- a tool scope over toolkits, their read tools, single tools and other agents;
- optionally a sandbox toolkit to work in (ADR 0041).

Each execution is an **agent run**: one conversation with its own transcript, made of **turns**. A turn is one input and the work up to its answer. Every trigger starts a new run, and a chat in the panel continues its own.

## Private and shared agents

Hosted agents follow the shared/private split that credentials and toolkits already use.

- **Private agent.** Any member may create one, if the org allows private agents; the org setting follows the one for private toolkits. Only that member uses it. Org admins see only that it exists, and may disable or remove it.
- **Shared agent.** Only org admins create and edit one. Members use it through grants, which gain a third object: shared agents, given to a member, a team or everyone. There is no default grant: the admin who creates it picks who may use it, as when connecting a toolkit's shared credential.

## Whom a run acts as

A run reaches models and tools as some principal, which fixes the grants, credentials and spend limits that apply to it.

- **A private agent's run acts as its member.** It has their reach, their private credentials and their spend limits.
- **A shared agent's run acts as the agent itself.** Its reach is exactly what its definition names, which an org admin chose from the org's shared credentials. It is not the reach of whoever started it, so no grant names an agent as a subject. A spend limit may be set on a shared agent.

Usage records name the agent, the run and the member who started it, if anyone did. A member granted a shared agent can make it do things outside their own reach, and that is the admin's deliberate choice, as granting a shared credential is.

A run reaches models and tools through the same gates as any client: reach, tool scope, spend limits, prices, approval rules and usage records (ADR 0023, ADR 0024, ADR 0038). It has no back door.

## What starts a run

A **trigger** starts runs of an agent, and its **trigger kind** says how.

| Trigger kind | How it starts a run                                                                                                                                                               | Who starts the run |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Chat         | A member types in the panel                                                                                                                                                       | That member        |
| MCP          | A client or another run calls the agents toolkit                                                                                                                                  | That member or run |
| Schedule     | A cron expression and a time zone, with a fixed input                                                                                                                             | No one             |
| Webhook      | A request to an unguessable URL that carries a secret (a bearer header or an HMAC-SHA256 signature of the body); the body, at most about 1 MB, fills the trigger's input template | No one             |

- Chat and MCP are always on for whoever may use the agent. Schedules and webhooks are configured on the agent, any number of each, and their secrets can be rotated.
- A scheduled or webhook run of a private agent counts as started by its member.
- Every run records its trigger and an idempotency key (a schedule tick or a webhook delivery), so a retried delivery never starts a second run.
- Trigger kinds are the extension point. Email, and events from Slack, GitHub or Linear, come later as new kinds that listen through a toolkit's credential and check each source's own signature scheme. They change nothing about runs, identity or records.

## Who watches and steers

Watching is reading a run's transcript as it grows. Steering is sending a message into a running run, interrupting it or cancelling it.

- **A private agent's runs:** only its member.
- **A run of a shared agent that a member started:** that member.
- **A run of a shared agent that no one started:** the agent's **watchers**, a set of members and teams named on it. By default that is the admin who created it. If every watcher leaves the org, the org admins take over.
- **Org admins:** they see the metadata of every shared agent's runs (starter, trigger, status, cost) and may cancel any run. They do not read the transcripts of runs that members started.

The person who watches a run also answers it:

- **Approvals.** Under an approval rule (ADR 0038), the run's starter is "the caller". For a run no one started, its watchers are.
- **Handoffs.** The same people answer browser handoffs.
- **Browser sessions.** A shared agent's browser sessions belong to the agent, and only the run's watchers see their Live View.
- **Waiting.** A pending approval or handoff parks the run durably, and nothing holds a connection open. It reaches its approver by elicitation if the run came in over MCP, and otherwise through the run's page in the panel and a link. If it expires (an hour for an approval, thirty minutes for a handoff), the tool call answers as refused and the run carries on.

## The agents toolkit

Clients and runs use agents through the built-in **agents toolkit** on the MCP endpoint. Its tools have the shape of pi's subagent tools, with the agent as a parameter:

| Tool             | Class | Does                                                                                                                                                                         |
| ---------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents_start`   | write | Starts a run of `agent` with `input`, and returns its run, its first turn and their status at once                                                                           |
| `agents_message` | write | Sends `message` into `run`: it queues into the active turn as steering, or starts a new turn on an idle run                                                                  |
| `agents_wait`    | read  | Returns the oldest result of `run` the caller has not yet claimed, or one named turn; when `timeout` ends first it returns the status and latest activity, and never cancels |
| `agents_status`  | read  | Lists the caller's runs, or shows one run's state, turns and recent activity                                                                                                 |
| `agents_cancel`  | write | Aborts a run's active turn; the run stays and can be continued                                                                                                               |

- `agents_start`'s description lists the agents the caller may use, with each one's name and description. Clients see the agents without one tool per agent.
- Long runs need no MCP async tasks, because `agents_wait` covers them. There is no tool to delete a run: runs are deleted in the panel or pruned by the retention period.
- **Which runs a caller sees.** An API key sees the runs it started. A run sees the child runs it started. In the panel, a member sees every run they started, and watchers see their agent's runs that no one started. Amended (#234): a child run is also seen, as a watcher, by the people of the run at the head of its chain, who already answer its approvals and handoffs. Any other run id answers like an unknown one.
- **Which agents a caller may run.**
  - A tool scope may name agents within the agents toolkit, as it names single tools elsewhere. Naming the toolkit alone allows every agent the member, or the shared agent's reach, may use.
  - A shared agent's definition lists the agents it may run, as part of its reach. A private agent may run any agent its member may use.
  - Through the tool classes, a read-only scope may watch runs but not start or steer them.
- **Child runs.** A run that calls another agent starts a **child run** of it. The child acts as the agent it runs, and records its parent. A child's finished turn is delivered into the parent's transcript as a message unless the parent claims it with `agents_wait`, and a delivery to an idle parent starts a turn there. Chains are at most three deep, and a call whose agent already appears in its chain is refused.

A chat in the panel uses the same run model. Steering, waiting, status and cancelling there are the same operations as these tools.

## Limits

Commissary sets no limits of its own on runs: no cap on concurrent runs, no step limit per turn and no wall-clock limit. Spend limits and Cloudflare's own platform limits bound them, and Commissary Cloud's plans may add quotas. Limits that org admins configure may come later.

## Editing, retention and deletion

- **No versions.** Each turn reads the definition as it stands when the turn starts, and edits keep no history. Disabling an agent stops new runs, and its open runs end at their next turn.
- **What a run keeps.** A run keeps its transcript, and its sandbox files (ADR 0041), in the agent's storage. That is a deliberate exception to keeping as little as we can (ADR 0027): a run cannot continue without its transcript. Usage records keep no content, as for tool calls.
- **Retention.** Runs are pruned when the org's retention period for agent runs passes after their last activity, 30 days by default. A private agent's runs are left out of org-wide usage.
- **Deletion is at once** (ADR 0027).
  - Removing a member deletes their private agents and every run they started, including runs of shared agents.
  - Deleting a shared agent deletes all its runs.
  - A watcher who leaves only drops out of the set of watchers.

## Runtime

- **Stack.** Runs execute on pi-durable in Durable Objects. Agents need Workers Paid.
- **Pinning.** pi-durable is experimental, and `@cloudflare/computer` is a preview. Commissary pins exact versions and keeps both behind its own adapter, so either can be replaced.
- **Cost.** A run's model calls, tool calls, browser seconds and computer seconds are ordinary usage records naming the agent, the run and the starter. They count toward whichever spend limits apply: the shared agent's own limit, or the member's for a private agent, plus the org's and the credentials'. A run has no fee of its own.

## Considered Options

- **Runs act as their starter.** It breaks for runs that no one starts, unless an admin picks a member to run as, and that stops working when the member leaves.
- **Agents as grant subjects** with reach from grants, like members. A shared agent's definition already names what it uses, so grants on it would only repeat that.
- **One tool per agent** (`agents_<name>`). It cannot steer, wait or continue a run, and it cannot deliver a child's result to its parent; pi's subagent tools do all of that.
- **MCP async tasks** for long runs. Clients support them unevenly, and `agents_wait` does the same job for every client.

## Consequences

- Grant, reach, spend limit and tool scope widen to cover shared agents.
- The map's "Hosted agents' runtime design" fog is resolved here and in ADR 0041. What remains is implementation.
- How the usage export carries agent runs is still open, with the export's other non-Models areas.

## Amendment: a child run is its chain's people's to see (#234)

The panel's run pages link a run's child runs from its transcript. Those who answer a chain are the member at the head of it, or the head agent's watchers when no one started the head. They also see each child run in the panel, as a watcher: they watch, steer, cancel and delete it. Before, a child run showed only to org admins, as its metadata, so a chat's starter could not open the child runs their own run started.

## Amendment: no default limits

The decision first gave runs deployment caps on concurrent runs per org and per agent, a step limit of 50 model calls per turn, and a wall-clock limit per turn. They are dropped. Cloudflare's plans and Commissary Cloud's billing tiers are what limit use, and fixed caps chosen now would only guess at them. If org admins need limits, they come later as settings an admin configures.
