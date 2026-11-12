// Shared and private credentials in selection: a private credential is a candidate only for its owner's requests.
import { describe, expect, it } from "vite-plus/test";
import { planRetry } from "../../src/credentials/selection/retry.ts";
import { ALLOW_ALL } from "../../src/grants/reach.ts";
import { Harness, NOW, cred, defaultSettings, entry } from "../support/credentials.ts";

const pool = () => [
  entry(cred("shared-a")),
  entry(cred("mine", { owner: "member-1" })),
  entry(cred("theirs", { owner: "member-2" })),
];

describe("selection of private credentials", () => {
  it("serves a private credential only to its owner (and shared ones to everyone)", () => {
    const h = new Harness({ ...defaultSettings, strategy: "fill-first" });
    const entries = pool();

    expect(h.ids(entries, 2, { memberId: "member-1" })).toEqual(["mine", "mine"]);
    expect(h.ids(entries, 2, { memberId: "member-2" })).toEqual(["shared-a", "shared-a"]);
  });

  it("round-robins over shared plus own credentials only", () => {
    const h = new Harness();
    const picked = new Set(h.ids(pool(), 6, { memberId: "member-2" }));

    expect([...picked].toSorted()).toEqual(["shared-a", "theirs"]);
  });

  it("never gives a private credential to a request without a member (service token, anonymous)", () => {
    const h = new Harness();
    const picked = new Set(h.ids(pool(), 6));

    expect([...picked]).toEqual(["shared-a"]);
  });

  it("finds nothing when the only credential is another member's", () => {
    const h = new Harness();
    const entries = [entry(cred("theirs", { owner: "member-2" }))];

    expect(h.id(entries, { memberId: "member-1" })).toBe("failure:auth_not_found");
    expect(h.id(entries)).toBe("failure:auth_not_found");
  });

  it("does not let a pinned id reach another member's credential", () => {
    const h = new Harness();

    expect(h.id(pool(), { memberId: "member-1", pinnedAuthId: "theirs" })).toBe(
      "failure:auth_not_found",
    );
  });
});

describe("retry planning with private credentials", () => {
  const query = {
    providers: ["gemini"],
    model: "model",
    round: 0,
    requestRetry: 3,
    status: 503,
    maxWaitMs: 0,
  };

  const plan = (memberId: string | undefined) =>
    planRetry({
      credentials: [entry(cred("theirs", { owner: "member-2" }))],
      query: { ...query, ...(memberId === undefined ? {} : { memberId }) },
      routing: { ...defaultSettings, knownPrefixes: new Set() },
      reach: ALLOW_ALL,
      coolingDisabled: () => false,
      now: NOW,
    });

  it("counts a private credential only for its owner", () => {
    expect(plan("member-2")).toEqual({ retry: true, waitMs: 0 });
    expect(plan("member-1")).toEqual({ retry: false });
    expect(plan(undefined)).toEqual({ retry: false });
  });
});
