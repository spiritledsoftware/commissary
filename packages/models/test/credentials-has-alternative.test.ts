// `CredentialPool.hasAlternative` (read-only probe behind a pinned Responses WebSocket continuation's 429): is there a
// credential other than the excluded one that could serve the request now? (injected clock, no Durable Object)
import { describe, expect, it } from "vitest";
import type { PickResult } from "../src/credentials/selection/types.ts";
import type { Reach } from "../src/grants/reach.ts";
import { makePool } from "./support/pool.ts";

const group = (name: string, extra = "") => `
    - name: ${name}
      base-url: https://${name}.example/v1
      ${extra}
      models: [{ name: m }]
      keys: [{ api-key: key-${name} }]`;

const config = (groups: string) => `
api-keys:
  openai-compatibility:${groups}
`;

const providers = ["openai-compatible-a", "openai-compatible-b"];

type Harness = Awaited<ReturnType<typeof makePool>>;

const idOf = (harness: Harness, label: string): string => {
  const found = harness.pool.list().find((credential) => credential.label === label);

  if (found === undefined) throw new Error(`no credential labelled ${label}`);

  return found.id;
};

const ok = (result: PickResult) => {
  if (!result.ok) throw new Error(`pick failed: ${result.failure.code}`);

  return result;
};

const request = { providers, model: "m", callerScope: "s" };

const coolDown = ({ pool }: Harness, name: string, retryAfterMs: number) => {
  const picked = ok(pool.pick({ providers: [`openai-compatible-${name}`], model: "m" }));
  pool.report(picked.lease, {
    success: false,
    httpStatus: 429,
    error: { message: "slow down", retryable: true, httpStatus: 429 },
    retryAfterMs,
  });
};

const two = () => makePool(config(group("a") + group("b")));

describe("CredentialPool.hasAlternative", () => {
  it("is true when another eligible credential can serve the request", async () => {
    const h = await two();
    expect(h.pool.hasAlternative({ ...request, tried: [idOf(h, "a")] })).toBe(true);
  });

  it("is false when the only other credential is excluded or there is none", async () => {
    const h = await two();
    expect(h.pool.hasAlternative({ ...request, tried: [idOf(h, "a"), idOf(h, "b")] })).toBe(false);

    const single = await makePool(config(group("a")));
    expect(single.pool.hasAlternative({ ...request, tried: [idOf(single, "a")] })).toBe(false);
  });

  it("is false while the only other credential is cooling, and true once the cooldown expired", async () => {
    const h = await two();
    coolDown(h, "b", 60_000);
    expect(h.pool.hasAlternative({ ...request, tried: [idOf(h, "a")] })).toBe(false);
    h.clock.advance(61_000);
    expect(h.pool.hasAlternative({ ...request, tried: [idOf(h, "a")] })).toBe(true);
  });

  it("is false when the grants keep the caller away from the other credential", async () => {
    const probe = await two();
    const a = idOf(probe, "a");

    const reach: Reach = {
      unrestricted: false,
      permits: (target) => target.id === a,
      coversAll: () => false,
    };

    const h = await makePool(config(group("a") + group("b")), { reach: () => reach });
    expect(h.pool.hasAlternative({ ...request, tried: [a] })).toBe(false);
  });

  it("is false when no credential serves the model", async () => {
    const h = await two();
    expect(h.pool.hasAlternative({ ...request, model: "other", tried: [idOf(h, "a")] })).toBe(
      false,
    );
  });

  it("takes no lease and moves no rotation state", async () => {
    const plain = await two();
    ok(plain.pool.pick(request));
    const second = ok(plain.pool.pick(request)).credential.id;

    const probed = await two();
    const first = ok(probed.pool.pick(request)).credential.id;

    // Probes between picks must not advance the round-robin cursor.
    for (let i = 0; i < 3; i += 1) probed.pool.hasAlternative({ ...request, tried: [first] });
    expect(ok(probed.pool.pick(request)).credential.id).toBe(second);
  });
});
