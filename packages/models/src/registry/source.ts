/**
 * `ModelSource`: the slice of a credential (and its runtime state) that model registration reads.
 *
 * The ControlPlane Durable Object returns these from `listModelSources()`; they never contain tokens, provider keys or
 * headers. Go counterpart: the `coreauth.Auth` fields read by `registerModelsForAuth`
 * (sdk/cliproxy/service_models.go) and `clientModelProjectionForAuth` (sdk/cliproxy/auth/conductor_models.go).
 */
import { CLOAK_MODE_ATTRIBUTE } from "../executor/opencode/providers.ts";
import type { ModelEntry, OAuthModelAlias } from "../config/schema.ts";
import type { AntigravityModelHints } from "./antigravity-hints.ts";
import { type Credential, type CredentialState, executorKey } from "../credentials/model.ts";

export interface ModelSource {
  readonly id: string;
  /** Credential provider as stored (lower-case), e.g. `codex`, `kimi.com`, `openai-compatible-foo`. */
  readonly provider: string;
  /** Executor key (`executorKey`): the provider key the registry registers the credential's models under. */
  readonly executor: string;
  readonly source: Credential["source"];
  readonly authKind?: NonNullable<Credential["authKind"]>;
  readonly label: string;
  readonly prefix?: string;
  readonly disabled: boolean;
  /** The member whose private credential this is (ADR 0023); absent for a shared credential. */
  readonly owner?: string;
  /** `attributes.plan_type` (Codex OAuth tier). */
  readonly planType?: string;
  /** OpenAI-compatibility credential (`compat_name` attribute or provider `openai-compatibility`). */
  readonly compat: boolean;
  readonly excludedModels: ReadonlyArray<string>;
  readonly modelAliases: ReadonlyArray<OAuthModelAlias>;
  /** OpenCode Zen keys: the key's `cloak.mode` (`cloak_mode` attribute), which decides whether free models register. */
  readonly cloakMode?: string;
  /** Config provider keys: the `models` list of the owning entry/group. */
  readonly models?: ReadonlyArray<ModelEntry>;
  /** Antigravity credentials: the entitlements of the last `fetchAvailableModels` probe (KV), when known. */
  readonly antigravityHints?: AntigravityModelHints;
  readonly state: Omit<CredentialState, "rejectedAccessToken">;
}

/** `openAICompatInfoFromAuth` (sdk/cliproxy/service_auth.go) reduced to the yes/no answer. */
const isCompat = (credential: Pick<Credential, "provider" | "attributes">): boolean =>
  (credential.attributes.compat_name?.trim() ?? "") !== "" ||
  credential.provider.trim().toLowerCase() === "openai-compatibility";

export const toModelSource = (credential: Credential, state: CredentialState): ModelSource => {
  const { rejectedAccessToken: _omitted, ...safeState } = state;
  const planType = credential.attributes.plan_type?.trim() ?? "";
  const cloakMode = credential.attributes[CLOAK_MODE_ATTRIBUTE]?.trim() ?? "";

  return {
    id: credential.id,
    provider: credential.provider,
    executor: executorKey(credential),
    source: credential.source,
    ...(credential.authKind === undefined ? {} : { authKind: credential.authKind }),
    label: credential.label,
    ...(credential.prefix === undefined ? {} : { prefix: credential.prefix }),
    disabled: credential.disabled,
    ...(credential.owner === undefined ? {} : { owner: credential.owner }),
    ...(planType === "" ? {} : { planType }),
    ...(cloakMode === "" ? {} : { cloakMode }),
    compat: isCompat(credential),
    excludedModels: credential.excludedModels,
    modelAliases: credential.modelAliases,
    ...(credential.models === undefined ? {} : { models: credential.models }),
    state: safeState,
  };
};
