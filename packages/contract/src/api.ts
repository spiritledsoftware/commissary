/**
 * The management API contract (`@commissary/contract`) shared by the Worker, its tests and the control panel
 * (`apps/web`): endpoint paths, query schemas, response and error bodies of the `/v9/management` routes the panel uses.
 * The handlers themselves stay plain router handlers (`apps/app/src/management/routes.ts` and Models' in
 * `packages/models/src/management/routes.ts`);
 * `apps/app/test/management-contract.test.ts` checks their real responses against these schemas through the generated
 * client.
 *
 * Browser-safe: its modules import `effect` and each other only.
 */
import { HttpApi } from "effect/http-api";
import { BillingGroup } from "./billing.ts";
import { ProviderKeysGroup } from "./provider-keys.ts";
import { CatalogGroup } from "./catalog.ts";
import { CredentialsGroup } from "./credentials.ts";
import { GrantsGroup } from "./grants.ts";
import { MembersGroup } from "./members.ts";
import { OAuthGroup } from "./oauth.ts";
import { ManagementKeysGroup } from "./management-keys.ts";
import { OrgsGroup } from "./orgs.ts";
import { PeopleGroup } from "./people.ts";
import { PricesGroup } from "./prices.ts";
import { ApiKeysGroup } from "./api-keys.ts";
import { RoutingGroup } from "./routing.ts";
import { SettingsGroup } from "./settings.ts";
import { SpendGroup } from "./spend.ts";
import { SsoGroup } from "./sso.ts";
import { UsageGroupApi } from "./usage.ts";

export const MANAGEMENT_API_PREFIX = "/v9/management";

export class ManagementApi extends HttpApi.make("management")
  .add(CredentialsGroup)
  .add(UsageGroupApi)
  .add(OAuthGroup)
  .add(ProviderKeysGroup)
  .add(RoutingGroup)
  .add(CatalogGroup)
  .add(SettingsGroup)
  .add(OrgsGroup)
  .add(PricesGroup)
  .add(MembersGroup)
  .add(ApiKeysGroup)
  .add(GrantsGroup)
  .add(SpendGroup)
  .add(PeopleGroup)
  .add(ManagementKeysGroup)
  .add(SsoGroup)
  .add(BillingGroup)
  .prefix(MANAGEMENT_API_PREFIX) {}

// Below the prefix `/orgs...` is platform-level and every other route exists per org; `/me` is not platform-level:
// addressed to an org it answers the caller's role in that org.
const isPlatformLevel = (rest: string): boolean => /^\/orgs(?=[/?#]|$)/.test(rest);

/**
 * `url` (an absolute URL or a path of the management API) addressed to the org `slug`: `/v9/management/credentials`
 * becomes `/v9/management/orgs/acme/credentials`.
 * `/me` is scoped too (it then answers the caller's role in the org). The platform-level routes (`/orgs`,
 * `/orgs/:slug`) and any other URL stay as they are. The panel's client addresses its org this way.
 */
export const scopedApiUrl = (url: string, slug: string | undefined): string => {
  if (slug === undefined) return url;

  const at = url.indexOf(`${MANAGEMENT_API_PREFIX}/`);

  if (at < 0) return url;

  const split = at + MANAGEMENT_API_PREFIX.length;

  if (isPlatformLevel(url.slice(split))) return url;

  return `${url.slice(0, split)}/orgs/${encodeURIComponent(slug)}${url.slice(split)}`;
};
