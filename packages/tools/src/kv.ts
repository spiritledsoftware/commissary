/**
 * Where Tools reads its `CACHE` KV binding (ADR 0044): the one module that does (lint rule `boundaries/org-scoped-kv`).
 * Tools keeps no org data in KV; what belongs to the deployment as a whole (the toolkit catalog's registry, #207) goes
 * through a {@link DeploymentKv} with names declared by `deploymentKey`.
 */
import { type DeploymentKv, deploymentKv } from "@commissary/core";
import type { ToolsBindings } from "./env.ts";

/** The deployment-wide KV entries. */
export const deploymentKvOf = (env: Pick<ToolsBindings, "CACHE">): DeploymentKv =>
  deploymentKv(env.CACHE);
