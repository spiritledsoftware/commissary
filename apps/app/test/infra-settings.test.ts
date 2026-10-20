// Deploy settings (infra/settings.ts): the platform admins (PLATFORM_ADMIN_*), the secrets key generations, Commissary
// Cloud's settings (its auth host among them), the browser (`COMMISSARY_BROWSER`) with its crawls (#270), and the
// sandbox's computer.
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Logger, Redacted } from "effect";
import {
  BASE_COOKIE_PREFIX,
  DEV_TURNSTILE_SECRET_KEY,
  DEV_TURNSTILE_SITE_KEY,
  readSettings,
} from "../../../infra/settings.ts";

const read = (variables: Record<string, string>, deployed?: { readonly stage: string }) => {
  const warnings: Array<string> = [];

  const capture = Logger.layer([
    Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push([message].flat().map(String).join(" "));
    }),
  ]);

  return readSettings(deployed === undefined, deployed?.stage ?? "dev").pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(variables))),
    Effect.provide(capture),
    Effect.map((settings) => ({ settings, warnings })),
  );
};

/** A deployed stage's settings, or the readable refusal of invalid ones (a defect, see `readSettings`). */
const refusal = (variables: Record<string, string>, stage = "prod") =>
  read(variables, { stage }).pipe(
    Effect.as("accepted"),
    Effect.catchDefect((defect) => Effect.succeed(String(defect))),
  );

/** The least a self-hosted Commissary deploys with. */
const selfHosted = {
  COMMISSARY_DOMAIN: "commissary.example.com",
  ACCESS_TEAM_DOMAIN: "team",
  ACCESS_ALLOW_EMAILS: "a@x.com",
};

describe("platform admin settings", () => {
  it.effect("reads PLATFORM_ADMIN_* without a warning", () =>
    Effect.gen(function* () {
      const { settings, warnings } = yield* read({
        PLATFORM_ADMIN_EMAILS: "a@x.com, b@x.com",
        PLATFORM_ADMIN_SERVICE_TOKENS: "ops",
      });

      assert.deepStrictEqual(settings.adminEmails, ["a@x.com", "b@x.com"]);
      assert.deepStrictEqual(settings.adminServiceTokens, ["ops"]);
      assert.deepStrictEqual(warnings, []);
    }),
  );
});

describe("secrets key generations", () => {
  it.effect(
    "default to generation 1 and no rotation, also when CI passes unset variables as empty",
    () =>
      Effect.gen(function* () {
        for (const variables of [
          {},
          { SECRETS_KEY_GENERATION: "", SECRETS_KEY_PREVIOUS_GENERATION: "" },
        ]) {
          const { settings } = yield* read(variables);

          assert.strictEqual(settings.secretsKeyGeneration, 1);
          assert.strictEqual(settings.secretsKeyPreviousGeneration, undefined);
        }
      }),
  );

  it.effect("read a rotation from an older generation to a newer one", () =>
    Effect.gen(function* () {
      const { settings } = yield* read({
        SECRETS_KEY_GENERATION: "3",
        SECRETS_KEY_PREVIOUS_GENERATION: "2",
      });

      assert.strictEqual(settings.secretsKeyGeneration, 3);
      assert.strictEqual(settings.secretsKeyPreviousGeneration, 2);
    }),
  );

  it.effect("refuse a generation that is not a positive integer, or a previous one not older", () =>
    Effect.gen(function* () {
      for (const [variables, message] of [
        [{ SECRETS_KEY_GENERATION: "0" }, "SECRETS_KEY_GENERATION must be a positive integer"],
        [{ SECRETS_KEY_GENERATION: "2.5" }, "SECRETS_KEY_GENERATION must be a positive integer"],
        [
          { SECRETS_KEY_PREVIOUS_GENERATION: "1" },
          "SECRETS_KEY_PREVIOUS_GENERATION (1) must be lower than SECRETS_KEY_GENERATION (1)",
        ],
        [
          { SECRETS_KEY_GENERATION: "2", SECRETS_KEY_PREVIOUS_GENERATION: "3" },
          "must be lower than SECRETS_KEY_GENERATION (2)",
        ],
      ] as const) {
        // The settings refuse invalid values as a defect with a readable message (see `readSettings`).
        const refused = yield* read(variables).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );

        assert.include(refused, message);
      }
    }),
  );
});

