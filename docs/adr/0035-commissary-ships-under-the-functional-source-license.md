---
status: accepted
---

# Commissary ships under the Functional Source License

Commissary's code is licensed under FSL-1.1-ALv2 (the Functional Source License, Apache-2.0 future license), with Spirit-Led Software LLC as licensor and copyright holder. Anyone may use, change and self-host Commissary for any purpose except a Competing Use: a commercial product or service that substitutes for Commissary or offers substantially similar functionality, such as a hosted Commissary sold to other orgs. Each version becomes Apache-2.0 two years after it's made available. One licence covers the whole repository. Nothing in Commissary Cloud stays closed; only secrets and deployment configuration are private.

Commissary is a rewrite of CLIProxyAPI, which is MIT. The rewrite translates that code into Effect TypeScript, so the modules that copy it are derived from it and keep its notice. Those portions stay MIT for everyone, so a competitor can always start from upstream's Go code. What the FSL protects is what Commissary adds on top: the Workers architecture, orgs, grants, spend limits, the panel, and the Tools, Browser and Agents areas. The MIT licence allows this because it permits sublicensing and asks only that its notice ships with the copied portions.

We rejected four alternatives:

- **MIT or Apache-2.0.** Executor and Supabase work this way. It would get the most adoption, but it would let anyone deploy a competing Commissary Cloud to Workers in one command.
- **AGPLv3.** A competitor could still host Commissary, as long as it published its changes, and some companies refuse AGPL software.
- **Open core.** A proprietary `ee/` directory, as in LiteLLM and PostHog, would split features between self-hosted Commissary and Commissary Cloud.
- **A later switch.** Choosing the licence now, while Commissary is new and has a single contributor, avoids the forks that followed when HashiCorp, Redis and Elastic tightened licences on code people already relied on.

## Consequences

- The root `LICENSE` holds the FSL text. A root `NOTICE` holds every third-party notice: CLIProxyAPI's copyright lines and MIT text (each derived module names its Go source at the top, which marks it), the models.dev catalog snapshot (MIT), the tiktoken rank files (MIT) and the Atkinson Hyperlegible font (OFL-1.1, whose licence ships with the panel build).
- Commissary is "Fair Source", not OSI open source. Loosening to Apache-2.0 or MIT later stays possible; tightening is ruled out.
- Commits published before the switch stay MIT for anyone who already has them.
- Contributors sign a CLA that grants Spirit-Led Software LLC a licence that allows relicensing, without assigning copyright, so that the licence can still change.
- A lawyer reviews the licence, the `NOTICE` and the CLA before Commissary Cloud launches.
