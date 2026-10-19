// What Commissary Cloud (ADR 0026) adds to the panel: who may create orgs and how many, how a refused create reads, and
// the platform admin's people page (an owned-org limit and suspension). Pure: no DOM, tested in test/hosted.test.ts.
import type { Me } from "@commissary/contract/orgs";
import { asSentence } from "./failure.ts";

type Hosting = Pick<Me, "platform_admin" | "deployment" | "org_limit" | "owned_orgs">;

/** Anyone signed in creates orgs on Commissary Cloud; on a self-hosted one only platform admins do. */
export const canCreateOrg = (me: Hosting): boolean => me.platform_admin || me.deployment.hosted;

/** A platform admin has no limit (the server sends neither number then). */
export const atOrgLimit = (me: Hosting): boolean =>
  !me.platform_admin &&
  me.org_limit !== undefined &&
  me.owned_orgs !== undefined &&
  me.owned_orgs >= me.org_limit;

/** "2 of 3 orgs", where the server sent both numbers. */
export const orgCountText = (me: Hosting): string | undefined =>
  me.org_limit === undefined || me.owned_orgs === undefined
    ? undefined
    : `${me.owned_orgs} of ${me.org_limit} ${me.org_limit === 1 ? "org" : "orgs"}`;

/** Why creating is closed at the limit. */
export const orgLimitNote = (me: Hosting): string =>
  `You own ${orgCountText(me) ?? "as many orgs as you may"}. Ask a platform admin to raise your limit.`;

/** Platform admins suspend and unsuspend orgs and people on Commissary Cloud only. */
export const canSuspend = (me: Pick<Me, "platform_admin" | "deployment">): boolean =>
  me.platform_admin && me.deployment.hosted;

/** What a refused org write says, by the server's error code. */
export const orgProblem = (error: string | undefined, message: string, detail?: string): string => {
  switch (error) {
    case "org_limit_reached":
      return "You own as many orgs as you may. Ask a platform admin to raise your limit.";
    case "slug_taken":
      return "That address is taken. Pick another.";
    case "invalid_slug":
      return "An address is lowercase letters, digits and hyphens.";
    case "org_not_found":
      return "That org no longer exists. Reload to see the current list.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};

// ---------------------------------------------------------------------------------------------------------------
// People

/** The most orgs a platform admin may allow one person. */
export const ORG_LIMIT_MAX = 1000;

export type LimitInput =
  | { readonly kind: "default" }
  | { readonly kind: "limit"; readonly value: number }
  | { readonly kind: "invalid" };

/** A typed org limit: a whole number from 0 to 1000, or "default" (or nothing) for the deployment's default. */
export const parseOrgLimit = (text: string): LimitInput => {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === "" || trimmed === "default") return { kind: "default" };

  if (!/^\d+$/.test(trimmed)) return { kind: "invalid" };
  const value = Number(trimmed);

  return value > ORG_LIMIT_MAX ? { kind: "invalid" } : { kind: "limit", value };
};

/** What is wrong with a typed email to look up, or `undefined`. */
export const emailProblem = (text: string): string | undefined => {
  const email = text.trim();

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? undefined
    : "Type the person’s whole email address.";
};

/** What a refused people write says, by the server's error code. */
export const personProblem = (
  error: string | undefined,
  message: string,
  detail?: string,
): string => {
  switch (error) {
    case "invalid_email":
      return "That is not an email address.";
    case "invalid_org_limit":
      return `An org limit is a whole number from 0 to ${ORG_LIMIT_MAX}, or “default”.`;
    case "platform_admin_required":
      return "Only platform admins manage people.";
    default:
      return detail === undefined ? message : asSentence(detail);
  }
};
