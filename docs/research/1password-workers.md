# Reading 1Password items from a Cloudflare Worker

Research for wayfinder ticket #210 (parent map #101). Researched 2026-10-19 against GitHub repos, npm and 1Password's own docs. Every claim cites its source URL; things I could not confirm are marked **Unconfirmed**. This file lists options and trade-offs; it makes no product decision.

> Naming: 1Password's developer docs have moved from `developer.1password.com` to `www.1password.dev`. Old URLs still serve content. https://www.1password.dev/llms.txt

## Answer

**No one has shipped a JavaScript-only service-account client or an official web/bundler build for Workers. A Worker can read items today only through the official SDK's Node WASM build plus a loader patch, or through a hosted service that holds the service-account token and has an HTTP API.**

- **No official web, ESM or bundler target.** `@1password/sdk@0.5.0` exports one entry (`./dist/sdk.js`, CommonJS) and `@1password/sdk-core@0.5.0` ships only `nodejs/core.js` and `nodejs/core_bg.wasm`. The npm dist-tags are `latest`, `stable`, `beta` and `credential-broker-dev-preview`, with no web tag. https://www.npmjs.com/package/@1password/sdk , https://unpkg.com/@1password/sdk-core@0.5.0/package.json
- **Upstream request #184 is open and unanswered.** Opened 2026-05-02 ("Support for Cloudflare Workers and Edge Runtimes"), one other "+1", no maintainer reply, no label, no linked PR. https://github.com/1Password/onepassword-sdk-js/issues/184 . I found no merged or open PR about a web, browser or bundler target in the repo's recent PR list. https://github.com/1Password/onepassword-sdk-js/pulls?q=is%3Apr
- **The shared Rust core is not open source.** The JS repo's `wasm/` workspace holds only the compiled `nodejs/` output and a `package.json`; there is no Rust source, and I found no public `onepassword-sdk-core` repo (GitHub returns "Could not resolve to a Repository"). The MIT licence covers the JS wrapper and the shipped artifact. Nobody can build a `web` target of the core themselves. https://github.com/1Password/onepassword-sdk-js/tree/main/wasm , https://github.com/1Password/onepassword-sdk-js/blob/main/LICENSE
- **One community project does implement the service-account protocol without the WASM core, but in Go, not JS.** `lox/onepassword-sdk-native-go` (unofficial, MIT, created 2026-07-04, 0 stars, 4 commits) does SRP-4096, keyset and vault-key unwrap and item decryption natively. It is a readable reference for a TypeScript port, not a Worker client. https://github.com/lox/onepassword-sdk-native-go
- **A TypeScript port looks feasible on Web Crypto.** In that Go port, the service-account token (`ops_` plus base64 JSON) already carries the derived SRP `x` and the master unlock key, and everything after sign-in is HKDF-SHA256 and AES-256-GCM, which Workers' Web Crypto provides. The SRP step needs 4096-bit modular exponentiation, which is plain `BigInt` in JS. So there should be **no PBKDF2 per call**. This is my reading of one unofficial implementation; no one has done it in JS (**Unconfirmed** for CPU and for correctness against the live service). https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_auth.go
- **The protocol is documented only in outline.** The 1Password Security Design white paper describes SRP, 2SKD, AES-256-GCM and RSA-OAEP, but not the service-account token format or the REST routes. Those are only visible in the SDK's behaviour and in the Go port. A re-implementation tracks undocumented, internal `/api/v1..v4` routes with no stability promise. https://1passwordstatic.com/files/security/1password-white-paper.pdf
- **Hosted HTTP options that read items:** Connect has no 1Password-hosted version (self-hosted only); the Events API does **not** read items; Credential Broker still goes through the JS SDK. Pulumi ESC's `1password-secrets` provider is a hosted service that reads items with a service-account token and exposes them through Pulumi Cloud's REST API (preview). Infisical and Doppler do not read from 1Password. See "Hosted HTTP surfaces".
- **The WASM route does fit Workers' limits on paper.** 13.9 MB uncompressed is under the 64 MiB Worker size limit, and Cloudflare says there is no compressed size limit. Startup and per-call CPU are **Unconfirmed**. https://developers.cloudflare.com/workers/platform/limits/

