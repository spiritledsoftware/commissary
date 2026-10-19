# AGENTS.md

TypeScript + Effect v4 (`effect@4.0.4`) port of [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) on plain Cloudflare Workers, behind Cloudflare Access. A pnpm + Turborepo workspace: the app Worker (panel, management API) is `apps/app`, the API Worker (client API, cron jobs) `apps/api`, the state Worker that defines the Durable Objects `apps/state`, Commissary Cloud's auth Worker (Better Auth on the auth host, its `SignIn` database, the sign-in RPC the app Worker calls) `apps/auth` (ADR 0030), the control panel served at `/` is `apps/web` (React + Effect Atom, talks to the management API through `packages/contract`, imported as `@commissary/contract/*`; design system in `DESIGN.md`, product context in `PRODUCT.md`, surface briefs in `.impeccable/`); translators, thinking, signatures and token counting are `packages/translation` (`@commissary/translation`), the JSON path engine `packages/json`, the foundation without bindings (org model, shared errors, log-safe helpers, management replies, the org-scoped KV and cache helpers `OrgKv`, `DeploymentKv` and `OrgCache`) `packages/core` (`@commissary/core`), request-side authentication (principals, Access JWTs, API and management keys, roles, the gates; state through its `AuthDirectory` service) `packages/auth` (`@commissary/auth`), and the org-wide state on Durable Objects (the ControlPlane's org-wide base, which the state Worker composes with the areas' parts, the Platform registry, SessionState, the stub helpers, the management routes' body readers, the `AuthDirectory` adapter) `packages/state` (`@commissary/state`). The Models area (executors, handlers, credentials, registry, config, usage, quota, grants, spend, OAuth, its management routes and its ControlPlane part) is `packages/models` (`@commissary/models`): the Workers import it only through `@commissary/models/api`, `/management` (the app Worker) and `/state` (the state Worker) (lint rule `boundaries/models-imports`). Commissary Cloud's billing (plans, free usage, plan limits, the request-rate ceiling per plan, its route and ControlPlane part; nothing on a self-hosted Commissary) is `packages/billing` (`@commissary/billing`), reached the same way (lint rule `boundaries/billing-imports`; Models imports its `/api` only). The Tools area (toolkits from remote MCP servers, their credentials and tool lists, Commissary's MCP endpoint, its management routes, its cron task and its ControlPlane part) is `packages/tools` (`@commissary/tools`), behind the same three entry points (lint rule `boundaries/tools-imports`). Design: `docs/ARCHITECTURE.md` (layout, per-subsystem behaviour, where it differs from Go); developer notes: `docs/DEVELOPMENT.md`.

## Commands

