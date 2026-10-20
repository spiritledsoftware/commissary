import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/**
 * Commissary Cloud's settings (ADR 0026, `COMMISSARY_MODE=cloud`): the auth Worker signs people in on the auth host (ADR
 * 0030), so no Access application is created. Secrets come from the shell (CI: the GitHub environment's secrets) and
 * are bound as secret text.
 */
export interface HostedSettings {
  readonly githubClientId: string;
  readonly githubClientSecret: Redacted.Redacted<string>;
  readonly googleClientId: string;
  readonly googleClientSecret: Redacted.Redacted<string>;
  readonly turnstileSiteKey: string;
  readonly turnstileSecretKey: Redacted.Redacted<string>;
  /** How many orgs a person may own by default (`OWNED_ORG_LIMIT`, default 3). */
  readonly ownedOrgLimit: string;
  /**
   * The rate-limit namespace of the Free plan's request-rate ceiling (`ORG_RATE_LIMIT_NAMESPACE_ID`, default 7201): a
   * positive integer unique in the account. The ceilings themselves are constants (`@commissary/billing`'s
   * `REQUEST_RATE_CEILING`, ADR 0042), not settings.
   */
  readonly orgRateLimitNamespaceId: number;
  /** Pay as you go's (`ORG_RATE_LIMIT_PAYG_NAMESPACE_ID`, default the Free plan's plus one): a namespace of its own. */
  readonly paygRateLimitNamespaceId: number;
  /**
   * The auth host (`COMMISSARY_AUTH_DOMAIN`, ADR 0030, ADR 0031), the auth Worker's custom domain: a subdomain of the
   * base domain (`baseDomain`), by default `auth.<base domain>`, other than the app host and the API host. Empty on a
   * preview (the auth Worker's workers.dev URL) and under `alchemy dev` (its dev port).
   */
  readonly authDomain: string;
  /**
   * The session cookie's `Domain` (ADR 0031): the base domain, so the cookie the auth host sets reaches the app host
   * and every other host under the base domain. Empty under `alchemy dev` (a host-only `localhost` cookie, which spans
   * the ports) and on a preview, whose cookie alchemy.run.ts scopes to the account's workers.dev subdomain, known only
   * once its first Worker is deployed (infra/preview-origin.ts).
   */
  readonly cookieDomain: string;
  /**
   * The session cookie's name prefix: Better Auth's default (empty) while the base domain is the app host, as before
   * there was an app host of its own, and under `alchemy dev`; {@link BASE_COOKIE_PREFIX} once the base domain is above
   * it, so a cookie still scoped to the app host (the old layout) never shadows the base domain's (ADR 0031);
   * `commissary-<stage>` on a preview, so previews, which share the account's workers.dev subdomain, keep apart.
   */
  readonly cookiePrefix: string;
  /**
   * Pay as you go through Polar (ADR 0042, #237): `POLAR_ACCESS_TOKEN` and `POLAR_WEBHOOK_SECRET` (secrets) and
   * `POLAR_PRODUCT_ID`, all three or none. None: the stage bills nothing (`@commissary/billing`'s routes answer 404,
   * nothing is sent). The `cloud` stage uses production Polar, every other stage Polar's sandbox (`server`).
   */
  readonly polar: PolarStageSettings | undefined;
}

/**
 * Polar's settings of a Commissary Cloud stage that bills (`HostedSettings.polar`); the Workers read theirs as
 * `@commissary/billing`'s `PolarSettings`.
 */
export interface PolarStageSettings {
  readonly accessToken: Redacted.Redacted<string>;
  readonly webhookSecret: Redacted.Redacted<string>;
  readonly productId: string;
  /** `production` on the `cloud` stage only; `sandbox` on previews and any other stage. */
  readonly server: "production" | "sandbox";
}

/**
 * The session cookie's name prefix once it is scoped to a base domain above the app host (`__Secure-commissary.*`).
 * A browser keeps a cookie of the same name scoped to the app host apart, sends the older one first, and Better Auth
 * reads the first: renaming the cookie with its scope signs people out once instead.
 */
