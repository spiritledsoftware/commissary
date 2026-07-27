## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five canonical label names. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

## Reference repositories

Read-only upstream implementations are available under `.repos/`:

| Name          | Path                 | Useful for                                                                                               |
| ------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| Effect        | `.repos/effect`      | Effect APIs, runtime patterns, services, layers, schemas, and error handling                             |
| OpenCode      | `.repos/opencode`    | Agent architecture, tool execution, sessions, permissions, and terminal workflows                        |
| Better Auth   | `.repos/better-auth` | Authentication flows, session management, providers, plugins, and security patterns                      |
| pi-mono       | `.repos/pi-mono`     | Coding-agent loops, model integrations, tool use, and terminal UI patterns                               |
| Flue          | `.repos/flue`        | React-like agent composition, durable execution, tools, skills, subagents, and sandbox patterns          |
| Eve           | `.repos/eve`         | Filesystem-first agent composition, dynamic capabilities, durable sessions, hooks, and workflow patterns |
| Vercel AI SDK | `.repos/vercel-ai`   | Typed AI APIs, message streaming, provider abstraction, and tool-call handling                           |
| Hono          | `.repos/hono`        | Web framework APIs, middleware, routing, adapters, and type-safe request contexts                        |

Before implementing related functionality, consult the relevant repository for established APIs, architecture, and implementation patterns. Treat these repositories as read-only references: do not modify them, add them to this workspace, or copy code without adapting it to this project's domain and conventions.
