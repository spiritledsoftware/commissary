// The built-in browser toolkit (#212, ADR 0039, ADR 0041) in the Tools part over RPC: it exists exactly when the
// deployment has a `browser` binding (here a fake), reaches nobody until a tool grant gives it, serves Browser Run's
// Quick Actions on the MCP endpoint's list and calls, takes overrides and grants like any org toolkit, cannot be edited
// or removed, takes its name from stored toolkits that had it, and serves the same tools whatever browser provider is
// behind it.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Schema } from "effect";
import type { GrantSubject, ToolGrantBody } from "@commissary/contract/grants";
import { withPart } from "@commissary/state/testing";
import { UPGRADE_TO_BROWSER } from "./worker.ts";

const POLICY = { ownHosts: [], localDevelopment: false };

const ADMIN = { member: "m-admin", admin: true };

const ALICE = { member: "m-alice", admin: false };

const EVERYONE: GrantSubject = { kind: "everyone" };

const QUICK_ACTIONS = [
  "browser_accessibility_tree",
  "browser_html",
  "browser_links",
  "browser_markdown",
  "browser_pdf",
  "browser_scrape",
  "browser_screenshot",
];

const withBrowser = () => env.BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID());

const withoutBrowser = () => env.CONTROL_PLANE.getByName(crypto.randomUUID());

const withOtherProvider = () => env.OTHER_BROWSER_CONTROL_PLANE.getByName(crypto.randomUUID());

/** Every test ControlPlane has the same Tools part. */
type Stub = ReturnType<typeof withBrowser>;

const grant = async (stub: Stub, body: ToolGrantBody) => {
  const written = await stub.tools().writeGrant({ revision: 0, value: body }, "test");

  if (!written.ok) throw new Error(written.message);

  return written.value;
};

const listed = async (stub: Stub, viewer: typeof ALICE) =>
  (await stub.tools().clientTools(viewer)).map((tool) => tool.name);

/** The text of a call's result, or what else it came to. */
const call = async (
  stub: Stub,
  viewer: typeof ALICE,
  name: string,
  args: Schema.JsonObject = { url: "https://example.com/" },
  toolkits?: ReadonlyArray<string>,
) => {
  const outcome = await stub.tools().callTool(viewer, { name, arguments: args, toolkits }, POLICY);

  return outcome.outcome === "result" ? outcome.result : outcome.outcome;
};