## Context: the existing spike

Cited, not redone. `@1password/sdk@0.5.0` runs in workerd with a three-line loader patch (import `core_bg.wasm` as a module and hand it to the wasm-bindgen glue). The WASM is 13.9 MB (13,954,367 bytes), 4.1 MB gzipped (4,188,530 bytes at gzip level 9). A fake token got a real `401` from `POST https://my.1password.com/api/v3/auth/start`. The spike lives in `/tmp/op-workerd-spike` (local, not linked). The WASM size and gzip size match the artifact manifest of an unrelated project that also bundles 0.5.0: https://github.com/Tyler-R-Kendrick/OpenSesame/blob/main/packages/app-core/src/lib/secret-backends/onepassword-artifacts.json

The failure in issue #184 is the same one the patch fixes: the core's generated Node glue calls `require('fs').readFileSync(path.join(__dirname, 'core_bg.wasm'))`. https://github.com/1Password/onepassword-sdk-js/issues/184

## Detail

### Community ports

| Project | Language / target | Protocol covered | State | Usable on Workers? |
|---|---|---|---|---|
| `lox/onepassword-sdk-native-go` | Go, native | Service accounts: `/api/v3/auth/start`, `/api/v2/auth`, `/api/v2/auth/confirm-key`, keysets, vault access, items batch. Read and write of items; `Secrets.Resolve` | MIT, created 2026-07-04, last commit 2026-07-16, 0 stars. README calls it "unofficial", "not published or supported by 1Password"; unimplemented service-account methods fail closed | No (Go). Reference only |
| `detunized/password-manager-access` (C#, also `1password-ruby`, `1password-sharp`) | C# | User accounts: master password, Secret Key, TOTP | MIT, 51 stars, last push 2026-04-24 | No. Has a `ServiceAccount` class that holds only a `Token` field; I did not find service-account logic (**Unconfirmed**) |
| `bitwarden/sdk-internal` `bitwarden-importers/.../onepassword/access` | Rust, intended to compile to WASM | User accounts: master password, Secret Key, 2FA TOTP. SRP, HKDF, AES-GCM, RSA. "No service account support" | Active (pushed 2026-10-19); a port of the C# library | Not as shipped. It reads whole accounts for import, with "no random access" |
| `privicy/onepassword-web-client` | TypeScript | User web vaults | Last push 2022-07-25, no licence | No. Stale |
| `@opengeni/vaults-onepassword` | TypeScript, wraps the official SDK | Service accounts through the WASM core | Active (published 2026-10-16). Its README says it "carries the pinned @1password/sdk WASM core" (~14 MB) and must be loaded by dynamic import | Wraps the same WASM; not a pure-JS client |
| `Tyler-R-Kendrick/OpenSesame` | TypeScript, browser extension | Official SDK core 0.5.0 loaded in a Web Worker, WASM served as a gzipped asset | Active (pushed 2026-10-19), 0 stars, MIT | Shows the SDK core can be loaded outside Node, but I did not read its loader in detail (**Unconfirmed** for how it patches the glue) |

Sources: https://github.com/lox/onepassword-sdk-native-go , https://github.com/detunized/password-manager-access , https://github.com/detunized/password-manager-access/blob/master/src/OnePassword/ServiceAccount.cs , https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-importers/src/importers/onepassword/access/README.md , https://github.com/privicy/onepassword-web-client , https://www.npmjs.com/package/@opengeni/vaults-onepassword , https://github.com/Cloudgeni-ai/opengeni/tree/main/packages/vaults-onepassword , https://github.com/Tyler-R-Kendrick/OpenSesame

- **npm and GitHub searches found no JS or TS package that logs in with a service-account token.** I searched npm for "1password workers", "onepassword edge", "1password service account", "1password srp", "op service account js" and "1password deno"; the matches are the official SDK, Connect SDK, the CLI wrapper `@1password/op-js`, wrappers like `@varlock/1password-plugin` and unrelated SRP libraries. I searched GitHub repos for the same terms and for "onepassword" with "deno", "bun" and "edge", and GitHub code search for `api/v3/auth/start`. Code search also hits only the projects in the table above. I found no Deno or Bun port. Absence of results is not proof (**Unconfirmed**). npm: https://www.npmjs.com/search?q=1password%20service%20account
- `@1password/op-js` wraps the `op` CLI, so it needs a process and cannot run in a Worker. https://www.npmjs.com/package/@1password/op-js
- `@1password/connect` is a plain HTTP client for a Connect server. It is not a service-account client. https://github.com/1Password/connect-sdk-js

### What the Go port shows about the protocol

Facts read from `lox/onepassword-sdk-native-go` at commit `705b7b8`; not 1Password documentation.

- The token is `ops_` plus base64 JSON with `signInAddress`, `email`, `secretKey`, `srpX`, `muk` (a JWK), `userAuth` (alg, iterations, method, salt), `deviceUuid` and `throttleSecret`. https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_auth.go
- Sign-in is SRP over a 4096-bit group (g = 5) with SHA-256: `POST /api/v3/auth/start`, `POST /api/v2/auth`, `POST /api/v2/auth/confirm-key`. The exponent is 38 bytes. https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_srp.go
- Key unwrap: `GET /api/v2/account/keysets` returns keysets, each encrypted by another keyset or by the master key; `GET /api/v1/objects/{vault}/access/combined` returns the vault key, itself encrypted by a keyset. All unwraps are AES-256-GCM on JWK-wrapped keys. Items come from `GET /api/v1/vault/{id}/items/overviews`, `GET /api/v1/vault/{id}/item/{id}` and `POST /api/v4/vault/{id}/item/itemsbatch`. https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_keys.go , https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_items.go
- Size: roughly 4,000 non-test lines of Go in `internal/` (`native_items.go` is 1,283 lines). Its README reports the Go binary at 5.8 MB against 20.1 MB for the official SDK, which measures the Go port, not a Worker bundle. https://github.com/lox/onepassword-sdk-native-go
- PBKDF2: the white paper says the account-password path runs PBKDF2-HMAC-SHA256 with 650,000 iterations. https://1passwordstatic.com/files/security/1password-white-paper.pdf . The token already carries `srpX` and `muk`, so the Go port never derives them. I take this to mean a Worker would not run PBKDF2 per call; I did not check that the Go port, or a JS one, behaves that way against the live service.

### Other SDK builds

- **Published versions and tags.** 35 versions from 0.0.0-credential-broker-dev-preview to 0.5.0 (2026-07-31 for the sdk; npm modified 2026-10-06). Tags: `latest`/`stable` 0.5.0, `beta` 0.5.0-beta.1, `credential-broker-dev-preview` 0.0.0-credential-broker-dev-preview.2. The package description says "The SDK currently supports `Node.JS`". https://www.npmjs.com/package/@1password/sdk (via `npm view @1password/sdk`)
- **Bundler and web builds.** `exports` has one `default` condition pointing at `./dist/sdk.js`. The core's `files` list has only `nodejs/`. https://unpkg.com/@1password/sdk@0.5.0/package.json , https://unpkg.com/@1password/sdk-core@0.5.0/package.json
- **Upstream repo activity.** The repo is active (pushed 2026-10-14). Recent merged PRs are "Regenerated client and wasm" (#199, 2026-07-30) and Workload Identity for GitHub Actions (#190). The only closed core-related web PR I saw is #3 "Add WASM interaction layer" from 2024. https://github.com/1Password/onepassword-sdk-js/pulls?q=is%3Apr
- **Core design.** `client/src/core.ts` takes the core through `initClient`, `invoke` and `releaseClient`; messages cross the boundary as JSON strings with a ~50 MB cap. That seam is small, but the core behind it is a closed binary. https://github.com/1Password/onepassword-sdk-js/blob/main/client/src/core.ts

### Hosted HTTP surfaces

| Option | Reads items over HTTP? | Notes |
|---|---|---|
| **Connect server** | Yes, REST | Self-hosted only: "Deploy a Connect server in your infrastructure". It caches data and avoids per-request limits. I found no 1Password-hosted Connect and no third party that resells one (**Unconfirmed**). https://www.1password.dev/connect/overview.md , https://www.1password.dev/connect/api-reference.md |
| **Events API** | **No** | Audit events, item-usage events (who accessed which item, when, from which IP) and sign-in attempts. The `itemusages` endpoint returns usage metadata, not item contents. https://www.1password.dev/events-api/introduction.md , https://www.1password.dev/events-api/reference.md |
| **Credential Broker** (public preview for GitHub Actions, beta for custom OIDC) | Not over plain HTTP | A workload presents an OIDC token plus an integration key, and the official JS SDK (`oidcFetcher`, `workloadDetails`, `client.environments.getVariables`) fetches an Environment's variables. The docs say it "is only supported in the 1Password JavaScript SDK at this time", so it carries the same WASM. It needs a Business account; I did not check whether a Worker could supply an OIDC token. https://www.1password.dev/brokered-access/custom-workflow , https://1password.com/blog/1password-credential-broker-public-preview |
| **Pulumi ESC `1password-secrets`** | Yes, through Pulumi Cloud's REST API | Preview. Authenticates with a service-account token only ("1Password Connect is not currently supported"); resolves `op://` references when an Environment is opened. The token sits in Pulumi's store. I did not confirm the exact "open environment" REST call, its latency or its pricing (**Unconfirmed**). https://www.pulumi.com/docs/esc/integrations/dynamic-secrets/1password-secrets/ , https://www.pulumi.com/docs/reference/cloud-rest-api/environments/ |
| **Infisical 1Password sync** | No | Pushes secrets from Infisical into a 1Password vault, and needs a Connect server. https://infisical.com/docs/integrations/secret-syncs/1password |
| **Doppler** | No (**Unconfirmed**) | Its integrations page lists Cloudflare Pages and Workers as push targets; I found no 1Password entry. https://docs.doppler.com/docs/integrations |
| **Akeyless** | One-time import only | The API has `gateway-migrate-personal-items` taking a 1Password user email and password (and, presumably, Secret Key). It migrates personal items rather than reading at runtime; service-account support is **Unconfirmed**. https://docs.akeyless.io/reference/gatewaymigratepersonalitems |
| **Cloudflare Secrets Store** | Not itself | A Workers binding with a REST API to write secrets. I found no first-party 1Password sync. Something outside the Worker (a script or CI job with the SDK or CLI) would have to copy values in. https://developers.cloudflare.com/secrets-store/integrations/workers/ . A community script, `lecstor/sync-cf-secrets`, syncs from 1Password or Bitwarden to Workers secrets (2 stars, last push 2026-06-15; mechanism **Unconfirmed**). https://github.com/lecstor/sync-cf-secrets |

### Rate limits that apply to every service-account route

Business: 10,000 reads/hour and 1,000 writes/hour per token, 50,000 requests/day per account. Teams: 1,000 reads/hour per token, 5,000/day per account. https://developer.1password.com/docs/service-accounts/rate-limits.md . Any option that signs in per request (including a TS port with no session cache) burns these limits faster. The Go port caches keysets and vault keys per client in memory. https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_keys.go

## Options and trade-offs

No product decision here. "Cost" figures marked as estimates are mine and unmeasured.

| | A. Official SDK in the Worker with loader patch | B. TypeScript port of the service-account client | C. Hosted reader (Pulumi ESC) | D. Self-hosted Connect reached over HTTP | E. Sync out of band into Secrets Store / env |
|---|---|---|---|---|---|
| Works today | Yes (spike) | No; nobody has built it | Preview; untested here | Yes, but a server must run somewhere | Yes, with a trusted runner |
| Bundle | 13.9 MB wasm, 4.1 MB gz; under the 64 MiB limit | Small. Web Crypto and `BigInt` are built in; I estimate tens of KB (**Unconfirmed**) | None | Plain `fetch`; or `@1password/connect` | None |
| CPU per call | Unmeasured. Includes WASM compile and instantiate at startup (limit 1 s) and SRP in wasm. Cloudflare's default CPU limit is 30 s on Paid, 10 ms on Free (**Unconfirmed** which a cold call hits) | Unmeasured. SRP is a few 4096-bit `BigInt` modexps, plus HKDF and AES-GCM per key (**Unconfirmed**; no PBKDF2 if the token carries `srpX` and `muk`) | One `fetch` | One `fetch` | One binding read |
| Upkeep | Loader patch breaks with each core release (the glue is regenerated: PR #199 "Regenerated client and wasm"); #184 open, no upstream commitment | High: tracks undocumented routes and crypto formats with no contract; only one unofficial reference (0 stars, 4 commits) to test against | Preview; its "inputs and behavior may change". Adds a vendor in the secret path | Run and patch a Connect server; Connect needs its own credentials file and vault grants | Rotation lag; a job must hold a token |
| Secret exposure | Token in Worker env; plaintext in Worker memory | Same | Service-account token held by Pulumi | Connect token in Worker env; secrets cross your network | Value stored as a Cloudflare secret |
| Official support | SDK is supported; Workers is not a listed target | None | Pulumi's | 1Password's | n/a |

Further notes:

- **A.** The unpatched package fails in workerd with the `__dirname`/`fs` errors in #184. The patch is a build-time shim; a pinned version plus a smoke test (the fake-token 401) would catch drift, but I have not tried a Wrangler or Alchemy build of it in this repo. Worker startup time (1 s limit) against a 14 MB module compile is the main open question. https://developers.cloudflare.com/workers/platform/limits/
- **B.** The AES-GCM, HKDF and RSA-OAEP pieces the white paper describes all exist in Web Crypto, but SRP-4096 is not in Web Crypto; it would be hand-written `BigInt` or a library such as `bsrp` (last published 2021, **Unconfirmed** that it matches 1Password's SRP variant). https://www.npmjs.com/package/bsrp . The Go port includes a hand-rolled variant: SHA-256 over the hex of the premaster, with an `N`/`g` hash proof. https://github.com/lox/onepassword-sdk-native-go/blob/705b7b8ea416048f52f0d01e911fa4fb23c40b54/internal/native_srp.go . A port also decides how to handle 1Password's terms of use: the SDK README says use of the APIs is governed by the 1Password API Terms of Service; whether a non-official client is allowed is **Unconfirmed**. https://github.com/1Password/onepassword-sdk-js#readme
- **C/D/E** keep the Worker free of 1Password crypto, but all add a component that holds or can reach the service-account (or Connect) credential.
- **Waiting for upstream.** #184 has no maintainer response in about 5.5 months; the `credential-broker-dev-preview` tag shows 1Password ships special builds on npm, but none is for web. Treat an official web build as not planned. https://github.com/1Password/onepassword-sdk-js/issues/184

## Gaps

- **Unconfirmed:** startup time (module compile) and per-call CPU of the patched SDK in workerd. The spike did not measure them.
- **Unconfirmed:** CPU of SRP-4096 in a Worker with `BigInt`, and whether a JS port interoperates with the live service. Nobody has published one.
- **Unconfirmed:** that service-account sign-in never needs PBKDF2. This rests on the token layout in one unofficial Go port.
- **Unconfirmed:** whether 1Password permits third-party clients of its private routes, and whether it plans a web build (no statement found on #184).
- **Unconfirmed:** that no JS/TS, Deno or Bun service-account client exists. Searches of GitHub and npm found none.
- **Unconfirmed:** whether anyone hosts Connect as a service; Pulumi ESC's REST call, latency and pricing; Doppler's lack of a 1Password reader; Akeyless service-account support.
- **Unconfirmed:** how OpenSesame patches the SDK core glue for a browser Web Worker.
- **Unconfirmed:** whether a Worker can supply an OIDC token acceptable to Credential Broker's custom OIDC (beta, rolling out slowly).
