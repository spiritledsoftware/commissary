/**
 * What a quota probe needs from one credential, extracted inside the ControlPlane Durable Object from the freshly
 * refreshed credential (`ensureFresh`) and handed to the Worker, which makes the upstream calls (src/quota/probe.ts).
 *
 * Token per provider: the `$TOKEN$` value of Go's `POST /requests/api-call` (`apiCallToken`; the route itself is not
 * ported) for Claude, Codex, Antigravity, Kimi and xAI; the `dca_token` for Meta (the usage endpoint refuses the
 * minted provider key, upstream panel features/quota/providers/meta/requests.ts); the session token for Devin
 * (`devinCredentials`); the provider key itself for OpenCode Go (`attributes.api_key`, usage URL from the key's
 * `base_url`). The target carries token material, so it only ever crosses the RPC boundary to the Worker and is never
 * logged or returned to clients.
 */
import type { Credential } from "../credentials/model.ts";
import { devinCredentials } from "../executor/devin/credentials.ts";
import { OPENCODE_GO, OPENCODE_SPECS } from "../executor/opencode/providers.ts";
import type { Json } from "@commissary/json";
import { apiCallToken } from "../management/credential-ops.ts";
import { antigravityProject, codexAccountId } from "./account-ids.ts";
import { kimiUsageUrl } from "./kimi.ts";
import { isDcaToken } from "./meta.ts";
import { openCodeGoUsageUrl } from "./opencode-go.ts";
import type { QuotaProvider } from "./report.ts";
import type { ResetGrantMark } from "./reset-grant-store.ts";

export interface QuotaProbeTarget {
  /** The stored credential id (never logged: a config key's id is derived from the key). */
  readonly id: string;
  /** What logs name the account by: the auth file name, or a config key's `auth_index`. */
  readonly handle?: string;
  readonly provider: QuotaProvider;
  /** Bearer token (Meta: the `dca_token`; Devin: the session token). */
  readonly token: string;
  /** Codex `Chatgpt-Account-Id`. */
  readonly accountId?: string;
  /** Antigravity Cloud project. */
  readonly projectId?: string;
  /** Kimi usage URL (`api.kimi.com` or `api.kimi.ai`); OpenCode Go `{base}/usage`. */
  readonly usageUrl?: string;
  /** xAI subject (`x-userid`). */
  readonly userId?: string;
  /** Devin API base URL and device seed. */
  readonly baseUrl?: string;
  readonly deviceSeed?: string;
  /** The stored credential version the token belongs to (`recordQuotaReport` drops a stale outcome). */
  readonly credentialVersion?: number;
  /** Claude: leave out the reset grant read (cron sweep, the stored status is recent or the account not eligible). */
  readonly skipResetGrants?: boolean;
}

/** Answer of the `quotaProbeTarget` RPC. `unavailable` is a failed check (it is recorded in the report). */
export type QuotaTargetResult =
  | {
      readonly ok: true;
      readonly target: QuotaProbeTarget;
      /** Claude: the grant state a reset grant status read is stored under (`reset-grant-store.ts`). */
      readonly grantsMark?: ResetGrantMark;
    }
  | { readonly ok: false; readonly error: "not_found" }
  | { readonly ok: false; readonly error: "unsupported"; readonly provider: string }
  | {
      readonly ok: false;
      readonly error: "unavailable";
      readonly id: string;
      readonly message: string;
      readonly credentialVersion?: number;
    };

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

const unavailable = (id: string, message: string): QuotaTargetResult => ({
  ok: false,
  error: "unavailable",
  id,
  message,
});

/** The probe input of a fresh credential of a supported provider. */
export const buildQuotaTarget = (
  credential: Pick<Credential, "id" | "provider" | "metadata" | "attributes">,
  provider: QuotaProvider,
): QuotaTargetResult => {
  const { id } = credential;

  switch (provider) {
    case "meta": {
      const token = text(credential.metadata.dca_token);

      return isDcaToken(token)
        ? { ok: true, target: { id, provider, token } }
        : unavailable(id, "credential has no dca_token");
    }

    case "devin": {
      const devin = devinCredentials({
        id,
        provider: credential.provider,
        kind: "oauth",
        attributes: credential.attributes,
        metadata: credential.metadata,
      });

      if (devin.providerKey === "") return unavailable(id, "credential has no session token");

      return {
        ok: true,
        target: {
          id,
          provider,
          token: devin.providerKey,
          baseUrl: devin.baseUrl,
          deviceSeed: devin.deviceSeed,
        },
      };
    }

    case "opencode-go": {
      const token = credential.attributes.api_key?.trim() ?? "";

      if (token === "") return unavailable(id, "credential has no api key");
      const baseUrl = credential.attributes.base_url?.trim() || OPENCODE_SPECS[OPENCODE_GO].baseUrl;

      return { ok: true, target: { id, provider, token, usageUrl: openCodeGoUsageUrl(baseUrl) } };
    }

    default:
      break;
  }

  const token = apiCallToken(credential);

  if (token === "") return unavailable(id, "credential has no access token");

  switch (provider) {
    case "codex": {
      const accountId = codexAccountId(credential);

      return {
        ok: true,
        target: { id, provider, token, ...(accountId === "" ? {} : { accountId }) },
      };
    }

    case "antigravity": {
      const projectId = antigravityProject(credential);

      return projectId === ""
        ? unavailable(id, "credential has no project_id")
        : { ok: true, target: { id, provider, token, projectId } };
    }

    case "kimi":
    case "kimi-ai":
      return {
        ok: true,
        target: {
          id,
          provider,
          token,
          usageUrl: kimiUsageUrl(credential.provider, credential.metadata),
        },
      };

    case "xai": {
      const userId = text(credential.metadata.sub);

      return { ok: true, target: { id, provider, token, ...(userId === "" ? {} : { userId }) } };
    }

    default:
      return { ok: true, target: { id, provider, token } };
  }
};