- Run before finishing: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke`; `pnpm format` formats.
- `typecheck`, `lint`, `test` and `build` run through Turborepo (`turbo.json`, local cache; `pnpm exec turbo run <task> --force` re-runs). Workspace layout and task graph: `docs/DEVELOPMENT.md` ("Workspace and Turborepo"); docs for the installed version: `node_modules/turbo/docs/`. Packages are source-only (`exports` point at `src/*.ts`, plus `./testing` at `test/testing.ts`; no build).
- Never run `pnpm run deploy`/`pnpm destroy` (Alchemy) against a real account unless asked. CI deploys previews (`pr-<number>`) and, from `main`, production (`prod`, self-hosted) and Commissary Cloud (`cloud`): `docs/DEPLOY.md`.
- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, …); Husky hooks format/lint staged files, check commit messages and run `pnpm typecheck && pnpm lint` before push. Fix hook failures instead of bypassing them.
- Put git worktrees in `.worktrees/<name>` (gitignored, outside lint): `git worktree add .worktrees/<name> -b <branch>`. Run `pnpm install` in it before checks or hooks (it also links `.repos/` to the main checkout's clones), and `git worktree remove` it when done.

## Go reference

- The Go server is a reference, not the authority (ADR 0019): a source of ideas and tested behaviour that Commissary copies by choice. It lives in the read-only reference checkout `.repos/CLIProxyAPI`; Go paths in code and docs (`internal/...`, `sdk/...`) are relative to it. Read it there; change only this repository.
- Golden fixtures come from `tools/fixturegen` (Go programs run against the reference checkout, see `docs/DEVELOPMENT.md`). A fixture diff after a reference update shows an upstream change to consider, not one that must be ported.

## Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
Effect v4 APIs differ from Effect 3.

## Conventions

- Infrastructure is Alchemy v2 (`alchemy.run.ts`, `infra/`); there is no Wrangler config. A new binding/variable goes, for each Worker that reads it (`apps/app`, `apps/api`, `apps/auth`), in its `env` in `alchemy.run.ts`, its `src/env.d.ts` and its `vitest.config.ts` together; one that `@commissary/state`'s Durable Object classes read also goes in `StateObjectEnv` (`packages/state/src/env.ts`), the `State` Worker's `env` in `alchemy.run.ts`, `apps/state/src/env.d.ts` and `packages/state/vitest.config.ts` (one the Models part reads: `ModelsPartEnv`, the same Worker `env` and `env.d.ts`); one Models reads also goes in `ModelsBindings` (`packages/models/src/env.ts`) and `packages/models/vitest.config.ts`. One Billing reads also goes in `BillingBindings` (`packages/billing/src/env.ts`) and `packages/billing/vitest.config.ts`; one Tools reads, in `ToolsBindings` (`packages/tools/src/env.ts`) and `packages/tools/vitest.config.ts`.
- The Workers' tests (`apps/app/test/`, `apps/api/test/`, `apps/auth/test/`) run in workerd via `@cloudflare/vitest-plugin` (`exports.default.fetch` from `cloudflare:workers`); use `@effect/vitest` for Effect code. `@commissary/state`'s tests run in workerd too, in a test Worker of their own (`packages/state/test/worker.ts`); `@commissary/models` runs `test/unit/` in Node.js and the rest in workerd against a test-only ControlPlane (`packages/models/test/worker.ts`); `@commissary/billing` runs all its tests in workerd against one too (`packages/billing/test/worker.ts`); `@commissary/tools` runs `test/unit/` in Node.js and the rest in workerd against its own (`packages/tools/test/worker.ts`). A test that goes through a Worker's router or `fetch` stays with that Worker (the client API: `apps/api/test/`; Better Auth's sign-in: `apps/auth/test/`; the rest: `apps/app/test/`) and reaches Models only through its entry points and `@commissary/models/testing`. The panel's tests (`apps/web/test/`) and the other packages' (`packages/*/test/`, `tools/vitest`) run in Node.js; shared test helpers are a package's `./testing` export, for test files only (`docs/DEVELOPMENT.md`, "Tests").
- Per-request `env`/`ctx` are provided as services via the web handler's `Context` (`requestContext` in each Worker's `src/worker-env.ts`); layers stay free of them. Code reads its package's view of `env` (`AuthConfig`, `StateEnv`, `ModelsEnv`, `BillingEnv`, `ToolsEnv`, `AppEnv` for code that stays in the app Worker, `ApiBindings` for the API Worker's own, or `AuthWorkerEnv` for the auth Worker's; state's Durable Object classes read `StateObjectEnv`), never the global `Env`: a binding a view needs goes into that interface too.
- Org data in Workers KV goes through an `OrgKv` (`orgKvOf(env, org)`), deployment-wide names through a `DeploymentKv`, never the raw `CACHE` binding (lint `boundaries/org-scoped-kv`, ADR 0044); each new store of org data adds one `storeCase` to the cross-org suite (`apps/app/test/org-isolation.test.ts`, `docs/DEVELOPMENT.md` "Tests").
- Translators/thinking/payload rules are pure sync functions over parsed JSON; cite the Go source path at the top of each module that copies Go. Payload rules stay the final mutation before upstream requests.
- Lint (`docs/DEVELOPMENT.md` "Lint and format") must have zero errors; fix findings instead of silencing them. An unavoidable type assertion gets a `// SAFETY: <invariant>` comment before it.
- Redact tokens/API keys/JWTs in logs (`redactHeaders`); drive time in tests with `TestClock`; justify every `any` with a comment.
- A difference from Go is an ordinary design decision (ADR 0019): note it in `docs/ARCHITECTURE.md` where it helps a reader. Cite a Go source path only where the code actually copies Go.

## Reference repositories

The `pnpm install` command materializes these read-only references in `.repos/`.
Run `pnpm repos:sync` (`./tools/sync-reference-repos.sh`) to refresh them; `pnpm install` skips it when dependencies are up to date.

| Repository                                                                                                          | Path                                     | Useful for                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`router-for-me/CLIProxyAPI`](https://github.com/router-for-me/CLIProxyAPI)                                         | `.repos/CLIProxyAPI`                     | The Go server this project ports: the reference (ADR 0019) for translators, thinking, payload rules, executors, credential selection/refresh and the management API; `tools/fixturegen` builds against it to generate golden fixtures. Its model catalogs are not a source any more: the catalog comes from models.dev plus our catalog additions (`pnpm catalog:sync`, ADR 0020). |
| [`router-for-me/Cli-Proxy-API-Management-Center`](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) | `.repos/Cli-Proxy-API-Management-Center` | The upstream management web UI for CLIProxyAPI: a reference for the `apps/web` control panel's feature set and flows (provider keys, auth files, OAuth login, config/YAML editing, quotas, logs, dashboard) and for how a client consumes the management API. Ideas to adapt, not a design to copy: `apps/web` follows `DESIGN.md`/`PRODUCT.md`.                                   |

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI (it reads the repo from `git remote`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`, created lazily. See `docs/agents/domain.md`.