describe("the browser toolkit", () => {
  it("is an org toolkit of Commissary's own, with a shared credential of kind none, for every member to see", async () => {
    const stub = withBrowser();

    for (const viewer of [ADMIN, ALICE]) {
      const { toolkits } = await stub.tools().listToolkits(viewer);

      expect(toolkits).toHaveLength(1);
      expect(toolkits[0]).toMatchObject({
        id: "browser",
        kind: "browser",
        name: "browser",
        source: "browser-run",
        private: false,
        accepts: "shared",
        built_in: true,
        credentials: { shared: { kind: "none", active: true } },
        tool_list: { tools: 7 },
      });
    }

    const tools = await stub.tools().listTools(ALICE, "browser");

    expect(tools.ok && tools.value.tools.map((tool) => [tool.id, tool.name, tool.class])).toEqual([
      ["browser:markdown", "browser_markdown", "read"],
      ["browser:html", "browser_html", "read"],
      ["browser:screenshot", "browser_screenshot", "read"],
      ["browser:pdf", "browser_pdf", "read"],
      ["browser:links", "browser_links", "read"],
      ["browser:scrape", "browser_scrape", "read"],
      ["browser:accessibility_tree", "browser_accessibility_tree", "read"],
    ]);
  });

  it("reaches nobody until a grant gives it; its tools then answer as unknown ones", async () => {
    const stub = withBrowser();

    expect(await listed(stub, ALICE)).toEqual([]);
    expect(await listed(stub, ADMIN)).toEqual([]);
    expect(await call(stub, ALICE, "browser_markdown")).toBe("unknown");
  });

  it("serves a granted member its Quick Actions, and a call returns the page's content", async () => {
    const stub = withBrowser();

    await grant(stub, { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } });

    const tools = await stub.tools().clientTools(ALICE);

    expect(tools.map((tool) => tool.name)).toEqual(QUICK_ACTIONS);
    expect(tools.every((tool) => tool.toolClass === "read" && tool.toolkit === "browser")).toBe(
      true,
    );
    expect(tools.find((tool) => tool.name === "browser_markdown")?.inputSchema).toMatchObject({
      type: "object",
      required: ["url"],
    });

    expect(
      await call(stub, ALICE, "browser_markdown", { url: "https://example.com/docs" }),
    ).toEqual({ content: [{ type: "text", text: "# Page at https://example.com/docs" }] });
    expect(await call(stub, ALICE, "browser_screenshot")).toMatchObject({
      content: [{ type: "image", mimeType: "image/png" }],
    });
    expect(
      await call(stub, ALICE, "browser_markdown", { url: "https://unreachable.invalid/" }),
    ).toEqual({
      content: [
        { type: "text", text: "net::ERR_NAME_NOT_RESOLVED at https://unreachable.invalid/" },
      ],
      isError: true,
    });
    expect(await call(stub, ALICE, "browser_crawl")).toBe("unknown");
  });

  it("narrows to the toolkits a request names, as any toolkit", async () => {
    const stub = withBrowser();

    await grant(stub, { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } });

    expect(await call(stub, ALICE, "browser_links", undefined, ["github"])).toBe("unknown");
    expect(await call(stub, ALICE, "browser_links", undefined, ["browser"])).toMatchObject({
      content: [{ type: "text" }],
    });
  });

  it("takes overrides that hide its tools or change their class, and grants by class or by name", async () => {
    const stub = withBrowser();

    await grant(stub, { subject: EVERYONE, toolkit: "browser", tools: { kind: "read" } });
    expect(await listed(stub, ALICE)).toEqual(QUICK_ACTIONS);

    const hidden = await stub
      .tools()
      .setOverride(ADMIN, "browser", 0, { tool: "pdf", hidden: true }, "test");

    expect(hidden.ok).toBe(true);

    const reclassified = await stub
      .tools()
      .setOverride(ADMIN, "browser", 0, { tool: "screenshot", class: "write" }, "test");

    expect(reclassified.ok && "class" in reclassified.value && reclassified.value.class).toBe(
      "write",
    );

    // A read grant no longer gives the screenshot, and the hidden PDF is served to nobody.
    expect(await listed(stub, ALICE)).toEqual(
      QUICK_ACTIONS.filter((name) => name !== "browser_pdf" && name !== "browser_screenshot"),
    );
    expect(await call(stub, ALICE, "browser_screenshot")).toBe("unknown");
    expect(await call(stub, ALICE, "browser_pdf")).toBe("unknown");

    // A grant of the screenshot by name gives it back.
    await grant(stub, {
      subject: EVERYONE,
      toolkit: "browser",
      tools: { kind: "named", ids: ["browser:screenshot"] },
    });

    expect(await listed(stub, ALICE)).toContain("browser_screenshot");
    expect(
      (await stub.tools().listGrants()).grants.map((entry) => entry.tools.kind).toSorted(),
    ).toEqual(["named", "read"]);

    // A plain member manages none of it.
    expect(
      (await stub.tools().setOverride(ALICE, "browser", 0, { tool: "links", hidden: true }, "t"))
        .ok,
    ).toBe(false);
  });

  it("cannot be renamed, edited, given a credential, refreshed or removed, and its name is taken", async () => {
    const stub = withBrowser();
    const tools = stub.tools();

    expect(
      await tools.updateToolkit(ADMIN, "browser", 1, { name: "web" }, "test", POLICY),
    ).toMatchObject({
      ok: false,
      error: "built_in",
    });
    expect(await tools.removeToolkit(ADMIN, "browser", 1)).toMatchObject({
      ok: false,
      error: "built_in",
    });
    expect(await tools.removeToolkit(ALICE, "browser", 1)).toMatchObject({
      ok: false,
      error: "forbidden",
    });
    expect(
      await tools.connectCredential(
        ADMIN,
        "browser",
        "shared",
        { kind: "bearer", token: "t", subject: EVERYONE },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "built_in" });
    expect(await tools.disconnectCredential(ADMIN, "browser", "shared")).toMatchObject({
      ok: false,
      error: "built_in",
    });
    expect(await tools.refreshToolList(ADMIN, "browser", POLICY)).toMatchObject({
      ok: false,
      error: "built_in",
    });

    await stub.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

    for (const [viewer, isPrivate] of [
      [ADMIN, false],
      [ALICE, true],
    ] as const)
      expect(
        await tools.addToolkit(
          viewer,
          {
            source: "https://mcp.example.com/mcp",
            name: "browser",
            private: isPrivate,
            accepts: isPrivate ? "private" : "shared",
          },
          "test",
          POLICY,
        ),
      ).toMatchObject({ ok: false, error: "name_taken" });

    expect((await tools.listToolkits(ADMIN)).toolkits.map((toolkit) => toolkit.id)).toEqual([
      "browser",
    ]);
  });

  it("takes approval rules as any toolkit, and nothing else of an edit: its marked tools' calls wait", async () => {
    const stub = withBrowser();
    const tools = stub.tools();

    await grant(stub, { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } });

    expect(
      await tools.updateToolkit(
        ADMIN,
        "browser",
        1,
        { approval_rules: { tools: [{ id: "browser:screenshot" }] } },
        "test",
        POLICY,
      ),
    ).toMatchObject({
      ok: true,
      value: {
        revision: 2,
        approval_rules: { tools: [{ id: "browser:screenshot", approver: { kind: "caller" } }] },
      },
    });
    // A stale revision, or anything but its rules, is refused.
    expect(
      await tools.updateToolkit(ADMIN, "browser", 1, { approval_rules: null }, "test", POLICY),
    ).toMatchObject({ ok: false, error: "conflict" });
    expect(
      await tools.updateToolkit(
        ADMIN,
        "browser",
        2,
        { name: "web", approval_rules: null },
        "test",
        POLICY,
      ),
    ).toMatchObject({ ok: false, error: "built_in" });
    expect(
      await tools.updateToolkit(ALICE, "browser", 2, { approval_rules: null }, "test", POLICY),
    ).toMatchObject({ ok: false, error: "forbidden" });

    expect(
      await tools.callTool(
        ALICE,
        {
          name: "browser_screenshot",
          arguments: { url: "https://example.com/" },
          principalId: "user:alice",
          approvalOutcomes: true,
        },
        POLICY,
      ),
    ).toMatchObject({ outcome: "pending", usage: { toolkitId: "browser", approval: "pending" } });
    expect(await call(stub, ALICE, "browser_links")).toMatchObject({ content: expect.any(Array) });

    // Cleared, the call goes to the provider.
    await tools.updateToolkit(ADMIN, "browser", 2, { approval_rules: null }, "test", POLICY);
    expect(await call(stub, ALICE, "browser_screenshot")).toMatchObject({
      content: expect.any(Array),
    });
  });

  it("serves the same tools whatever browser provider is behind it", async () => {
    const browserRun = withBrowser();
    const other = withOtherProvider();

    for (const stub of [browserRun, other])
      await grant(stub, { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } });

    expect(await other.tools().clientTools(ALICE)).toEqual(
      await browserRun.tools().clientTools(ALICE),
    );
    expect((await other.tools().listToolkits(ALICE)).toolkits[0]?.source).toBe("other-browser");
    expect(await call(other, ALICE, "browser_markdown")).toEqual({
      content: [{ type: "text", text: "other-browser markdown https://example.com/" }],
    });
  });
});

