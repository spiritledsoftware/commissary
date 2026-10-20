// Page routes (code-based, no generator). The Worker answers every one of these paths with index.html
// (apps/app/src/management/zones.ts `PANEL_SECTIONS`); add a section there when adding a top-level page here.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "./components/Shell.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { AccountsPage } from "./pages/Accounts.tsx";
import { ApprovalPage } from "./pages/Approval.tsx";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { AuthorizePage } from "./pages/Authorize.tsx";
import { ConnectPage } from "./pages/Connect.tsx";
import { GrantsPage } from "./pages/Grants.tsx";
import { KeyGroupPage, NewKeyGroupPage, OwnKeyGroupPage } from "./pages/KeyGroup.tsx";
import { KeysPage } from "./pages/Keys.tsx";
import { LimitsPage } from "./pages/Limits.tsx";
import { ManagementKeysPage } from "./pages/ManagementKeys.tsx";
import { MembersPage } from "./pages/Members.tsx";
import { ModelRulesPage } from "./pages/ModelRules.tsx";
import { ModelsPage } from "./pages/Models.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { MyModelsPage } from "./pages/MyModels.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { PricesPage } from "./pages/Prices.tsx";
import { ApiKeysPage } from "./pages/ApiKeys.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SsoPage } from "./pages/Sso.tsx";
import { UsagePage } from "./pages/Usage.tsx";
import { readNewKeySearch } from "./lib/keys.ts";
import { legacyHashTarget } from "./lib/legacy-hash.ts";
import { panelBasepath } from "./lib/org.ts";
import { readPricesSearch } from "./lib/prices.ts";
import { readUsageSearch } from "./lib/usage.ts";

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts", component: AccountsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/accounts/connect",
    component: ConnectPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/accounts/$authIndex",
    component: AccountPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/keys", component: KeysPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/keys/new",
    validateSearch: readNewKeySearch,
    component: NewKeyGroupPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/keys/$family/$index",
    component: KeyGroupPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/keys/private/$family/$index",
    component: OwnKeyGroupPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/models", component: ModelsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/models/rules",
    component: ModelRulesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage",
    validateSearch: readUsageSearch,
    component: UsagePage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage/prices",
    validateSearch: readPricesSearch,
    component: PricesPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/members", component: MembersPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/grants", component: GrantsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/my-models", component: MyModelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/api-keys", component: ApiKeysPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/limits", component: LimitsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/approvals", component: ApprovalsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals/$approvalId",
    component: ApprovalPage,
  }),
  // Commissary Cloud's consent page of an MCP client's sign-in (#200); the Worker serves it there only.
  createRoute({ getParentRoute: () => rootRoute, path: "/authorize", component: AuthorizePage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/management-keys",
    component: ManagementKeysPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/settings/sso", component: SsoPage }),
]);

// The panel of an org lives under `/o/<slug>` (the router's base path), so its pages keep the paths above.
const basepath = panelBasepath(window.location.pathname);

// An upstream panel bookmark (`/management.html#/auth-files`, redirected to `/#/auth-files`) opens the page that
// replaced it, in the org the Worker redirected `/` to. Before the router reads the location.
const atRoot = ["/", `${basepath}/`, basepath].includes(window.location.pathname);

const legacyTarget = atRoot ? legacyHashTarget(window.location.hash) : undefined;

if (legacyTarget !== undefined)
  window.history.replaceState(null, "", `${basepath === "/" ? "" : basepath}${legacyTarget}`);

export const router = createRouter({
  routeTree,
  basepath,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
