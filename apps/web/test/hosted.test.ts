import { describe, expect, it } from "vitest";
import {
  atOrgLimit,
  billingProblem,
  canCreateOrg,
  canSuspend,
  ceilingHint,
  ceilingText,
  emailProblem,
  hasBrowser,
  orgCountText,
  parseCeiling,
  parseOrgLimit,
  planLabel,
} from "../src/lib/hosted.ts";
import { issuableRoles, issuerText } from "../src/lib/management-keys.ts";
import { callerOf } from "../src/lib/role.ts";

const SELF_HOSTED = { hosted: false, browser: false, computer: false, agents: false };

const HOSTED = { hosted: true, browser: false, computer: false, agents: false };

describe("the browser (ADR 0043)", () => {
  it("is on the panel only where the deployment has the browser toolkit", () => {
    const deployment = { hosted: false, computer: false, agents: false };

    expect(hasBrowser({ deployment: { ...deployment, browser: true } })).toBe(true);
    expect(hasBrowser({ deployment: { ...deployment, browser: false } })).toBe(false);
  });
});

describe("creating orgs", () => {
  it("is for platform admins, and for everyone on Commissary Cloud", () => {
    expect(canCreateOrg({ platform_admin: false, deployment: SELF_HOSTED })).toBe(false);
    expect(canCreateOrg({ platform_admin: true, deployment: SELF_HOSTED })).toBe(true);
    expect(canCreateOrg({ platform_admin: false, deployment: HOSTED })).toBe(true);
  });

  it("counts against the limit, except for platform admins", () => {
    const me = { platform_admin: false, deployment: HOSTED, org_limit: 3, owned_orgs: 3 };

    expect(atOrgLimit(me)).toBe(true);
    expect(atOrgLimit({ ...me, owned_orgs: 2 })).toBe(false);
    expect(atOrgLimit({ platform_admin: true, deployment: HOSTED })).toBe(false);
    expect(orgCountText(me)).toBe("3 of 3 orgs");
    expect(orgCountText({ platform_admin: true, deployment: HOSTED })).toBeUndefined();
  });

  it("suspends only for platform admins of Commissary Cloud", () => {
    expect(canSuspend({ platform_admin: true, deployment: HOSTED })).toBe(true);
    expect(canSuspend({ platform_admin: true, deployment: SELF_HOSTED })).toBe(false);
    expect(canSuspend({ platform_admin: false, deployment: HOSTED })).toBe(false);
  });
});

describe("people", () => {
  it("reads an org limit", () => {
    expect(parseOrgLimit("default")).toEqual({ kind: "default" });
    expect(parseOrgLimit("")).toEqual({ kind: "default" });
    expect(parseOrgLimit(" 5 ")).toEqual({ kind: "limit", value: 5 });
    expect(parseOrgLimit("0")).toEqual({ kind: "limit", value: 0 });
    expect(parseOrgLimit("1001")).toEqual({ kind: "invalid" });
    expect(parseOrgLimit("-1")).toEqual({ kind: "invalid" });
    expect(parseOrgLimit("2.5")).toEqual({ kind: "invalid" });
  });

  it("checks an email", () => {
    expect(emailProblem("a@b.co")).toBeUndefined();
    expect(emailProblem("nope")).toBeDefined();
  });
});

describe("org billing", () => {
  it("names the plan, and an unbilled org as such", () => {
    expect(planLabel({ plan: "free", unbilled: false })).toBe("Free");
    expect(planLabel({ plan: "payg", unbilled: false })).toBe("Pay as you go");
    expect(planLabel({ plan: "payg", unbilled: true })).toBe("Pay as you go, unbilled");
  });

  it("reads a raised ceiling: a whole number from 1 to 1,000,000, or empty or “plan” for the plan's", () => {
    expect(parseCeiling("")).toEqual({ kind: "plan" });
    expect(parseCeiling(" Plan ")).toEqual({ kind: "plan" });
    expect(parseCeiling("1200")).toEqual({ kind: "raised", value: 1200 });
    expect(parseCeiling("1000000")).toEqual({ kind: "raised", value: 1_000_000 });

    for (const text of ["0", "-1", "1.5", "1000001", "lots"])
      expect(parseCeiling(text)).toEqual({ kind: "invalid" });
  });

  it("shows a ceiling with what the plan gives when a platform admin raised it", () => {
    expect(ceilingText({ plan: 600, raised: null })).toBe("600 (the plan’s)");
    expect(ceilingText({ plan: 600, raised: 1200 })).toBe("1,200 (plan: 600)");
    // A raise at or below the plan's changes nothing.
    expect(ceilingText({ plan: 600, raised: 100 })).toBe("600 (plan: 600; raised to 100)");
  });

  it("tells what the ceilings form takes", () => {
    expect(ceilingHint()).toBe(
      "Raise a ceiling above the plan’s for this org: a whole number up to 1,000,000. Leave it empty for the plan’s.",
    );
  });

  it("explains a refused billing write", () => {
    expect(billingProblem("invalid_ceiling", "422")).toBe(
      "A ceiling is a whole number from 1 to 1,000,000, or empty for the plan’s.",
    );
    expect(billingProblem("platform_admin_required", "403")).toBe(
      "Only platform admins change an org’s billing.",
    );
    expect(billingProblem(undefined, "Failed")).toBe("Failed");
  });
});

describe("management keys", () => {
  it("offers the roles up to the caller's", () => {
    expect(issuableRoles(callerOf({ role: "admin", platform_admin: false }))).toEqual([
      "member",
      "admin",
    ]);
    expect(issuableRoles(callerOf({ role: "owner", platform_admin: false }))).toEqual([
      "member",
      "admin",
      "owner",
    ]);
  });

  it("names a service token issuer", () => {
    expect(issuerText({ created_by: "service:abc" })).toBe("Service token abc");
    expect(issuerText({ created_by: "a@b.co" })).toBe("a@b.co");
  });
});
