// The built-in sandbox toolkit (#222, ADR 0041, ADR 0044) in the Tools part over RPC, with Cloudflare's sandbox behind
// it: real `SandboxSession` objects whose just-bash runs in Dynamic Workers of the test `LOADER`. A granted member opens
// a session and works in it across separate calls; it is theirs alone, closes on `sandbox_close` or after a day idle;
// the ControlPlane keeps the org's open sessions, so a member's leaving and the org's deletion delete theirs at once;
// its network stays within the org's ceiling, and every request it makes goes through the egress entrypoint, which also
// applies the outbound guard (also on a redirect; and `git` has no way out of its own). A fake second provider serves
// the same tools.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Schema } from "effect";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { OrgId } from "@commissary/core";
import { deleteOrgSandboxSessions } from "../src/org-deletion.ts";
import { SESSION_IDLE_MS as IDLE_MS } from "../src/sandbox/provider.ts";

const POLICY = { ownHosts: ["app.example.com"], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

type Viewer = typeof ALICE;

const withSandbox = () => env.SANDBOX_CONTROL_PLANE.getByName(crypto.randomUUID());

const withOtherProvider = () => env.OTHER_SANDBOX_CONTROL_PLANE.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof withSandbox>;

const grantEveryone = async (stub: Stub) => {
  const written = await stub.tools().writeGrant(
    {
      revision: 0,
      value: { subject: { kind: "everyone" }, toolkit: "sandbox", tools: { kind: "all" } },
    },
    "test",
  );

  if (!written.ok) throw new Error(written.message);
};

/** A call's result as the endpoint gets it, or what else it came to. */
const call = async (
  stub: Stub,
  viewer: Viewer,
  name: string,
  args: Schema.JsonObject,
  principalId = `user:${viewer.member}@example.com`,
) => {
  const outcome = await stub
    .tools()
    .callTool(viewer, { name, arguments: args, principalId }, POLICY);

  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.result;
};

const textOf = (result: Schema.JsonObject): string => {
  const [first] = result["content"] as ReadonlyArray<{ text: string }>;

  return first?.text ?? "";
};

const open = async (stub: Stub, viewer: Viewer, network?: SandboxNetwork, principal?: string) => {
  const result = await call(
    stub,
    viewer,
    "sandbox_open",
    network === undefined ? {} : { network },
    principal,
  );

  expect(result["isError"]).toBeUndefined();

  return (result["structuredContent"] as { session: string }).session;
};

const setCeiling = async (stub: Stub, network: SandboxNetwork) => {
  const { toolkits } = await stub.tools().listToolkits(ADMIN);
  const revision = toolkits.find((toolkit) => toolkit.id === "sandbox")?.revision ?? 0;

  const updated = await stub
    .tools()
    .updateToolkit(ADMIN, "sandbox", revision, { network }, "admin", POLICY);

  if (!updated.ok) throw new Error(updated.message);

  return updated.value;
};

describe("the sandbox toolkit", () => {
  it("is an org toolkit of Commissary's own, with no network by default, reaching nobody until a grant", async () => {
    const stub = withSandbox();
    const { toolkits } = await stub.tools().listToolkits(ALICE);

    expect(toolkits).toHaveLength(1);
    expect(toolkits[0]).toMatchObject({
      id: "sandbox",
      kind: "sandbox",
      name: "sandbox",
      source: "cloudflare",
      private: false,
      accepts: "shared",
      built_in: true,
      credentials: { shared: { kind: "none", active: true } },
      tool_list: { tools: 7 },
      network: { kind: "none" },
    });

    const tools = await stub.tools().listTools(ALICE, "sandbox");

    expect(tools.ok && tools.value.tools.map((tool) => [tool.id, tool.name, tool.class])).toEqual([
      ["sandbox:open", "sandbox_open", "write"],
      ["sandbox:bash", "sandbox_bash", "write"],
      ["sandbox:read", "sandbox_read", "read"],
      ["sandbox:write", "sandbox_write", "write"],
      ["sandbox:edit", "sandbox_edit", "write"],
      ["sandbox:list", "sandbox_list", "read"],
      ["sandbox:close", "sandbox_close", "write"],
    ]);

    expect(await stub.tools().clientTools(ALICE)).toEqual([]);
    expect(
      (await stub.tools().callTool(ALICE, { name: "sandbox_open", principalId: "user:a" }, POLICY))
        .outcome,
    ).toBe("unknown");
  });

  it("lets a granted member open a session, write a file, run ls and cat, edit it and close it, call by call", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    const session = await open(stub, ALICE);

    expect(session).toMatch(/^sbx_[0-9a-f]{32}$/);
    expect(
      textOf(
        await call(stub, ALICE, "sandbox_write", {
          session,
          path: "notes.txt",
          content: "hello\nworld\n",
        }),
      ),
    ).toBe("Successfully wrote 12 bytes to /workspace/notes.txt");

    const listed = await call(stub, ALICE, "sandbox_bash", { session, command: "ls" });

    expect(listed["structuredContent"]).toMatchObject({ exit_code: 0, stdout: "notes.txt\n" });

    const shown = await call(stub, ALICE, "sandbox_bash", { session, command: "cat notes.txt" });

    expect(textOf(shown)).toBe("hello\nworld\n");

    expect(
      textOf(
        await call(stub, ALICE, "sandbox_edit", {
          session,
          path: "/workspace/notes.txt",
          edits: [{ oldText: "world", newText: "sandbox" }],
        }),
      ),
    ).toBe("Successfully replaced 1 block(s) in /workspace/notes.txt.");
    expect(textOf(await call(stub, ALICE, "sandbox_read", { session, path: "notes.txt" }))).toBe(
      "hello\nsandbox\n",
    );
    expect(textOf(await call(stub, ALICE, "sandbox_list", { session }))).toBe("notes.txt");

    const failed = await call(stub, ALICE, "sandbox_bash", { session, command: "cat missing.txt" });

    expect(failed["isError"]).toBe(true);
    expect(textOf(failed)).toContain("Command exited with code 1");

    expect(textOf(await call(stub, ALICE, "sandbox_close", { session }))).toBe(
      `Closed sandbox session ${session}; its files are deleted.`,
    );

    const after = await call(stub, ALICE, "sandbox_read", { session, path: "notes.txt" });

    expect([after["isError"], textOf(after)]).toEqual([
      true,
      `The sandbox session ${session} is closed, and its files are gone. Open a new one with sandbox_open.`,
    ]);
  });

  it("is its principal's alone: another member, another API key and another org answer an unknown session", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    const session = await open(stub, ALICE);

    await call(stub, ALICE, "sandbox_write", { session, path: "secret.txt", content: "alice's" });

    const unknown = `Unknown sandbox session ${session}. Open one with sandbox_open.`;

    for (const [viewer, principal] of [
      [BOB, "user:m-bob@example.com"],
      // Alice's own API key is a principal of its own.
      [ALICE, "key:alice-laptop"],
    ] as const) {
      for (const [tool, args] of [
        ["sandbox_read", { session, path: "secret.txt" }],
        ["sandbox_bash", { session, command: "cat secret.txt" }],
        ["sandbox_write", { session, path: "secret.txt", content: "taken" }],
        ["sandbox_list", { session }],
        ["sandbox_close", { session }],
      ] as const) {
        const result = await call(stub, viewer, tool, args, principal);

        expect([tool, result["isError"], textOf(result)]).toEqual([tool, true, unknown]);
      }
    }

    // The same id in another org names another, empty object.
    const other = withSandbox();

    await grantEveryone(other);
    const elsewhere = await call(other, ALICE, "sandbox_read", { session, path: "secret.txt" });

    expect(textOf(elsewhere)).toBe(unknown);
    // A made-up id is just as unknown.
    expect(textOf(await call(stub, ALICE, "sandbox_list", { session: "sbx_nope" }))).toBe(
      "Unknown sandbox session sbx_nope. Open one with sandbox_open.",
    );
    // And Alice still has her file.
    expect(textOf(await call(stub, ALICE, "sandbox_read", { session, path: "secret.txt" }))).toBe(
      "alice's",
    );
  });

  it("deletes a session idle for a day, and its owner's later calls answer that it is closed", async () => {
    const org = crypto.randomUUID();
    const stub = env.SANDBOX_CONTROL_PLANE.getByName(org);

    await grantEveryone(stub);
    const session = await open(stub, ALICE);

    await call(stub, ALICE, "sandbox_write", { session, path: "kept.txt", content: "for a day" });
    const object = env.SANDBOX_SESSION.getByName(`${org}:${session}`);

    const before = await runInDurableObject(object, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      now: Date.now(),
    }));

    // A call is a use: the session lasts a day from the last one.
    expect(before.alarm).toBeGreaterThan(before.now + IDLE_MS - 60_000);
    expect(before.alarm).toBeLessThanOrEqual(before.now + IDLE_MS);

    expect(await runDurableObjectAlarm(object)).toBe(true);

    const after = await call(stub, ALICE, "sandbox_read", { session, path: "kept.txt" });

    expect(textOf(after)).toContain("is closed, and its files are gone");

    // Its files are deleted: the object keeps only the note that it was closed.
    const kept = await runInDurableObject(object, (_instance, state) =>
      [...state.storage.kv.list()].map(([key]) => key),
    );

    expect(kept).toEqual(["sandbox:session"]);
    // Someone else still hears of an unknown session.
    expect(textOf(await call(stub, BOB, "sandbox_read", { session, path: "kept.txt" }))).toContain(
      "Unknown sandbox session",
    );

    // A week later the note goes too.
    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(textOf(await call(stub, ALICE, "sandbox_list", { session }))).toContain(
      "Unknown sandbox session",
    );
  });
});

