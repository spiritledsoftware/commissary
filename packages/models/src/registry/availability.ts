/**
 * Per-credential, per-model availability projection.
 *
 * Go source: sdk/cliproxy/auth/conductor_models.go (`clientModelProjectionForAuth`), conductor_cooldown.go
 * (`cooldownReason`). The Go registry stores the projection the conductor pushes after every result; on Workers the
 * projection is derived on demand from the credential state the ControlPlane keeps.
 */
import { canonicalModelKey, findModelState } from "../credentials/selection/model-name.ts";
import type { ModelInfo } from "./model-info.ts";
import type { ModelSource } from "./source.ts";

/** `modelQuotaExceededWindow`: a quota-exceeded credential does not count as available for this long. */
export const MODEL_QUOTA_EXCEEDED_WINDOW_MS = 5 * 60_000;

/** `registry.ClientModelProjection` plus the instant the quota condition was observed. */
export interface ClientProjection {
  readonly suspended: boolean;
  readonly suspendReason: string;
  readonly quotaExceeded: boolean;
  /** Epoch ms at which the quota-exceeded state started (window origin). */
  readonly quotaSince?: number;
}

export const NOT_PROJECTED: ClientProjection = {
  suspended: false,
  suspendReason: "",
  quotaExceeded: false,
};

type Quota = ModelSource["state"]["quota"];

/** `cooldownReason`. */
export const cooldownReason = (
  statusMessage: string | undefined,
  quota: Quota,
  lastError: ModelSource["state"]["lastError"],
): string => {
  const reason = (quota.reason ?? "").trim();

  if (reason !== "") return reason;
  const message = (statusMessage ?? "").trim();

  if (message !== "") return message;
  const code = (lastError?.code ?? "").trim();

  if (code !== "") return code;

  return (lastError?.message ?? "").trim();
};

/**
 * Projection of one registered model of `source` at `now` (epoch ms). The state is looked up under the model id and,
 * for aliased/prefixed models, under the upstream id the selection layer keys cooldowns by.
 */
export const projectModel = (
  source: ModelSource,
  model: ModelInfo,
  now: number,
): ClientProjection => {
  const { state } = source;
  const keys = [canonicalModelKey(model.id)];

  if (model.metadataModelId !== undefined && model.metadataModelId !== "")
    keys.push(canonicalModelKey(model.metadataModelId));

  const modelState = keys
    .map((key) => findModelState(state.modelStates, key))
    .find((candidate) => candidate !== undefined);

  let suspended = source.disabled || state.status === "disabled";

  if (
    state.quota.exceeded &&
    state.quota.reason === "credential_quota" &&
    state.quota.nextRecoverAt > now
  )
    suspended = true;
  let quotaExceeded = false;
  let suspendReason = "";
  let quotaSince: number | undefined;

  if (modelState !== undefined) {
    if (
      modelState.status === "disabled" ||
      modelState.unavailable ||
      modelState.nextRetryAfter > now
    )
      suspended = true;

    if (
      modelState.quota.exceeded &&
      (modelState.quota.nextRecoverAt === 0 || modelState.quota.nextRecoverAt > now)
    ) {
      quotaExceeded = true;
      quotaSince =
        modelState.quota.observedAt ?? (modelState.updatedAt > 0 ? modelState.updatedAt : now);
    }

    if (suspended)
      suspendReason = cooldownReason(
        modelState.statusMessage,
        modelState.quota,
        modelState.lastError,
      );
  }

  if (
    Object.keys(state.modelStates).length === 0 &&
    state.unavailable &&
    state.nextRetryAfter > now
  )
    suspended = true;

  if (suspended && suspendReason === "")
    suspendReason = cooldownReason(state.statusMessage, state.quota, state.lastError);

  return {
    suspended,
    suspendReason,
    quotaExceeded,
    ...(quotaSince === undefined ? {} : { quotaSince }),
  };
};
