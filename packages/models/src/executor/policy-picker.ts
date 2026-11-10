/**
 * Credential policy filtering on top of a {@link CredentialPicker}.
 *
 * Go source: sdk/cliproxy/auth/credential_policy.go (CredentialPolicyCodexAlphaSearchV1, credentialPolicyAllows) and
 * the `WithDisallowFreeAuth` option of the image handlers. Credentials the policy rejects are excluded and the pick is
 * retried; the rejected leases are reported as request-scoped failures so no cooldown is applied.
 */
import { Effect } from "effect";
import { ExecutionError } from "./errors.ts";
import { CredentialPicker, type CredentialSnapshot } from "./picker.ts";

type PickerService = typeof CredentialPicker.Service;

const MAX_REJECTIONS = 32;

export const withCredentialPolicy = (
  base: PickerService,
  allows: (credential: CredentialSnapshot) => boolean,
  unavailableMessage: string,
): PickerService => ({
  report: base.report,
  planRetry: base.planRetry,
  hasAlternative: base.hasAlternative,
  pick: (request) =>
    Effect.gen(function* () {
      const excluded = [...(request.excludedIds ?? [])];

      for (let attempt = 0; attempt < MAX_REJECTIONS; attempt++) {
        const picked = yield* base.pick({ ...request, excludedIds: excluded });

        if (allows(picked.credential)) return picked;
        excluded.push(picked.credential.id);
        yield* base.report(picked.lease, {
          success: false,
          requestScoped: true,
          error: { message: unavailableMessage, retryable: false, code: "request_scoped" },
        });
      }

      return yield* new ExecutionError({
        status: 503,
        code: "auth_not_found",
        message: unavailableMessage,
      });
    }),
});

/** `credentialPolicyAllows(codex_alpha_search_v1)`: OAuth credentials, or provider keys with `alpha-search` enabled. */
export const allowsCodexAlphaSearch = (credential: CredentialSnapshot): boolean =>
  credential.provider.trim().toLowerCase() === "codex" &&
  (credential.kind === "oauth" ||
    (credential.attributes["codex_alpha_search"] ?? "").toLowerCase() === "true");

/** `WithDisallowFreeAuth`: free-plan Codex credentials cannot use the image tools. */
export const disallowFreePlan = (credential: CredentialSnapshot): boolean =>
  (credential.attributes["plan_type"] ?? "").trim().toLowerCase() !== "free";
