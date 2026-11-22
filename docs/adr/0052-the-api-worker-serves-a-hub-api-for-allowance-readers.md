---
status: accepted, amends ADR-0015 and ADR-0028
---

# The API Worker serves a hub API for allowance readers

Applications such as T3 Code show each account's allowances by polling a Go server. They list its auth files, ask it to call a provider's usage endpoint with the account's token (`POST /v0/management/api-call`), and clear cooldowns after redeeming a Codex reset credit. They send a management key and nothing else, and they cannot be changed. ADR 0015 left the v0 management API out, and the port dropped `api-call` because it sends a token to any host the caller names.

Commissary serves three of those routes as the **hub API**, on the API Worker: `GET /v0/management/auth-files`, `POST /v0/management/api-call` and `POST /v0/management/reset-quota`.

## Decisions

- **A fixed list, not a proxy.** `api-call` accepts seven method and URL pairs, and only for an account of that provider: Codex usage, reset credits and their consume; Claude usage; xAI billing; Antigravity's quota summary and Google's userinfo. Anything else is refused and nothing is sent. Commissary builds the headers and bodies itself, as its quota check does, and ignores the caller's headers. The answer is the provider's status and body, without headers, and any copy of the token in the body is redacted.
- **Management keys only.** No Access sign-in, session or API key is accepted. The key acts in its own org, with its role. On the hub API it also acts as the member who issued it, so that member's private accounts are listed as well as the shared ones an admin key reaches (ADR 0023). On the management API, keys keep acting as no member. A key whose issuer has left the org reaches nothing.
- **On the API host.** The management API stays on the app host (ADR 0028). The hub API sits outside Access because its callers cannot pass Access. On a stage with one host, its prefix joins the zone routes and the Access bypass. The client gate and the client API's CORS do not apply to it. On Commissary Cloud its requests count against the plan's request-rate ceiling.
- **Nothing stored.** A relayed call leaves a log line. The stored quota reports stay the output of Commissary's own quota checks, because the hub's callers read only part of what a quota check reads.
- Tokens still never leave Commissary's Workers.

## Considered Options

- **Go's `api-call` as it is.** Every client of the upstream panel would work, but a management key could send any account's token to any host.
- **Answering from stored quota reports.** This needs no provider call per poll, but the bodies would be made up and stale, and reset credits could be neither read nor redeemed.
- **Moving `/v9/management` to the API host for management keys.** Scripts would get one address, but every management write would be exposed with only a key, and a stage with one host cannot route a prefix by credential.
- **Keys acting as no member on the hub API too.** This is consistent with the management API, but someone whose accounts are private would see none of them.
- **A separate key kind for the hub API.** This gives least privilege to a key that lives in a desktop application. Deferred.

## Consequences

- On a self-hosted Commissary, a management key now reaches something without passing Access: account emails, plans and project ids, allowances, a Codex reset-credit redemption and cooldown resets.
- On Commissary Cloud, an admin key held by such an application also opens the whole management API.
- The list is tied to what today's callers send. A new provider or endpoint is a code change.
- With an Access application managed outside the stack, the operator adds `/v0/management` to the bypass themselves.
