// The sandbox's computer (#223) in the Tools part over RPC: Cloudflare's sandbox on a deployment that attached the
// computer's container (`ComputerSandboxControlPlane`), with the container faked (`support/fake-computer.ts`) where the
// session objects run it. A command line just-bash cannot run at all runs on the computer, on the same files; one it can
// run stays on just-bash, even when it fails, and is never run again. The computer's installs, under mise's directory
// in the Workspace, outlast its restarts. It reaches the network only through the session's egress, as just-bash does.
// Where the computer is off (the org's ceiling, the session's choice, or a deployment without one), such a line answers
// just-bash's error with a note that says so, when it failed. And the real way out: a request of the computer's container
// comes back through `WorkspaceProxy` to its session object and `@cloudflare/computer`'s container backend, which sends
// it to `SandboxEgress`, with the session's network and the outbound guard.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Schema } from "effect";
import type { SandboxNetwork } from "@commissary/contract/tools";
import { NO_COMPUTER } from "../src/sandbox/toolkit.ts";
import { computerStarts } from "./support/fake-computer.ts";
import { fakeContainerOf, LAUNCH_STOPPED, realContainerOrgs } from "./support/fake-container.ts";

const POLICY = { ownHosts: ["app.example.com"], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

type Viewer = typeof ALICE;

const withComputer = () => {
  const org = crypto.randomUUID();

  return { org, stub: env.COMPUTER_SANDBOX_CONTROL_PLANE.getByName(org) };
};

type Stub = ReturnType<typeof withComputer>["stub"] | ReturnType<typeof withoutComputer>;

const withoutComputer = () => env.SANDBOX_CONTROL_PLANE.getByName(crypto.randomUUID());

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

const call = async (stub: Stub, viewer: Viewer, name: string, args: Schema.JsonObject) => {
  const outcome = await stub
    .tools()
    .callTool(
      viewer,
      { name, arguments: args, principalId: `user:${viewer.member}@example.com` },
      POLICY,
    );

  if (outcome.outcome !== "result") throw new Error(`the call came to ${outcome.outcome}`);

  return outcome.result;
};

const textOf = (result: Schema.JsonObject): string => {
  const [first] = result["content"] as ReadonlyArray<{ text: string }>;

  return first?.text ?? "";
};

const revisionOf = async (stub: Stub) =>
  (await stub.tools().listToolkits(ADMIN)).toolkits.find((toolkit) => toolkit.id === "sandbox")
    ?.revision ?? 0;

/** Sets the org's ceiling for the sandbox: its network and whether it allows the computer. */
const allow = async (stub: Stub, change: { network?: SandboxNetwork; computer?: boolean }) => {
  const updated = await stub
    .tools()
    .updateToolkit(ADMIN, "sandbox", await revisionOf(stub), change, "admin", POLICY);

  if (!updated.ok) throw new Error(updated.message);

  return updated.value;
};

const open = async (stub: Stub, args: Schema.JsonObject = { computer: true }) => {
  const result = await call(stub, ALICE, "sandbox_open", args);

  expect([result["isError"], textOf(result)]).toEqual([undefined, expect.any(String)]);

  return (result["structuredContent"] as { session: string }).session;
};

const bash = async (stub: Stub, session: string, command: string) =>
  await call(stub, ALICE, "sandbox_bash", { session, command });

/** How many times the computer of `org`'s session `session` started. */
const startsOf = async (org: string, session: string) =>
  await runInDurableObject(
    env.SANDBOX_SESSION.getByName(`${org}:${session}`),
    (_instance, state) => computerStarts.get(state.id.toString()) ?? 0,
  );

describe("the sandbox's computer", () => {
  const reached: Array<string> = [];
  const realFetch = globalThis.fetch;

  // The egress entrypoint runs in this isolate: what it forwards reaches this fake internet.
  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);

      reached.push(request.url);

      return new Response(`hello from ${new URL(request.url).hostname}`);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  it("is off unless an org admin allows it, and the toolkit says which", async () => {
    const { stub } = withComputer();

    await grantEveryone(stub);
    const { toolkits } = await stub.tools().listToolkits(ALICE);

    expect(toolkits.find((toolkit) => toolkit.id === "sandbox")).toMatchObject({
      computer: false,
    });

    const refused = await call(stub, ALICE, "sandbox_open", { computer: true });

    expect([refused["isError"], textOf(refused)]).toEqual([
      true,
      "The org does not allow the computer: a sandbox runs every command with just-bash. An org admin may allow it on the sandbox toolkit.",
    ]);

    expect((await allow(stub, { computer: true })).computer).toBe(true);
  });

  it("runs what just-bash cannot, on the session's files: node after mise use reads what the file tools wrote", async () => {
    const { org, stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, {
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
      computer: true,
    });

    const session = await open(stub, {
      computer: true,
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
    });

    await call(stub, ALICE, "sandbox_write", {
      session,
      path: "app.js",
      content: "console.log('hi')",
    });
    // just-bash writes a file too.
    await bash(stub, session, "echo 'from just-bash' > made.txt");
    expect(await startsOf(org, session)).toBe(0);

    const installed = await bash(stub, session, "mise use node@22");

    expect(installed["structuredContent"]).toMatchObject({ exit_code: 0 });
    expect(reached.some((url) => url.startsWith("https://nodejs.org/"))).toBe(true);
    // mise's config is a file of the session's too, for the file tools.
    expect(textOf(await call(stub, ALICE, "sandbox_read", { session, path: "mise.toml" }))).toBe(
      '[tools]\nnode = "22"\n',
    );

    expect((await bash(stub, session, "node --version"))["structuredContent"]).toMatchObject({
      exit_code: 0,
      stdout: "v22.0.0\n",
    });
    expect((await bash(stub, session, "node app.js"))["structuredContent"]).toMatchObject({
      exit_code: 0,
      stdout: "v22.0.0 ran app.js: console.log('hi')",
    });
    expect((await bash(stub, session, "node made.txt"))["structuredContent"]).toMatchObject({
      stdout: "v22.0.0 ran made.txt: from just-bash\n",
    });
    // One computer served them all.
    expect(await startsOf(org, session)).toBe(1);
  });

  it("is not where a line just-bash runs goes, even one that fails: it runs once, on just-bash", async () => {
    const { org, stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, { computer: true });
    const session = await open(stub);

    const failed = await bash(stub, session, "cat missing.txt");

    expect(failed["isError"]).toBe(true);
    expect(failed["structuredContent"]).toMatchObject({ exit_code: 1 });
    expect(failed["structuredContent"]).not.toHaveProperty("note");
    expect(textOf(failed)).toContain("No such file or directory");

    const grep = await bash(stub, session, "echo a | grep b");

    expect(grep["structuredContent"]).toMatchObject({ exit_code: 1 });
    expect(await startsOf(org, session)).toBe(0);
  });

  it("keeps what mise installed when the computer stops and starts again", async () => {
    const { org, stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, {
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
      computer: true,
    });

    const session = await open(stub, {
      computer: true,
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
    });

    expect((await bash(stub, session, "mise use python@3.12"))["structuredContent"]).toMatchObject({
      exit_code: 0,
    });
    expect(await startsOf(org, session)).toBe(1);

    // The object restarts (an eviction, a deploy): the computer it had is gone, and a new one starts on the next line.
    const object = env.SANDBOX_SESSION.getByName(`${org}:${session}`);

    await runInDurableObject(object, (_instance, state) => {
      state.abort("restart");
    }).catch(() => undefined);

    const before = reached.length;

    expect((await bash(stub, session, "python3 --version"))["structuredContent"]).toMatchObject({
      exit_code: 0,
      stdout: "Python 3.12.0\n",
    });
    expect(await startsOf(org, session)).toBe(2);
    // Nothing was downloaded again.
    expect(reached.length).toBe(before);
  });

  it("reaches only the session's network: none makes mise fail, package_registries lets it install", async () => {
    const { stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, {
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
      computer: true,
    });

    const offline = await open(stub);
    const before = reached.length;
    const failed = await bash(stub, offline, "mise use node@22");

    expect(failed["isError"]).toBe(true);
    expect(textOf(failed)).toContain("the sandbox has no network");
    expect(reached.length).toBe(before);
    expect((await bash(stub, offline, "node --version"))["structuredContent"]).toMatchObject({
      exit_code: 127,
    });

    const online = await open(stub, {
      computer: true,
      network: { kind: "hosts", hosts: [], presets: ["package_registries"] },
    });

    expect((await bash(stub, online, "mise use node@22"))["structuredContent"]).toMatchObject({
      exit_code: 0,
    });
  });

  it("goes through the egress point: the hosts the network allows, and never what the outbound guard refuses", async () => {
    const { stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, { network: { kind: "open" }, computer: true });

    const allowed = await open(stub, {
      computer: true,
      network: { kind: "hosts", hosts: ["allowed.example.com"] },
    });

    const outside = await bash(stub, allowed, "mise use node@22");

    expect(outside["structuredContent"]).toMatchObject({ exit_code: 1 });
    expect(textOf(outside)).toContain("the sandbox's network does not allow nodejs.org");

    const anywhere = await open(stub, { computer: true, network: { kind: "open" } });

    expect((await bash(stub, anywhere, "mise use node@22"))["structuredContent"]).toMatchObject({
      exit_code: 0,
    });

    for (const url of ["https://10.0.0.1/", "https://169.254.169.254/latest/meta-data"]) {
      // `node` is the computer's: the request is the computer's own, through its intercept.
      const result = await bash(stub, anywhere, `mise use node@22 && curl -sS ${url}`);

      expect([url, result["isError"]]).toEqual([url, true]);
      expect(textOf(result)).toContain("Commissary only reaches public HTTPS addresses");
      expect(reached).not.toContain(url);
    }
  });
});

