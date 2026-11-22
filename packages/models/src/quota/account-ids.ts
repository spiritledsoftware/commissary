/**
 * Account ids a credential's provider needs beside its token: Codex's ChatGPT account and Antigravity's Cloud project.
 * Read by the quota check (`target.ts`) and the hub API's account list (`hub/accounts.ts`). Pure, apart from the
 * Worker's bindings, so Node.js tests import it.
 */
import { decodeJwtClaims } from "../credentials/expiry.ts";
import type { Credential } from "../credentials/model.ts";
import { isJsonObject, type Json } from "@commissary/json";

const text = (value: Json | undefined): string => (typeof value === "string" ? value.trim() : "");

/** `chatgpt_account_id` of the Codex id token, else the stored `account_id`. */
export const codexAccountId = (credential: Pick<Credential, "metadata">): string => {
  const token = text(credential.metadata.id_token);
  const auth = token === "" ? undefined : decodeJwtClaims(token)?.["https://api.openai.com/auth"];
  const claim = isJsonObject(auth) ? text(auth.chatgpt_account_id) : "";

  return claim || text(credential.metadata.account_id);
};

/** `resolveAntigravityProjectId`: `project_id` of the file, of `installed` or of `web`. */
export const antigravityProject = (
  credential: Pick<Credential, "metadata" | "attributes">,
): string => {
  const { metadata } = credential;

  const nested = (key: string): string => {
    const value = metadata[key];

    return isJsonObject(value) ? text(value.project_id) || text(value.projectId) : "";
  };

  return (
    text(metadata.project_id) ||
    text(metadata.projectId) ||
    (credential.attributes.project_id?.trim() ?? "") ||
    nested("installed") ||
    nested("web")
  );
};
