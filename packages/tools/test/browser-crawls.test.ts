// The browser toolkit's crawl tools (#270) in the Tools part over RPC, on a deployment whose settings have the account
// and API token of Browser Run's crawls (`CrawlControlPlane`, test/worker.ts; its REST API is a fake served through the
// global `fetch`): they reach a member through grants like any tool, with Commissary's classes, and take at most the
// deployment's cap of pages; a crawl belongs to the member and principal that started it, so nobody else reaches it;
// the part cancels the crawls that may still be running at Browser Run when their member leaves and when the org is
// deleted, and forgets a crawl 21 days after it started, when Browser Run no longer keeps its pages (`TestClock` drives
// the time). Without the token there are no crawl tools (test/browser-toolkit.test.ts lists the toolkit without them).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { type Duration, Effect, type Schema } from "effect";
import { TestClock } from "effect/testing";
import { OrgId } from "@commissary/core";
import type { ToolGrantBody } from "@commissary/contract/grants";
import { CRAWL_KEPT_MS, CRAWL_RUN_MS } from "../src/browser/crawls.ts";
import { deleteOrgBrowserCrawls } from "../src/org-deletion.ts";
import { CRAWL_MAX_PAGES, CRAWL_ORIGIN, fakeCrawlApi } from "./support/fake-crawl.ts";
import { routeFakeServer, serveFakeServers } from "./support/fake-fetch.ts";
import { textOf } from "./support/tool-result.ts";

serveFakeServers();

const api = fakeCrawlApi();

routeFakeServer(CRAWL_ORIGIN, api.handle);

const POLICY = { ownHosts: ["app.example.com"], localDevelopment: false };

const ALICE = { member: "m-alice", admin: false };

const BOB = { member: "m-bob", admin: false };

type Viewer = typeof ALICE;

const CRAWL_TOOLS = ["browser_crawl_cancel", "browser_crawl_result", "browser_crawl_start"];

const withCrawls = () => env.CRAWL_CONTROL_PLANE.getByName(crypto.randomUUID());

type Stub = ReturnType<typeof withCrawls>;

const grant = async (stub: Stub, body: ToolGrantBody) => {
  const written = await stub.tools().writeGrant({ revision: 0, value: body }, "test");

  if (!written.ok) throw new Error(written.message);
};

const grantEveryone = (stub: Stub) =>
  grant(stub, { subject: { kind: "everyone" }, toolkit: "browser", tools: { kind: "all" } });

/** A call's result, or what else it came to; `principalId` null names no principal. */
const call = async (
  stub: Stub,
  viewer: Viewer,
  name: string,
  args: Schema.JsonObject,
  principalId: string | null = `user:${viewer.member}@example.com`,
) => {
  const outcome = await stub
    .tools()
    .callTool(
      viewer,
      { name, arguments: args, ...(principalId === null ? {} : { principalId }) },
      POLICY,
    );

  return outcome.outcome === "result" ? outcome.result : outcome.outcome;
};

/** Starts a crawl as `viewer` (and `principal`); answers its id. */
const start = async (stub: Stub, viewer: Viewer, principal?: string) => {
  const result = await call(
    stub,
    viewer,
    "browser_crawl_start",
    { url: "https://docs.example.com/" },
    principal,
  );

  if (typeof result === "string" || result["isError"] === true)
    throw new Error(`the crawl did not start: ${JSON.stringify(result)}`);

  // SAFETY: a started crawl answers its id in the structured content.
  return (result["structuredContent"] as { crawlId: string }).crawlId;
};

/** The status `viewer` reads of the crawl `id`, or what the call answered instead. */
const statusOf = async (stub: Stub, viewer: Viewer, id: string, principal?: string) => {
  const text = textOf(await call(stub, viewer, "browser_crawl_result", { crawlId: id }, principal));

  try {
    // SAFETY: a crawl's result is its JSON.
    return (JSON.parse(text ?? "") as { status: string }).status;
  } catch {
    return text;
  }
};

