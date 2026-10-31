/**
 * CI credentials as code (docs/DEPLOY.md): the GitHub Actions environments `production`, `preview` and `cloud`, a scoped
 * Cloudflare API token for deploys, the Access service token of the post-deploy check, and the secrets and variables
 * that hand them to .github/workflows/ci.yml. Deployed once from a workstation with a profile that may create API
 * tokens, and again to rotate or change permissions:
 *
 *   bun run ci:setup        # alchemy deploy --config stacks/github.ts --profile admin --stage ci
 *
 * The deploy settings (COMMISSARY_DOMAIN, COMMISSARY_APP_DOMAIN, ACCESS_*) come from `.env`, like `alchemy.run.ts`,
 * and so do Commissary Cloud's (SIGN_IN_*, TURNSTILE_*, …), written whenever `.env` sets them: previews labeled
 * `cloud-preview` need them even while production is self-hosted; and so do the browser toolkit's crawls'
 * (BROWSER_RUN_*, COMMISSARY_CRAWL_MAX_PAGES). The `cloud` environment (Commissary Cloud, which CI deploys next to
 * production, stage `cloud`) takes its settings from `.env.cloud` instead, and is left alone while that file does not
 * exist. Production and `cloud` get the sandbox's computer (#223) when `.env` (or `.env.cloud`) sets
 * `COMMISSARY_COMPUTER=on`, with its instance size; a preview gets it only with the `preview-computer` label (ci.yml).
 */
import * as zones from "@distilled.cloud/cloudflare/zones";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_COMPUTER_INSTANCE } from "@commissary/core/computer";
import {
  CLOUD_STAGE,
  DEFAULT_OAUTH_REDIRECT_URIS,
  isWithin,
  readSettings,
} from "../infra/settings.ts";

/** The `cloud` stage's deploy settings, next to `.env` (docs/DEPLOY.md "The Commissary Cloud stage"). */
const CLOUD_ENV_FILE = ".env.cloud";

/** Commissary Cloud's settings (docs/DEPLOY.md "Commissary Cloud"): GitHub variables, then GitHub secrets. */
const HOSTED_VARIABLES = [
  "SIGN_IN_GITHUB_CLIENT_ID",
  "SIGN_IN_GOOGLE_CLIENT_ID",
  "TURNSTILE_SITE_KEY",
  "OWNED_ORG_LIMIT",
  "ORG_RATE_LIMIT_NAMESPACE_ID",
  "ORG_RATE_LIMIT_PAYG_NAMESPACE_ID",
  "POLAR_PRODUCT_ID",
] as const;

const HOSTED_SECRETS = [
  "SIGN_IN_GITHUB_CLIENT_SECRET",
  "SIGN_IN_GOOGLE_CLIENT_SECRET",
  "TURNSTILE_SECRET_KEY",
  "POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
] as const;

/** The browser toolkit's crawls' settings (#270, docs/DEPLOY.md "Crawls"): GitHub variables, then GitHub secrets. */
const CRAWL_VARIABLES = ["BROWSER_RUN_ACCOUNT_ID", "COMMISSARY_CRAWL_MAX_PAGES"] as const;

const CRAWL_SECRETS = ["BROWSER_RUN_API_TOKEN"] as const;

/** The `.env` value of `name`, trimmed; "" when unset. */
const optional = (name: string) =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Config.map((value) => value.trim()),
  );

/** Account-scoped "Access: Apps and Policies Write" (the catalog name is shared with a zone-scoped group). */
const ACCESS_APPS_AND_POLICIES_WRITE = { id: "1e13c5124ca64b72b1969a67e8829049" };

/**
 * The sandbox's computer as a stage's settings have it (#223): `COMMISSARY_COMPUTER=on` and its instance size when it
 * is on and not the default (empty, so not written, otherwise: unset is off).
 */
const computerVariables = (settings: {
  readonly computer: boolean;
  readonly computerInstance: string;
}): Record<"COMMISSARY_COMPUTER" | "COMMISSARY_COMPUTER_INSTANCE", string> => ({
  COMMISSARY_COMPUTER: settings.computer ? "on" : "",
  COMMISSARY_COMPUTER_INSTANCE:
    settings.computer && settings.computerInstance !== DEFAULT_COMPUTER_INSTANCE
      ? settings.computerInstance
      : "",
});

/**
 * Commissary Cloud's and the crawls' GitHub variables and secrets, as set by the active config provider (unset ones left
 * out).
 */
const passedConfig = Effect.gen(function* () {
  const variables: Record<string, string> = {};
  const secrets: Record<string, Redacted.Redacted> = {};

  for (const name of [...HOSTED_VARIABLES, ...CRAWL_VARIABLES])
    variables[name] = yield* optional(name);

  for (const name of [...HOSTED_SECRETS, ...CRAWL_SECRETS]) {
    const value = yield* optional(name);

    // GitHub rejects empty secrets; an unset secret reads as "" in the workflow anyway.
    if (value !== "") secrets[name] = Redacted.make(value);
  }

  return { variables, secrets };
});

