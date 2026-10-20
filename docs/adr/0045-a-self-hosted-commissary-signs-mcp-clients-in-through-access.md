---
status: accepted, amended below (Managed OAuth off by default)
---

# A self-hosted Commissary signs MCP clients in through Access

ADR 0036 made Commissary the OAuth server for its MCP endpoint: an MCP client that signs in gets an API key of its own, with a tool scope the member picks on a consent page. That stays on Commissary Cloud. On a self-hosted Commissary, people already sign in through Cloudflare Access (ADR 0022), and Access now acts as an OAuth server for MCP clients itself (**Managed OAuth**: discovery, DCR and PKCE, with an opaque token Access resolves). So a self-hosted Commissary runs no OAuth server: Access signs MCP clients in, and Commissary sees each request with the person's Access JWT, as it sees the panel's.

## Decisions

- **Where.** The MCP endpoint is also served on the app host, behind the deployment's Access application with Managed OAuth turned on. A client signed in there acts as its member, with the member's whole reach narrowed by `?toolkits=`; Access service tokens work there too. The API host's MCP endpoint stays outside Access, for static API keys (headless clients and scripts, and a member who wants a narrower client through a key's tool scope).
- **What self-hosted gives up.** No consent page, no API key and no tool scope per client; usage records show the member, not the client; cutting a client off means revoking the person's Access session.
- **Setup.** The deploy turns Managed OAuth on (its redirect URIs and loopback clients) where it manages the Access application; with an Access application managed outside the stack, `docs/DEPLOY.md` gives the steps.
- **Commissary Cloud is unchanged**: Commissary's own OAuth server (`workers-oauth-provider`), the panel session, the consent page, and one API key with a tool scope per client (ADR 0036). Its CIMD and DCR fetches go through the outbound guard (ADR 0044).
- On either, Commissary never passes tokens through: a client's token never goes upstream, and an upstream token never reaches a client.

## Considered Options

- **Commissary's OAuth server everywhere, with Access only as the sign-in** (the pattern of Cloudflare's `remote-mcp-cf-access` demo). One code path, and per-client keys on self-hosted too, but a self-hosted Commissary would run token storage and an OAuth server of its own beside the operator's identity provider.

## Consequences

- Two sign-in paths for MCP clients, by deployment.
- Managed OAuth is in open beta, and Access documents DCR but not CIMD, so a client that only registers through CIMD cannot sign in to a self-hosted Commissary yet; it uses a static API key.
- Access's tokens are short-lived (15 minutes by default) and refreshing re-checks the Access policy, so removing a person from the Access policy cuts their clients off at the next refresh.

## Amendment: Managed OAuth is opt-in

The deploy turns Managed OAuth on only with `ACCESS_MANAGED_OAUTH=true`; it is off by default. Managed OAuth is in open beta, and it changes how Access answers the whole app host, not just `/mcp`: a non-browser request without a sign-in gets `401` and a pointer to Access's OAuth metadata where it used to be redirected to the login page. That may break `cloudflared access login` and `cloudflared access token`, which scripts on the management API use, and #267 is to confirm it does not on a deployed stage before the default changes.

Without Managed OAuth the app host's MCP endpoint is still served behind Access: a `cloudflared` token in `cf-access-token` and an Access service token reach it as before, as their member or the token's role. Only the sign-in that MCP clients start by themselves needs the setting. The redirect URIs and loopback setting apply only with it on, and the deploy refuses them otherwise.
