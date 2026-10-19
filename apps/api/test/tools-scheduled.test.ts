// Tools' cron task (`tool-list-refresh`, #196) through the API Worker's cron runner: every org's toolkits get their
// tool lists built again from their MCP servers, so a tool that disappears upstream drops out and a new one appears.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { OrgId } from "@commissary/core";
import { scheduledTasks as toolsTasks } from "@commissary/tools/api";
import { fakeMcpServer, serveFakeMcpServers } from "@commissary/tools/testing";
import { runScheduledTasks } from "../src/scheduled.ts";

serveFakeMcpServers();

const ctx = {} as unknown as ExecutionContext;

const ADMIN = { member: "m-admin", admin: true };

const POLICY = { ownHosts: [], localDevelopment: false };

describe("the tool list refresh", () => {
  it("rebuilds each toolkit's list in every org it runs for", async () => {
    const server = fakeMcpServer("https://mcp.cron.example.com/mcp", {
      tools: [{ name: "old" }, { name: "kept" }],
    });

    const org = OrgId.make(`cron-${crypto.randomUUID().slice(0, 8)}`);
    const plane = env.CONTROL_PLANE.getByName(org);

    const added = await plane.tools().addToolkit(
      ADMIN,
      {
        source: server.url,
        name: "cron",
        private: false,
        accepts: "shared",
        credential: { kind: "none" },
      },
      "test",
      POLICY,
    );

    if (!added.ok) throw new Error(added.message);

    server.tools = [{ name: "kept" }, { name: "new" }];
    await runScheduledTasks(toolsTasks, env, ctx, [org]);

    const listed = await plane.tools().listTools(ADMIN, added.value.id);

    expect(listed.ok && listed.value.tools.map((tool) => tool.name)).toEqual([
      "cron_kept",
      "cron_new",
    ]);
  });
});