export const BASE_COOKIE_PREFIX = "commissary";

/**
 * Cloudflare Turnstile's test keys whose check always passes (https://developers.cloudflare.com/turnstile/troubleshooting/testing/):
 * the default under `alchemy dev`, where Commissary Cloud runs without real keys.
 */
export const DEV_TURNSTILE_SITE_KEY = "1x00000000000000000000AA";

export const DEV_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";

/**
 * Deploy-time settings of the stack, read from the shell environment and `.env` (see `.env.example`). They
 * are inputs of `alchemy deploy` only; the Worker itself never reads this file.
 */
export interface Settings {
  /** `COMMISSARY_MODE=cloud` (ADR 0026): set for Commissary Cloud, `undefined` for a self-hosted one (the default). */
  readonly hosted: HostedSettings | undefined;
  /**
   * Pull-request preview stage (`pr-<number>`): served on its `workers.dev` URL behind its own Access application (none
   * on Commissary Cloud), with empty storage and no cron trigger. `baseDomain`, `appDomain`, `existingAud` and
   * `serviceTokens` are ignored.
   */
  readonly preview: boolean;
  /**
   * The base domain (`COMMISSARY_DOMAIN`, ADR 0031), e.g. `example.com`: the domain the app host and Commissary Cloud's
   * auth host are under (the API host may be elsewhere), the scope of Commissary Cloud's session cookie, and where a
   * landing page may live. The app host unless `COMMISSARY_APP_DOMAIN` names another.
   */
  readonly baseDomain: string;
  /**
   * The app host (`COMMISSARY_APP_DOMAIN`, by default the base domain), e.g. `app.example.com`: the app Worker's custom
   * domain (its zone must exist in the account) with the panel, the sign-in page and the management API, a self-hosted
   * Commissary's Access application and, without `apiDomain`, the client API through zone routes to the API Worker.
   * The base domain or a host under it.
   */
  readonly appDomain: string;
  /**
   * The API host (`COMMISSARY_API_DOMAIN`, ADR 0028), e.g. `api.example.com`: the API Worker's custom domain, the only
   * host of the client API, which leave `appDomain` then. Empty (the default, and always on a preview): zone routes on
   * `appDomain` (a preview: the API Worker's workers.dev URL).
   */
  readonly apiDomain: string;
  /** Access team name or domain, e.g. `myteam` or `myteam.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** AUD tag(s) of an Access application managed outside this stack; when set, no Access resources are created. */
  readonly existingAud: string;
  /** Users allowed through Access (Allow policy). */
  readonly allowEmails: ReadonlyArray<string>;
  readonly allowEmailDomains: ReadonlyArray<string>;
  /** Names of the service tokens to create (Service Auth policy), one per client/machine. */
  readonly serviceTokens: ReadonlyArray<string>;
  /** IDs of service tokens managed outside the stack (e.g. CI's) that the Service Auth policy also admits. */
  readonly allowServiceTokenIds: ReadonlyArray<string>;
  /**
   * Platform admins (ADR 0022): emails, and service token names (from `serviceTokens`) or Client IDs. They manage every
   * org (`PLATFORM_ADMIN_*`).
   */
  readonly adminEmails: ReadonlyArray<string>;
  readonly adminServiceTokens: ReadonlyArray<string>;
  /** Access session duration, e.g. `24h`. */
  readonly sessionDuration: string;
  /** Optional header Access reads a JSON service token from (single-header mode), e.g. `x-api-key`. */
  readonly serviceTokenHeader: string;
  /**
   * Managed OAuth of the stack's Access application (ADR 0045), which signs MCP clients in to the app host's `/mcp`:
   * whether it is on (`ACCESS_MANAGED_OAUTH`, off by default while it is in open beta and until a stage confirms that
   * `cloudflared access` clients keep working with it, #267), the redirect URIs a dynamically registered client may use
   * (`ACCESS_OAUTH_REDIRECT_URIS`, by default {@link DEFAULT_OAUTH_REDIRECT_URIS}), and whether any client redirecting
   * to `localhost` or `127.0.0.1` may (`ACCESS_OAUTH_LOOPBACK_CLIENTS`, by default on: Claude Code, Codex, Cursor's
   * desktop app). The three are refused with `ACCESS_AUD` (docs/DEPLOY.md gives the dashboard steps) and on Commissary
   * Cloud, and the last two while Managed OAuth is off.
   */
  readonly managedOAuth: {
    readonly enabled: boolean;
    readonly redirectUris: ReadonlyArray<string>;
    readonly loopbackClients: boolean;
  };
  readonly metaMintUrl: string;
  readonly cpuMs: number;
  /** Local development identity (`alchemy dev` only). */
  readonly devBypass: string;
  /**
   * Generation of the stage's secrets key (`SECRETS_KEY`, packages/state/src/secrets/): raising it mints a new key on
   * the next deploy (a rotation, docs/DEPLOY.md). Starts at 1.
   */
  readonly secretsKeyGeneration: number;
  /**
   * During a rotation, the generation the new key replaces: bound as `SECRETS_KEY_PREVIOUS` so ControlPlanes wrap their
   * data keys again. Unset once every org started under the new key.
   */
  readonly secretsKeyPreviousGeneration: number | undefined;
  /**
   * `COMMISSARY_BROWSER` (ADR 0043, default on): the State and app Workers bind Browser Run (`BROWSER`), and the
   * browser toolkit exists (#212). Never bound under `alchemy dev`, where `quickAction()` has no local emulation.
   */
  readonly browser: boolean;
}