describe("Commissary Cloud settings", () => {
  const hosted = {
    COMMISSARY_MODE: "cloud",
    COMMISSARY_DOMAIN: "commissary.example.com",
    SIGN_IN_GITHUB_CLIENT_ID: "gh-id",
    SIGN_IN_GITHUB_CLIENT_SECRET: "gh-secret",
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
  };

  // Commissary Cloud's own layout: a base domain for a landing page, and the app, auth and API hosts under it.
  const cloud = {
    ...hosted,
    COMMISSARY_DOMAIN: "example.com",
    COMMISSARY_APP_DOMAIN: "app.example.com",
    COMMISSARY_API_DOMAIN: "api.example.com",
  };

  it.effect("need no Access settings, and default the org limits", () =>
    Effect.gen(function* () {
      const { settings } = yield* read(hosted, { stage: "prod" });

      assert.strictEqual(settings.hosted?.githubClientId, "gh-id");
      assert.strictEqual(
        Redacted.value(settings.hosted?.githubClientSecret ?? Redacted.make("")),
        "gh-secret",
      );
      assert.strictEqual(settings.hosted?.googleClientId, "");
      assert.strictEqual(settings.hosted?.ownedOrgLimit, "3");
      assert.strictEqual(settings.hosted?.orgRateLimitNamespaceId, 7201);
      assert.strictEqual(settings.hosted?.paygRateLimitNamespaceId, 7202);
      assert.strictEqual(
        (yield* read({ ...hosted, ORG_RATE_LIMIT_NAMESPACE_ID: "7300" }, { stage: "prod" }))
          .settings.hosted?.paygRateLimitNamespaceId,
        7301,
      );
    }),
  );

  it.effect(
    "bill through Polar with its three settings: production Polar on the cloud stage only",
    () =>
      Effect.gen(function* () {
        const polar = {
          ...cloud,
          POLAR_ACCESS_TOKEN: "polar_oat_x",
          POLAR_WEBHOOK_SECRET: "polar_whs_x",
          POLAR_PRODUCT_ID: "prod_1",
        };

        assert.strictEqual(
          (yield* read(cloud, { stage: "cloud" })).settings.hosted?.polar,
          undefined,
        );

        const onCloud = (yield* read(polar, { stage: "cloud" })).settings.hosted?.polar;

        assert.strictEqual(onCloud?.server, "production");
        assert.strictEqual(onCloud?.productId, "prod_1");
        assert.strictEqual(
          Redacted.value(onCloud?.accessToken ?? Redacted.make("")),
          "polar_oat_x",
        );
        assert.strictEqual(
          (yield* read(polar, { stage: "pr-12" })).settings.hosted?.polar?.server,
          "sandbox",
        );
      }),
  );

  it.effect("are not read on a self-hosted Commissary", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* read({ ...hosted, COMMISSARY_MODE: "" })).settings.hosted,
        undefined,
      );
      assert.include(
        yield* refusal({ ...hosted, COMMISSARY_MODE: "self-hosted" }),
        "ACCESS_TEAM_DOMAIN is required",
      );
    }),
  );

  it.effect(
    "run under `alchemy dev` with Turnstile's test keys, no provider and no auth host",
    () =>
      Effect.gen(function* () {
        const { settings } = yield* read({ COMMISSARY_MODE: "cloud" });

        assert.strictEqual(settings.hosted?.turnstileSiteKey, DEV_TURNSTILE_SITE_KEY);
        assert.strictEqual(
          Redacted.value(settings.hosted?.turnstileSecretKey ?? Redacted.make("")),
          DEV_TURNSTILE_SECRET_KEY,
        );
        assert.strictEqual(settings.hosted?.githubClientId, "");
        assert.strictEqual(settings.hosted?.authDomain, "");
        assert.strictEqual((yield* read(hosted)).settings.hosted?.turnstileSiteKey, "site");
      }),
  );

  it.effect(
    "put the auth host under the base domain, auth.<base domain> by default, none on a preview",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* read(hosted, { stage: "prod" })).settings.hosted?.authDomain,
          "auth.commissary.example.com",
        );
        assert.strictEqual(
          (yield* read(
            { ...hosted, COMMISSARY_AUTH_DOMAIN: " login.commissary.example.com " },
            { stage: "prod" },
          )).settings.hosted?.authDomain,
          "login.commissary.example.com",
        );
        assert.strictEqual(
          (yield* read(cloud, { stage: "prod" })).settings.hosted?.authDomain,
          "auth.example.com",
        );
        assert.strictEqual(
          (yield* read({ ...hosted, COMMISSARY_DOMAIN: "" }, { stage: "pr-12" })).settings.hosted
            ?.authDomain,
          "",
        );

        for (const [variables, message] of [
          [
            { COMMISSARY_AUTH_DOMAIN: "auth.elsewhere.com" },
            "COMMISSARY_AUTH_DOMAIN must be a subdomain of COMMISSARY_DOMAIN",
          ],
          [
            { COMMISSARY_AUTH_DOMAIN: "commissary.example.com" },
            "COMMISSARY_AUTH_DOMAIN must be a subdomain of COMMISSARY_DOMAIN",
          ],
          [
            { COMMISSARY_AUTH_DOMAIN: "https://auth.commissary.example.com" },
            "COMMISSARY_AUTH_DOMAIN must be a lowercase hostname",
          ],
          [
            {
              COMMISSARY_AUTH_DOMAIN: "api.commissary.example.com",
              COMMISSARY_API_DOMAIN: "api.commissary.example.com",
            },
            "COMMISSARY_AUTH_DOMAIN must differ from COMMISSARY_API_DOMAIN",
          ],
          [
            {
              COMMISSARY_APP_DOMAIN: "app.commissary.example.com",
              COMMISSARY_AUTH_DOMAIN: "app.commissary.example.com",
            },
            "COMMISSARY_AUTH_DOMAIN must differ from the app host (app.commissary.example.com)",
          ],
          [
            { COMMISSARY_APP_DOMAIN: "auth.commissary.example.com" },
            "COMMISSARY_AUTH_DOMAIN must differ from the app host (auth.commissary.example.com)",
          ],
        ] as const)
          assert.include(yield* refusal({ ...hosted, ...variables }), message);

        // The auth host of the old layout, under an app host that is the base domain, outside a base domain above it.
        assert.strictEqual(
          yield* refusal({ ...cloud, COMMISSARY_AUTH_DOMAIN: "auth.app.example.com" }),
          "accepted",
        );
        assert.include(
          yield* refusal({ ...cloud, COMMISSARY_AUTH_DOMAIN: "auth.elsewhere.example.org" }),
          "COMMISSARY_AUTH_DOMAIN must be a subdomain of COMMISSARY_DOMAIN (example.com)",
        );
      }),
  );

  it.effect(
    "scope the session cookie to the base domain, named apart once the base domain is above the app host",
    () =>
      Effect.gen(function* () {
        // The app host is the base domain (the layout before COMMISSARY_APP_DOMAIN): Better Auth's cookie name.
        const legacy = (yield* read(hosted, { stage: "prod" })).settings.hosted;

        assert.strictEqual(legacy?.cookieDomain, "commissary.example.com");
        assert.strictEqual(legacy?.cookiePrefix, "");

        const split = (yield* read(cloud, { stage: "cloud" })).settings.hosted;

        assert.strictEqual(split?.cookieDomain, "example.com");
        assert.strictEqual(split?.cookiePrefix, BASE_COOKIE_PREFIX);

        // A preview names its cookie apart, scoped in alchemy.run.ts to the account's workers.dev subdomain.
        const preview = (yield* read(cloud, { stage: "pr-12" })).settings.hosted;

        assert.strictEqual(preview?.cookieDomain, "");
        assert.strictEqual(preview?.cookiePrefix, "commissary-pr-12");

        // `alchemy dev`: a host-only `localhost` cookie of Better Auth's name.
        const dev = (yield* read(cloud)).settings.hosted;

        assert.strictEqual(dev?.cookieDomain, "");
        assert.strictEqual(dev?.cookiePrefix, "");
      }),
  );

  it.effect("are required on the cloud stage, which never deploys a self-hosted Commissary", () =>
    Effect.gen(function* () {
      const { settings } = yield* read(hosted, { stage: "cloud" });

      assert.strictEqual(settings.hosted?.githubClientId, "gh-id");

      for (const mode of ["", "self-hosted"]) {
        const refused = yield* read(
          {
            ...hosted,
            COMMISSARY_MODE: mode,
            ACCESS_TEAM_DOMAIN: "team",
            ACCESS_ALLOW_EMAILS: "a@x.com",
          },
          { stage: "cloud" },
        ).pipe(
          Effect.as("accepted"),
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );

        assert.include(refused, "the cloud stage is Commissary Cloud: set COMMISSARY_MODE=cloud");
      }
    }),
  );

  it.effect("refuse Commissary Cloud without a sign-in provider, Turnstile or valid limits", () =>
    Effect.gen(function* () {
      for (const [variables, message] of [
        [{ COMMISSARY_MODE: "managed" }, "COMMISSARY_MODE must be self-hosted or cloud"],
        [{ COMMISSARY_MODE: "hosted" }, "COMMISSARY_MODE must be self-hosted or cloud"],
        [{ SIGN_IN_GITHUB_CLIENT_SECRET: "" }, "Commissary Cloud needs a sign-in provider"],
        [
          { TURNSTILE_SECRET_KEY: "" },
          "Commissary Cloud needs TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY",
        ],
        [{ OWNED_ORG_LIMIT: "-1" }, "OWNED_ORG_LIMIT must be a whole number from 0"],
        [
          { ORG_RATE_LIMIT_NAMESPACE_ID: "x" },
          "ORG_RATE_LIMIT_NAMESPACE_ID must be a positive integer",
        ],
        [
          { ORG_RATE_LIMIT_PAYG_NAMESPACE_ID: "0" },
          "ORG_RATE_LIMIT_PAYG_NAMESPACE_ID must be a positive integer",
        ],
        [
          { ORG_RATE_LIMIT_NAMESPACE_ID: "5", ORG_RATE_LIMIT_PAYG_NAMESPACE_ID: "5" },
          "ORG_RATE_LIMIT_PAYG_NAMESPACE_ID must differ from ORG_RATE_LIMIT_NAMESPACE_ID",
        ],
        [{ COMMISSARY_DOMAIN: "" }, "COMMISSARY_DOMAIN is required"],
        [
          { POLAR_ACCESS_TOKEN: "polar_oat_x" },
          "needs POLAR_ACCESS_TOKEN, POLAR_WEBHOOK_SECRET and POLAR_PRODUCT_ID together",
        ],
      ] as const)
        assert.include(yield* refusal({ ...hosted, ...variables }), message);
    }),
  );
});