/** A `TestClock` at the real time, which the org's Tools part reads the time from from now on; `adjust` moves it. */
const testClock = async (stub: Stub) => {
  const clock = await Effect.runPromise(Effect.scoped(TestClock.make()));
  const now = Date.now();

  await Effect.runPromise(clock.setTime(now));
  await runInDurableObject(stub, (instance) => instance.tools().useClock(clock));

  return {
    /** The time the clock was set to. */
    now,
    adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)),
  };
};

/** The ids among `ids` of the crawls the part asked Browser Run to cancel, in the order it asked. */
const cancelled = (ids: ReadonlyArray<string>) =>
  api.requests
    .filter((request) => request.method === "DELETE")
    .map((request) => request.path.split("/").at(-1) ?? "")
    .filter((id) => ids.includes(id));

/** The org's crawls as its ControlPlane keeps them: id, member and principal. */
const logged = async (stub: Stub) =>
  await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<{ id: string; member: string; principal: string }>(
        "SELECT id, member, principal FROM browser_crawls ORDER BY started_at, id",
      )
      .toArray()
      .map((row) => [row.id, row.member, row.principal]),
  );

describe("the browser toolkit's crawl tools", () => {
  it("are on the toolkit of a deployment with the crawls' token, start and cancel writing and result reading", async () => {
    const stub = withCrawls();
    const tools = await stub.tools().listTools(ALICE, "browser");

    expect(
      tools.ok &&
        tools.value.tools
          .filter((tool) => CRAWL_TOOLS.includes(tool.name))
          .map((tool) => [tool.id, tool.name, tool.class]),
    ).toEqual([
      ["browser:crawl_start", "browser_crawl_start", "write"],
      ["browser:crawl_result", "browser_crawl_result", "read"],
      ["browser:crawl_cancel", "browser_crawl_cancel", "write"],
    ]);
  });

  it("reach a member only through a grant, a read grant giving the result alone", async () => {
    const stub = withCrawls();

    const crawlTools = async () =>
      (await stub.tools().clientTools(ALICE))
        .map((tool) => tool.name)
        .filter((name) => CRAWL_TOOLS.includes(name));

    expect(await crawlTools()).toEqual([]);
    expect(await call(stub, ALICE, "browser_crawl_start", { url: "https://a.example/" })).toBe(
      "unknown",
    );

    await grant(stub, {
      subject: { kind: "everyone" },
      toolkit: "browser",
      tools: { kind: "read" },
    });
    expect(await crawlTools()).toEqual(["browser_crawl_result"]);

    await grantEveryone(stub);
    expect((await crawlTools()).toSorted()).toEqual(CRAWL_TOOLS);
  });

  it("start a crawl through Browser Run's REST API and read it back, for the member and principal that started it only", async () => {
    const stub = withCrawls();

    await grantEveryone(stub);
    const id = await start(stub, ALICE);

    expect(await statusOf(stub, ALICE, id)).toBe("running");
    // Bob, and Alice through an API key of hers, did not start it.
    expect(await statusOf(stub, BOB, id)).toBe(`There is no crawl ${id}.`);
    expect(await statusOf(stub, ALICE, id, "key:alice-laptop")).toBe(`There is no crawl ${id}.`);
    expect(textOf(await call(stub, BOB, "browser_crawl_cancel", { crawlId: id }))).toBe(
      `There is no crawl ${id}.`,
    );
    expect(api.jobs.get(id)?.status).toBe("running");

    expect(textOf(await call(stub, ALICE, "browser_crawl_cancel", { crawlId: id }))).toBe(
      `Cancelled crawl ${id}.`,
    );
    expect(await statusOf(stub, ALICE, id)).toBe("cancelled_by_user");
  });

  it("take at most the deployment's cap of pages", async () => {
    const stub = withCrawls();

    await grantEveryone(stub);
    const asked = api.requests.length;

    expect(
      textOf(
        await call(stub, ALICE, "browser_crawl_start", {
          url: "https://docs.example.com/",
          limit: CRAWL_MAX_PAGES + 1,
        }),
      ),
    ).toMatch(/^Invalid arguments: /);
    expect(api.requests.length).toBe(asked);

    const result = await call(stub, ALICE, "browser_crawl_start", {
      url: "https://docs.example.com/",
      limit: CRAWL_MAX_PAGES,
    });

    expect(typeof result !== "string" && result["isError"]).not.toBe(true);
    expect(api.requests.at(-1)?.body).toMatchObject({ limit: CRAWL_MAX_PAGES });
  });

  it("are refused to a call that names no principal", async () => {
    const stub = withCrawls();

    await grantEveryone(stub);

    expect(
      textOf(await call(stub, ALICE, "browser_crawl_start", { url: "https://a.example/" }, null)),
    ).toBe("Browser crawls need a caller with an identity: an API key or a signed-in person.");
    expect(await logged(stub)).toEqual([]);
  });

  it("refuse to start from an address the outbound guard refuses", async () => {
    const stub = withCrawls();

    await grantEveryone(stub);
    const asked = api.requests.length;

    expect(
      textOf(await call(stub, ALICE, "browser_crawl_start", { url: "https://app.example.com/" })),
    ).toBe("Invalid arguments: Commissary only reaches public HTTPS addresses");
    expect(api.requests.length).toBe(asked);
    expect(await logged(stub)).toEqual([]);
  });
});