/** The org's open sandbox sessions as its ControlPlane keeps them: id, member and principal. */
const tracked = async (stub: Stub) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; member: string; principal: string }>(
        "SELECT id, member, principal FROM sandbox_sessions ORDER BY opened_at, id",
      )
      .toArray()
      .map((row) => [row.id, row.member, row.principal]),
  );

/** What a session's object still holds: its storage's keys. */
const heldBy = async (org: string, session: string) =>
  await runInDurableObject(env.SANDBOX_SESSION.getByName(`${org}:${session}`), (_instance, state) =>
    [...state.storage.kv.list()].map(([key]) => key),
  );

describe("the org's open sandbox sessions", () => {
  it("are refused to a call that names no principal", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    const result = await stub.tools().callTool(ALICE, { name: "sandbox_open" }, POLICY);

    expect(
      result.outcome === "result" && [result.result["isError"], textOf(result.result)],
    ).toEqual([
      true,
      "Commissary could not tell who is calling, so the sandbox cannot be used from this call.",
    ]);
    expect(await tracked(stub)).toEqual([]);
  });

  it("are kept by the ControlPlane while open, and a member's leaving deletes theirs at once", async () => {
    const org = crypto.randomUUID();
    const stub = env.SANDBOX_CONTROL_PLANE.getByName(org);

    await grantEveryone(stub);
    const mine = await open(stub, ALICE);
    const viaKey = await open(stub, ALICE, undefined, "key:alice-laptop");
    const bobs = await open(stub, BOB);
    const closed = await open(stub, BOB);

    await call(stub, ALICE, "sandbox_write", { session: mine, path: "a.txt", content: "alice" });
    await call(stub, BOB, "sandbox_close", { session: closed });

    const byId = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
      (a[0] ?? "").localeCompare(b[0] ?? "");

    expect((await tracked(stub)).toSorted(byId)).toEqual(
      [
        [mine, ALICE.member, "user:m-alice@example.com"],
        [viaKey, ALICE.member, "key:alice-laptop"],
        [bobs, BOB.member, "user:m-bob@example.com"],
      ].toSorted(byId),
    );

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().memberLeft(ALICE.member);
    });

    // Alice's sessions are gone with their files, with no note that they were.
    expect(await heldBy(org, mine)).toEqual([]);
    expect(await heldBy(org, viaKey)).toEqual([]);
    expect(textOf(await call(stub, ALICE, "sandbox_list", { session: mine }))).toContain(
      "Unknown sandbox session",
    );
    expect(await tracked(stub)).toEqual([[bobs, BOB.member, "user:m-bob@example.com"]]);
    expect(textOf(await call(stub, BOB, "sandbox_list", { session: bobs }))).toBe(
      "(empty directory)",
    );
  });

  it("are forgotten by the ControlPlane once a day passes without a call, as the sandbox ends them", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    const session = await open(stub, ALICE);
    const now = Date.now();

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(now + IDLE_MS - 60_000);
    });
    expect((await tracked(stub)).map(([id]) => id)).toEqual([session]);

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(now + IDLE_MS + 60_000);
    });
    expect(await tracked(stub)).toEqual([]);
  });

  it("are deleted with the org, within the deletion's budget", async () => {
    const org = OrgId.make(crypto.randomUUID());
    const stub = env.SANDBOX_CONTROL_PLANE.getByName(org);
    const step = deleteOrgSandboxSessions({ CONTROL_PLANE: env.SANDBOX_CONTROL_PLANE });

    await grantEveryone(stub);
    const sessions = [await open(stub, ALICE), await open(stub, BOB)];

    // Too little budget for a page: nothing is deleted, and the step says it stopped.
    expect(await step(org, 5)).toEqual({ complete: false, calls: 0, part: "sandbox" });
    expect(await tracked(stub)).toHaveLength(2);

    expect(await step(org, 400)).toEqual({ complete: true, calls: 3 });
    expect(await tracked(stub)).toEqual([]);

    for (const session of sessions) expect(await heldBy(org, session)).toEqual([]);
  });
});

