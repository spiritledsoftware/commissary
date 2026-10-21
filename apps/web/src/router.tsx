// Page routes (code-based, no generator). The Worker answers every one of these paths with index.html
// (apps/app/src/management/zones.ts `PANEL_SECTIONS`); add a section there when adding a top-level page here.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "./components/Shell.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { AgentNewPage } from "./pages/AgentNew.tsx";
import { AgentPage } from "./pages/Agent.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { AccountsPage } from "./pages/Accounts.tsx";
import { ApprovalPage } from "./pages/Approval.tsx";
import { ApprovalsPage } from "./pages/Approvals.tsx";
import { BillingPage } from "./pages/Billing.tsx";
import { BrowserProfilesPage } from "./pages/BrowserProfiles.tsx";
import { BrowserSessionPage, BrowserSessionsPage } from "./pages/BrowserSessions.tsx";
import { AuthorizePage } from "./pages/Authorize.tsx";
import { ConnectPage } from "./pages/Connect.tsx";
import { GrantsPage } from "./pages/Grants.tsx";
import { KeyGroupPage, NewKeyGroupPage, OwnKeyGroupPage } from "./pages/KeyGroup.tsx";
import { KeysPage } from "./pages/Keys.tsx";
import { LimitsPage } from "./pages/Limits.tsx";
import { ManagementKeysPage } from "./pages/ManagementKeys.tsx";
import { McpEndpointPage } from "./pages/McpEndpoint.tsx";
import { MembersPage } from "./pages/Members.tsx";
import { ModelRulesPage } from "./pages/ModelRules.tsx";
import { ModelsPage } from "./pages/Models.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { MyModelsPage } from "./pages/MyModels.tsx";
import { MyToolsPage } from "./pages/MyTools.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { PricesPage } from "./pages/Prices.tsx";
import { ApiKeysPage } from "./pages/ApiKeys.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SsoPage } from "./pages/Sso.tsx";
import { ToolkitPage } from "./pages/Toolkit.tsx";
import { ToolkitAddPage } from "./pages/ToolkitAdd.tsx";
import { ToolkitConnectPage } from "./pages/ToolkitConnect.tsx";
import { ToolsPage } from "./pages/Tools.tsx";
import { UsagePage } from "./pages/Usage.tsx";
import { readGrantsSearch } from "./lib/grants.ts";
import { readNewKeySearch } from "./lib/keys.ts";
import { AGENTS_PAGE, BILLING_PAGE, TOOLS_PAGE } from "./lib/role.ts";
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
  // Tools (#208): the toolkits, adding one, the endpoint URL builder, a toolkit's page, and the connect page a tool call
  // that needs the caller's own credential links to (`/tools/<toolkit id>/connect`).
  createRoute({ getParentRoute: () => rootRoute, path: TOOLS_PAGE, component: ToolsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/tools/add", component: ToolkitAddPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/endpoint",
    component: McpEndpointPage,
  }),
  // The browser toolkit's Browser sessions pages (#216), where the deployment has it: the list and each session's
  // page, the link a handoff answers (`/tools/sessions/<session id>`).
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/sessions",
    component: BrowserSessionsPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/sessions/$sessionId",
    component: BrowserSessionPage,
  }),
  // The browser toolkit's Browser profiles page (#217), where the deployment has it.
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/profiles",
    component: BrowserProfilesPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/$toolkitId",
    component: ToolkitPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/tools/$toolkitId/connect",
    component: ToolkitConnectPage,
  }),
  // Agents (#233): the agents, creating one, and an agent's page with its triggers (`deployment.agents` only).
  createRoute({ getParentRoute: () => rootRoute, path: AGENTS_PAGE, component: AgentsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/agents/new", component: AgentNewPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/agents/$agentId",
    component: AgentPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/members", component: MembersPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/grants",
    validateSearch: readGrantsSearch,
    component: GrantsPage,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: "/my-models", component: MyModelsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/my-tools", component: MyToolsPage }),
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
  // Commissary Cloud's billing of the org (ADR 0042); the page answers Not found on a self-hosted Commissary.
  createRoute({ getParentRoute: () => rootRoute, path: BILLING_PAGE, component: BillingPage }),
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