const text = (name: string, fallback = "") =>
  Config.String(name).pipe(Config.withDefault(fallback));

const list = (name: string) =>
  Config.map(text(name), (value) =>
    value
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => item !== ""),
  );

/** A key generation: a positive integer, or `fallback` when the variable is unset or empty (CI passes unset as ""). */
const generation = (name: string, fallback: number | undefined) =>
  Effect.gen(function* () {
    const value = (yield* text(name)).trim();

    if (value === "") return fallback;

    if (!/^[1-9]\d*$/.test(value))
      return yield* Effect.die(
        new Error(`Invalid deploy settings:\n- ${name} must be a positive integer, not "${value}"`),
      );

    return Number(value);
  });

/** `SECRETS_KEY_GENERATION` and, during a rotation, `SECRETS_KEY_PREVIOUS_GENERATION` (an older one). */
const secretsKeyGenerations = Effect.gen(function* () {
  const current = (yield* generation("SECRETS_KEY_GENERATION", 1)) ?? 1;
  const previous = yield* generation("SECRETS_KEY_PREVIOUS_GENERATION", undefined);

  if (previous !== undefined && previous >= current)
    return yield* Effect.die(
      new Error(
        `Invalid deploy settings:\n- SECRETS_KEY_PREVIOUS_GENERATION (${previous}) must be lower than SECRETS_KEY_GENERATION (${current})`,
      ),
    );

  return { current, previous };
});

const TOKEN_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * The redirect URIs Managed OAuth allows by default: the hosted clients of docs/CLIENTS.md that sign in from a web
 * origin (Claude's apps, Cursor's web and agents). Clients on the person's machine redirect to a loopback address,
 * which `ACCESS_OAUTH_LOOPBACK_CLIENTS` allows.
 */
export const DEFAULT_OAUTH_REDIRECT_URIS: ReadonlyArray<string> = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://www.cursor.com/agents/mcp/oauth/callback",
];

/** Schemes no client redirects to: they run or embed content rather than return to an application. */
const UNSAFE_REDIRECT_SCHEMES = new Set(["javascript:", "data:", "file:"]);

/**
 * Why `uri` cannot be a redirect URI Managed OAuth allows, `undefined` when it can: an absolute URL, `https:` (a path
 * may end in `/*`) or a client's own scheme (`cursor://…`), never `http:` (loopback clients have their own setting) nor
 * a scheme that runs or embeds content (`javascript:`, `data:`, `file:`).
 */
