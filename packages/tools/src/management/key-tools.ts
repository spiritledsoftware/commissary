/**
 * What the API keys' views say of a key's tools (#200, the app Worker's `management/api-key-routes.ts`): how many
 * tools each key may use now and what its tool scope names that is gone, from the org's Tools part, which alone knows
 * the members' reach and the tool lists. The keys and their scopes are the org-wide base's.
 */
import { Effect } from "effect";
import type { ToolScope } from "@commissary/contract/api-keys";
import type { KeyToolSummary } from "../control-plane-part.ts";
import { toolsControlPlane } from "../env.ts";

export type { KeyToolSummary };

/**
 * The summary of each key, in order; `undefined` when the Tools part cannot be reached (logged by
 * `toolsControlPlane`): the keys are still listed, without their tool counts.
 */
export const keyToolSummaries = (
  keys: ReadonlyArray<{ readonly memberId: string; readonly toolScope?: ToolScope | undefined }>,
) =>
  keys.length === 0
    ? Effect.succeed<ReadonlyArray<KeyToolSummary> | undefined>([])
    : toolsControlPlane("keyToolSummaries", (stub) => stub.tools().keyToolSummaries(keys)).pipe(
        Effect.map((summaries): ReadonlyArray<KeyToolSummary> | undefined => summaries),
        Effect.orElseSucceed(() => undefined),
      );
