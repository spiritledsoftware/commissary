/**
 * GitHub Copilot token refresh: the GitHub token (`refresh_token`) is exchanged again for a short-lived Copilot token.
 *
 * Go source: internal/runtime/executor/copilot_executor.go (`CopilotExecutor.Refresh`), sdk/auth/copilot.go
 * (`RefreshLead`: 5 minutes, in `schedule.ts`). The exchange is the sign-in's (`exchangeCopilotToken`), so a refreshed
 * credential keeps only a trusted `base_url`. Go also revokes the account's discovered model catalog when the origin
 * changes; Commissary serves the preset catalog only (docs/ARCHITECTURE.md, "GitHub Copilot"), so there is none to
 * revoke.
 */
import { Effect } from "effect";
import type { JsonObject } from "@commissary/json";
import { exchangeCopilotToken } from "../../oauth/flows/copilot.ts";
import { refreshError } from "./error.ts";
import { rfc3339, str } from "./http.ts";
import type { RefreshContext, RefreshProtocolEffect } from "./types.ts";

export const refreshCopilot = (context: RefreshContext): RefreshProtocolEffect =>
  Effect.gen(function* () {
    const metadata: JsonObject = { ...context.metadata };
    const githubToken = str(metadata.refresh_token);

    if (githubToken === "") {
      return yield* refreshError({
        message: "copilot: missing GitHub credential; sign in again",
        status: 401,
      });
    }

    const exchanged = yield* exchangeCopilotToken(githubToken, context.now).pipe(
      Effect.mapError((failure) =>
        refreshError({
          message: `token refresh failed: ${failure.message}`,
          // A 401 (revoked GitHub token) is terminal for the manager: only a new sign-in helps.
          status: failure.status,
        }),
      ),
    );

    metadata.access_token = exchanged.token;
    metadata.base_url = exchanged.baseUrl;
    metadata.expired = rfc3339(exchanged.expiresAt * 1000);
    metadata.last_refresh = rfc3339(context.now);

    return metadata;
  });