describe("API host settings", () => {
  it.effect("default to one host serving everything", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* read(selfHosted, { stage: "prod" })).settings.apiDomain, "");
    }),
  );

  it.effect("read COMMISSARY_API_DOMAIN, except on a preview and in `alchemy dev`", () =>
    Effect.gen(function* () {
      const split = { ...selfHosted, COMMISSARY_API_DOMAIN: " api.example.com " };

      assert.strictEqual(
        (yield* read(split, { stage: "prod" })).settings.apiDomain,
        "api.example.com",
      );
      assert.strictEqual((yield* read(split, { stage: "pr-12" })).settings.apiDomain, "");
      assert.strictEqual((yield* read(split)).settings.apiDomain, "");
    }),
  );

  it.effect(
    "refuse an API host that is an app host of its own, but not one that is the base domain",
    () =>
      Effect.gen(function* () {
        const app = { ...selfHosted, COMMISSARY_APP_DOMAIN: "app.commissary.example.com" };

        assert.include(
          yield* refusal({ ...app, COMMISSARY_API_DOMAIN: "app.commissary.example.com" }),
          "COMMISSARY_API_DOMAIN must differ from the app host (app.commissary.example.com)",
        );
        assert.strictEqual(
          (yield* read(
            { ...app, COMMISSARY_API_DOMAIN: "commissary.example.com" },
            { stage: "prod" },
          )).settings.apiDomain,
          "commissary.example.com",
        );
      }),
  );

  it.effect("refuse an API host that is the app host or no hostname", () =>
    Effect.gen(function* () {
      for (const [apiDomain, message] of [
        [
          "commissary.example.com",
          "COMMISSARY_API_DOMAIN must differ from the app host (commissary.example.com)",
        ],
        ["https://api.example.com", "COMMISSARY_API_DOMAIN must be a lowercase hostname"],
        ["api.example.com/v1", "COMMISSARY_API_DOMAIN must be a lowercase hostname"],
        ["API.example.com", "COMMISSARY_API_DOMAIN must be a lowercase hostname"],
        ["localhost", "COMMISSARY_API_DOMAIN must be a lowercase hostname"],
      ] as const)
        assert.include(
          yield* refusal({ ...selfHosted, COMMISSARY_API_DOMAIN: apiDomain }),
          message,
        );
    }),
  );
});

