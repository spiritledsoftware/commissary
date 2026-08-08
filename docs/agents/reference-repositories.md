# Reference Repositories

The `pnpm run bootstrap` command materializes these read-only references in `.repos/`. Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                   | Path                  | Useful for                                                                                                        |
| ------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Effect](https://github.com/Effect-TS/effect)                | `.repos/effect`       | Effect v4 services, layers, scopes, streams, schemas, failures, and runtime patterns                              |
| [OpenCode](https://github.com/anomalyco/opencode)            | `.repos/opencode`     | Coding-agent sessions, tool loops, permission boundaries, event delivery, and terminal workflows                  |
| [Better Auth](https://github.com/better-auth/better-auth)    | `.repos/better-auth`  | Value-driven TypeScript inference, plugin composition, framework adapters, and secure extension boundaries        |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm)   | `.repos/drizzle-orm`  | Typed SQL builders, dialects, sessions, transactions, prepared statements, and SQLite driver behavior             |
| [pi-mono](https://github.com/badlogic/pi-mono)               | `.repos/pi-mono`      | Provider-neutral model APIs, agent loops, session state, tool streaming, and terminal UI integration              |
| [Flue](https://github.com/withastro/flue)                    | `.repos/flue`         | Composable agent authoring, durable recovery, tools, skills, subagents, sandboxes, and runtime adapters           |
| [Eve](https://github.com/vercel/eve)                         | `.repos/eve`          | Filesystem-first capability discovery, durable sessions, tools, skills, channels, schedules, and hooks            |
| [Vercel AI SDK](https://github.com/vercel/ai)                | `.repos/vercel-ai`    | Typed model and Tool APIs, provider adapters, message streaming, structured output, and tool-call protocols       |
| [TanStack AI](https://github.com/TanStack/ai)                | `.repos/tanstack-ai`  | Composable provider adapters, client/server Tools, Code Mode, stream protocols, and framework bindings            |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `.repos/hermes-agent` | Provider routing, agent loops, tool RPC, subagents, multimodal input, skills, and cross-session memory            |
| [Hono](https://github.com/honojs/hono)                       | `.repos/hono`         | Web-Standard HTTP APIs, typed middleware and contexts, runtime adapters, routing, and streaming transports        |
| [Cloudflare Agents](https://github.com/cloudflare/agents)    | `.repos/agents`       | Durable Object agent state, typed RPC, scheduling, resumable streaming, MCP, Code Mode, and React client patterns |

Before implementing related functionality, consult the relevant repository for established APIs, architecture, and implementation patterns. Treat the repositories materialized in `.repos/` as read-only references: do not modify or commit their contents, and do not copy code without adapting it to this project's domain and conventions.
