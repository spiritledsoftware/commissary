// LCP conversation affinity inside the credential pool: requests without an explicit session stay on the credential
// that served their conversation, forks/compactions get their own identities, failures drop only the attempted
// sequence, and the derived / message-hash identities bind like explicit ones (selector.go Pick/OnResult).
import { describe, expect, it } from "vite-plus/test";
import type { PickResult, ReportResult } from "../src/credentials/selection/types.ts";
import type { CredentialPool } from "../src/credentials/pool.ts";
import { extractCanonicalTurns, prepareFingerprints } from "../src/session-routing/canonical.ts";
import { prepareSessionRouting } from "../src/session-routing/routing.ts";
import type { Json } from "@commissary/json";
import { makePool } from "./support/pool.ts";

const key = (name: string) => `
    - name: ${name}
      base-url: https://${name}.example/v1
      models: [{ name: m }]
      keys: [{ api-key: key-${name} }]`;

const yaml = (affinity: boolean) => `
routing:
  strategy: round-robin
  session-affinity: ${affinity}
  cooldown:
    disable-cooling: true
api-keys:
  openai-compatibility:${key("a")}${key("b")}${key("c")}
`;

const providers = ["openai-compatible-a", "openai-compatible-b", "openai-compatible-c"];

const SCOPE = "scope-1";

const conversation = (...turns: string[]): Json => ({
  model: "m",
  messages: turns.map((content, index) => ({
    role: index === 0 ? "system" : index % 2 === 1 ? "user" : "assistant",
    content,
  })),
});

const lcpOf = (body: Json) => {
  const prepared = prepareFingerprints(extractCanonicalTurns("openai", body));

  return { ...prepared, callerScope: SCOPE };
};

const pickLcp = (pool: CredentialPool, body: Json, extra: Record<string, unknown> = {}) => {
  const result = pool.pick({ providers, model: "m", lcp: lcpOf(body), ...extra });

  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

const success: ReportResult = { success: true, httpStatus: 200 };

const failure: ReportResult = {
  success: false,
  httpStatus: 500,
  error: { message: "boom", httpStatus: 500, retryable: false },
};

const requestScoped: ReportResult = { success: false, requestScoped: true, httpStatus: 400 };

const turns2 = conversation("sys", "hello", "hi");

const turns3 = conversation("sys", "hello", "hi", "next");

describe("LCP affinity in the pool", () => {
  it("keeps follow-up requests of a conversation on the same credential", async () => {
    const { pool } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);
    pool.report(first.lease, success);
    const credentials = new Set<string>();

    for (let index = 0; index < 6; index += 1) {
      const next = pickLcp(pool, turns3);
      credentials.add(next.credential.id);
      pool.report(next.lease, success);
    }

    expect([...credentials]).toEqual([first.credential.id]);
    // The session identity is stable across the conversation.
    const again = pickLcp(pool, turns3);
    expect(again.session?.id).toBe(first.session?.id);
    expect(again.session?.id).toMatch(/^lcp:v1:[0-9a-f]{64}$/);
  });

  it("spreads unrelated conversations", async () => {
    const { pool } = await makePool(yaml(true));

    const ids = ["x", "y", "z"].map(
      (name) => pickLcp(pool, conversation("sys", `hello ${name}`, "hi")).credential.id,
    );

    expect(new Set(ids).size).toBe(3);
  });

  it("an explicit session wins over the LCP matcher", async () => {
    const { pool } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);

    const explicit = pool.pick({
      providers,
      model: "m",
      lcp: lcpOf(turns2),
      session: { id: "claude:s1", callerScope: SCOPE },
    });

    expect(explicit.ok && explicit.session).toBeFalsy();
    expect(explicit.ok && explicit.lease.lcp).toBeUndefined();
    expect(first.lease.lcp).toBeDefined();
  });

  it("binds nothing without caller scope, affinity or fingerprints", async () => {
    const off = await makePool(yaml(false));
    expect(pickLcp(off.pool, turns2).session).toBeUndefined();
    const on = await makePool(yaml(true));

    const noScope = on.pool.pick({
      providers,
      model: "m",
      lcp: { ...lcpOf(turns2), callerScope: "" },
    });

    expect(noScope.ok && noScope.session).toBeFalsy();
    const shortBody = conversation("only system");
    const noTurns = on.pool.pick({ providers, model: "m", lcp: { ...lcpOf(shortBody) } });
    expect(noTurns.ok && noTurns.session).toBeFalsy();
  });

  it("a credential failure rebinds the conversation to another credential", async () => {
    const { pool } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);
    pool.report(first.lease, failure);
    const second = pickLcp(pool, turns2);
    expect(second.session?.id).toBe(first.session?.id);
    // The failed binding was dropped, so the strategy picked again (round robin moved on).
    expect(second.credential.id).not.toBe(first.credential.id);
  });

  it("a request-scoped failure keeps the binding", async () => {
    const { pool } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);
    pool.report(first.lease, requestScoped);
    expect(pickLcp(pool, turns3).credential.id).toBe(first.credential.id);
  });

  it("a stale failure report does not drop a refreshed binding", async () => {
    const { pool } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);
    const concurrent = pickLcp(pool, turns2);
    expect(concurrent.credential.id).toBe(first.credential.id);
    // `first` was refreshed by the newer request: its late failure must not remove the active binding.
    pool.report(first.lease, failure);
    expect(pickLcp(pool, turns2).credential.id).toBe(first.credential.id);
  });

  it("forks get their own identity with the shared prefix as parent", async () => {
    const { pool } = await makePool(yaml(true));
    const base = pickLcp(pool, conversation("sys", "u1", "a1", "u2"));
    pool.report(base.lease, success);
    const fork = pickLcp(pool, conversation("sys", "u1", "a1", "u3"));
    expect(fork.session?.isFork).toBe(true);
    expect(fork.session?.nodeKind).toBe("fork");
    expect(fork.session?.parentId).toBeDefined();
    expect(fork.session?.id).not.toBe(base.session?.id);
    expect(fork.credential.id).toBe(base.credential.id);
  });

  it("expires bindings after the affinity TTL", async () => {
    const { pool, clock } = await makePool(yaml(true));
    const first = pickLcp(pool, turns2);
    pool.report(first.lease, success);
    clock.advance(3_600_001);
    const later = pickLcp(pool, turns2);
    expect(later.credential.id).not.toBe(first.credential.id);
  });
});

