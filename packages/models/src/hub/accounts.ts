/**
 * What the hub API lists of an account (`GET /v0/management/auth-files`, ADR 0052): the fields of Go's auth file entry
 * (internal/api/handlers/management/auth_files.go) that allowance readers read, and nothing else. Not the
 * management API's entry (`buildCredentialEntry`): no runtime state, no owner, and never a token or the raw id token.
 * Pure; the ControlPlane decides which accounts are listed (`listHubAccounts`).
 */
import { type Credential, executorKey } from "../credentials/model.ts";
import { codexClaims } from "../management/credential-entry.ts";
import { antigravityProject, codexAccountId, text } from "../quota/account-ids.ts";

export interface HubAccount {
  /** The auth file name, as the management API names it. */
  readonly id: string;
  readonly auth_index: string;
  /** Commissary's executor key (`codex`, `claude`, `xai`, `antigravity`). */
  readonly provider: string;
  readonly email?: string;
  readonly project_id?: string;
  readonly id_token?: { readonly chatgpt_account_id?: string; readonly plan_type?: string };
}

/** The listed form of `credential`, whose `auth_index` is `authIndex`; absent fields are left out. */
export const hubAccount = (
  credential: Pick<Credential, "id" | "provider" | "label" | "metadata" | "attributes">,
  authIndex: string,
): HubAccount => {
  const provider = executorKey(credential);
  const email = text(credential.metadata.email);
  const project = provider === "antigravity" ? antigravityProject(credential) : "";
  const account = provider === "codex" ? codexAccountId(credential) : "";
  const plan = provider === "codex" ? text(codexClaims(credential)?.plan_type) : "";

  const idToken = {
    ...(account === "" ? {} : { chatgpt_account_id: account }),
    ...(plan === "" ? {} : { plan_type: plan }),
  };

  return {
    id: credential.id,
    auth_index: authIndex,
    provider,
    ...(email === "" ? {} : { email }),
    ...(project === "" ? {} : { project_id: project }),
    ...(Object.keys(idToken).length === 0 ? {} : { id_token: idToken }),
  };
};
