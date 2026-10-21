# Commissary

One service through which an org's members and their clients reach models, tools, a browser and hosted agents, under the
org's credentials, grants and spend limits. An org can run it itself (self-hosted Commissary), or use Commissary Cloud.
Its Models area began as a port of the Go server CLIProxyAPI, which it now consults as a reference rather than follows.

## Language

### Commissary, orgs and members

**Commissary**:
The product, and any one deployment of it: one service that serves one or more orgs, each with its own credentials,
through its three areas.
_Avoid_: proxy (as the whole), gateway, server, platform

**Area**:
One of Commissary's three parts, under one org, one API key and one control panel: Models (the model proxy), Tools (with
the hosted browser and sandbox) and Agents. Commissary Cloud is not an area; it is how Commissary is run.
_Avoid_: product, module, feature

**Hosted agent**:
An agent that Commissary runs for an org in its Agents area, as opposed to a client a member runs: a saved definition
(instructions, a model, the tools and agents it may use) that is either private to one member, whom its runs act as, or
shared, used under grants, with runs that act as the agent itself.
_Avoid_: agent (on its own), bot, assistant, assistant config

**Org**:
A company or group that uses Commissary as one unit, with its own members, teams, credentials, config entries and spend
limits. Nothing in one org is visible to another. A self-hosted Commissary usually serves a single org.
_Avoid_: tenant, workspace, organisation (kept for a provider's own organisation, such as an Anthropic organisation)

**Retention period**:
How many days an org keeps its usage records, or its agent runs after their last activity, before they are deleted; an
org admin sets each (none keeps them). They are the only retention settings, per org; deletions of orgs, members,
credentials, API keys and hosted agents keep nothing and have no grace period.
_Avoid_: TTL, expiry (an API key and replay state expire on their own)

**Export**:
What an org owner downloads before deleting the org: its settings, shared config, prices, credential summaries and
people, with every secret as a preview. It holds no usage records and cannot rebuild a secret.
_Avoid_: backup (nothing can be restored from it)

**Self-hosted Commissary**:
A Commissary run by an org for its own people, who sign in through Cloudflare Access. It has every area that Commissary
Cloud has. It lacks only what running a service for strangers needs, such as signing up, plans and billing. The browser
toolkit and the sandbox's computer are present only if the deployment turns them on.
_Avoid_: self-hosted proxy, on-prem

**Commissary Cloud**:
The Commissary run as a paid service for anyone: people sign up and sign in through Commissary itself, and signing up
gives them an org of their own.
_Avoid_: hosted proxy, SaaS, cloud (on its own), multi-tenant mode

**API host**:
The hostname a deployment may give its client API alone (ADR 0028), where clients send API keys.
_Avoid_: proxy domain, endpoint

**Auth host**:
Commissary Cloud's hostname for signing in, under the base domain (`auth.<base domain>` by default; ADR 0030, ADR 0031), where the auth Worker answers.
_Avoid_: login domain, SSO host

**App host**:
The hostname of the control panel, the sign-in _page_ and the management API, and on a self-hosted Commissary of the MCP endpoint behind Access (`/mcp`, another org's at `/o/<slug>/mcp`); with no API host it still serves the rest of the client API, through the API Worker. The base domain itself or a host under it.
_Avoid_: dashboard domain, panel host

**Base domain**:
The domain the app host and the auth host are under (ADR 0031; the API host may be elsewhere): the app host unless the deployment gives the app a host of its own, and where a landing page may live. Commissary Cloud's sign-in reaches every host under it.
_Avoid_: root domain, apex, zone (a zone is Cloudflare's)

**Personal org**:
The org Commissary Cloud gives a person who signs up without being a member anywhere; they are its org owner. An ordinary
org in every other way.
_Avoid_: default org, home org, workspace

**Owned-org limit**:
How many orgs one person may own on Commissary Cloud, their Personal org included: the deployment's default unless a
platform admin set theirs. Platform admins have none.
_Avoid_: quota, org quota (a quota is a provider's)

**Platform admin**:
A person named by the deployment who can repair any org, and the only one who can create orgs on a self-hosted Commissary.
On Commissary Cloud they also set owned-org limits, suspend people and orgs, raise an org's ceilings and mark it unbilled.
_Avoid_: operator, superuser, admin (on its own)

**Org slug**:
The short name that addresses an org in URLs (`/o/acme/accounts`, `/v9/management/orgs/acme/...`): lowercase letters,
digits and inner hyphens, unique across the deployment, and renamable. It is not the org's id, which never changes and names
its stored data.
_Avoid_: org name (a free-text display name), handle, subdomain

**Platform registry**:
The deployment's own record of what spans orgs: the list of orgs with their slugs, which orgs each person and each service
token belong to, and the leases that keep the shared model catalog and the toolkit catalog to one refresh at a time.
Platform admins are not in it;
the deployment's settings name them.
_Avoid_: org table, tenant directory

**Member**:
A person who belongs to an org, with one role there. A person can be a member of several orgs.
_Avoid_: user, seat, operator

**Role**:
What a member may do in their org: org owner, org admin or plain member.
_Avoid_: permission

**Org admin**:
A member who manages the org's credentials, grants, spend limits and settings. Org owners are org admins too.
_Avoid_: admin (on its own), operator, administrator

**Org owner**:
An org admin who can also change roles and, through a service token, hold the sensitive powers such as downloading a
stored credential.
_Avoid_: owner (on its own), which also says whom a credential belongs to

**Team**:
A named group of members within one org. Grants and spend limits can name a team.
_Avoid_: group

**Plain member**:
A member with the lowest role: they use Commissary and see their own usage, and manage nothing.
_Avoid_: user, viewer

**Auto-join**:
An org's setting that makes every person the org's sign-in admits a plain member on their first request. On for the
first org of a self-hosted Commissary, off for every org created later.
_Avoid_: open signup, self-service

**Access sign-ins for clients**:
A setting of the first org of a self-hosted Commissary that lets clients on the client API still sign in through
Cloudflare Access instead of sending an API key, so its existing clients keep working. On until an owner turns it off;
no other org has it.
_Avoid_: legacy auth, Access fallback

**Client**:
An application that calls the client API, such as pi, Claude Code, Codex, an MCP client or an SDK.
_Avoid_: caller, consumer, user, agent (on its own: a hosted agent is Commissary's)

**Principal**:
The identity behind a request: a signed-in person, a service token, a management key, an API key or a shared agent's
run. Usage and session
state are attributed to it.
_Avoid_: user, caller

**Client API**:
Everything clients call with an API key: the model endpoints, the MCP endpoint and the browser and agent endpoints. On a
self-hosted Commissary an MCP client may also reach the MCP endpoint through Access instead.
_Avoid_: proxy routes, public API, model routes (a model route is a credential's)

**API key**:
A secret Commissary issues to a member for their clients, which reaches every area through the client API. It names its
org and member, and it can have a spend limit and a tool scope of its own. A member creates one in the control panel, or,
on Commissary Cloud, by signing in an MCP client, which gets one of its own (a self-hosted Commissary signs MCP clients in
through Access instead).
_Avoid_: proxy key, client key, access key, agent key, token

**Service token**:
An Access identity for a machine, registered to one org with a role, which scripts present to the management API (or
the MCP endpoint behind Access) of a self-hosted Commissary.
_Avoid_: API key, client key

**Management key**:
A secret an org admin issues for scripts that use the management API, carrying a role in that org. Unlike a service
token it never grants the sensitive powers, such as downloading a stored credential.
_Avoid_: API key, admin key

**Suspended**:
Said of an org or person a platform admin has stopped: signed out and refused everywhere, with nothing deleted.
_Avoid_: disabled, banned, locked

**Caller scope**:
The namespace that keeps one principal's sessions and cached conversation state apart from every other principal's.
_Avoid_: tenant, user scope

**Client key**:
A shared secret that the Go server accepted from clients. Commissary accepts it on import but never enforces it.
_Avoid_: API key

**Secrets key**:
The secret of a deployment that protects every org's data key. Rotating it does not encrypt any stored secret again.
_Avoid_: master key, encryption key (unqualified)

**Data key**:
The key of one org that encrypts the secrets the org stores: its auth files and its config entries. No other org can
read them with its own data key.
_Avoid_: org key, encryption key (unqualified)

**Outbound guard**:
The one check every URL an org or member supplies passes before Commissary fetches it (ADR 0044): public HTTPS
addresses only, none of the deployment's own hosts.
_Avoid_: SSRF filter, egress filter, allowlist

### Providers and credentials

**Provider**:
An upstream LLM service the Models area can call: Claude, Codex, Gemini, Vertex, xAI, Antigravity, Kimi, Meta, Devin, OpenCode
Zen, OpenCode Go, TypeSafe, SubQ, or any single OpenAI-compatible endpoint.
_Avoid_: upstream (as a noun), family, executor type, section

**Channel**:
A provider in its role as the scope of model rules that apply to all of its accounts.
_Avoid_: channel as a general word for a provider

**Credential**:
Anything Commissary can authenticate to an outside service with, such as a provider or a toolkit's service: an account,
a provider key or a toolkit's secret.
_Avoid_: auth

**Shared credential**:
A credential that belongs to the org. Members use it through grants.
_Avoid_: org account, team account

**Private credential**:
A credential that belongs to one member, who alone can use it. Other members see nothing of it; org admins see only that
it exists (provider, owner, label), and can disable or remove it. Its traffic is left out of org-wide usage.
_Avoid_: personal account, own key

**Grant**:
Permission for a member, a team or everyone in an org to use certain shared credentials for certain upstream models, or
a toolkit's shared credential for certain of its tools (all of them, its read tools, or named ones), certain shared
agents, or certain shared browser profiles (to open a browser session from; saving into one stays an org admin's). A
member's access is the union of the grants that name them; there is no deny. A new org starts with one grant that gives everyone every
model on every shared credential; a toolkit's shared credential goes to whoever the org admin picks when connecting it.
_Avoid_: entitlement, ACL, access rule

**Reach**:
What a member's grants add up to: the upstream models and the tools they may use on each shared credential, and the
shared agents they may run. A shared agent's reach is what its definition names. Selection, the model lists and the tool
lists are computed under it; a model, tool or agent outside it answers like an unknown one.
_Avoid_: allowance (a provider's limit), permissions

**Sign-in account**:
A person's own identity with Commissary, which Commissary Cloud keeps outside every org (Better Auth's user with its
sessions and linked GitHub/Google accounts). Deleting it removes the person from every org with their data there. On a self-hosted Commissary Access is the sign-in, so deleting the account only
leaves the orgs until Access signs the person in again.
_Avoid_: account (that is a provider login, below), user

**Identity provider**:
An org's own sign-in service on Commissary Cloud (OIDC or SAML, such as Okta or Entra ID), one per org, through which the
people of the org's verified domains sign in and join the org. A provider of models is never called this.
_Avoid_: IdP (in user-facing text), SSO connection, provider (alone)

**Verified domain**:
An email domain an org proved it controls with a DNS TXT record; one org holds it at a time. Its people may sign in
through the org's identity provider, and the org may require them to (GitHub and Google are then refused for it).
_Avoid_: claimed domain, owned domain

**Account**:
A credential that is a provider login: an OAuth sign-in, a device-code login, an imported service account or an
uploaded auth file. Provider keys whose provider reports allowances, such as OpenCode Go keys, are listed beside the accounts
but are still provider keys.
_Avoid_: auth, auth file, login

**Cloaking**:
Making a request sent on a Claude account look like Claude Code's own traffic, which a Claude subscription requires
before it counts a request against the plan. Requests from Claude Code itself are never cloaked.
_Avoid_: disguise, impersonation, spoofing

**Cloak mode**:
When Commissary cloaks a request: on accounts and on provider keys configured for it (auto), on every credential
(always) or never.
_Avoid_: cloak setting, cloak level (that is how much)

**Cloak level**:
How much of a cloaked request is made to look like Claude Code: everything Claude Code sends (full), or only what the
subscription checks (minimal).
_Avoid_: cloak strength, cloak mode (that is when)

**Provider key**:
A credential that is a provider secret, entered by an org admin or a member as part of a key group.
_Avoid_: API key (that is the member's), config key, config credential

**Key group**:
One endpoint of a provider, together with its provider keys and the rules they share.
_Avoid_: section, compat group

**OpenAI-compatible endpoint**:
A key group for a third-party service that speaks OpenAI Chat Completions. Each one is a provider of its own.
_Avoid_: compat, compatibility entry

**Auth file**:
The stored document of one account: its provider tokens and the account's own settings, in the Go server's file format.
_Avoid_: credential file, token record

**Auth index**:
The opaque public handle that names a credential in the control panel, the management API and usage exports.
_Avoid_: credential id, auth id

**Disabled**:
Said of an account or provider key that an org admin, or the member a private credential belongs to, has taken out of
selection without deleting it.
_Avoid_: paused, excluded

**Connect**:
To add an account to Commissary, whether by signing in to the provider, importing a service account or uploading an auth
file.
_Avoid_: login, auth

**Re-authorize**:
To connect again as an existing account. Its tokens are replaced and its settings are kept.
_Avoid_: re-login, re-auth

**Login session**:
A pending connect attempt, which expires if it is not completed.
_Avoid_: OAuth session, auth session

**Token refresh**:
Renewing an account's provider tokens, or a toolkit credential's OAuth tokens, before they expire, or after the
provider or the toolkit's source rejects them.
_Avoid_: refresh (on its own), renewal

### Models

**Model id**:
A model name a client can request, as listed by the Models area's model lists.
_Avoid_: model name

**Upstream model**:
The model name the provider receives for an attempt.
_Avoid_: provider's name, route model

**Model rule**:
An org-defined alias, exclusion or prefix that shapes which model ids a credential serves.
_Avoid_: mapping, routing rule

**Model alias**:
A model id that an org defines to stand for an upstream model.
_Avoid_: mapping, rename

**Alias pool**:
Several upstream models behind one model alias, tried in turn.
_Avoid_: model pool

**Forked alias**:
A model alias that leaves the upstream model's own id listed as well.
_Avoid_: fork (on its own)

**Force mapping**:
The rule that answers name the alias the client asked for rather than the upstream model.
_Avoid_: model rewrite

**Model exclusion**:
A pattern that removes models from what a credential, or every account of a channel, serves.
_Avoid_: blacklist, disabled model

**Model prefix**:
A per-credential name segment (`work/gpt-5`) through which clients reach that credential alone.
_Avoid_: namespace, prefix (on its own)

**Model catalog**:
The known models of each provider and their capabilities, built from models.dev and the catalog additions.
_Avoid_: catalogue, static models

**Catalog addition**:
A model, or a fact about a model, that Commissary records itself because models.dev lacks it. It fills gaps and never
overrides a value models.dev has.
_Avoid_: overlay, patch, overrides

**Model route**:
One credential's way of serving one model id, together with whether it can serve it right now.
_Avoid_: route (on its own)

**System One model**:
A model that answers typed questions about a state with values and probabilities instead of generating text,
such as TypeSafe's Jev or Subquadratic's SubQ Snap.
_Avoid_: decision model, classifier, Jev (that is one model)

**Thinking**:
How much a model reasons before it answers, expressed provider-neutrally as a budget or a level.
_Avoid_: reasoning effort, effort, variant

**Thinking suffix**:
A thinking value in parentheses after a model id (`gpt-5(high)`), which overrides whatever the request body asks for.
_Avoid_: suffix (on its own)

### Requests

**Client format**:
The API a client speaks to the Models area: OpenAI Chat Completions, OpenAI Responses, Claude Messages, Gemini,
Interactions or System One (TypeSafe's API for System One models, whichever provider serves the model).
_Avoid_: entry protocol, source format, handler type

**Provider format**:
The API the Models area speaks to a provider for an attempt.
_Avoid_: target format, protocol

**Translation**:
Converting a request and its answer between a client format and a provider format.
_Avoid_: conversion

**Upstream**:
Toward the provider: the upstream request, the upstream model, the upstream answer.
_Avoid_: upstream as a noun for a provider or for the Go server

**Request**:
One model call a client makes to Commissary. It may take several attempts.
_Avoid_: attempt, call

**Attempt**:
One try of a request against one credential and one upstream model.
_Avoid_: request, retry

**Failover**:
Moving a request to another credential after a failed attempt.
_Avoid_: retry

**Retry round**:
A pass over the available credentials that ends when one succeeds. Rounds are separated by waiting for a cooldown to end.
_Avoid_: retry (on its own)

**Bootstrap**:
The start of a streamed answer, up to its first content. Until then a failure can still fail over to another
credential.
_Avoid_: peek, first byte

**Selection**:
Choosing the credential for an attempt. Commissary keeps the available credentials that the principal's grants allow,
takes the highest priority tier, applies the routing strategy and then honours session affinity.
_Avoid_: scheduling, rotation

**Priority tier**:
Credentials of equal priority. Only the highest tier that has an available credential takes requests.

**Routing strategy**:
How selection spreads requests within a priority tier: round-robin, weighted round-robin or fill-first.
_Avoid_: rotation, routing (on its own)

**Weight**:
A credential's share of requests under weighted round-robin.

**Session**:
A client conversation, identified by a marker the client sends or derived from the conversation's content.
_Avoid_: thread, session state

**Session affinity**:
Sending a session's later requests to the credential that served it before.
_Avoid_: sticky routing, binding

**Payload rule**:
An org-defined change to the body sent upstream. Payload rules are applied after every other change Commissary makes.
_Avoid_: payload (on its own), payload config

**Reasoning signature**:
An opaque, provider-signed token on reasoning content. Only the provider that produced it accepts it back.
_Avoid_: thought signature, signature (on its own)

**Reasoning replay**:
Putting a previous turn's reasoning back into a request, because the client did not send it back.
_Avoid_: continuity, ledger

**Compaction capsule**:
A sealed summary of earlier conversation history, which stands in for that history on providers without native
compaction.
_Avoid_: encrypted summary

**Responses WebSocket**:
A client's long-lived connection that carries a series of OpenAI Responses turns.
_Avoid_: socket session

### Health and limits

**Cooldown**:
A period during which a credential, or one of its models, is not selected after a failed attempt. The control panel
calls a credential in cooldown _resting_.
_Avoid_: cooling, back-off, blocked

**Failure scope**:
What a failed attempt is blamed on. The model is cooled down by default. The whole credential is cooled down when the
provider limits the account. Nothing is cooled down when the request itself was at fault.

**Cooldown reset**:
An org admin clearing a credential's cooldowns.
_Avoid_: quota reset, reset (on its own)

**Allowance**:
A usage limit that the provider reports for an account over a period (five-hour, weekly, monthly), with the share used
and the time it renews.
_Avoid_: quota window, usage window, bucket, quota

**Pace**:
How an allowance's share used compares with the share of its period that has passed. An allowance _ahead of pace_ would
reach the limit before the allowance renews at its rate so far, one _behind pace_ would leave part of it unused, and one
_on pace_ is within a few points of an even rate.
_Avoid_: burn rate, velocity, utilization rate

**Quota check**:
Asking a provider for an account's current allowances.
_Avoid_: probe, quota (on its own)

**Quota signals**:
The rate-limit figures Commissary observes on live answers, as opposed to those from a quota check.
_Avoid_: quota (on its own)

**Standing**:
The control panel's verdict on an account, provider key or model: taking requests, near its limit, resting, closed, failing
or disabled.
_Avoid_: status, health

**Reset grant**:
An Anthropic entitlement to empty an account's allowances a fixed number of times. Each use is one reset.
_Avoid_: credits, quota reset

**Reset claim**:
One attempt to use a reset. There is at most one at a time per Anthropic organisation. The control panel calls it
_using a reset_.

### Configuration and the control panel

**Config entry**:
One stored part of an org's configuration, such as a setting, key group, provider key, model rule or payload rule. Each is
created, changed and deleted on its own. A setting at its default is not stored.
_Avoid_: config document, config row, record

**Revision**:
The counter of one config entry that each write to it must name. A write based on an older revision is refused. An entry
that is not stored is at revision 0.
_Avoid_: version (for one entry)

**Change counter**:
The counter of an org's config writes, which moves on every write. The entries a write changes take its new value as their
revision. Its value is the config version, which readers use to rebuild their cached view of the org's configuration.
_Avoid_: revision (for the whole org)

**Settings**:
An org's typed options, edited on the Settings page.
_Avoid_: config, configuration (for settings alone)

**Go config document**:
The Go server's configuration file, which an org can import into config entries.
_Avoid_: config file, config.yaml, config document

**Config import**:
Replacing every config entry of an org with a Go config document in one transaction. It names the not-applied keys and is the
only write of the whole configuration.
_Avoid_: restore, upload, sync

**Layout**:
The shape of a Go config document: the v8 layout or the legacy flat layout. Both can be imported.
_Avoid_: revision

**Not-applied key**:
A key of a Go config document that the import names but does not store, because it would have no effect here.
_Avoid_: unsupported, deprecated, ignored

**Control panel**:
Commissary's own web interface for members and org admins.
_Avoid_: management panel, dashboard, web UI

**Upstream panel**:
The Go server's management web interface. Commissary does not serve it.
_Avoid_: panel (on its own), Management Center

**Management API**:
The HTTP API that the control panel and scripts use. What a principal may do through it depends on its role.
_Avoid_: admin API

**Key test**:
A one-off check that a stored provider key is accepted by its provider.
_Avoid_: probe, connection test

**Stage**:
One deployment of Commissary with its own storage: production, which is a self-hosted Commissary behind Cloudflare Access;
the Commissary Cloud stage, run from `main` on its own hostname (stage `cloud`); or a pull
request's preview, which has empty storage.
_Avoid_: environment

### Usage

**Usage**:
Commissary's own record of the traffic it served.
_Avoid_: usage as a word for allowances

**Usage record**:
The stored account of one attempt, tool call, browser session or sandbox session, never its content: an attempt's or a
tool call's org, principal, credential, tokens or tool, cost, latency and outcome, and the hosted agent, agent run and
starter behind it if any; a browser session's org, principal, browser profile, browser time and cost; a sandbox
session's org, principal, computer time and cost. A request that fails over leaves one record per attempt; a browser
or sandbox session leaves one when it closes, which is not a request, but an agent run's sandbox session leaves one
each time its computer stops instead.
_Avoid_: request, log entry

**Token breakdown**:
The split of a usage record's tokens into uncached input, cache reads, cache writes, reasoning and other output.
_Avoid_: usage (on its own)

**Usage export**:
The feed of usage records for external collectors, in the Go server's shape.
_Avoid_: usage queue

### Spend

**Price**:
What a model charges per token of one kind (uncached input, cache read, cache write, output), from the model catalog or
a price override; or what a tool charges per call, or the browser or computer per hour, which an org admin sets.
_Avoid_: cost (for a rate), pricing

**Price override**:
A price an org sets for a model, replacing the model catalog's or filling a gap in it.
_Avoid_: custom pricing, rate card

**Cost**:
The API-equivalent price of an attempt: its token breakdown at the model's prices. Attempts on subscription accounts
are costed the same way as attempts on provider keys. A tool call costs its tool's price per call, or nothing; browser
time costs the price per browser hour, prorated, or nothing, and a sandbox session's computer time the price per
computer hour, prorated, or nothing.
_Avoid_: charge, bill, spend (for one attempt)

**Unpriced**:
Said of an attempt on a model that has no price. It costs nothing toward spend limits; its usage record is flagged and
the model is listed so an admin can give it a price override. A tool call without a price costs nothing too; the panel
shows it as Free and does not flag it as unpriced.
_Avoid_: free (as a name for the state; the panel labels a price-less tool call Free)

**Spend**:
The cost added up over a period for whatever a spend limit covers.
_Avoid_: usage (on its own), consumption

**Spend limit**:
A cap on spend over a calendar day, week or month, set on a member, a team, an org, a shared credential, an API key or a
shared agent.
_Avoid_: budget, quota, allowance (a provider's limit)

### Plans

**Plan**:
What an org holds on Commissary Cloud to decide what it is billed: Free or Pay as you go (ADR 0042). A self-hosted
Commissary has none.
_Avoid_: tier, subscription, Pro

**Free usage**:
The requests and tool calls, browser hours and computer hours an org gets free each month, on either plan.
_Avoid_: allowance, quota (a provider's), free tier, credits

**Plan limit**:
Where a plan refuses further use: Free's stop at its free usage, the billing cap, or a ceiling on concurrent browser
sessions, computers or request rate.
_Avoid_: spend limit (an org's own cap on cost), quota, rate limit (on its own)

**Billing cap**:
The most Commissary Cloud may bill a Pay-as-you-go org in a month, which its org owners set.
_Avoid_: budget, spend limit, overage cap

**Payment state**:
Whether a Pay-as-you-go org's payments are in order (ok) or one failed (past due). A past-due org stays on Pay as you
go but is held to Free's plan limits until a payment succeeds.
_Avoid_: delinquent, suspended, unpaid

**Billing email**:
The email Commissary Cloud bills a Pay-as-you-go org to: that of the org owner who first upgraded it. One email bills
one org.
_Avoid_: payer, billing contact, owner (an org role)

**Unbilled org**:
An org a platform admin put on Pay as you go with no card and no invoice, for the operator's own orgs, design partners
and support credit (ADR 0042). Nothing it uses is billed and no billing cap applies to it.
_Avoid_: free org, comped, sponsored

### Tools

**Toolkit**:
A named set of tools that the Tools area builds from one source, such as GitHub's MCP server or Stripe's OpenAPI
document, and that its tools are named after (`github_create_issue`). An org admin adds a toolkit for the org; a member
can add a private toolkit, which only they can use and of which org admins see only that it exists. Commissary provides
the browser, sandbox and agents toolkits itself.
_Avoid_: integration, connector, app, source, MCP server (for the toolkit itself)

**Toolkit kind**:
What a toolkit is built from: a remote MCP server, an OpenAPI document, a GraphQL endpoint or a Google Discovery
document; for a built-in toolkit, the service Commissary provides it on (`browser`: the browser toolkit, on a browser
provider; `sandbox`: the sandbox toolkit, on a sandbox provider; `agents`: the agents toolkit, on Commissary's own
hosted agents).
_Avoid_: source type, protocol

**Tool list**:
The tools of one toolkit as its source last listed them, each with its upstream name, description, input schema
and annotations. It is rebuilt on demand and on a schedule; a tool its source stops listing drops out (ADR 0037).
_Avoid_: tool catalog, manifest

**Full name**:
The name a client calls a tool by, `<toolkit>_<tool>` in lowercase letters, digits and `_`, at most 46 characters (a
longer one is shortened and ends in a hash). Full names are unique in what one member is served (ADR 0037).
_Avoid_: tool id, qualified name

**Stable id**:
A tool's identity, its toolkit's id and its upstream name, which neither renaming the toolkit or the tool nor a
refresh changes. Tool overrides, grants and tool scopes refer to tools by it (ADR 0037).
_Avoid_: tool name (that is the full name), tool key

**Tool override**:
An org admin's (or, on a private toolkit, its member's) change to one tool by stable id: hidden, renamed, described
anew or given another tool class.
_Avoid_: alias, patch, customisation

**Shadowed / rename suggested**:
An org toolkit is shadowed for a member whose private toolkit has its name: that member is served the private one
instead, and the private toolkit is marked rename suggested (ADR 0037).
_Avoid_: hidden (that is an override), conflict

**Tool scope**:
The toolkits, their read tools, single tools and agents that an API key or a hosted agent may use, within what its
member (or, for a shared agent, the org admin) may use. A key without one may use every tool its member may use.
_Avoid_: tool permissions, allow-list

**Toolkit catalog**:
The services an org admin or member can add a toolkit from, with each one's sources and how to sign in to them, built
from integrations.sh and the toolkit catalog additions.
_Avoid_: registry (that is integrations.sh's), marketplace, directory

**Toolkit catalog addition**:
A service, or a fact about one, that Commissary records itself for the toolkit catalog. Unlike a catalog addition for
models, it may also correct a fact integrations.sh has; the correction is offered upstream too.
_Avoid_: overlay, patch

**Tool class**:
Whether a tool reads or writes, taken from its source (an MCP read-only hint, an HTTP method, a GraphQL query or
mutation) or set by an org admin. A tool with no sign of reading writes.
_Avoid_: permission level, mode

**Approval rule**:
A setting on a toolkit that makes calls to some of its tools wait until their approver approves them.
_Avoid_: policy, gate

**Approver**:
Who may approve a call under an approval rule: the member who made it, or any member of a set that leaves them out.
_Avoid_: reviewer

**Pending approval**:
A tool call held for its approver, with its arguments, until it is approved, denied or expires.
_Avoid_: approval request, ticket

**OAuth app**:
An OAuth client that an org admin (or, on a private toolkit, its member) registered with a toolkit's service and gave
the toolkit, for a service that does not let Commissary register itself. Toolkit sign-ins use it in place of Commissary's
own client.
_Avoid_: OAuth client (on its own), integration, connected app

**Credential settings**:
What a toolkit says about how its credentials are used, the same for its shared credential and every member's private
one, such as a JWT's algorithm and token endpoint, AWS's region and service, or the template that places a compound
credential's fields. Set by the toolkit's managers and shown to its readers: nothing in them is secret.
_Avoid_: credential config, auth settings, credential template (on its own)

**Toolkit sign-in**:
Connecting a toolkit's shared or private credential by signing in to its service with OAuth, in a browser; like a login
session, it is pending until the member who started it comes back from the service, and expires if they do not. A
credential whose token refresh fails for good needs sign-in: it is not used until someone signs in to it again, which
re-authorizes it.
_Avoid_: OAuth session, OAuth flow, login (for a toolkit), renewal

**Browser toolkit**:
The toolkit that Commissary provides itself: a hosted browser, from a browser provider, that clients and hosted agents
drive through tools.
_Avoid_: Browser area, browser (as an area), browser MCP

**Browser session**:
One open browser of the browser toolkit, which belongs to the member and API key that opened it, or to the shared agent
whose run opened it.
_Avoid_: tab, context, browser instance

**Browser profile**:
Saved logins and site data that a browser session can start from, either shared (used under grants) or private to one
member.
_Avoid_: context, cookie jar, identity, credential (a profile holds logins to many sites)

**Handoff**:
A browser session's request that a person act in it themselves, such as typing a password or solving a CAPTCHA, before
the tools carry on.
_Avoid_: takeover, intervention, human-in-the-loop (on its own)

**Browser provider**:
The service behind a browser toolkit, reached through Commissary's own adapter, such as Cloudflare's Browser Run.
_Avoid_: provider (on its own: that is a model provider), browser host, browser vendor

**Sandbox toolkit**:
A toolkit that Commissary provides itself, in which clients and hosted agents run commands on files.
_Avoid_: workspace (on its own), shell, code interpreter

**Sandbox session**:
One open sandbox with its files, which belongs to the member and API key that opened it, or to the agent run it serves.
_Avoid_: container, VM, workspace (on its own)

**Gated call**:
An agent run's call of one of its coding tools (bash, read, write, edit), checked as the sandbox toolkit's tool of the
same name and charged its price, then made by the run itself on its sandbox session; its ticket authorises that call's
operations until it is settled. It is not a call held for an approver: that is a pending approval.
_Avoid_: pending call, approval ticket

**Computer**:
The Linux machine that Cloudflare's sandbox falls back to for a command its shell cannot run, working on the same files.
_Avoid_: container (for the sandbox), VM, box

**Computer time**:
How long a sandbox session's computer ran, from the command that starts it until it stops, its idle minutes included;
the time a price per computer hour applies to.
_Avoid_: sandbox time, container time (just-bash's time is not metered)

**Sandbox provider**:
The service behind a sandbox toolkit, reached through Commissary's own adapter, such as Cloudflare or Daytona.
_Avoid_: provider (on its own: that is a model provider), sandbox host, backend (just-bash and the computer are the
backends of Cloudflare's sandbox)

**Agents toolkit**:
The toolkit that Commissary provides itself, through which clients and agent runs start, steer and wait for runs of the
hosted agents they may use.
_Avoid_: agent tools, subagents

### Agents

**Agent run**:
One conversation of a hosted agent, with its own transcript and sandbox files, started by a trigger.
_Avoid_: session, task, job, execution

**Turn**:
One input to an agent run and the work up to its answer.
_Avoid_: step (one model call within a turn), message

**Trigger**:
What starts runs of a hosted agent, such as a schedule or a webhook configured on it.
_Avoid_: event, hook, automation

**Trigger kind**:
How a trigger starts runs: chat in the panel, a call through the agents toolkit, a schedule or a webhook.
_Avoid_: trigger type, channel

**Starter**:
The member or agent run that started an agent run; a run started by a schedule or webhook of a shared agent has none.
_Avoid_: owner, initiator, caller

**Watcher**:
A member, or a member of a team, named on a shared agent to watch, steer and answer its runs that no one started.
_Avoid_: owner, supervisor, subscriber

**Child run**:
An agent run that another run started through the agents toolkit, which acts as the agent it runs.
_Avoid_: subagent, sub-run, nested run

### The reference

**Go server**:
The original CLIProxyAPI, which Commissary's Models area was ported from and still consults for ideas and tested behaviour.
_Avoid_: upstream, reference repo

**Deviation**:
A deliberate behaviour difference from the Go server, from the time when the Models area followed it everywhere.
_Avoid_: difference, divergence

**Golden fixture**:
An expected result recorded by running the Go server's own code.
_Avoid_: snapshot
