import "@fontsource-variable/atkinson-hyperlegible-next";
import "./styles/tokens.css";
import "./styles/base.css";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { panelOrgSlug } from "./api/client.ts";
import { SIGN_IN_PAGE_PATH } from "@commissary/contract/sign-in";
import { AuthorizeOrgChooser } from "./pages/Authorize.tsx";
import { OrgsPage } from "./pages/Orgs.tsx";
import { PeoplePage } from "./pages/People.tsx";
import { SignInPage } from "./pages/SignIn.tsx";
import { router } from "./router.tsx";

const root = document.getElementById("root");

/**
 * The pages that are not an org's: sign-in (before anyone is signed in), people, the chooser, and the org chooser of an
 * MCP client's sign-in (`/authorize`, #200).
 */
const outsideOrg = () => {
  const path = window.location.pathname.replace(/\/+$/, "");

  if (path === SIGN_IN_PAGE_PATH) return <SignInPage />;

  if (path === "/authorize") return <AuthorizeOrgChooser />;

  return path === "/people" ? <PeoplePage /> : <OrgsPage />;
};

if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      {/* An address without an org (`/`, `/?choose`) is the chooser; an org's pages live under `/o/<slug>`. */}
      {panelOrgSlug === undefined ? outsideOrg() : <RouterProvider router={router} />}
    </RegistryProvider>
  </StrictMode>,
);