const notARedirectUri = (uri: string): string | undefined => {
  if (!URL.canParse(uri)) return `ACCESS_OAUTH_REDIRECT_URIS: "${uri}" is not an absolute URL`;
  const { protocol } = new URL(uri);

  if (protocol === "http:")
    return `ACCESS_OAUTH_REDIRECT_URIS: "${uri}" must be https (ACCESS_OAUTH_LOOPBACK_CLIENTS allows clients on localhost)`;

  return UNSAFE_REDIRECT_SCHEMES.has(protocol)
    ? `ACCESS_OAUTH_REDIRECT_URIS: "${uri}" must be https or a client's own scheme, not ${protocol}`
    : undefined;
};

/** The Managed OAuth settings, which apply only to a stack-managed Access application. */
const MANAGED_OAUTH_SETTINGS = [
  "ACCESS_MANAGED_OAUTH",
  "ACCESS_OAUTH_REDIRECT_URIS",
  "ACCESS_OAUTH_LOOPBACK_CLIENTS",
] as const;

/** A boolean setting: `true`, `false` or unset (""), lowercased. */
const flag = (name: string) => Config.map(text(name), (value) => value.trim().toLowerCase());

const notAFlag = (name: string, value: string): string | undefined =>
  value === "" || value === "true" || value === "false"
    ? undefined
    : `${name} must be true or false, not "${value}"`;

/** A hostname as a custom domain takes it: lowercase labels, at least two, no scheme, port or path. */
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** Why the setting `name` is no hostname (`value`, e.g. `example`), `undefined` when it is one. */
const notAHostname = (name: string, value: string, example: string): string | undefined =>
  HOSTNAME.test(value)
    ? undefined
    : `${name} must be a lowercase hostname such as ${example}, not "${value}"`;

/**
 * Whether `host` is `domain` or a host under it. Settings compare hosts that passed {@link HOSTNAME}, so lowercase;
 * stacks/github.ts matches a host to its zone with it.
 */
export const isWithin = (host: string, domain: string): boolean =>
  host === domain || host.endsWith(`.${domain}`);

/** The refusal of a setting (`name`) that names the app host. */
const sameAsAppHost = (name: string, appDomain: string): string =>
  `${name} must differ from the app host (${appDomain}), COMMISSARY_APP_DOMAIN or by default COMMISSARY_DOMAIN`;

const secret = (name: string, fallback = "") =>
  Effect.map(text(name, fallback), (value) => Redacted.make(value.trim()));

/** A whole number from `min`, or `fallback` when unset; `undefined` when set to something else. */
const wholeNumber = (value: string, fallback: number, min: number): number | undefined => {
  if (value.trim() === "") return fallback;
  const parsed = Number(value.trim());

  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : undefined;
};

/** `COMMISSARY_MODE`: `self-hosted` (or unset) or `cloud`. */
const commissaryMode = Effect.gen(function* () {
  const mode = (yield* text("COMMISSARY_MODE")).trim();

  if (mode === "" || mode === "self-hosted") return "self-hosted" as const;

  if (mode === "cloud") return "cloud" as const;

  return yield* Effect.die(
    new Error(
      `Invalid deploy settings:\n- COMMISSARY_MODE must be self-hosted or cloud, not "${mode}"`,
    ),
  );
});

/**
 * `COMMISSARY_BROWSER` (ADR 0043): whether the deployment binds Browser Run (`browser`), which the browser toolkit runs
 * on (#212). `on` (or unset) by default, as Browser Run includes 10 hours a month on Workers Paid; `off` deploys no
 * binding and no browser toolkit.
 */
const browserSetting = Effect.gen(function* () {
  const value = (yield* text("COMMISSARY_BROWSER")).trim().toLowerCase();

  if (value === "" || value === "on") return true;

  if (value === "off") return false;

  return yield* Effect.die(
    new Error(`Invalid deploy settings:\n- COMMISSARY_BROWSER must be on or off, not "${value}"`),
  );
});

