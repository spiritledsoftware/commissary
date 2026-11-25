/**
 * The org's Antigravity pool pause after a TOS_VIOLATION (CLIProxyAPI 5a351d95, e96d4c48, 81018ba4): a violation arms
 * it when `oauth.providers.antigravity.tos-pause-window` is set, and while it runs every generate, stream and token
 * count answers a request-scoped 503 without touching a credential. The deadline lives in {@link AntigravityState}.
 */
import { Clock, Effect, Option } from "effect";
import type { OrgId } from "@commissary/core";
import { optionalRequestOrg } from "@commissary/state";
import { antigravityTosPauseWindowMs } from "../../config/accessors.ts";
import type { Config } from "../../config/schema.ts";
import { ModelsEnv } from "../../env.ts";
import { ExecutionError } from "../errors.ts";
import { redactTosAppealUrl, type TosViolation } from "./errors.ts";
import { antigravityStateFor } from "./state.ts";

/**
 * `applyAntigravityTOSState`: arms the pause of `org` when a window is configured and logs the violation, with the
 * appeal URL cut at its query. The credential itself is disabled by the ControlPlane from the reported
 * `tos_violation` result.
 */
export const armTosPause = (
  config: Config,
  credentialId: string,
  env: ModelsEnv["Service"] | undefined,
  org: OrgId,
  violation: TosViolation,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const windowMs = antigravityTosPauseWindowMs(config);

    if (windowMs > 0) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.promise(() => antigravityStateFor(env, org).pauseForTos(windowMs, now));
      yield* Effect.logWarning(`antigravity: TOS_VIOLATION pause armed for ${windowMs} ms`);
    }

    yield* Effect.logWarning(
      violation.appealUrl === ""
        ? `antigravity: credential ${credentialId} suspended for TOS_VIOLATION`
        : `antigravity: credential ${credentialId} suspended for TOS_VIOLATION; appeal: ${redactTosAppealUrl(violation.appealUrl)} (${violation.appealUrlText})`,
    );
  });

/** `antigravityInTOSPause`: fails with the request-scoped 503 while the request's org is paused. */
export const tosPauseGate = Effect.fnUntraced(function* (config: Config) {
  if (antigravityTosPauseWindowMs(config) <= 0) return;
  const env = Option.getOrUndefined(yield* Effect.serviceOption(ModelsEnv));
  const org = yield* optionalRequestOrg;
  const now = yield* Clock.currentTimeMillis;

  const remaining = yield* Effect.promise(() =>
    antigravityStateFor(env, org).tosPauseRemaining(now),
  );

  if (remaining > 0) {
    return yield* new ExecutionError({
      status: 503,
      message: "antigravity pool paused after TOS_VIOLATION",
      requestScoped: true,
    });
  }
});
