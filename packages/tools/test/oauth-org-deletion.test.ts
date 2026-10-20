// Tools' step of deleting an org (ADR 0027) on Commissary Cloud (#200): the org's OAuth sign-ins of MCP clients, kept in
// the OAuth server's KV namespace under the users `<org>/<member id>`, go with it (grants and tokens), within the
// deletion's budget; another org's stay, even one whose id starts with the deleted org's, and so do the clients.
import { env } from "cloudflare:workers";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { OrgId } from "@commissary/core";
import type { McpOAuthConfig } from "../src/oauth/config.ts";
import { deleteOrgSignIns, orgDeletionStep } from "../src/org-deletion.ts";
import { ToolsEnv } from "../src/env.ts";
import { signInGrants } from "./support/sign-in-grants.ts";

const config: McpOAuthConfig = {
  issuer: "https://commissary.test",
  resource: "https://commissary.test/mcp",
  kv: env.OAUTH_KV,
};

const grants = signInGrants(config);

const allKeys = async (prefix: string): Promise<ReadonlyArray<string>> =>
  (await env.OAUTH_KV.list({ prefix })).keys.map((key) => key.name);

beforeEach(async () => {
  await Promise.all((await allKeys("")).map(async (name) => await env.OAUTH_KV.delete(name)));
});

describe("Tools' org deletion step", () => {
  it("deletes the org's grants and tokens, and nothing of another org or any client", async () => {
    const doomed = OrgId.make("org1");
    const kept = OrgId.make("org12");

    await grants.write(doomed, "member-a", "key-a");
    await grants.write(doomed, "member-b", "key-b");
    await grants.write(kept, "member-a", "key-c");
    // A token as the library keeps it: under its user and grant.
    await env.OAUTH_KV.put(`token:${doomed}/member-a:grant:token`, "{}");
    await env.OAUTH_KV.put(`token:${kept}/member-a:grant:token`, "{}");

    const clients = await allKeys("client:");

    expect(clients).toHaveLength(3);

    const progress = await deleteOrgSignIns(config.kv)(doomed, 400);

    expect(progress.complete).toBe(true);
    expect(await grants.keyIds(doomed, "member-a")).toEqual([]);
    expect(await grants.keyIds(doomed, "member-b")).toEqual([]);
    expect(await allKeys(`token:${doomed}/`)).toEqual([]);

    expect(await grants.keyIds(kept, "member-a")).toEqual(["key-c"]);
    expect(await allKeys(`token:${kept}/`)).toHaveLength(1);
    expect(await allKeys("client:")).toEqual(clients);
  });

  it("stops within its budget, and finishes when it runs again", async () => {
    const org = OrgId.make("org2");

    await grants.write(org, "member-a", "key-a");

    expect(await deleteOrgSignIns(config.kv)(org, 50)).toEqual({
      complete: false,
      calls: 0,
      part: "oauth",
    });
    expect(await grants.keyIds(org, "member-a")).toEqual(["key-a"]);

    const finished = await deleteOrgSignIns(config.kv)(org, 400);

    expect(finished.complete).toBe(true);
    expect(await grants.keyIds(org, "member-a")).toEqual([]);
  });

  it("deletes nothing on a self-hosted stage, which has no OAuth server", async () => {
    const org = OrgId.make("org3");

    await grants.write(org, "member-a", "key-a");

    const step = await Effect.runPromise(
      orgDeletionStep.pipe(Effect.provideService(ToolsEnv, env)),
    );

    expect(await step(org, 400)).toEqual({ complete: true, calls: 0 });
    expect(await grants.keyIds(org, "member-a")).toEqual(["key-a"]);
  });
});