describe("base domain and app host", () => {
  it.effect("serve the app on the base domain by default, as a self-hosted .env always did", () =>
    Effect.gen(function* () {
      for (const variables of [selfHosted, { ...selfHosted, COMMISSARY_APP_DOMAIN: "" }]) {
        const { settings } = yield* read(variables, { stage: "prod" });

        assert.strictEqual(settings.baseDomain, "commissary.example.com");
        assert.strictEqual(settings.appDomain, "commissary.example.com");
        assert.strictEqual(settings.hosted, undefined);
      }
    }),
  );

  it.effect("read COMMISSARY_APP_DOMAIN: the base domain itself or a host under it", () =>
    Effect.gen(function* () {
      for (const [app, expected] of [
        [" app.commissary.example.com ", "app.commissary.example.com"],
        ["commissary.example.com", "commissary.example.com"],
        ["panel.eu.commissary.example.com", "panel.eu.commissary.example.com"],
      ] as const) {
        const { settings } = yield* read(
          { ...selfHosted, COMMISSARY_APP_DOMAIN: app },
          { stage: "prod" },
        );

        assert.strictEqual(settings.baseDomain, "commissary.example.com");
        assert.strictEqual(settings.appDomain, expected);
      }
    }),
  );

  it.effect("refuse a base domain that is no hostname", () =>
    Effect.gen(function* () {
      for (const base of ["Commissary.example.com", "https://commissary.example.com", "localhost"])
        assert.include(
          yield* refusal({ ...selfHosted, COMMISSARY_DOMAIN: base }),
          "COMMISSARY_DOMAIN must be a lowercase hostname",
        );
    }),
  );

  it.effect("refuse an app host outside the base domain or no hostname", () =>
    Effect.gen(function* () {
      for (const [app, message] of [
        [
          "app.elsewhere.com",
          "COMMISSARY_APP_DOMAIN must be COMMISSARY_DOMAIN (commissary.example.com) or a subdomain of it",
        ],
        [
          "example.com",
          "COMMISSARY_APP_DOMAIN must be COMMISSARY_DOMAIN (commissary.example.com) or a subdomain of it",
        ],
        [
          "appcommissary.example.com",
          "COMMISSARY_APP_DOMAIN must be COMMISSARY_DOMAIN (commissary.example.com) or a subdomain of it",
        ],
        [
          "https://app.commissary.example.com",
          "COMMISSARY_APP_DOMAIN must be a lowercase hostname",
        ],
        ["App.commissary.example.com", "COMMISSARY_APP_DOMAIN must be a lowercase hostname"],
      ] as const)
        assert.include(yield* refusal({ ...selfHosted, COMMISSARY_APP_DOMAIN: app }), message);
    }),
  );

  it.effect("ignore the hosts on a preview", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* refusal(
          { ...selfHosted, COMMISSARY_DOMAIN: "", COMMISSARY_APP_DOMAIN: "app.elsewhere.com" },
          "pr-12",
        ),
        "accepted",
      );
    }),
  );
});

