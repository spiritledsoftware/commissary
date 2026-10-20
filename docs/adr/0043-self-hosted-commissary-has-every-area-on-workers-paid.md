---
status: accepted, amended below (the computer's presence marker; how Commissary Cloud and `prod` turn it on)
---

# A self-hosted Commissary has every area, on Workers Paid

A self-hosted Commissary needs Cloudflare's Workers Paid plan. On that plan it has the same three areas (Models, Tools, Agents) and the same toolkits and settings as Commissary Cloud. Only two pieces depend on an extra binding the self-hoster chooses: the browser toolkit and the sandbox's computer. Commissary Cloud holds back nothing for commercial reasons. What it has beyond a self-hosted Commissary is only what running a service for strangers needs. This follows from ADR 0035, which rejected open core.

## Workers Free is not supported

Workers Free gives a request 10 ms of CPU, 50 subrequests and a share of 100,000 requests a day, and has no Containers or Dynamic Workers. Waiting on a provider does not count against the CPU limit. Translating a streamed response chunk by chunk does count, so a Free deployment would fail on some requests and not on others, depending on what each one translates. Supporting Free for Models only would mean a second set of docs and tests for a $5-a-month difference. The docs state Workers Paid as a prerequisite. The deploy does not try to detect the account's plan.

## What every deployment has, and what is optional

Models, Tools and Agents run on what every deployment binds: Durable Objects, KV and D1. The sandbox toolkit's just-bash also needs a Dynamic Workers binding (ADR 0041). Dynamic Workers are Paid-only, so every deployment has one. Two pieces are optional:

| Piece                             | Deploy setting                        | Binding     | Without it                                                                                                              |
| --------------------------------- | ------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| The browser toolkit (ADR 0039)    | `COMMISSARY_BROWSER`, on by default   | Browser Run | The toolkit does not exist: it is not on the MCP endpoint, in toolkit lists or in grants, and the panel hides its pages |
| The sandbox's computer (ADR 0041) | `COMMISSARY_COMPUTER`, off by default | A container | "May use the computer" is shown turned off, with the reason and a link to the docs; runs use just-bash only             |

- **Defaults.** The browser is on by default because Browser Run includes 10 hours a month on Workers Paid. The computer is off by default because deploying it builds a container image, which needs Docker on the deploying machine or in CI, and because container time is billed.
- **Stages.** Commissary Cloud and `prod` turn on both. Previews turn on the browser, and turn on the computer only when the pull request has a `preview-computer` label.
- **Reporting.** `GET /v9/management/me` returns a `deployment` object, `{ hosted, browser, computer }`, which replaces the bare `hosted` field. The panel decides what to show from it. A member never sees a missing piece explained. Admins see the reason where the setting lives.

## Cloud-only features

This list is closed. Adding to it is a decision of its own.

- People sign up and sign in through Commissary itself (ADR 0026, ADR 0030). A self-hosted Commissary signs people in through Cloudflare Access.
- Plans, billing, ceilings and unbilled orgs (ADR 0042).
- The per-org request rate limit.
- Commissary-owned OAuth apps for catalog toolkits (ADR 0036). A self-hosted Commissary uses its own apps.
- Suspending people, and owned-org limits.

## Considered options

- **Support Workers Free for Models only.** Rejected for the reasons above.
- **Always bind the browser and the computer.** Rejected because the computer makes every deploy need Docker and adds container costs for an org that never uses it.
- **Toolkits that reach private networks** through Cloudflare Tunnel or Workers VPC. Left out of v1: Workers VPC is in open beta, and private networks would need settings per org. An org can instead put an internal MCP server on a public hostname behind Access, and have the toolkit send an Access service token as a custom-header credential.

## Consequences

- ADR 0041's consequence "a self-hosted Commissary on Workers Free has no Agents area and no sandbox that runs commands" is replaced: Workers Free is not supported at all.
- The README's prerequisites list Workers Paid and Zero Trust, and say what the browser and the computer cost. DEPLOY.md drops its "Workers Free" section and gains the table above and the list of Cloud-only features.

## Amendment: the computer's marker, and how Commissary Cloud and `prod` turn it on

- The table's "Binding" for the computer is a container attached to the `SandboxSession` class, which gives no Worker an `env` binding. The Workers see it through a `COMPUTER` variable that the same deploy setting sets (ADR 0041's amendment).
- "Stages" is unchanged: Commissary Cloud and `prod` turn on both. Only the mechanism is settled: each stage reads `COMMISSARY_COMPUTER` from its deployer settings (`.env` for `prod`, `.env.cloud` for Commissary Cloud), which `pnpm ci:setup` writes into the stage's GitHub environment, so the computer is on there once `ci:setup` is re-run with the setting. The code's default stays off, for any other deployer's stage, since the computer needs Docker and its container time is billed. Previews are unchanged.
