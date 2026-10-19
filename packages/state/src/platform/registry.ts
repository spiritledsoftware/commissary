/**
 * The Worker's side of the Platform registry (ADR 0021): {@link platformOf} is the only place that turns the deployment
 * into a `Platform` stub, as `controlPlaneOf` is for an org's ControlPlane.
 */
import { Data, Effect } from "effect";
import { type StateBindings, StateEnv } from "../env.ts";
import type { Platform } from "./platform.ts";

export type PlatformStub = DurableObjectStub<Platform>;

/** The one Platform object of the deployment is named like this. */
export const PLATFORM_NAME = "platform";

export const platformOf = (env: Pick<StateBindings, "PLATFORM">): PlatformStub =>
  env.PLATFORM.getByName(PLATFORM_NAME);

/**
 * The URL of the panel's page `page` (`billing`, `tools/<id>/connect`) of `org`:
 * `https://<APP_DOMAIN>/o/<slug>/<page>`.
 * A Worker knows an org by its id, and only the registry knows its slug, so this asks it; when it cannot say or the
 * app host is not set, the answer is `fallback`, plain text naming the page, never a URL that leads nowhere.
 */
export const panelPageUrl = (
  env: Pick<StateBindings, "PLATFORM"> & { readonly APP_DOMAIN?: string | undefined },
  org: string,
  page: string,
  fallback: string,
): Effect.Effect<string> => {
  const host = (env.APP_DOMAIN ?? "").trim();

  if (host === "") return Effect.succeed(fallback);

  return Effect.tryPromise(async () => (await platformOf(env).getOrgById(org))?.slug).pipe(
    Effect.map((slug) =>
      slug === undefined ? fallback : `https://${host}/o/${encodeURIComponent(slug)}/${page}`,
    ),
    Effect.orElseSucceed(() => fallback),
  );
};

/** The Platform registry could not be reached; the message names the call, the caller logs it. */
export class PlatformUnavailable extends Data.TaggedError("PlatformUnavailable")<{
  readonly message: string;
}> {}

/** Calls the Platform registry; a failed RPC is a {@link PlatformUnavailable} (RPC results are plain data after `await`). */
export const platform = <R>(
  label: string,
  call: (stub: PlatformStub) => R,
): Effect.Effect<Awaited<R>, PlatformUnavailable, StateEnv> =>
  Effect.gen(function* () {
    const stub = platformOf(yield* StateEnv);

    return yield* Effect.tryPromise({
      try: async (): Promise<Awaited<R>> => await call(stub),
      catch: (cause) =>
        new PlatformUnavailable({
          message: `${label}: ${cause instanceof Error ? cause.message : "unknown error"}`,
        }),
    });
  });