describe("the org's browser crawls", () => {
  it("are cancelled at Browser Run, those that may still run, and forgotten when the member who started them leaves", async () => {
    const stub = withCrawls();
    const clock = await testClock(stub);

    await grantEveryone(stub);
    // Alice's first crawl started seven days ago: Browser Run has ended it.
    const ended = await start(stub, ALICE);

    await clock.adjust(CRAWL_RUN_MS);
    const alices = await start(stub, ALICE);
    const bobs = await start(stub, BOB);

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().memberLeft(ALICE.member);
    });

    expect(cancelled([ended, alices, bobs])).toEqual([alices]);
    expect(api.jobs.get(alices)?.status).toBe("cancelled_by_user");
    expect(api.jobs.get(bobs)?.status).toBe("running");
    expect(await logged(stub)).toEqual([[bobs, BOB.member, "user:m-bob@example.com"]]);
    expect(await statusOf(stub, ALICE, alices)).toBe(`There is no crawl ${alices}.`);
  });

  it("are forgotten 21 days after they started, when Browser Run no longer keeps their pages", async () => {
    const stub = withCrawls();
    const clock = await testClock(stub);

    await grantEveryone(stub);
    const id = await start(stub, ALICE);

    expect(await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm())).toBe(
      clock.now + CRAWL_KEPT_MS,
    );

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(clock.now + CRAWL_KEPT_MS - 1);
    });
    expect((await logged(stub)).map(([crawl]) => crawl)).toEqual([id]);

    await runInDurableObject(stub, async (instance) => {
      await instance.tools().alarm(clock.now + CRAWL_KEPT_MS);
    });
    expect(await logged(stub)).toEqual([]);
  });

  it("are cancelled at Browser Run when the org is deleted, within the deletion's budget", async () => {
    const org = OrgId.make(crypto.randomUUID());
    const stub = env.CRAWL_CONTROL_PLANE.getByName(org);
    const step = deleteOrgBrowserCrawls({ CONTROL_PLANE: env.CRAWL_CONTROL_PLANE });

    await grantEveryone(stub);
    const crawls = [await start(stub, ALICE), await start(stub, BOB)];

    // Too little budget for a page: nothing is cancelled, and the step says it stopped.
    expect(await step(org, 20)).toEqual({ complete: false, calls: 0, part: "crawls" });
    expect(cancelled(crawls)).toEqual([]);

    // One call of the ControlPlane, and one request of its to Browser Run per crawl.
    expect(await step(org, 400)).toEqual({ complete: true, calls: 3 });
    expect(cancelled(crawls).toSorted()).toEqual(crawls.toSorted());
    expect(crawls.map((id) => api.jobs.get(id)?.status)).toEqual([
      "cancelled_by_user",
      "cancelled_by_user",
    ]);
    expect(await logged(stub)).toEqual([]);
  });
});
