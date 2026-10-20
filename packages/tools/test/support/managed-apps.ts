// Commissary Cloud's managed OAuth apps as the test Worker's `CloudControlPlane` has them (#207): toolkit catalog
// additions with one managed app, for the catalog service `acme`, whose secret its env binds, as `COMMISSARY_MODE=cloud`
// and a `TOOLKIT_OAUTH_ACME` binding would on a deployment. Its authorization server is a fake at a fixed origin.
import { additionsOf } from "../../src/catalog/additions.ts";
import { managedAppsOf } from "../../src/catalog/managed-apps.ts";

/** Where the managed app's fake authorization server answers. */
export const MANAGED_AUTH_ORIGIN = "https://auth.managed-acme.example.com";

export const MANAGED_CLIENT_ID = "commissary-cloud-acme";

export const MANAGED_CLIENT_SECRET = "managed-acme-secret";

export const managedAdditions = additionsOf({
  featured: [],
  services: [],
  corrections: [],
  managed_apps: {
    acme: {
      client_id: MANAGED_CLIENT_ID,
      authorize_url: `${MANAGED_AUTH_ORIGIN}/authorize`,
      token_url: `${MANAGED_AUTH_ORIGIN}/token`,
      scopes: ["read"],
      secret: "TOOLKIT_OAUTH_ACME",
    },
    // A managed app whose secret the deployment does not bind: unavailable.
    unbound: {
      client_id: "commissary-cloud-unbound",
      authorize_url: `${MANAGED_AUTH_ORIGIN}/authorize`,
      token_url: `${MANAGED_AUTH_ORIGIN}/token`,
      secret: "TOOLKIT_OAUTH_UNBOUND",
    },
  },
  tool_overrides: {},
});

/** A Commissary Cloud deployment's env that binds the `acme` app's secret. */
const cloudEnv = { COMMISSARY_MODE: "cloud", TOOLKIT_OAUTH_ACME: MANAGED_CLIENT_SECRET };

/** The managed apps of {@link cloudEnv}. */
export const cloudManagedApps = managedAppsOf(cloudEnv, managedAdditions);
