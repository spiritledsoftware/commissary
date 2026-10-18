/**
 * The first-class System One providers (ADR 0032): TypeSafe (Jev) and Subquadratic (SubQ Snap). Provider keys, default
 * endpoints and display names.
 *
 * Workers addition, no Go counterpart (see docs/ARCHITECTURE.md "System One"). Dependency-free so config, credential
 * synthesis, the registry, pricing and the management API can share it. OpenCode Zen also serves a System One model,
 * through its own executor (`executor/opencode`).
 */

export const TYPESAFE = "typesafe";

export const SUBQ = "subq";

export type SystemOneProvider = typeof TYPESAFE | typeof SUBQ;

export interface SystemOneProviderSpec {
  /** Executor/registry key, also the `api-keys` family name and the catalog additions provider. */
  readonly provider: SystemOneProvider;
  /** Default `base-url`; requests go to `{base}/systemone`. */
  readonly baseUrl: string;
  /** Human-readable name (`owned_by`, errors, panel). */
  readonly displayName: string;
}

export const SYSTEM_ONE_PROVIDER_SPECS: Readonly<Record<SystemOneProvider, SystemOneProviderSpec>> =
  {
    [TYPESAFE]: {
      provider: TYPESAFE,
      baseUrl: "https://api.typesafe.ai/v1",
      displayName: "TypeSafe",
    },
    [SUBQ]: { provider: SUBQ, baseUrl: "https://api.subq.ai/v1", displayName: "SubQ" },
  };

export const isSystemOneProvider = (provider: string): provider is SystemOneProvider =>
  provider === TYPESAFE || provider === SUBQ;