/** The account's zone that serves `domain` (the longest zone name `domain` ends with). */
const zoneFor = (accountId: string, domain: string) =>
  zones.listZones.items({ account: { id: accountId } }).pipe(
    Stream.filter((zone) => isWithin(domain, zone.name)),
    Stream.runCollect,
    Effect.flatMap((matches) => {
      const zone = [...matches].toSorted((a, b) => b.name.length - a.name.length)[0];

      return zone === undefined
        ? Effect.die(new Error(`no zone of account ${accountId} serves ${domain}`))
        : Effect.succeed(zone);
    }),
    // A failed lookup aborts the deploy (the stack's error channel only carries ConfigError).
    Effect.orDie,
  );

export default Alchemy.Stack(
  "commissary-github",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
    const settings = yield* readSettings(false, "prod");

    // The `cloud` stage reads only `.env.cloud` (not `.env`, whose sign-in settings are the previews').
    const cloudFile = existsSync(CLOUD_ENV_FILE)
      ? ConfigProvider.fromDotEnvContents(readFileSync(CLOUD_ENV_FILE, "utf8"))
      : undefined;

    const cloudStage =
      cloudFile === undefined
        ? undefined
        : yield* Effect.all({
            settings: readSettings(false, CLOUD_STAGE),
            config: passedConfig,
          }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, cloudFile));

    const [owner = "", repository = ""] = (yield* Config.String("GITHUB_REPOSITORY").pipe(
      Config.withDefault("spiritledsoftware/commissary"),
    )).split("/");

    const repo = { owner, repository };
    const zone = yield* zoneFor(accountId, settings.appDomain);

    // Every hostname CI deploys: production's and the `cloud` stage's app host, with its API host (ADR 0028) and its
    // auth host (ADR 0030) when set. Each is looked up on its own: under the base domain (ADR 0031) a host may still be
    // in a zone of its own.
    const hostnames = [settings, ...(cloudStage === undefined ? [] : [cloudStage.settings])]
      .flatMap(({ appDomain, apiDomain, hosted }) => [
        appDomain,
        apiDomain,
        hosted?.authDomain ?? "",
      ])
      .filter((name) => name !== "");

    const zoneIds = [
      ...new Set(
        (yield* Effect.forEach(hostnames, (name) => zoneFor(accountId, name))).map(({ id }) => id),
      ),
    ];

    const production = yield* GitHub.Environment("Production", {
      ...repo,
      name: "production",
      deploymentBranchPolicy: { customBranchPolicies: ["main"] },
    });

    const preview = yield* GitHub.Environment("Preview", { ...repo, name: "preview" });

    const cloud =
      cloudStage === undefined
        ? undefined
        : yield* GitHub.Environment("Cloud", {
            ...repo,
            name: "cloud",
            deploymentBranchPolicy: { customBranchPolicies: ["main"] },
          });

    // Everything `alchemy deploy`/`destroy` of alchemy.run.ts touches, for any stage. Alchemy's state store needs
    // Secrets Store Write (it binds its token secret to a short-lived preview Worker on every run).
    const deployToken = yield* Cloudflare.ApiToken.AccountApiToken("DeployToken", {
      name: "commissary-ci-deploy",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Workers KV Storage Write",
            "D1 Write",
            "Secrets Store Write",
            "Account Settings Read",
            // The sandbox's computer (#223): its container application and image (COMMISSARY_COMPUTER).
            "Workers Containers Write",
            ACCESS_APPS_AND_POLICIES_WRITE,
          ],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
        {
          // The custom domains of production and the `cloud` stage, API hosts included (their DNS records and Workers
          // routes).
          effect: "allow",
          permissionGroups: ["Zone Read", "DNS Write", "Workers Routes Write"],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: Object.fromEntries(
              zoneIds.map((id) => [`com.cloudflare.api.account.zone.${id}`, "*"]),
            ),
          },
        },
      ],
    });

    // The post-deploy check (tools/check-deploy.sh) authenticates with this token; ACCESS_ALLOW_SERVICE_TOKEN_IDS
    // admits it on every stage's Access application.
    const checkToken = yield* Cloudflare.Access.ServiceToken("CheckToken", {
      name: "commissary-ci-check",
    });

    const checkSecret = checkToken.clientSecret.pipe(
      Output.map((secret) => {
        if (secret === undefined) throw new Error("Cloudflare returned no client secret");

        return secret;
      }),
    );

    const { variables: passedVariables, secrets: passedSecrets } = yield* passedConfig;

    // Managed OAuth (ADR 0045), written only when it is on, and then only what differs from the defaults ("" is
    // skipped). Production's only: a cloud-preview deploy, which uses Preview, would be refused it, and a preview's
    // Access application has no domain; previews get it once #267 checks one.
    const { managedOAuth } = settings;

    const redirectUris = managedOAuth.redirectUris.join(",");

    const managedOAuthVariables = managedOAuth.enabled
      ? {
          ACCESS_MANAGED_OAUTH: "true",
          ACCESS_OAUTH_REDIRECT_URIS:
            redirectUris === DEFAULT_OAUTH_REDIRECT_URIS.join(",") ? "" : redirectUris,
          ACCESS_OAUTH_LOOPBACK_CLIENTS: managedOAuth.loopbackClients ? "" : "false",
        }
      : {};

    const variables = {
      ...passedVariables,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      ACCESS_TEAM_DOMAIN: settings.teamDomain,
      ACCESS_ALLOW_EMAILS: settings.allowEmails.join(","),
      ACCESS_ALLOW_EMAIL_DOMAINS: settings.allowEmailDomains.join(","),
      PLATFORM_ADMIN_EMAILS: settings.adminEmails.join(","),
      ACCESS_SESSION_DURATION: settings.sessionDuration,
      ACCESS_ALLOW_SERVICE_TOKEN_IDS: checkToken.serviceTokenId,
    } satisfies Record<string, string | Output.Output<string>>;

    const secrets = {
      CLOUDFLARE_API_TOKEN: deployToken.value,
      CF_ACCESS_CLIENT_ID: checkToken.clientId.pipe(Output.map((id) => Redacted.make(id))),
      CF_ACCESS_CLIENT_SECRET: checkSecret,
      ...passedSecrets,
    } satisfies Record<string, Redacted.Redacted | Output.Output<Redacted.Redacted>>;

    for (const [label, environment] of [
      ["Production", production],
      ["Preview", preview],
    ] as const) {
      // Production's mode follows `.env`; a preview's follows its `cloud-preview` label (ci.yml).
      const scoped =
        label === "Production"
          ? {
              ...variables,
              COMMISSARY_DOMAIN: settings.baseDomain,
              // The app host (ADR 0031), written even when it is the base domain, so the variables say where it is.
              COMMISSARY_APP_DOMAIN: settings.appDomain,
              COMMISSARY_API_DOMAIN: settings.apiDomain,
              // The auth host of Commissary Cloud (ADR 0030), a subdomain of COMMISSARY_DOMAIN.
              COMMISSARY_AUTH_DOMAIN: settings.hosted?.authDomain ?? "",
              COMMISSARY_MODE: settings.hosted === undefined ? "" : "cloud",
              // The sandbox's computer (#223, docs/DEPLOY.md "Optional pieces"), as `.env` sets it; a preview's follows
              // its label.
              ...computerVariables(settings),
              ...managedOAuthVariables,
            }
          : variables;

      for (const [name, value] of Object.entries(scoped)) {
        // GitHub rejects empty variables; an unset variable reads as "" in the workflow anyway.
        if (value === "") continue;

        yield* GitHub.Variable(`${label}-${name}`, { ...repo, environment, name, value });
      }

      for (const [name, value] of Object.entries(secrets)) {
        yield* GitHub.Secret(`${label}-${name}`, { ...repo, environment, name, value });
      }
    }

    // The `cloud` stage: no Access, so no Access settings and no check token.
    if (cloud !== undefined && cloudStage !== undefined) {
      const scoped = {
        ...cloudStage.config.variables,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        COMMISSARY_DOMAIN: cloudStage.settings.baseDomain,
        COMMISSARY_APP_DOMAIN: cloudStage.settings.appDomain,
        COMMISSARY_API_DOMAIN: cloudStage.settings.apiDomain,
        COMMISSARY_AUTH_DOMAIN: cloudStage.settings.hosted?.authDomain ?? "",
        PLATFORM_ADMIN_EMAILS: cloudStage.settings.adminEmails.join(","),
        COMMISSARY_MODE: "cloud",
        ...computerVariables(cloudStage.settings),
      };

      for (const [name, value] of Object.entries(scoped)) {
        if (value === "") continue;

        yield* GitHub.Variable(`Cloud-${name}`, { ...repo, environment: cloud, name, value });
      }

      for (const [name, value] of Object.entries({
        CLOUDFLARE_API_TOKEN: deployToken.value,
        ...cloudStage.config.secrets,
      })) {
        yield* GitHub.Secret(`Cloud-${name}`, { ...repo, environment: cloud, name, value });
      }
    }

    return {
      // Put this into ACCESS_ALLOW_SERVICE_TOKEN_IDS in .env too, so local deploys keep the CI token admitted.
      checkServiceTokenId: checkToken.serviceTokenId,
      zone: zone.name,
      cloudBaseDomain: cloudStage?.settings.baseDomain ?? "(no .env.cloud)",
      cloudAppDomain: cloudStage?.settings.appDomain ?? "",
      cloudApiDomain: cloudStage?.settings.apiDomain ?? "",
      // Where the `cloud` stage's OAuth callbacks go (docs/DEPLOY.md "The Commissary Cloud stage").
      cloudAuthDomain: cloudStage?.settings.hosted?.authDomain ?? "",
    };
  }),
);