describe("derived and message-hash identities bind like explicit sessions", () => {
  const headers = new Headers();

  const route = (body: Json, explicit = false) =>
    prepareSessionRouting({
      headers,
      body,
      format: "openai",
      callerScope: SCOPE,
      explicit: explicit
        ? {
            sessionId: "x",
            agentName: "main",
            clientType: "generic",
            isFork: false,
            isSubagent: false,
          }
        : undefined,
      affinity: true,
    });

  it("requests the LCP matcher does not handle use the derived identity", async () => {
    const { pool } = await makePool(yaml(true));
    const routing = route(conversation("sys", "hello"));
    expect(routing.fallbackSession?.id).toMatch(/^derived:ctx:v1:[0-9a-f]{64}$/);

    const picks = Array.from({ length: 4 }, () => {
      const result = pool.pick({
        providers,
        model: "m",
        fallbackSession: { ...routing.fallbackSession!, callerScope: SCOPE },
      });

      if (!result.ok) throw new Error("pick failed");
      pool.report(result.lease, success);

      return result.credential.id;
    });

    expect(new Set(picks).size).toBe(1);
  });

  it("the usage identity is explicit, derived or message-hash based", () => {
    expect(route(conversation("sys", "hello"), true).usageSession).toEqual({ id: "x" });
    expect(route(conversation("sys", "hello")).usageSession?.id).toMatch(/^derived:ctx:v1:/);

    const marked = prepareSessionRouting({
      headers: new Headers({ "X-Thread-Id": "t" }),
      body: conversation("sys", "hello"),
      format: "openai",
      callerScope: SCOPE,
      explicit: undefined,
      affinity: true,
    });

    // A marker that the extractor does not understand disables derivation; the message hash still applies.
    expect(marked.usageSession?.id).toMatch(/^msg:[0-9a-f]{16}$/);
    expect(marked.fallbackSession?.id).toBe(marked.usageSession?.id);

    const off = prepareSessionRouting({
      headers,
      body: conversation("sys", "hello"),
      format: "openai",
      callerScope: SCOPE,
      explicit: undefined,
      affinity: false,
    });

    expect(off.lcp).toBeUndefined();
    expect(off.fallbackSession).toBeUndefined();
    expect(off.usageSession?.id).toMatch(/^derived:/);
  });
});

describe("picked credentials expose the session for usage", () => {
  it("returns the LCP identity in the pick result", async () => {
    const { pool } = await makePool(yaml(true));
    const result: PickResult = pool.pick({ providers, model: "m", lcp: lcpOf(turns2) });
    expect(result.ok && result.session?.id).toMatch(/^lcp:v1:/);
  });
});

describe("derived identity feeds executor metadata", () => {
  it("exposes the raw ctx:v1 id only without an explicit marker", () => {
    const body = conversation("sys", "hello");

    const plain = prepareSessionRouting({
      headers: new Headers(),
      body,
      format: "openai",
      callerScope: SCOPE,
      explicit: undefined,
      affinity: false,
    });

    expect(plain.derivedId).toMatch(/^ctx:v1:[0-9a-f]{64}$/);

    const marked = prepareSessionRouting({
      headers: new Headers({ "X-Session-ID": "abc" }),
      body,
      format: "openai",
      callerScope: SCOPE,
      explicit: undefined,
      affinity: false,
    });

    expect(marked.derivedId).toBeUndefined();
  });
});