describe("the computer's way out", () => {
  const reached: Array<string> = [];
  const realFetch = globalThis.fetch;

  beforeAll(() => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);

      reached.push(request.url);

      return new Response(`hello from ${new URL(request.url).hostname}`);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  /**
   * A session of a fresh org on the real container backend over the fake container, its computer launched as far as
   * the intercept of its outbound traffic, and a request of the computer's: through the intercept the platform sets
   * (`WorkspaceProxy`), to the session object (`SandboxSession.fetch`) and its backend (`handleFetch`), to the egress.
   */
  const computerOf = async (network: SandboxNetwork) => {
    const { org, stub } = withComputer();

    realContainerOrgs.add(org);
    await grantEveryone(stub);
    await allow(stub, { network: { kind: "open" }, computer: true });
    const session = await open(stub, { computer: true, network });
    const launched = await bash(stub, session, "node --version");

    expect([launched["isError"], textOf(launched)]).toEqual([
      true,
      expect.stringContaining(LAUNCH_STOPPED),
    ]);

    const object = env.SANDBOX_SESSION.getByName(`${org}:${session}`);

    return async (url: string) =>
      await runInDurableObject(object, async (_instance, state) => {
        const outbound = fakeContainerOf(state.id.toString()).outbound;

        if (outbound === undefined) throw new Error("the computer has no outbound intercept");

        return await outbound.fetch(url).then(
          async (response) => ({ status: response.status, body: await response.text() }),
          (error: Error) => ({ refused: error.message }),
        );
      });
  };

  it("reaches a host the session's network allows, and no other", async () => {
    const send = await computerOf({ kind: "hosts", hosts: ["allowed.example.com"] });

    expect(await send("https://allowed.example.com/data")).toEqual({
      status: 200,
      body: "hello from allowed.example.com",
    });
    expect(reached).toContain("https://allowed.example.com/data");

    expect(await send("https://other.example.org/")).toEqual({
      refused: expect.stringContaining("the sandbox's network does not allow other.example.org"),
    });
    expect(reached).not.toContain("https://other.example.org/");
  });

  it("never reaches what the outbound guard refuses, even on the open internet", async () => {
    const send = await computerOf({ kind: "open" });

    expect(await send("https://public.example.com/")).toMatchObject({ status: 200 });

    for (const url of [
      "https://10.0.0.1/",
      "https://169.254.169.254/latest/meta-data",
      "http://public.example.com/",
      "https://app.example.com/v9/management/me",
    ]) {
      expect([url, await send(url)]).toEqual([
        url,
        { refused: expect.stringContaining("Commissary only reaches public HTTPS addresses") },
      ]);
      expect(reached).not.toContain(url);
    }
  });
});