/** A `curl` of `url` in `session`, as Alice. */
const curl = async (stub: Stub, session: string, url: string) =>
  await call(stub, ALICE, "sandbox_bash", { session, command: `curl -sS ${url}` });

describe("the sandbox's network", () => {
  const reached: Array<string> = [];
  const realFetch = globalThis.fetch;

  // The egress entrypoint runs in this isolate: what it forwards reaches this fake internet.
  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);

      reached.push(request.url);
      const url = new URL(request.url);

      // An allowed host that sends the sandbox elsewhere.
      if (url.hostname === "redirect.example.com")
        return new Response(null, {
          status: 302,
          headers: {
            location:
              url.pathname === "/private" ? "https://10.0.0.1/" : "https://other.example.org/",
          },
        });

      return new Response(`hello from ${url.hostname}`);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("is none by default: a curl from the sandbox fails", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    const session = await open(stub, ALICE);
    const result = await curl(stub, session, "https://example.com/");

    expect(result["isError"]).toBe(true);
    expect(textOf(result)).toContain("the sandbox has no network");
    expect(reached).not.toContain("https://example.com/");
  });

  it("reaches only the hosts it allows, within the org's ceiling, and refuses a network above it", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);

    // The ceiling is none until an org admin widens it.
    const refused = await call(stub, ALICE, "sandbox_open", {
      network: { kind: "hosts", hosts: ["allowed.example.com"] },
    });

    expect([refused["isError"], textOf(refused)]).toEqual([
      true,
      "The org does not allow that network: a sandbox may have at most no network.",
    ]);

    const view = await setCeiling(stub, {
      kind: "hosts",
      hosts: ["*.example.com", "Other.Example.org."],
      presets: ["package_registries"],
    });

    expect(view.network).toEqual({
      kind: "hosts",
      hosts: ["*.example.com", "other.example.org"],
      presets: ["package_registries"],
    });

    for (const network of [
      { kind: "open" },
      { kind: "hosts", hosts: ["elsewhere.example.net"] },
      { kind: "hosts", hosts: ["*.org"] },
    ] as const) {
      const above = await call(stub, ALICE, "sandbox_open", { network });

      expect(textOf(above)).toContain("The org does not allow that network");
    }

    const session = await open(stub, ALICE, { kind: "hosts", hosts: ["allowed.example.com"] });
    const allowed = await curl(stub, session, "https://allowed.example.com/data");

    expect(allowed["structuredContent"]).toMatchObject({
      exit_code: 0,
      stdout: "hello from allowed.example.com",
    });
    expect(reached).toContain("https://allowed.example.com/data");

    const other = await curl(stub, session, "https://other.example.org/");

    expect(other["isError"]).toBe(true);
    expect(textOf(other)).toContain("the sandbox's network does not allow other.example.org");
    expect(reached).not.toContain("https://other.example.org/");
  });

  it("refuses what the outbound guard refuses, even when open", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    await setCeiling(stub, { kind: "open" });
    const session = await open(stub, ALICE, { kind: "open" });

    expect(
      (await curl(stub, session, "https://public.example.com/"))["structuredContent"],
    ).toMatchObject({ exit_code: 0, stdout: "hello from public.example.com" });

    for (const url of [
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "http://public.example.com/",
      "https://app.example.com/v9/management/me",
    ]) {
      const result = await curl(stub, session, url);

      expect([url, result["isError"]]).toEqual([url, true]);
      expect(textOf(result)).toContain("Commissary only reaches public HTTPS addresses");
      expect(reached).not.toContain(url);
    }
  });

  it("checks every hop of a redirect: one to an address it may not reach fails without reaching it", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    await setCeiling(stub, { kind: "hosts", hosts: ["redirect.example.com"] });
    const session = await open(stub, ALICE, { kind: "hosts", hosts: ["redirect.example.com"] });

    for (const [path, refusal] of [
      ["/private", "the sandbox's network does not allow 10.0.0.1"],
      ["/away", "the sandbox's network does not allow other.example.org"],
    ] as const) {
      const result = await call(stub, ALICE, "sandbox_bash", {
        session,
        command: `curl -sS -L https://redirect.example.com${path}`,
      });

      expect([path, result["isError"]]).toEqual([path, true]);
      expect(textOf(result)).toContain(refusal);
      expect(reached).toContain(`https://redirect.example.com${path}`);
    }

    expect(reached).not.toContain("https://10.0.0.1/");
    expect(reached).not.toContain("https://other.example.org/");
  });

  it("has no way out but the egress point: git does not fetch, even from a host the network allows", async () => {
    const stub = withSandbox();

    await grantEveryone(stub);
    await setCeiling(stub, { kind: "hosts", hosts: ["allowed.example.com"] });
    const session = await open(stub, ALICE, { kind: "hosts", hosts: ["allowed.example.com"] });

    const cloned = await call(stub, ALICE, "sandbox_bash", {
      session,
      command: "git clone https://allowed.example.com/x",
    });

    expect(cloned["isError"]).toBe(true);
    expect(reached.filter((url) => url.startsWith("https://allowed.example.com/x"))).toEqual([]);
  });

  it("is set on the sandbox toolkit only, by its org admins, with host names only", async () => {
    const stub = withSandbox();

    const malformed = await stub
      .tools()
      .updateToolkit(
        ADMIN,
        "sandbox",
        1,
        { network: { kind: "hosts", hosts: ["https://x.com/"] } },
        "a",
        POLICY,
      );

    expect(malformed.ok ? undefined : malformed.error).toBe("invalid");
    expect(
      await stub
        .tools()
        .updateToolkit(ALICE, "sandbox", 1, { network: { kind: "open" } }, "alice", POLICY)
        .then((result) => (result.ok ? undefined : result.error)),
    ).toBe("forbidden");

    const browser = env.BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID());

    const onBrowser = await browser
      .tools()
      .updateToolkit(ADMIN, "browser", 1, { network: { kind: "open" } }, "a", POLICY);

    expect(onBrowser.ok ? undefined : onBrowser.error).toBe("built_in");
  });
});