describe("Managed OAuth settings (ADR 0045)", () => {
  const managed = { ...selfHosted, ACCESS_MANAGED_OAUTH: "true" };

  it.effect("are off by default, also when CI passes them empty", () =>
    Effect.gen(function* () {
      for (const variables of [
        selfHosted,
        {
          ...selfHosted,
          ACCESS_MANAGED_OAUTH: "",
          ACCESS_OAUTH_REDIRECT_URIS: "",
          ACCESS_OAUTH_LOOPBACK_CLIENTS: "",
        },
        { ...selfHosted, ACCESS_MANAGED_OAUTH: "false" },
      ])
        assert.isFalse((yield* read(variables, { stage: "prod" })).settings.managedOAuth.enabled);
    }),
  );

  it.effect(
    "default to the hosted clients' redirect URIs and loopback clients, also when CI passes them empty",
    () =>
      Effect.gen(function* () {
        for (const variables of [
          managed,
          { ...managed, ACCESS_OAUTH_REDIRECT_URIS: "", ACCESS_OAUTH_LOOPBACK_CLIENTS: "" },
          { ...managed, ACCESS_MANAGED_OAUTH: " TRUE " },
        ])
          assert.deepStrictEqual(
            (yield* read(variables, { stage: "prod" })).settings.managedOAuth,
            {
              enabled: true,
              redirectUris: [
                "https://claude.ai/api/mcp/auth_callback",
                "https://www.cursor.com/agents/mcp/oauth/callback",
              ],
              loopbackClients: true,
            },
          );
      }),
  );

  it.effect(
    "read the redirect URIs in place of the defaults, a client's own scheme among them, and loopback clients turned off",
    () =>
      Effect.gen(function* () {
        const { settings } = yield* read(
          {
            ...managed,
            ACCESS_OAUTH_REDIRECT_URIS: "https://chat.example.com/oauth/*, myclient://callback",
            ACCESS_OAUTH_LOOPBACK_CLIENTS: " FALSE ",
          },
          { stage: "prod" },
        );

        assert.deepStrictEqual(settings.managedOAuth, {
          enabled: true,
          redirectUris: ["https://chat.example.com/oauth/*", "myclient://callback"],
          loopbackClients: false,
        });
      }),
  );

  it.effect(
    "refuse an http, relative or content redirect URI and a setting other than true or false",
    () =>
      Effect.gen(function* () {
        for (const [variables, message] of [
          [
            { ACCESS_OAUTH_REDIRECT_URIS: "http://chat.example.com/cb" },
            'ACCESS_OAUTH_REDIRECT_URIS: "http://chat.example.com/cb" must be https',
          ],
          [
            { ACCESS_OAUTH_REDIRECT_URIS: "/callback" },
            'ACCESS_OAUTH_REDIRECT_URIS: "/callback" is not an absolute URL',
          ],
          [
            { ACCESS_OAUTH_REDIRECT_URIS: "javascript:alert(1)" },
            "must be https or a client's own scheme, not javascript:",
          ],
          [
            { ACCESS_OAUTH_REDIRECT_URIS: "data:text/html,hi" },
            "must be https or a client's own scheme, not data:",
          ],
          [
            { ACCESS_OAUTH_REDIRECT_URIS: "file:///etc/passwd" },
            "must be https or a client's own scheme, not file:",
          ],
          [
            { ACCESS_OAUTH_LOOPBACK_CLIENTS: "yes" },
            'ACCESS_OAUTH_LOOPBACK_CLIENTS must be true or false, not "yes"',
          ],
          [{ ACCESS_MANAGED_OAUTH: "on" }, 'ACCESS_MANAGED_OAUTH must be true or false, not "on"'],
        ] as const)
          assert.include(yield* refusal({ ...managed, ...variables }), message);
      }),
  );

  it.effect("refuse the redirect URIs and loopback clients while Managed OAuth is off", () =>
    Effect.gen(function* () {
      for (const variables of [
        { ACCESS_OAUTH_REDIRECT_URIS: "https://chat.example.com/cb" },
        { ACCESS_OAUTH_LOOPBACK_CLIENTS: "false" },
        { ACCESS_MANAGED_OAUTH: "false", ACCESS_OAUTH_LOOPBACK_CLIENTS: "true" },
      ])
        assert.include(
          yield* refusal({ ...selfHosted, ...variables }),
          "ACCESS_OAUTH_REDIRECT_URIS and ACCESS_OAUTH_LOOPBACK_CLIENTS apply to Managed OAuth: set ACCESS_MANAGED_OAUTH=true",
        );
    }),
  );

  it.effect("refuse them with an Access application managed outside the stack", () =>
    Effect.gen(function* () {
      const external = { ...selfHosted, ACCESS_AUD: "aud", ACCESS_ALLOW_EMAILS: "" };

      assert.strictEqual(yield* refusal(external), "accepted");

      for (const [variables, named] of [
        [{ ACCESS_MANAGED_OAUTH: "true" }, "ACCESS_MANAGED_OAUTH"],
        [
          { ACCESS_OAUTH_REDIRECT_URIS: "https://chat.example.com/cb" },
          "ACCESS_OAUTH_REDIRECT_URIS",
        ],
        [{ ACCESS_OAUTH_LOOPBACK_CLIENTS: "false" }, "ACCESS_OAUTH_LOOPBACK_CLIENTS"],
      ] as const)
        assert.include(
          yield* refusal({ ...external, ...variables }),
          `${named} need a stack-managed Access application`,
        );
    }),
  );

  it.effect("refuse them on Commissary Cloud, which has no Access application", () =>
    Effect.gen(function* () {
      const hosted = {
        COMMISSARY_MODE: "cloud",
        COMMISSARY_DOMAIN: "commissary.example.com",
        SIGN_IN_GITHUB_CLIENT_ID: "gh-id",
        SIGN_IN_GITHUB_CLIENT_SECRET: "gh-secret",
        TURNSTILE_SITE_KEY: "site",
        TURNSTILE_SECRET_KEY: "turnstile-secret",
      };

      assert.strictEqual(yield* refusal(hosted), "accepted");

      assert.include(
        yield* refusal({
          ...hosted,
          ACCESS_MANAGED_OAUTH: "true",
          ACCESS_OAUTH_LOOPBACK_CLIENTS: "false",
        }),
        "ACCESS_MANAGED_OAUTH, ACCESS_OAUTH_LOOPBACK_CLIENTS: Commissary Cloud has no Access application",
      );

      // Without the flag: the one refusal of Commissary Cloud, not also the one of Managed OAuth being off.
      const refused = yield* refusal({
        ...hosted,
        ACCESS_OAUTH_REDIRECT_URIS: "https://a.example/cb",
      });

      assert.include(
        refused,
        "ACCESS_OAUTH_REDIRECT_URIS: Commissary Cloud has no Access application",
      );
      assert.notInclude(refused, "apply to Managed OAuth");
    }),
  );
});

