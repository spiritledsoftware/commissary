import { env } from "cloudflare:workers";
import { it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expect } from "vite-plus/test";
import { NotFoundLayer } from "../src/http/not-found.ts";
import { WorkerExecutionContext } from "@commissary/core";
import { AuthConfig } from "@commissary/auth";
import { ModelsEnv } from "@commissary/models/api";
import { StateEnv } from "@commissary/state";
import { AppEnv, requestContext } from "../src/worker-env.ts";

// Only `waitUntil`/`passThroughOnException` are exercised; the rest of the interface is runtime-internal.
const executionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

it.effect("requestContext provides each env view and WorkerExecutionContext", () =>
  Effect.sync(() => {
    const context = requestContext(env, executionContext);
    expect(Context.get(context, AuthConfig)).toBe(env);
    expect(Context.get(context, StateEnv)).toBe(env);
    expect(Context.get(context, ModelsEnv)).toBe(env);
    expect(Context.get(context, AppEnv)).toBe(env);
    expect(Context.get(context, WorkerExecutionContext)).toBe(executionContext);
  }),
);

it.effect("web handler routes see per-request env/ctx services", () =>
  Effect.gen(function* () {
    const Route = HttpRouter.add(
      "GET",
      "/binding",
      Effect.gen(function* () {
        const bindings = yield* ModelsEnv;
        const ctx = yield* WorkerExecutionContext;

        return HttpServerResponse.text(`${typeof bindings.CACHE.get}:${ctx === executionContext}`);
      }),
    );

    const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(Route, NotFoundLayer), {
      disableLogger: true,
    });

    const response = yield* Effect.promise(() =>
      handler(
        new Request("https://commissary.test/binding"),
        requestContext(env, executionContext),
      ),
    );

    expect(yield* Effect.promise(() => response.text())).toBe("function:true");
    yield* Effect.promise(dispose);
  }),
);
