---
status: accepted
---

# Tools are listed directly, named `toolkit_tool`

Commissary's MCP endpoint lists every tool a client may use, as one flat list. It offers no meta-tools (search, describe, call) and no code mode. Every aggregator we studied collapses large lists that way (Composio, Docker, Cloudflare portals, Executor). But the clients that matter already do it themselves (Claude Code's tool search, pi's deferred and code-mode exposure), so doing it again in the gateway would put one search on top of another. A client keeps its list small with `?toolkits=` on the endpoint and its API key's tool scope (ADR 0036). When the panel builds an endpoint URL, it shows how many tools the client will get and suggests narrowing above about 100. There is no hard cap.

A tool's name is its toolkit's name and its own joined by one underscore: `github_create_issue`. Names hold only `[a-z0-9_]`: Commissary lowercases upstream names and replaces every other character with `_`. Anthropic's and OpenAI's APIs reject dots, and Codex, pi and Claude Code rewrite them, so a dotted name would reach the model changed or not at all. A full name is at most 46 characters, so that it fits after a client's `mcp__<server>__` prefix (pi caps the whole name at 64, Cursor the server and tool names together at about 60). Commissary shortens a longer name with a four-character hash, and the panel flags it so an admin can rename it.

Names stay unique as follows:

- Uniqueness is checked on the full name, so `github_rest` + `create_issue` can never collide with `github` + `rest_create_issue`.
- Org toolkit names are unique within the org. A second toolkit from one service takes a name of its own (`github_rest`); the default is the catalog's slug.
- A private toolkit's name must not clash with an org toolkit or with the member's other private toolkits. If an org admin later adds an org toolkit with a name a member already uses privately, the add goes through and the admin is not told. For that member the private toolkit wins, and the panel asks them to rename it.
- Tool scopes, grants and admin overrides refer to a tool by a stable id (its toolkit and its upstream name), not by the name shown. Toolkits and tools can be renamed at any time without breaking them.
- When an upstream refresh adds a tool whose name an admin's rename already took, the rename wins: the new tool stays hidden until an admin renames it, and the panel flags it. A tool that disappears upstream drops out of every list, and a tool scope that names it shows it as missing.

## Considered Options

- Search, describe and call meta-tools, alone or chosen per endpoint. They keep the context cost flat as tools grow, but clients with their own tool search would do the work twice, and it adds a surface to build and rank. They can still be added later without changing names.
- Code mode: the model writes JS that calls tools, run in a sandbox. It needs the same sandbox as tools that agents write, so it waits for that.
- A dotted name (`github.create_issue`), as Executor uses. It reads better, but provider APIs reject it.
- A double underscore (`github__create_issue`). It echoes the `mcp__` prefix but costs a character, and checking uniqueness on the full name already removes the ambiguity of a single underscore.

## Consequences

- A client without its own tool search (Claude connectors on the web) sees the whole list unless the member narrows it.
- A tool name can differ from its upstream name (lowercased, rewritten, shortened, renamed), so Commissary keeps the upstream name for the call.
