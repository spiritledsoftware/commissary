/**
 * Per-credential, per-model availability projection.
 *
 * Go source: sdk/cliproxy/auth/conductor_models.go (`clientModelProjectionForAuth`), conductor_cooldown.go
 * (`cooldownReason`). The Go registry stores the projection the conductor pushes after every result; on Workers the
 * projection is derived on demand from the credential state the ControlPlane keeps.
 */
import {
  availabilityBlock,
  hasUnauthorizedFailure,
} from "../credentials/selection/availability.ts";
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
  quota: Pick<Quota, "reason">,
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
 *
 * The cooldown checks are the selector's (`availabilityBlock`, CLIProxyAPI 69ed202a): a model whose bounded cooldown
 * has passed is listed again although no result has cleared its flags yet; a flag without any deadline, a disabled
 * credential or model and a terminal 401 stay suspended until something changes them.
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

  const credentialDisabled = source.disabled || state.status === "disabled";
  const modelDisabled = modelState?.status === "disabled";
  const terminalUnauthorized = hasUnauthorizedFailure(state);

  let suspended = credentialDisabled || modelDisabled || terminalUnauthorized;

  // A credential-wide quota without a recovery time blocks until it is cleared.
  if (
    state.quota.exceeded &&
    state.quota.reason === "credential_quota" &&
    (state.quota.nextRecoverAt === 0 || state.quota.nextRecoverAt > now)
  )
    suspended = true;
  let modelSuspended = false;
  let quotaExceeded = false;
  let quotaSince: number | undefined;

  if (modelState !== undefined) {
    if (
      !modelDisabled &&
      availabilityBlock(
        modelState.unavailable,
        modelState.quota.exceeded,
        modelState.nextRetryAfter,
        modelState.quota.nextRecoverAt,
        now,
      ).blocked
    ) {
      suspended = true;
      modelSuspended = true;
    }

    if (
      modelState.quota.exceeded &&
      (modelState.quota.nextRecoverAt === 0 || modelState.quota.nextRecoverAt > now)
    ) {
      quotaExceeded = true;
      quotaSince =
        modelState.quota.observedAt ?? (modelState.updatedAt > 0 ? modelState.updatedAt : now);
    }
  }

  // Without model states, scheduling falls back to the credential-wide cooldown, and the projection agrees with it.
  if (
    Object.keys(state.modelStates).length === 0 &&
    availabilityBlock(
      state.unavailable,
      state.quota.exceeded,
      state.nextRetryAfter,
      state.quota.nextRecoverAt,
      now,
    ).blocked
  )
    suspended = true;

  let suspendReason = "";

  if (suspended) {
    if (credentialDisabled || modelDisabled) suspendReason = "disabled";
    else if (terminalUnauthorized)
      suspendReason = cooldownReason(state.statusMessage, {}, state.lastError) || "unauthorized";
    else if (modelSuspended && modelState !== undefined)
      suspendReason = cooldownReason(
        modelState.statusMessage,
        modelState.quota,
        modelState.lastError,
      );

    if (suspendReason === "")
      suspendReason = cooldownReason(state.statusMessage, state.quota, state.lastError);
  }

  return {
    suspended,
    suspendReason,
    quotaExceeded,
    ...(quotaSince === undefined ? {} : { quotaSince }),
  };
};