describe("the browser (COMMISSARY_BROWSER, ADR 0043)", () => {
  it.effect(
    "is on by default, also when CI passes the unset variable as empty, and off when set off",
    () =>
      Effect.gen(function* () {
        for (const variables of [{}, { COMMISSARY_BROWSER: "" }, { COMMISSARY_BROWSER: "on" }])
          assert.strictEqual((yield* read({ ...selfHosted, ...variables })).settings.browser, true);

        assert.strictEqual(
          (yield* read({ ...selfHosted, COMMISSARY_BROWSER: " off " })).settings.browser,
          false,
        );
      }),
  );

  it.effect("refuses any other value", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal({ ...selfHosted, COMMISSARY_BROWSER: "yes" }),
        'COMMISSARY_BROWSER must be on or off, not "yes"',
      );
    }),
  );
});

describe("the sandbox's computer (COMMISSARY_COMPUTER, #223)", () => {
  it.effect(
    "is off by default, also when CI passes the unset variable as empty, and on when set on",
    () =>
      Effect.gen(function* () {
        for (const variables of [{}, { COMMISSARY_COMPUTER: "" }, { COMMISSARY_COMPUTER: "off" }])
          assert.strictEqual(
            (yield* read({ ...selfHosted, ...variables })).settings.computer,
            false,
          );

        assert.strictEqual(
          (yield* read({ ...selfHosted, COMMISSARY_COMPUTER: " On " })).settings.computer,
          true,
        );
      }),
  );

  it.effect("runs on standard-1 unless another of Cloudflare's sizes is named", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* read(selfHosted)).settings.computerInstance, "standard-1");
      assert.strictEqual(
        (yield* read({ ...selfHosted, COMMISSARY_COMPUTER_INSTANCE: "standard-2" })).settings
          .computerInstance,
        "standard-2",
      );
    }),
  );

  it.effect("refuses any other value", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal({ ...selfHosted, COMMISSARY_COMPUTER: "yes" }),
        'COMMISSARY_COMPUTER must be on or off, not "yes"',
      );
      assert.include(
        yield* refusal({ ...selfHosted, COMMISSARY_COMPUTER_INSTANCE: "huge" }),
        'COMMISSARY_COMPUTER_INSTANCE must be one of lite, basic, standard-1, standard-2, standard-3, standard-4, not "huge"',
      );
    }),
  );
});

