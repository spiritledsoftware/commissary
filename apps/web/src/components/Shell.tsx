// The page frame: the shell bar (name and host, the org switcher, Refresh, the theme and account menus) over the
// sidebar (the page links; a drawer on narrow screens) beside the page. Connecting an account starts on Accounts.
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { credentialsAtom, meAtom, usageEpochAtom, usageLastDayAtom } from "../api/client.ts";
import { NotAllowed } from "../pages/NotAllowed.tsx";
import { changesBilling, seesBilling } from "../lib/billing.ts";
import { canManageMembers, homeFor, pageAllowed, pageGroupsFor } from "../lib/role.ts";
import { type RoleState, useRole } from "../lib/use-role.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { Problem } from "./Kit.tsx";
import { OrgSwitcher } from "./OrgSwitcher.tsx";
import { PlanNotices } from "./PlanNotices.tsx";
import styles from "./Shell.module.css";
import { Sidebar, SidebarDrawer } from "./Sidebar.tsx";
import { ThemeMenu } from "./ThemeMenu.tsx";

const RefreshIcon = ({
  busy,
  onRefresh,
}: {
  readonly busy: boolean;
  readonly onRefresh: () => void;
}) => (
  <button
    type="button"
    className={styles["refresh"]}
    aria-label="Refresh"
    title="Refresh"
    aria-busy={busy}
    onClick={onRefresh}
  >
    <RefreshCw
      aria-hidden="true"
      size={18}
      strokeWidth={2.25}
      className={busy ? styles["spinning"] : undefined}
    />
  </button>
);

/** A plain member's Refresh: their usage only (they may not read the accounts). */
const UsageRefresh = () => {
  const usage = useAtomValue(usageLastDayAtom);
  const bumpUsage = useAtomSet(usageEpochAtom);

  return <RefreshIcon busy={usage.waiting} onRefresh={() => bumpUsage((epoch) => epoch + 1)} />;
};

/** An org admin's Refresh: the accounts and the usage. */
const OrgAdminRefresh = () => {
  const credentials = useAtomValue(credentialsAtom);
  const usage = useAtomValue(usageLastDayAtom);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const bumpUsage = useAtomSet(usageEpochAtom);

  return (
    <RefreshIcon
      busy={credentials.waiting || usage.waiting}
      onRefresh={() => {
        refreshCredentials();
        bumpUsage((epoch) => epoch + 1);
      }}
    />
  );
};

/** The page, once the caller's role is known and opens it; otherwise what is going on instead. */
const Gate = ({ role }: { readonly role: RoleState }) => {
  const pathname = useLocation({ select: (location) => location.pathname });

  switch (role.kind) {
    case "loading":
      return (
        <p aria-busy="true" className={styles["gate"]}>
          Loading…
        </p>
      );
    case "failed":
      return (
        <div className={styles["gate"]}>
          <Problem onRetry={role.retry}>Could not check your access to this org.</Problem>
        </div>
      );
    case "ready":
      // A plain member's home is Usage.
      if (
        pathname === "/" &&
        !pageAllowed(role.caller.role, pathname, role.caller.privateCredentials)
      )
        return <Navigate to={homeFor(role.caller.role)} replace />;

      return pageAllowed(role.caller.role, pathname, role.caller.privateCredentials) ? (
        <Outlet />
      ) : (
        <NotAllowed home={homeFor(role.caller.role)} />
      );
  }
};

export const Shell = () => {
  const role = useRole();
  const me = useAtomValue(meAtom);
  // Commissary Cloud adds pages (Single sign-on, Billing), the plan notices and the account menu's Sign out.
  const hosted = AsyncResult.isSuccess(me) && me.value.deployment.hosted;

  const groups =
    role.kind === "ready"
      ? pageGroupsFor(role.caller.role, role.caller.privateCredentials, hosted)
      : [];

  const admin = role.kind === "ready" && canManageMembers(role.caller);
  // Commissary Cloud's plan notices, over every page for the org's owners and admins (ADR 0042).
  const showsPlanNotices = role.kind === "ready" && seesBilling(hosted, role.caller);

  return (
    <>
      <a className={styles["skip"]} href="#main">
        Skip to content
      </a>
      <header className={styles["bar"]}>
        <div className={styles["inner"]}>
          <SidebarDrawer groups={groups} />
          <Link
            to={role.kind === "ready" ? homeFor(role.caller.role) : "/"}
            className={styles["brand"]}
          >
            <span className={styles["name"]}>Commissary</span>
            <span className={styles["host"]} title={window.location.host}>
              {window.location.host}
            </span>
          </Link>
          <OrgSwitcher />
          <div className={styles["actions"]}>
            {role.kind === "ready" ? admin ? <OrgAdminRefresh /> : <UsageRefresh /> : null}
            <ThemeMenu />
            <AccountMenu hosted={hosted} offersDelete={role.kind === "ready"} />
          </div>
        </div>
      </header>
      <div className={styles["frame"]}>
        <Sidebar groups={groups} />
        <main id="main" tabIndex={-1} className={styles["main"]}>
          {showsPlanNotices ? <PlanNotices owner={changesBilling(role.caller)} /> : null}
          <Gate role={role} />
        </main>
      </div>
    </>
  );
};
