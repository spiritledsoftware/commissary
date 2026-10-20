// An org that spent under Spend limits (ADR 0027, issue #71), through the real ControlPlane: an admin, two members with
// an API key each, a shared account, and Spend that every one used; and the Spend rows a subject holds.
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { Viewer } from "@commissary/auth";
import { OrgId } from "@commissary/core";
import { controlPlaneOf } from "@commissary/state";
import { FULL_ACCESS } from "../../src/credentials/ownership.ts";
import { claudeFile } from "./control-plane.ts";
import { USD } from "./spend.ts";

/** The owner of the org, as the org-wide base answers its caller. */
export const OWNER = { role: "owner", sensitive: true } as const;

const REQUEST = { providers: ["claude"], model: "claude-sonnet-4-5" };

/** An org with an admin, two members with an API key each, a shared account, and Spend that was used by every one. */
export const spendingOrg = async () => {
  const org = OrgId.make(`spend-zdr-${crypto.randomUUID().slice(0, 8)}`);
  const stub = controlPlaneOf(env, org);

  const member = async (email: string, role: "admin" | "member" = "member") => {
    const added = await stub.addMember({ email, role }, OWNER, "test");

    if (!added.ok) throw new Error(added.message);

    return added.value;
  };

  const admin = await member("admin@example.com", "admin");
  const alice = await member("alice@example.com");
  const bob = await member("bob@example.com");
  const viewer: Viewer = { member: admin.id, admin: true };

  const key = async (owner: { readonly id: string }, name: string, expiresAt?: number) => {
    const made = await stub.createApiKey(
      { memberId: owner.id, name, ...(expiresAt === undefined ? {} : { expiresAt }) },
      Date.now(),
    );

    if (!made.ok) throw new Error(made.message);

    return made.value.record;
  };

  const limit = async (kind: "member" | "key" | "org", subject: string) => {
    const made = await stub.createSpendLimit(
      viewer,
      { kind, subject, period: "day", amountMicros: 100 * USD },
      "test@example.com",
    );

    if (!made.ok) throw new Error(`${made.error}: ${made.message}`);
  };

  const spend = async (memberId: string, apiKeyId: string) => {
    const picked = await stub.models().pick({ ...REQUEST, memberId, apiKeyId });

    if (!picked.ok) throw new Error(picked.failure.code);
    await stub.models().report(picked.lease, { success: true, httpStatus: 200, costMicros: USD });
  };

  expect(
    (
      await stub
        .models()
        .importAuthFile("claude-a.json", JSON.stringify(claudeFile()), {}, FULL_ACCESS)
    ).ok,
  ).toBe(true);

  const aliceKey = await key(alice, "alice laptop");
  const bobKey = await key(bob, "bob laptop");

  for (const [who, apiKey] of [
    [alice, aliceKey],
    [bob, bobKey],
  ] as const) {
    await limit("member", who.id);
    await limit("key", apiKey.id);
    await spend(who.id, apiKey.id);
  }

  await limit("org", "");

  return { org, stub, admin, alice, bob, aliceKey, bobKey, key, limit, spend };
};

export type SpendingOrg = Awaited<ReturnType<typeof spendingOrg>>;

/** The Spend rows of `subject` in an org: limits and counters. */
export const spendRows = async (org: SpendingOrg, kind: string, subject: string) =>
  await runInDurableObject(controlPlaneOf(env, org.org), (_instance, state) => {
    const count = (table: string) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE subject_kind = ? AND subject_id = ?`,
          kind,
          subject,
        )
        .one().n;

    return { limits: count("spend_limits"), counters: count("spend_counters") };
  });

export const HELD = { limits: 1, counters: 1 };

export const GONE = { limits: 0, counters: 0 };
