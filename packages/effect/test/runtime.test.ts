import { Agent, Content, Hook, Model } from "@commissary/core";
import { MemoryThreadStore } from "@commissary/store-memory";
import { Clock, Duration, Effect } from "effect";
import { expect, it } from "vitest";

import { EffectCommissary } from "../src/index.js";

it("maps the active Effect Clock and the configured ID generator", async () => {
  let invocations = 0;
  const model = Model.define({
    id: "effect-clock-model",
    async *invoke() {
      invocations += 1;
      if (invocations === 1) {
        yield {
          type: "interruption" as const,
          interruption: {
            type: "provider-unavailable" as const,
            provider: "test",
            reason: "rate-limit" as const,
          },
        };
        return;
      }
      yield {
        type: "finish" as const,
        response: {
          message: {
            role: "assistant" as const,
            content: [Content.text("done")],
          },
          finishReason: "stop" as const,
        },
      };
    },
  });
  const agent = Agent.define({
    id: "effect-clock-agent",
    fragments: Agent.combine(
      model,
      Hook.afterModelInvocation(({ invocation }) =>
        invocation.type === "interruption" ? { type: "retry", delayMs: 25 } : undefined,
      ),
    ),
  });
  const sleeps: number[] = [];
  const liveClock = Effect.runSync(Clock.Clock);
  const clock = Object.assign(Object.create(liveClock) as Clock.Clock, {
    currentTimeMillisUnsafe: () => 100,
    sleep: (duration: Duration.Duration) => {
      const milliseconds = Duration.toMillis(duration);
      sleeps.push(milliseconds);
      return milliseconds === 25 ? Effect.void : Effect.never;
    },
  });
  let sequence = 0;
  const app = await Effect.runPromise(
    EffectCommissary.make({
      threadStore: MemoryThreadStore.make(),
      generateId: () => `effect-${++sequence}`,
    }).pipe(Effect.provideService(Clock.Clock, clock)),
  );
  const thread = await Effect.runPromise(app.createThread());
  const branch = await Effect.runPromise(app.createBranch({ threadId: thread.id, name: "main" }));
  const client = await Effect.runPromise(app.agent(agent));
  const submission = await Effect.runPromise(
    client.submit({
      type: "start",
      threadId: thread.id,
      branchId: branch.id,
      message: { role: "user", content: [Content.text("start")] },
    }),
  );
  if (submission.type !== "submitted") {
    throw new Error(`Unexpected submission result '${submission.type}'`);
  }
  const execution = await Effect.runPromise(client.execute(submission.runId));

  await expect(Effect.runPromise(execution.result)).resolves.toMatchObject({
    type: "completed",
  });
  expect(thread.id).toBe("effect-1");
  expect(submission.runId).toBe("effect-3");
  expect(execution.id).toBe("effect-6");
  expect(sleeps).toEqual([30_000, 25]);
});