describe("a deployment that gains the browser binding", () => {
  it("renames the org and private toolkits named browser once, to names no toolkit has", async () => {
    const name = crypto.randomUUID();
    const before = env.UPGRADED_CONTROL_PLANE.getByName(name);

    await before.setMembershipSettings({ privateCredentials: true, privateToolkits: true });

    const add = async (viewer: typeof ALICE, toolkit: string, isPrivate: boolean) => {
      // A stub of the part the test still held would keep the object from being evicted.
      const added = await withPart(before.tools(), (tools) =>
        tools.addToolkit(
          viewer,
          {
            source: "https://mcp.example.com/mcp",
            name: toolkit,
            private: isPrivate,
            accepts: isPrivate ? "private" : "shared",
          },
          "test",
          POLICY,
        ),
      );

      if (!added.ok) throw new Error(added.message);

      return added.value.id;
    };

    // Alice's private toolkit first: an org toolkit may then take its name (ADR 0037).
    const alices = await add(ALICE, "browser", true);
    const org = await add(ADMIN, "browser", false);

    await add(ADMIN, "browser_2", false);

    await runInDurableObject(before, (_instance, state) => {
      state.storage.kv.put(UPGRADE_TO_BROWSER, true);
    });
    await evictDurableObject(before);

    for (let start = 0; start < 2; start++) {
      const after = env.UPGRADED_CONTROL_PLANE.getByName(name);

      const [toolkits, alicesToolkits] = await withPart(after.tools(), async (tools) => [
        (await tools.listToolkits(ADMIN)).toolkits,
        (await tools.listToolkits(ALICE)).toolkits,
      ]);

      const alicesView = alicesToolkits.find((toolkit) => toolkit.private);

      const orgView = toolkits.find((toolkit) => toolkit.id === org);

      const byName = (a: string | undefined, b: string | undefined) =>
        String(a).localeCompare(String(b));

      expect(toolkits.map((toolkit) => toolkit.name).toSorted(byName)).toEqual([
        "browser",
        "browser_2",
        orgView?.name,
      ]);

      // The two take the next names no toolkit has, in the order they were added (which can tie).
      expect([orgView?.name, alicesView?.name].toSorted(byName)).toEqual([
        "browser_3",
        "browser_4",
      ]);

      for (const renamed of [orgView, alicesView])
        expect(renamed).toMatchObject({ revision: 2, updated_by: "commissary" });

      expect(alicesView?.id).toBe(alices);

      // Renamed once: the next start finds no toolkit named browser but the built-in one.
      await evictDurableObject(after);
    }
  });
});

describe("a deployment without a browser binding", () => {
  it("has no browser toolkit anywhere: not listed, not served, not granted", async () => {
    const stub = withoutBrowser();

    expect((await stub.tools().listToolkits(ADMIN)).toolkits).toEqual([]);
    expect(await stub.tools().listTools(ADMIN, "browser")).toMatchObject({
      ok: false,
      error: "not_found",
    });
    expect(
      await stub
        .tools()
        .writeGrant(
          { revision: 0, value: { subject: EVERYONE, toolkit: "browser", tools: { kind: "all" } } },
          "test",
        ),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(await listed(stub, ADMIN)).toEqual([]);
    expect(await call(stub, ADMIN, "browser_markdown")).toBe("unknown");
    expect(await stub.tools().exportToolkits({ member: ADMIN.member, admin: true })).toEqual([]);
  });
});
