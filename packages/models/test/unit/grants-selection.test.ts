// Grants in selection (ADR 0023): a member's reach leaves out the shared credentials and upstream models they have no
// grant for before priority tiers, strategy and session affinity look at the candidates. Everything that cannot be
// reached answers like an unknown model.
import { describe, expect, it } from "vite-plus/test";
import { planRetry } from "../../src/credentials/selection/retry.ts";
import { ALL_MODELS } from "../../src/grants/grant.ts";
import {
  Harness,
  NOW,
  cooling,
  cred,
  defaultSettings,
  entry,
  state,
} from "../support/credentials.ts";
import {
  allCredentials,
  reachFor,
  credential,
  everyone,
  grant,
  member,
  provider,
  team,
} from "../support/grants.ts";

const SONNET = "claude-sonnet-4-5";

const OPUS = "claude-opus-4-1";

const claude = (id: string, overrides: Parameters<typeof cred>[1] = {}) =>
  cred(id, { provider: "claude", ...overrides });

const harness = (settings = defaultSettings) => {
  const h = new Harness(settings);

  return h;
};

const as = (
  h: Harness,
  holder: Parameters<typeof reachFor>[1],
  ...grants: Parameters<typeof reachFor>[0]
) => {
  h.reach = reachFor(grants, holder);

  return h;
};

const ask = (model: string, extra = {}) => ({ providers: ["claude"], model, ...extra });

describe("a grant for one credential", () => {
  const subscriptionA = entry(claude("sub-a"));
  const alice = { member: "alice", teams: [] };
  const sonnetOnA = grant(member("alice"), credential("sub-a"), ["claude-sonnet-*"]);

  it("serves Sonnet on subscription A and refuses Opus there", () => {
    const h = as(harness(), alice, sonnetOnA);

    expect(h.id([subscriptionA], ask(SONNET))).toBe("sub-a");
    expect(h.id([subscriptionA], ask(OPUS))).toBe("failure:model_not_found");
  });

  it("answers the refusal as an unknown model, without naming a grant", () => {
    const h = as(harness(), alice, sonnetOnA);
    const outcome = h.select([subscriptionA], ask(`${OPUS}(high)`));

    expect(outcome.ok).toBe(false);

    if (outcome.ok) return;

    expect(outcome.failure).toMatchObject({ code: "model_not_found", httpStatus: 400 });
    expect(JSON.parse(outcome.failure.body ?? "")).toEqual({
      error: {
        message: `unknown provider for model ${OPUS}(high)`,
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
      },
    });
  });

  it("gives a member with no grant nothing at all", () => {
    const h = as(harness(), { member: "bob", teams: [] }, sonnetOnA);

    expect(h.id([subscriptionA], ask(SONNET))).toBe("failure:model_not_found");
  });

  it("matches the pattern against the model without its thinking suffix, in any case", () => {
    const h = as(harness(), alice, sonnetOnA);

    expect(h.id([subscriptionA], ask(`${SONNET}(high)`))).toBe("sub-a");
    expect(h.id([subscriptionA], ask(SONNET.toUpperCase()))).toBe("sub-a");
  });

  it("leaves a credential the grant does not name to the credentials it does", () => {
    const h = as(harness({ ...defaultSettings, strategy: "fill-first" }), alice, sonnetOnA);
    const pool = [entry(claude("sub-a")), entry(claude("sub-b")), entry(claude("sub-0"))];

    expect(h.ids(pool, 3, ask(SONNET))).toEqual(["sub-a", "sub-a", "sub-a"]);
  });

  it("applies a provider grant to every credential of that provider only", () => {
    const h = as(harness(), alice, grant(member("alice"), provider("claude"), [ALL_MODELS]));

    expect(h.id([entry(claude("sub-a"))], ask(OPUS))).toBe("sub-a");
    expect(h.id([entry(cred("gem"))], { providers: ["gemini"], model: "gemini-pro" })).toBe(
      "failure:model_not_found",
    );
  });

  it("is the union of every grant that names the member", () => {
    const h = as(
      harness(),
      alice,
      sonnetOnA,
      grant(member("alice"), allCredentials, ["claude-opus-*"]),
      grant(member("bob"), allCredentials, ["gpt-*"]),
    );

    expect(h.id([subscriptionA], ask(SONNET))).toBe("sub-a");
    expect(h.id([subscriptionA], ask(OPUS))).toBe("sub-a");
    expect(h.id([subscriptionA], ask("claude-haiku-4"))).toBe("failure:model_not_found");
  });
});

