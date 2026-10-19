---
status: accepted, amended by ADR-0026 for hosted proxies and below for Access sign-ins in `global`, and by ADR-0045 for MCP clients on a self-hosted Commissary
---

# Access authenticates people; the proxy authorizes them and issues proxy keys to clients

This replaces ADRs 0005 and 0006. Cloudflare Access still signs people in, for the control panel and the management API, but it only answers who someone is. Which orgs they belong to and which role they hold there is the proxy's own data, so a hosted org needs no Access configuration of its own. Clients no longer authenticate through Access: they send a proxy key, which the proxy issues to a member, stores only as a hash, and which names its org in a visible prefix. Access service tokens remain for automation of the management API.

Access cannot carry clients for many orgs. An account holds at most 50 service tokens (more only on Enterprise), they are created by deploying rather than by the org, and Access policies have no notion of an org. A hosted Access application admits anyone who can sign in with one of its login methods, such as a one-time PIN, Google or GitHub, and the proxy decides what they may see. An org that wants its own single sign-on gets an identity provider added to the Access account; an account holds at most 50, so this is a feature for a limited number of orgs.

## Roles

- **Platform admins** are named by the deployment's variables and need no stored state, so they can always repair the Platform registry or any org. They replace the deployment admins of ADR 0006.
- **Org roles** are owner, admin and member, held in the org.
- ADR 0006's rule carries over to each org: only a service token that holds the owner role in its org, or a platform admin, may download a stored credential or grant a service token admin rights. A person's browser session cannot grant itself those powers.

## Consequences

- The proxy routes (`/v1*`, `/openai/v1*`, `/backend-api/codex*` and their aliases) are no longer behind Access. The Worker's proxy key check is their only gate, so ADR 0005's guarantee that nothing reaches the Worker without passing Access now covers only the control panel and the management API.
- Clients that send Access service token headers to the proxy routes must switch to proxy keys. Self-hosted deployments issue them from the control panel.
- Browsers do not attach proxy keys on their own, so cross-site request forgery stops being a risk for the proxy routes. The defences stay for the Access-gated routes.
- The Go server's client keys are still accepted on import and never enforced; proxy keys are a new kind of key, not a revival of them.
- A key is the member who holds it: requests made with it carry that member, so the member's private credentials (ADR 0023) serve them and nobody else's.
- The Worker remembers a verified key for 30 seconds, so a key revoked or a member removed is refused within that window (see the amendment on revocation latency). Checking every request against the org's ControlPlane would cost a round trip per request; the window bounds the exposure instead.

## Amendment: Access sign-ins in `global` during the move to proxy keys

Clients of the first org, `global`, signed in through Access before proxy keys existed (`cloudflared access`, or service token headers). Breaking them on deploy would strand every existing client, so `global` keeps an owner-controlled setting, `access_clients`, that lets its proxy routes accept an Access JWT, from `Cf-Access-Jwt-Assertion` or the `cf-access-token` header `cloudflared` sends, in place of a proxy key. The Worker checks that JWT itself, as strictly as the Access edge would (signature, audience, issuer, expiry), since Access no longer sits in front of the proxy routes.

The exception is transitional and narrow:

- It exists in `global` only and is on there by default. An Access sign-in on a proxy route names no org, so it can only ever reach `global`; every other org takes proxy keys alone and has no such setting (`PATCH /membership` answers `422 access_clients_global_only`).
- It covers Access JWTs only. Service token headers stop working on the proxy routes with the deploy that takes them out of Access, since nothing there turns them into a JWT any more; those clients move to proxy keys first.
- A presented proxy key always wins: a bad key is refused even when the request also carries an Access sign-in.
- Once every client sends a proxy key (`docs/MIGRATION.md`), an org owner turns the setting off, and the proxy key check is again the proxy routes' only gate.

## Amendment: revocation latency

Revoking a key, removing a member and deleting an org no longer clear the verified-key cache of the isolate that served the request. The client API may run in its own Worker (ADR 0030), whose caches the management routes cannot reach, and pushing revocations to it over RPC was rejected. A revoked key may therefore keep working for up to 30 seconds, the same bound other isolates already had.
