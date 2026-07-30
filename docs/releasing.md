# Release setup and bootstrap

This guide is for Commissary maintainers. Complete the steps in order.

## Create the GitHub App

Before the first push, create a GitHub App named **Commissary Bot**.

- Disable webhooks.
- Give it **Contents: read and write**.
- Give it **Pull requests: read and write**.
- Keep the automatic **Metadata: read** permission.
- Install it only on `spiritledsoftware/commissary`.

## Configure the npm environment

Create the GitHub environment and load the App credentials:

```sh
gh api --method PUT repos/spiritledsoftware/commissary/environments/npm
gh variable set COMMISSARY_APP_CLIENT_ID --env npm --body '<client-id>'
gh secret set COMMISSARY_APP_PRIVATE_KEY --env npm < /path/to/app-private-key.pem
gh variable set NPM_PUBLISH_ENABLED --env npm --body false
```

In GitHub, restrict the `npm` environment to `main`. Do not add a required reviewer. Publishing stays disabled until the first npm release and trusted publishers exist.

## Push and check `main`

Push the committed branch:

```sh
git push --set-upstream origin main
```

Wait for the CI and Release workflows to pass. The Release workflow can create a Version Packages pull request, but it cannot publish while `NPM_PUBLISH_ENABLED` is `false`.

## Publish bootstrap version 0.0.0 once

Log in to npm from a package directory with an `@commissary` owner account and 2FA:

```sh
cd packages/core
npm login --scope=@commissary --registry=https://registry.npmjs.org/
cd ../..
```

From a clean `main` branch, run:

```sh
pnpm run verify
pnpm run build
pnpm run pack:check
pnpm run release
```

This publishes all four packages at `0.0.0` and creates local package tags. Push the tags:

```sh
git push origin --follow-tags
```

Do not create GitHub Releases for the `0.0.0` bootstrap packages.

## Enable trusted publishing

For each package on npm, add a GitHub Actions trusted publisher with these values:

- Organization: `spiritledsoftware`
- Repository: `commissary`
- Workflow: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Then require 2FA and disallow token publication for each package.

Enable later automated publications:

```sh
gh variable set NPM_PUBLISH_ENABLED --env npm --body true
```

## Publish the first supported version

Create and merge a pull request with a minor Changeset for all four packages. After CI passes on `main`, the Release workflow opens the **Version Packages** pull request.

Review that pull request and confirm that it changes all four package versions from `0.0.0` to `0.1.0`. Merge it after every required check passes.

The next successful Release workflow publishes all four `0.1.0` packages through npm trusted publishing. It also creates the four `0.1.0` GitHub Releases.

## Configure repository policy

Create the release label and enable private vulnerability reports:

```sh
gh label create no-changeset --color 6f42c1 --description 'No package release is required'
gh api --method PUT repos/spiritledsoftware/commissary/private-vulnerability-reporting
```

In repository merge settings:

- Allow squash merge only.
- Use the pull request title as the squash commit title.
- Delete merged branches.

After CI has reported its checks once, create an active ruleset for `main` with no bypass actors:

- Require a pull request with zero approvals.
- Require successful, up-to-date status checks.
- Require resolved review conversations.
- Require linear history.
- Block force pushes and branch deletion.
- Select `Changeset`, `Node 22.14.0`, `Node 24`, `Bun`, `Deno`, `Chromium`, `Cloudflare Workers`, and `Conventional title` as required checks.