describe("aliases cannot reach an ungranted upstream model", () => {
  const alice = { member: "alice", teams: [] };
  const sonnetOnly = grant(member("alice"), allCredentials, ["claude-sonnet-*"]);

  it("refuses an alias of the credential that points at an ungranted model", () => {
    const h = as(harness(), alice, sonnetOnly);

    const aliased = entry(
      claude("keyed", {
        authKind: "apikey",
        source: "config",
        models: [{ name: OPUS, alias: "smart" }],
      }),
    );

    expect(h.id([aliased], ask("smart"))).toBe("failure:model_not_found");
  });

  it("refuses an oauth-model-alias that points at an ungranted model", () => {
    const h = as(
      harness({
        ...defaultSettings,
        oauthModelAlias: { claude: [{ name: OPUS, alias: "smart" }] },
      }),
      alice,
      sonnetOnly,
    );

    expect(h.id([entry(claude("sub-a"))], ask("smart"))).toBe("failure:model_not_found");
  });

  it("serves an alias that points at a granted model", () => {
    const h = as(
      harness({
        ...defaultSettings,
        oauthModelAlias: { claude: [{ name: SONNET, alias: "fast" }] },
      }),
      alice,
      sonnetOnly,
    );

    const outcome = h.select([entry(claude("sub-a"))], ask("fast"));

    expect(outcome.ok && outcome.route.upstreamModel).toBe(SONNET);
  });

  it("does not let the alias name a model the patterns would not match", () => {
    // The pattern is checked against the upstream model: an alias spelled like a granted model changes nothing.
    const h = as(
      harness({
        ...defaultSettings,
        oauthModelAlias: { claude: [{ name: OPUS, alias: "claude-sonnet-lookalike" }] },
      }),
      alice,
      sonnetOnly,
    );

    expect(h.id([entry(claude("sub-a"))], ask("claude-sonnet-lookalike"))).toBe(
      "failure:model_not_found",
    );
  });

  it("skips the ungranted members of an alias pool", () => {
    const h = as(harness(), alice, sonnetOnly);

    const pooled = entry(
      claude("pool", {
        authKind: "apikey",
        source: "config",
        models: [
          { name: OPUS, alias: "any" },
          { name: SONNET, alias: "any" },
        ],
      }),
    );

    for (let index = 0; index < 4; index += 1) {
      const outcome = h.select([pooled], ask("any"));

      expect(outcome.ok && outcome.route.upstreamModels).toEqual([SONNET]);
      expect(outcome.ok && outcome.route.pooled).toBe(true);
    }

    const everything = as(harness(), alice, grant(member("alice"), allCredentials, [ALL_MODELS]));
    const whole = everything.select([pooled], ask("any"));

    expect(whole.ok && whole.route.upstreamModels).toEqual([OPUS, SONNET]);
  });

  it("refuses an alias pool none of whose models is granted", () => {
    const h = as(harness(), alice, grant(member("alice"), allCredentials, ["gpt-*"]));

    const pooled = entry(
      claude("pool", {
        authKind: "apikey",
        source: "config",
        models: [
          { name: OPUS, alias: "any" },
          { name: SONNET, alias: "any" },
        ],
      }),
    );

    expect(h.id([pooled], ask("any"))).toBe("failure:model_not_found");
  });

  it("tracks the cooldown of the granted pool member only", () => {
    const h = as(harness(), alice, sonnetOnly);

    const pooled = entry(
      claude("pool", {
        authKind: "apikey",
        source: "config",
        models: [
          { name: OPUS, alias: "any" },
          { name: SONNET, alias: "any" },
        ],
      }),
      state({ modelStates: { [SONNET]: cooling(NOW + 60_000, true) } }),
    );

    // Opus is free upstream but not granted; Sonnet is granted but cooling: the request waits, it is not "unknown".
    expect(h.id([pooled], ask("any"))).toBe("failure:model_cooldown");
  });
});

describe("the prefix of a credential pins it only with a grant", () => {
  const alice = { member: "alice", teams: [] };

  const work = entry(claude("work", { prefix: "work", authKind: "apikey", source: "config" }));

  const plain = entry(claude("plain"));

  it("refuses `work/<model>` when the credential behind the prefix is not granted", () => {
    const h = as(harness(), alice, grant(member("alice"), credential("plain"), [ALL_MODELS]));

    expect(h.id([work, plain], ask(`work/${SONNET}`))).toBe("failure:model_not_found");
  });

  it("serves `work/<model>` once the credential behind the prefix is granted the upstream model", () => {
    const h = as(harness(), alice, grant(member("alice"), credential("work"), [SONNET]));

    expect(h.id([work, plain], ask(`work/${SONNET}`))).toBe("work");
    expect(h.id([work, plain], ask(`work/${OPUS}`))).toBe("failure:model_not_found");
  });

  it("refuses a pinned credential that is not granted", () => {
    const h = as(harness(), alice, grant(member("alice"), credential("plain"), [ALL_MODELS]));

    expect(h.id([work, plain], ask(SONNET, { pinnedAuthId: "work" }))).toBe(
      "failure:model_not_found",
    );
    expect(h.id([work, plain], ask(SONNET, { pinnedAuthId: "plain" }))).toBe("plain");
  });
});