/** The auth host: `COMMISSARY_AUTH_DOMAIN` (`configured`), else `auth.<base domain>` (empty without a base domain). */
const authHost = (configured: string, baseDomain: string): string => {
  if (configured !== "") return configured;

  return baseDomain === "" ? "" : `auth.${baseDomain}`;
};

/**
 * The settings of Commissary Cloud, and what is wrong with them. Under `alchemy dev` (`dev`) Turnstile defaults to its
 * always-passing test keys and no problem is reported: a sign-in provider is optional there.
 */
const hostedSettings = Effect.fnUntraced(function* (
  dev: boolean,
  stage: string,
  preview: boolean,
  hosts: { readonly baseDomain: string; readonly appDomain: string; readonly apiDomain: string },
) {
  const { baseDomain, appDomain, apiDomain } = hosts;
  const deployed = !dev && !preview;
  const scopedToBase = deployed && baseDomain !== appDomain;
  const problems: Array<string> = [];
  const limit = wholeNumber(yield* text("OWNED_ORG_LIMIT"), 3, 0);
  const namespace = wholeNumber(yield* text("ORG_RATE_LIMIT_NAMESPACE_ID"), 7201, 1);

  // Unset, one above the Free plan's, so an environment that already set its own namespace needs nothing more.
  const paygNamespace = wholeNumber(
    yield* text("ORG_RATE_LIMIT_PAYG_NAMESPACE_ID"),
    (namespace ?? 7201) + 1,
    1,
  );

  if (limit === undefined) problems.push("OWNED_ORG_LIMIT must be a whole number from 0");

  if (namespace === undefined)
    problems.push("ORG_RATE_LIMIT_NAMESPACE_ID must be a positive integer");

  if (paygNamespace === undefined)
    problems.push("ORG_RATE_LIMIT_PAYG_NAMESPACE_ID must be a positive integer");

  // Two bindings on one namespace would count Free's and Pay as you go's requests together.
  if (namespace !== undefined && namespace === paygNamespace)
    problems.push("ORG_RATE_LIMIT_PAYG_NAMESPACE_ID must differ from ORG_RATE_LIMIT_NAMESPACE_ID");

  const polarToken = yield* secret("POLAR_ACCESS_TOKEN");
  const polarWebhookSecret = yield* secret("POLAR_WEBHOOK_SECRET");
  const polarProduct = (yield* text("POLAR_PRODUCT_ID")).trim();

  const polarSet = [
    Redacted.value(polarToken) !== "",
    Redacted.value(polarWebhookSecret) !== "",
    polarProduct !== "",
  ];

  if (polarSet.some((set) => set) && !polarSet.every((set) => set))
    problems.push(
      "Pay as you go through Polar needs POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET and POLAR_PRODUCT_ID together (or none: no billing)",
    );

  const polar: PolarStageSettings | undefined = polarSet.every((set) => set)
    ? {
        accessToken: polarToken,
        webhookSecret: polarWebhookSecret,
        productId: polarProduct,
        server: stage === CLOUD_STAGE ? "production" : "sandbox",
      }
    : undefined;

  const hosted: HostedSettings = {
    githubClientId: (yield* text("SIGN_IN_GITHUB_CLIENT_ID")).trim(),
    githubClientSecret: yield* secret("SIGN_IN_GITHUB_CLIENT_SECRET"),
    googleClientId: (yield* text("SIGN_IN_GOOGLE_CLIENT_ID")).trim(),
    googleClientSecret: yield* secret("SIGN_IN_GOOGLE_CLIENT_SECRET"),
    turnstileSiteKey: (yield* text("TURNSTILE_SITE_KEY", dev ? DEV_TURNSTILE_SITE_KEY : "")).trim(),
    turnstileSecretKey: yield* secret("TURNSTILE_SECRET_KEY", dev ? DEV_TURNSTILE_SECRET_KEY : ""),
    ownedOrgLimit: String(limit ?? 3),
    orgRateLimitNamespaceId: namespace ?? 7201,
    paygRateLimitNamespaceId: paygNamespace ?? 7202,
    authDomain: deployed
      ? authHost((yield* text("COMMISSARY_AUTH_DOMAIN")).trim(), baseDomain)
      : "",
    cookieDomain: deployed ? baseDomain : "",
    cookiePrefix: preview ? `commissary-${stage}` : scopedToBase ? BASE_COOKIE_PREFIX : "",
    polar,
  };

  if (hosted.authDomain !== "") {
    const notHostname = notAHostname(
      "COMMISSARY_AUTH_DOMAIN",
      hosted.authDomain,
      "auth.example.com",
    );

    if (notHostname !== undefined) problems.push(notHostname);
    else if (hosted.authDomain === baseDomain || !isWithin(hosted.authDomain, baseDomain))
      problems.push(
        `COMMISSARY_AUTH_DOMAIN must be a subdomain of COMMISSARY_DOMAIN (${baseDomain}), the scope of its session cookie`,
      );
    else if (hosted.authDomain === appDomain)
      problems.push(sameAsAppHost("COMMISSARY_AUTH_DOMAIN", appDomain));
    else if (hosted.authDomain === apiDomain)
      problems.push("COMMISSARY_AUTH_DOMAIN must differ from COMMISSARY_API_DOMAIN");
  }

  const github = hosted.githubClientId !== "" && Redacted.value(hosted.githubClientSecret) !== "";
  const google = hosted.googleClientId !== "" && Redacted.value(hosted.googleClientSecret) !== "";

  if (!github && !google)
    problems.push(
      "Commissary Cloud needs a sign-in provider: SIGN_IN_GITHUB_CLIENT_ID and SIGN_IN_GITHUB_CLIENT_SECRET, and/or SIGN_IN_GOOGLE_CLIENT_ID and SIGN_IN_GOOGLE_CLIENT_SECRET",
    );

  if (hosted.turnstileSiteKey === "" || Redacted.value(hosted.turnstileSecretKey) === "")
    problems.push("Commissary Cloud needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY");

  return { hosted, problems };
});

