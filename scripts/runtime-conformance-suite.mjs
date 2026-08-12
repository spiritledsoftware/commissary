import * as Core from "@commissary/core";
import * as CoreInternal from "@commissary/core/internal";
import * as Drizzle from "@commissary/drizzle";
import * as DrizzleMysql from "@commissary/drizzle/mysql";
import * as DrizzlePostgres from "@commissary/drizzle/postgres";
import * as DrizzleSqlite from "@commissary/drizzle/sqlite";
import * as EffectCommissary from "@commissary/effect";
import * as EffectAi from "@commissary/effect/ai";
import * as StoreMemory from "@commissary/store-memory";
import * as Stream from "@commissary/stream";
import * as StreamEffect from "@commissary/stream/effect";

/** @type {ReadonlyArray<readonly [string, object]>} */
const publicModules = [
  ["@commissary/core", Core],
  ["@commissary/core/internal", CoreInternal],
  ["@commissary/drizzle", Drizzle],
  ["@commissary/drizzle/postgres", DrizzlePostgres],
  ["@commissary/drizzle/mysql", DrizzleMysql],
  ["@commissary/drizzle/sqlite", DrizzleSqlite],
  ["@commissary/effect", EffectCommissary],
  ["@commissary/effect/ai", EffectAi],
  ["@commissary/store-memory", StoreMemory],
  ["@commissary/stream", Stream],
  ["@commissary/stream/effect", StreamEffect],
];

export const expectedRuntimeConformance = Object.freeze({
  imports: publicModules.length,
  result: "completed:smoke-ok",
});

export const runRuntimeConformance = async () => {
  for (const [specifier, module] of publicModules) {
    if (Object.keys(module).length === 0) {
      throw new Error(`Built package '${specifier}' has no exports`);
    }
  }

  const model = Core.Model.define({
    id: "smoke-model",
    async *invoke() {
      yield {
        type: "finish",
        response: {
          message: {
            role: "assistant",
            content: [Core.Content.text("smoke-ok")],
          },
          finishReason: "stop",
        },
      };
    },
  });
  const agent = Core.Agent.define({ id: "smoke-agent", fragments: model });
  const app = Core.commissary({ threadStore: StoreMemory.MemoryThreadStore.make() });
  const thread = await app.createThread();
  const branch = await app.createBranch({ threadId: thread.id, name: "main" });
  const client = app.agent(agent);
  const accepted = await client.createRun({
    threadId: thread.id,
    branchId: branch.id,
    message: { role: "user", content: [Core.Content.text("smoke")] },
  });
  if (accepted.type !== "accepted") {
    throw new Error(`Run creation failed: ${accepted.type}`);
  }

  const execution = await client.execute(accepted.runId);
  const result = await execution.result;
  const stored = await client.readResult(Core.RunId.decode(accepted.runId));
  if (
    result.type !== "completed" ||
    stored?.type !== "completed" ||
    result.response.message.content[0]?.type !== "text" ||
    result.response.message.content[0].text !== "smoke-ok"
  ) {
    throw new Error("Built Runtime smoke result is incorrect");
  }

  return { ...expectedRuntimeConformance };
};