describe("teams, everyone and requests without a member", () => {
  it("applies a team grant to the members of the team only", () => {
    const pool = [entry(claude("sub-a"))];
    const grants = [grant(team("t-1"), credential("sub-a"), [ALL_MODELS])];

    expect(
      as(harness(), { member: "carol", teams: ["t-1"] }, ...grants).id(pool, ask(SONNET)),
    ).toBe("sub-a");

    expect(as(harness(), { member: "dave", teams: ["t-2"] }, ...grants).id(pool, ask(SONNET))).toBe(
      "failure:model_not_found",
    );

    expect(as(harness(), { member: "erin", teams: [] }, ...grants).id(pool, ask(SONNET))).toBe(
      "failure:model_not_found",
    );
  });

  it("gives a request without a member only the grants for everyone", () => {
    const pool = [entry(claude("sub-a"))];

    const h = as(
      harness(),
      { teams: [] },
      grant(member("alice"), allCredentials, [ALL_MODELS]),
      grant(team("t-1"), allCredentials, [ALL_MODELS]),
      grant(everyone, credential("sub-a"), ["claude-sonnet-*"]),
    );

    expect(h.id(pool, ask(SONNET))).toBe("sub-a");
    expect(h.id(pool, ask(OPUS))).toBe("failure:model_not_found");
  });

  it("never lets a member grant reach a request that has no member, whatever the id", () => {
    const h = as(
      harness(),
      { teams: [] },
      grant(member("undefined"), allCredentials, [ALL_MODELS]),
    );

    expect(h.id([entry(claude("sub-a"))], ask(SONNET))).toBe("failure:model_not_found");
  });
});

describe("private credentials", () => {
  it("are never limited by grants", () => {
    const h = as(harness(), { member: "alice", teams: [] });

    expect(
      h.id([entry(claude("mine", { owner: "alice" }))], ask(OPUS, { memberId: "alice" })),
    ).toBe("mine");
  });

  it("do not make a shared credential the member has no grant for reachable", () => {
    const h = as(harness(), { member: "alice", teams: [] });
    const pool = [entry(claude("mine", { owner: "alice" })), entry(claude("shared"))];

    expect(h.ids(pool, 3, ask(OPUS, { memberId: "alice" }))).toEqual(["mine", "mine", "mine"]);
    expect(h.id(pool, ask(OPUS, { memberId: "bob" }))).toBe("failure:model_not_found");
  });
});

describe("session affinity", () => {
  const alice = { member: "alice", teams: [] };
  const session = { session: { id: "s-1" } };

  it("moves a session whose credential lost its grant to another credential", () => {
    const h = as(
      harness({ ...defaultSettings, sessionAffinity: true }),
      alice,
      grant(member("alice"), allCredentials, [ALL_MODELS]),
    );

    const pool = [entry(claude("sub-a")), entry(claude("sub-b"))];
    const first = h.id(pool, ask(SONNET, session));

    expect(["sub-a", "sub-b"]).toContain(first);
    expect(h.id(pool, ask(SONNET, session))).toBe(first);

    // The grant for the bound credential is replaced by one for the other.
    const other = first === "sub-a" ? "sub-b" : "sub-a";

    as(h, alice, grant(member("alice"), credential(other), [ALL_MODELS]));

    expect(h.id(pool, ask(SONNET, session))).toBe(other);
    expect(h.id(pool, ask(SONNET, session))).toBe(other);
  });

  it("fails the session when no credential is granted any more", () => {
    const h = as(
      harness({ ...defaultSettings, sessionAffinity: true }),
      alice,
      grant(member("alice"), allCredentials, [ALL_MODELS]),
    );

    const pool = [entry(claude("sub-a"))];

    expect(h.id(pool, ask(SONNET, session))).toBe("sub-a");

    as(h, alice);

    expect(h.id(pool, ask(SONNET, session))).toBe("failure:model_not_found");
  });
});

describe("retry planning", () => {
  const query = {
    providers: ["claude"],
    model: SONNET,
    round: 0,
    requestRetry: 3,
    status: 503,
    maxWaitMs: 0,
    memberId: "alice",
  };

  const plan = (...grants: Parameters<typeof reachFor>[0]) =>
    planRetry({
      credentials: [entry(claude("sub-a")), entry(claude("sub-b"))],
      query,
      routing: { ...defaultSettings, knownPrefixes: new Set() },
      reach: reachFor(grants, { member: "alice", teams: [] }),
      coolingDisabled: () => false,
      now: NOW,
    });

  it("counts only the credentials the member may use for the model", () => {
    expect(plan(grant(member("alice"), credential("sub-a"), [SONNET]))).toEqual({
      retry: true,
      waitMs: 0,
    });

    expect(plan(grant(member("alice"), credential("sub-a"), [OPUS]))).toEqual({ retry: false });
    expect(plan()).toEqual({ retry: false });
  });
});
