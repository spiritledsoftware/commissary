/**
 * Where Models reads its `CACHE` KV binding (ADR 0044): the one module that does (lint rule `boundaries/org-scoped-kv`).
 * Org data (signatures, Antigravity state and entitlements, video bindings) goes through an {@link OrgKv} of the
 * request's org; what belongs to the deployment as a whole (the catalog, client versions) through a {@link DeploymentKv}
 * with names declared by {@link deploymentKey}. The `…IfBound` forms are for callers that run without bindings (tests,
 * executors built without an `env`).
 */
import { type DeploymentKv, deploymentKv, type OrgId, type OrgKv, orgKv } from "@commissary/core";
import type { ModelsBindings } from "./env.ts";

/** An `env` that holds the `CACHE` KV namespace. */
export type KvEnv = Pick<ModelsBindings, "CACHE">;

/** The KV entries of `org`. */
export const orgKvOf = (env: KvEnv, org: OrgId): OrgKv => orgKv(env.CACHE, org);

/** An `env` that may lack the `CACHE` binding (tests, executors built without an `env`). */
export type OptionalKvEnv = Partial<KvEnv>;

/** The KV entries of `org`, `undefined` when the invocation has no `CACHE` binding. */
export const orgKvIfBound = (env: OptionalKvEnv | undefined, org: OrgId): OrgKv | undefined =>
  env?.CACHE === undefined ? undefined : orgKv(env.CACHE, org);

/** The deployment-wide KV entries. */
export const deploymentKvOf = (env: KvEnv): DeploymentKv => deploymentKv(env.CACHE);

/** The deployment-wide KV entries, `undefined` when the invocation has no `CACHE` binding. */
export const deploymentKvIfBound = (env: OptionalKvEnv | undefined): DeploymentKv | undefined =>
  env?.CACHE === undefined ? undefined : deploymentKv(env.CACHE);