describe("the computer, off", () => {
  it("answers a line just-bash cannot run with just-bash's error and a note that the session's computer is off", async () => {
    const { org, stub } = withComputer();

    await grantEveryone(stub);
    await allow(stub, { computer: true });
    const session = await open(stub, {});
    const result = await bash(stub, session, "node --version");

    expect(result["isError"]).toBe(true);
    const { note } = result["structuredContent"] as { note?: string };

    expect(note).toContain("this session's computer is off");
    expect(textOf(result)).toContain(note ?? "");
    expect(await startsOf(org, session)).toBe(0);

    // A line just-bash runs has no note.
    expect(await bash(stub, session, "echo ok")).toMatchObject({
      structuredContent: { exit_code: 0, stdout: "ok\n" },
    });
    expect((await bash(stub, session, "echo ok"))["structuredContent"]).not.toHaveProperty("note");

    // Nor does a line that tests for a command just-bash lacks and copes without it; one that runs it behind a wrapper,
    // and fails, gets the note.
    const coped = await bash(stub, session, "if node -v; then echo node; else echo none; fi");

    expect(coped["structuredContent"]).toMatchObject({ exit_code: 0, stdout: "none\n" });
    expect(coped["structuredContent"]).not.toHaveProperty("note");
    expect(
      (await bash(stub, session, "env FOO=1 node app.js"))["structuredContent"],
    ).toHaveProperty("note", expect.stringContaining("just-bash has no node command"));
  });

  it("cannot be allowed or asked for on a deployment without one", async () => {
    const stub = withoutComputer();

    await grantEveryone(stub);
    const { toolkits } = await stub.tools().listToolkits(ADMIN);

    expect(toolkits.find((toolkit) => toolkit.id === "sandbox")).toMatchObject({
      computer: false,
    });

    const allowed = await stub
      .tools()
      .updateToolkit(ADMIN, "sandbox", await revisionOf(stub), { computer: true }, "a", POLICY);

    expect(allowed.ok ? undefined : allowed.error).toBe("invalid");

    const asked = await call(stub, ALICE, "sandbox_open", { computer: true });

    expect([asked["isError"], textOf(asked)]).toEqual([true, NO_COMPUTER]);

    const session = await open(stub, {});
    const result = await bash(stub, session, "git status");

    expect(result["isError"]).toBe(true);
    expect((result["structuredContent"] as { note?: string }).note).toContain("computer is off");
  });

  it("is a choice of the sandbox toolkit's alone", async () => {
    const browser = env.BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID());

    const onBrowser = await browser
      .tools()
      .updateToolkit(ADMIN, "browser", 1, { computer: true }, "a", POLICY);

    expect(onBrowser.ok ? undefined : onBrowser.error).toBe("built_in");
  });
});
