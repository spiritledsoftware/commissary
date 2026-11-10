/**
 * The Codex catalog's native tool search bit of one credential (`RegistrySnapshot.nativeToolSearchCapability`).
 *
 * It applies the executor's predicates to what a model source carries (`toModelSource` evaluates the origin one, since a
 * source has neither the base URL nor the attributes), so the catalog advertises `tool_search` only where an attempt
 * would carry it natively.
 */
import type { Config } from "../config/schema.ts";
import { claudeModelLacksToolSearch } from "../executor/claude/classify.ts";
import type { ModelInfo } from "./model-info.ts";
import type { ModelSource } from "./source.ts";

/**
 * The per-credential bit: the org gate is on and the Claude credential qualifies for the model's upstream model after
 * aliasing (`metadataModelId`).
 */
export const sourceTakesNativeToolSearch = (
  config: Config,
  source: Pick<ModelSource, "executor" | "nativeToolSearchOrigin">,
  model: Pick<ModelInfo, "id" | "metadataModelId">,
): boolean =>
  config.upstream.claude["tool-search"] &&
  source.executor === "claude" &&
  source.nativeToolSearchOrigin === true &&
  !claudeModelLacksToolSearch(model.metadataModelId ?? model.id);