describe("another sandbox provider", () => {
  it("serves the same tools", async () => {
    const stub = withOtherProvider();

    await grantEveryone(stub);
    const { toolkits } = await stub.tools().listToolkits(ALICE);

    expect(toolkits.map((toolkit) => [toolkit.id, toolkit.source])).toEqual([
      ["sandbox", "fake-sandbox"],
    ]);
    expect((await stub.tools().clientTools(ALICE)).map((tool) => tool.name)).toEqual([
      "sandbox_bash",
      "sandbox_close",
      "sandbox_edit",
      "sandbox_list",
      "sandbox_open",
      "sandbox_read",
      "sandbox_write",
    ]);

    const session = await open(stub, ALICE);

    await call(stub, ALICE, "sandbox_write", { session, path: "a.txt", content: "one" });
    await call(stub, ALICE, "sandbox_edit", {
      session,
      path: "a.txt",
      edits: [{ oldText: "one", newText: "two" }],
    });

    expect(textOf(await call(stub, ALICE, "sandbox_bash", { session, command: "cat a.txt" }))).toBe(
      "two\n\nstderr:\nfake-sandbox",
    );
    expect(textOf(await call(stub, BOB, "sandbox_read", { session, path: "a.txt" }))).toContain(
      "Unknown sandbox session",
    );
    await call(stub, ALICE, "sandbox_close", { session });
    expect(textOf(await call(stub, ALICE, "sandbox_list", { session }))).toContain("is closed");
  });
});
