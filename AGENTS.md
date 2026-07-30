# Commissary Project Instructions

## Engineering standards

### Coding standards

Use the project-local `coding-standards` skill for all TypeScript and Effect engineering. Read the applicable references that the skill identifies before design or implementation.

### Architecture decision records

Read the related files in `docs/adr/` before focused changes.

Read all ADRs before changes to public APIs, package boundaries, runtime state, or repository-wide architecture.

Accepted ADRs are the source of truth. If requested work conflicts with an accepted ADR, update or supersede the ADR before changing the implementation.

### Reference repositories

The `pnpm run bootstrap` command materializes these read-only references in `.repos/`. Run `./scripts/sync-reference-repos.sh` to refresh them directly.

| Repository                                                   | Path                  | Useful for                                                                                                        |
| ------------------------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Effect](https://github.com/Effect-TS/effect)                | `.repos/effect`       | Effect v4 services, layers, scopes, streams, schemas, failures, and runtime patterns                              |
| [OpenCode](https://github.com/anomalyco/opencode)            | `.repos/opencode`     | Coding-agent sessions, tool loops, permission boundaries, event delivery, and terminal workflows                  |
| [Better Auth](https://github.com/better-auth/better-auth)    | `.repos/better-auth`  | Value-driven TypeScript inference, plugin composition, framework adapters, and secure extension boundaries        |
| [pi-mono](https://github.com/badlogic/pi-mono)               | `.repos/pi-mono`      | Provider-neutral model APIs, agent loops, session state, tool streaming, and terminal UI integration              |
| [Flue](https://github.com/withastro/flue)                    | `.repos/flue`         | Composable agent authoring, durable recovery, tools, skills, subagents, sandboxes, and runtime adapters           |
| [Eve](https://github.com/vercel/eve)                         | `.repos/eve`          | Filesystem-first capability discovery, durable sessions, tools, skills, channels, schedules, and hooks            |
| [Vercel AI SDK](https://github.com/vercel/ai)                | `.repos/vercel-ai`    | Typed model and Tool APIs, provider adapters, message streaming, structured output, and tool-call protocols       |
| [TanStack AI](https://github.com/TanStack/ai)                | `.repos/tanstack-ai`  | Composable provider adapters, client/server Tools, Code Mode, stream protocols, and framework bindings            |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | `.repos/hermes-agent` | Provider routing, agent loops, tool RPC, subagents, multimodal input, skills, and cross-session memory            |
| [Hono](https://github.com/honojs/hono)                       | `.repos/hono`         | Web-Standard HTTP APIs, typed middleware and contexts, runtime adapters, routing, and streaming transports        |
| [Cloudflare Agents](https://github.com/cloudflare/agents)    | `.repos/agents`       | Durable Object agent state, typed RPC, scheduling, resumable streaming, MCP, Code Mode, and React client patterns |

Before implementing related functionality, consult the relevant repository for established APIs, architecture, and implementation patterns. Treat these repositories as read-only references: do not modify them, add them to this workspace, or copy code without adapting it to this project's domain and conventions.

## Project workflow

### Issue tracker

Issues are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default five canonical label names. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses the single-context layout. See `docs/agents/domain.md`.

## Git conventions

### Commit messages

Use Conventional Commits for commit messages:

```text
<type>[optional scope][!]: <description>
```

Use a short, lowercase, imperative description with no final period. Use a scope only when it identifies a useful package or subsystem. Use `!` and a `BREAKING CHANGE:` footer for breaking changes.

### Pull request titles

Use the Conventional Commit format for pull request titles. The title must describe the net effect of the complete pull request, not one individual commit. Use `!` when the pull request introduces a breaking change.

## Verification

Run `pnpm run verify` after changes to source code, tests, package configuration, or build configuration.

For documentation-only changes, run only the applicable documentation or formatting check.
