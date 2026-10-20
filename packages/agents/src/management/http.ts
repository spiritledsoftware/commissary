/**
 * What Agents' management routes share (`routes.ts`, `run-routes.ts`): the base path, the area's absence (`404`
 * without the deployment's Dynamic Workers binding `LOADER`, before anything else), body and path readers, and the
 * reply to a refusal of the part or of a run's object.
 */
import { Effect, Schema } from "effect";
import { HttpRouter, type HttpServerResponse } from "effect/http";
import { handled, type Reply, replyError } from "@commissary/core";
import { bodyJson } from "@commissary/state";
import { AgentsEnv, agentsPresent } from "../env.ts";
import type { Refusable } from "../result.ts";

const BASE = "/v9/management";

/** The Agents area exists only on a deployment with Dynamic Workers (`LOADER`, #226); elsewhere its routes are not. */
const present = Effect.gen(function* () {
  if (!agentsPresent(yield* AgentsEnv)) return yield* replyError(404, "not_found");
});

/** An Agents route under `/v9/management`, answering `404` while the area is absent. */
export const route = <R>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, Reply, R>,
) => HttpRouter.route(method, `${BASE}${path}`, handled(Effect.andThen(present, handler)));

/** The JSON body as `schema` decodes it; `400 invalid body` otherwise. */
export const decode = <S extends Schema.Decoder<unknown>>(schema: S) =>
  bodyJson.pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => replyError(400, "invalid body")),
      ),
    ),
  );

/** The path parameter `name` (`""` when absent). */
export const param = (name: string) =>
  Effect.map(HttpRouter.params, (params) => params[name] ?? "");

/**
 * The value of `result`, or its refusal answered with the status `status` gives its code, and the refused field's
 * path where `path` names one (for the panel's form).
 */
export const orRefuseWith =
  <E extends string>(status: Readonly<Record<E, number>>, path: Partial<Record<E, string>> = {}) =>
  <A>(result: Refusable<E, A>): Effect.Effect<A, Reply> => {
    if (result.ok) return Effect.succeed(result.value);
    const field = path[result.error];

    return Effect.fail(
      replyError(status[result.error], result.error, {
        message: result.message,
        ...(field === undefined ? {} : { path: field }),
      }),
    );
  };
