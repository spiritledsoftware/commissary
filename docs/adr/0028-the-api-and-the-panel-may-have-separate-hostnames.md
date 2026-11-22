---
status: partly superseded by ADR-0030, amended by ADR-0052
---

# The API and the panel may have separate hostnames

A deployment may give its proxy routes a hostname of their own, the API host (`CF_LLM_PROXY_API_DOMAIN`, for example `api.example.com`). The control panel, sign-in and the management API stay on the app host (`CF_LLM_PROXY_DOMAIN`, for example `app.example.com`). With an API host, each hostname serves only its own paths, and a path on the wrong one answers `404` naming the right host. The management API stays on the app host: the panel calls it from there, and scripts with management keys can call it there too, so only one host needs the browser protections. Without the setting, one hostname serves everything as before. Pull-request previews always serve everything from the app Worker's `workers.dev` URL (ADR 0030 gives the API Worker and, on Commissary Cloud, the auth Worker URLs of their own).

The split gives clients a stable address that is only an API, and it frees the bare domain and `www` for a landing page and `docs.` for documentation. One Worker answers on both hostnames and decides by hostname before routing, so storage, bindings and deploys stay shared. ADR 0030 replaced this with an app Worker and an API Worker, so the host split stands but not the single Worker. On a self-hosted proxy, Access covers the app host only and the API host has no Access application. This replaces the list of path exceptions the single host needs, which had to change whenever a proxy route was added.

## Consequences

- Moving to an API host changes every client's base URL, and on a hosted proxy people sign in again because the session cookie belongs to the old hostname.
- The Turnstile widget of a hosted proxy names the app host; its OAuth callbacks name the auth host (ADR 0030).
- Clients that sign in through Access send the app application's token to the API host; the API Worker verifies it against the application's AUD itself.