/** Stage names of pull-request previews (`pr-<number>`, as deployed by .github/workflows/ci.yml). */
export const PREVIEW_STAGE = /^pr-\d+$/;

/**
 * Stage of Commissary Cloud, which CI deploys from `main` next to `prod` (docs/DEPLOY.md "The Commissary Cloud stage"). Its settings live
 * in `.env.cloud` (`pnpm deploy:cloud`) and the GitHub environment `cloud`.
 */
export const CLOUD_STAGE = "cloud";

export const readSettings = (dev: boolean, stage: string) =>
  Effect.gen(function* () {
    const preview = !dev && PREVIEW_STAGE.test(stage);
    const secretsKey = yield* secretsKeyGenerations;
    const mode = yield* commissaryMode;

    // Deployed with `.env`'s self-hosted settings, the stage would claim the self-hosted Commissary's hostname.
    if (!dev && stage === CLOUD_STAGE && mode !== "cloud")
      return yield* Effect.die(
        new Error(
          `Invalid deploy settings:\n- the ${CLOUD_STAGE} stage is Commissary Cloud: set COMMISSARY_MODE=cloud (deploy it with \`pnpm deploy:cloud\`, which reads .env.cloud)`,
        ),
      );

    // The hosts are trimmed here and refused below unless lowercase hostnames, so they compare as they are.
    const baseDomain = (yield* text("COMMISSARY_DOMAIN")).trim();
    // The app host is the base domain unless set (ADR 0031): a self-hosted `.env` from before keeps serving it there.
    const configuredAppDomain = (yield* text("COMMISSARY_APP_DOMAIN")).trim();
    const appDomain = configuredAppDomain === "" ? baseDomain : configuredAppDomain;
    // A preview's Workers serve their workers.dev URLs only.
    const apiDomain = dev || preview ? "" : (yield* text("COMMISSARY_API_DOMAIN")).trim();

    // Under `alchemy dev` too (`COMMISSARY_MODE=cloud pnpm smoke`): people sign in on the auth Worker's dev port, without the dev bypass.
    const hosted =
      mode === "cloud"
        ? yield* hostedSettings(dev, stage, preview, { baseDomain, appDomain, apiDomain })
        : undefined;

    const managedOAuthSetting = yield* flag("ACCESS_MANAGED_OAUTH");
    const oauthRedirectUris = yield* list("ACCESS_OAUTH_REDIRECT_URIS");
    const oauthLoopbackClients = yield* flag("ACCESS_OAUTH_LOOPBACK_CLIENTS");

    // Which of the Managed OAuth settings are set, for the refusals where they do not apply.
    const setOAuth: Record<(typeof MANAGED_OAUTH_SETTINGS)[number], boolean> = {
      ACCESS_MANAGED_OAUTH: managedOAuthSetting !== "",
      ACCESS_OAUTH_REDIRECT_URIS: oauthRedirectUris.length > 0,
      ACCESS_OAUTH_LOOPBACK_CLIENTS: oauthLoopbackClients !== "",
    };

    const configuredOAuth = MANAGED_OAUTH_SETTINGS.filter((name) => setOAuth[name]);

    const settings: Settings = {
      hosted: hosted?.hosted,
      preview,
      baseDomain,
      appDomain,
      apiDomain,
      teamDomain: (yield* text("ACCESS_TEAM_DOMAIN")).trim(),
      existingAud: preview ? "" : (yield* text("ACCESS_AUD")).trim(),
      allowEmails: yield* list("ACCESS_ALLOW_EMAILS"),
      allowEmailDomains: yield* list("ACCESS_ALLOW_EMAIL_DOMAINS"),
      serviceTokens: preview ? [] : yield* list("ACCESS_SERVICE_TOKENS"),
      allowServiceTokenIds: yield* list("ACCESS_ALLOW_SERVICE_TOKEN_IDS"),
      adminEmails: yield* list("PLATFORM_ADMIN_EMAILS"),
      adminServiceTokens: yield* list("PLATFORM_ADMIN_SERVICE_TOKENS"),
      sessionDuration: (yield* text("ACCESS_SESSION_DURATION", "24h")).trim(),
      serviceTokenHeader: (yield* text("ACCESS_SERVICE_TOKEN_HEADER")).trim(),
      managedOAuth: {
        enabled: managedOAuthSetting === "true",
        redirectUris:
          oauthRedirectUris.length === 0 ? DEFAULT_OAUTH_REDIRECT_URIS : oauthRedirectUris,
        loopbackClients: oauthLoopbackClients !== "false",
      },
      metaMintUrl: (yield* text("META_MINT_URL")).trim(),
      cpuMs: yield* Config.Number("COMMISSARY_CPU_MS").pipe(Config.withDefault(300_000)),
      devBypass: (yield* text("ACCESS_DEV_BYPASS", "dev@example.com")).trim(),
      secretsKeyGeneration: secretsKey.current,
      secretsKeyPreviousGeneration: secretsKey.previous,
      browser: yield* browserSetting,
    };

    if (dev) return settings;
    const problems: Array<string> = [...(hosted?.problems ?? [])];

    // A preview ignores the base domain and the app host: its Workers serve their workers.dev URLs.
    if (!preview) {
      const notHostname =
        settings.baseDomain === ""
          ? "COMMISSARY_DOMAIN is required (the base domain; the app host unless COMMISSARY_APP_DOMAIN names another)"
          : notAHostname("COMMISSARY_DOMAIN", settings.baseDomain, "example.com");

      if (notHostname !== undefined) problems.push(notHostname);
      else if (configuredAppDomain !== "") {
        const notAppHostname = notAHostname(
          "COMMISSARY_APP_DOMAIN",
          configuredAppDomain,
          "app.example.com",
        );

        if (notAppHostname !== undefined) problems.push(notAppHostname);
        else if (!isWithin(configuredAppDomain, settings.baseDomain))
          problems.push(
            `COMMISSARY_APP_DOMAIN must be COMMISSARY_DOMAIN (${settings.baseDomain}) or a subdomain of it`,
          );
      }
    }

    if (settings.apiDomain !== "") {
      const notHostname = notAHostname(
        "COMMISSARY_API_DOMAIN",
        settings.apiDomain,
        "api.example.com",
      );

      if (notHostname !== undefined) problems.push(notHostname);
      else if (settings.apiDomain === settings.appDomain)
        problems.push(
          `${sameAsAppHost("COMMISSARY_API_DOMAIN", settings.appDomain)}: unset it to serve the client API on the app host`,
        );
    }

    if (hosted !== undefined) {
      if (configuredOAuth.length > 0)
        problems.push(
          `${configuredOAuth.join(", ")}: Commissary Cloud has no Access application (its MCP clients sign in with Commissary's own OAuth); unset them`,
        );

      if (settings.adminServiceTokens.length > 0)
        yield* Effect.logWarning(
          "PLATFORM_ADMIN_SERVICE_TOKENS is ignored on Commissary Cloud: platform admins sign in with PLATFORM_ADMIN_EMAILS",
        );

      if (problems.length > 0)
        return yield* Effect.die(new Error(`Invalid deploy settings:\n- ${problems.join("\n- ")}`));

      // Commissary Cloud creates no Access resources and reads none of the Access settings.
      return settings;
    }

    if (settings.teamDomain === "")
      problems.push("ACCESS_TEAM_DOMAIN is required (your Zero Trust team name)");

    for (const problem of [
      notAFlag("ACCESS_MANAGED_OAUTH", managedOAuthSetting),
      notAFlag("ACCESS_OAUTH_LOOPBACK_CLIENTS", oauthLoopbackClients),
      ...oauthRedirectUris.map(notARedirectUri),
    ])
      if (problem !== undefined) problems.push(problem);

    // Commissary Cloud refused them above, and ACCESS_AUD does below: each setting is refused once.
    if (
      settings.existingAud === "" &&
      !settings.managedOAuth.enabled &&
      (oauthRedirectUris.length > 0 || oauthLoopbackClients !== "")
    )
      problems.push(
        "ACCESS_OAUTH_REDIRECT_URIS and ACCESS_OAUTH_LOOPBACK_CLIENTS apply to Managed OAuth: set ACCESS_MANAGED_OAUTH=true, or unset them",
      );

    if (settings.existingAud === "") {
      if (
        settings.allowEmails.length === 0 &&
        settings.allowEmailDomains.length === 0 &&
        settings.serviceTokens.length === 0 &&
        settings.allowServiceTokenIds.length === 0
      ) {
        problems.push(
          "set ACCESS_ALLOW_EMAILS, ACCESS_ALLOW_EMAIL_DOMAINS, ACCESS_SERVICE_TOKENS and/or ACCESS_ALLOW_SERVICE_TOKEN_IDS, or ACCESS_AUD for an existing Access application",
        );
      }

      for (const name of settings.serviceTokens) {
        if (!TOKEN_NAME.test(name))
          problems.push(`ACCESS_SERVICE_TOKENS: "${name}" must match ${TOKEN_NAME.source}`);
      }
    } else {
      if (settings.serviceTokens.length > 0 || settings.allowServiceTokenIds.length > 0)
        problems.push(
          "ACCESS_SERVICE_TOKENS and ACCESS_ALLOW_SERVICE_TOKEN_IDS need a stack-managed Access application: unset ACCESS_AUD",
        );

      if (configuredOAuth.length > 0)
        problems.push(
          `${configuredOAuth.join(", ")} need a stack-managed Access application: unset ACCESS_AUD, or turn Managed OAuth on in your application (docs/DEPLOY.md)`,
        );
    }

    if (problems.length > 0) {
      // The stack's error channel only carries ConfigError: report invalid combinations as a defect with a readable message.
      return yield* Effect.die(new Error(`Invalid deploy settings:\n- ${problems.join("\n- ")}`));
    }

    return settings;
  });
