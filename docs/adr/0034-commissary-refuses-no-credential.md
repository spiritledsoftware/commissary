---
status: accepted
---

# Commissary refuses no credential; orgs use accounts at their own risk

Most providers forbid sharing a subscription, and most bar or don't address a hosted service holding one. Anthropic's Usage Policy (from 2026-11-12) names "services that route requests through consumer subscriptions or misrepresent the product or client being used". Even so, Commissary refuses no credential, on Commissary Cloud or a self-hosted Commissary. An org may connect provider keys, Vertex service accounts and every kind of account (sign-ins and uploaded auth files), as shared or private credentials, and keeps the same cloak defaults (`auto`, `full`) everywhere. Commissary warns instead of blocking. The Connect page shows a notice for each provider whose terms bar or don't address this use, and a notice appears when an account becomes shared. Nothing is disabled and no confirmation is required.

The rejected alternative was a Commissary Cloud limited to provider keys, with account providers added back one at a time only through a sanctioned path (written permission or a provider program). It would have kept Commissary Cloud clear of the policies that name the service, but it would have taken from Cloud orgs what self-hosted orgs have, for a risk the org chooses to take.

## Consequences

- On Commissary Cloud, Commissary is the service that holds the subscription and cloaks its requests, so a provider could act against Commissary Cloud, not only against the member's account. This risk is accepted for v1. Providers' terms are re-checked before launch.
- Commissary never markets subscriptions: the landing page leads with provider keys and what Commissary adds, may say any credential can be connected, and never names a plan or claims subscription savings.
- Commissary Cloud's terms of service make the org responsible for each provider's terms and let Commissary Cloud disable a credential a provider objects to.