describe("the browser's crawls (BROWSER_RUN_API_TOKEN, #270)", () => {
  const prod = { stage: "prod" };

  it.effect("are off without the token, also when CI passes the unset secret as empty", () =>
    Effect.gen(function* () {
      for (const variables of [{}, { BROWSER_RUN_API_TOKEN: "", BROWSER_RUN_ACCOUNT_ID: "" }]) {
        const { settings } = yield* read({ ...selfHosted, ...variables }, prod);

        assert.strictEqual(settings.browserCrawls, undefined);
      }
    }),
  );

  it.effect("take the token and its account, by default the deploy's (CLOUDFLARE_ACCOUNT_ID)", () =>
    Effect.gen(function* () {
      const own = yield* read(
        { ...selfHosted, BROWSER_RUN_API_TOKEN: " token ", CLOUDFLARE_ACCOUNT_ID: "acct" },
        prod,
      );

      assert.strictEqual(own.settings.browserCrawls?.accountId, "acct");
      assert.strictEqual(
        Redacted.value(own.settings.browserCrawls?.apiToken ?? Redacted.make("")),
        "token",
      );

      const other = yield* read(
        {
          ...selfHosted,
          BROWSER_RUN_API_TOKEN: "token",
          BROWSER_RUN_ACCOUNT_ID: " crawls ",
          CLOUDFLARE_ACCOUNT_ID: "acct",
        },
        prod,
      );

      assert.strictEqual(other.settings.browserCrawls?.accountId, "crawls");
    }),
  );

  it.effect(
    "cap a crawl at 1000 pages, or at COMMISSARY_CRAWL_MAX_PAGES up to Browser Run's 100000",
    () =>
      Effect.gen(function* () {
        const crawls = {
          ...selfHosted,
          BROWSER_RUN_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "acct",
        };

        for (const [value, pages] of [
          [undefined, 1000],
          ["", 1000],
          [" 50 ", 50],
          ["100000", 100_000],
        ] as const) {
          const { settings } = yield* read(
            value === undefined ? crawls : { ...crawls, COMMISSARY_CRAWL_MAX_PAGES: value },
            prod,
          );

          assert.strictEqual(settings.browserCrawls?.maxPages, pages);
        }

        for (const value of ["0", "100001", "1.5", "many"])
          assert.include(
            yield* refusal({ ...crawls, COMMISSARY_CRAWL_MAX_PAGES: value }),
            "COMMISSARY_CRAWL_MAX_PAGES must be a whole number from 1 to 100000",
          );

        // Without the token there are no crawls to cap, and the setting is not read.
        assert.strictEqual(
          (yield* read({ ...selfHosted, COMMISSARY_CRAWL_MAX_PAGES: "0" }, prod)).settings
            .browserCrawls,
          undefined,
        );
      }),
  );

  it.effect(
    "are off under alchemy dev, and off with a warning when the deploy has no browser",
    () =>
      Effect.gen(function* () {
        const crawls = { BROWSER_RUN_API_TOKEN: "token", CLOUDFLARE_ACCOUNT_ID: "acct" };

        assert.strictEqual((yield* read({ ...crawls })).settings.browserCrawls, undefined);

        const off = yield* read({ ...selfHosted, ...crawls, COMMISSARY_BROWSER: "off" }, prod);

        assert.strictEqual(off.settings.browserCrawls, undefined);
        assert.deepStrictEqual(off.warnings, [
          "BROWSER_RUN_API_TOKEN is ignored with COMMISSARY_BROWSER=off: there is no browser toolkit to crawl with",
        ]);
      }),
  );

  it.effect("refuse a token without the account it is of", () =>
    Effect.gen(function* () {
      assert.include(
        yield* refusal({ ...selfHosted, BROWSER_RUN_API_TOKEN: "token" }),
        "BROWSER_RUN_API_TOKEN needs the account it is of: BROWSER_RUN_ACCOUNT_ID, or CLOUDFLARE_ACCOUNT_ID",
      );
    }),
  );
});
