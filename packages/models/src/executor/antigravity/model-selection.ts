/**
 * The upstream model of one Antigravity attempt: a grouped thinking variant chosen by the requested thinking level, and
 * the model enum of the agent envelope, from the credential's `fetchAvailableModels` catalog (`models.ts`).
 *
 * Go source: sdk/cliproxy/auth/antigravity_model_enums.go (`SelectAntigravityModel`, `selectThinkingVariant`,
 * `AntigravityExcludedModels`) and internal/runtime/executor/helps/antigravity_thinking.go
 * (`SelectAntigravityRequestModel`), CLIProxyAPI 2f86992c, 14a95b19, b8e3bc66. Go keeps the snapshot in a KV entry of
 * its own, bound to the credential's grant, project and endpoint; Commissary reads the cron task's stored probe and
 * applies the same binding through the record's `scope` (`antigravityCatalogScope`). A record without a scope (stored
 * before it existed) or from another grant selects nothing, which keeps the requested model.
 */
import { isModelExcluded } from "../../credentials/selection/model-name.ts";
import type { CredentialSnapshot } from "../picker.ts";
import type { Config } from "../../config/schema.ts";
import {
  antigravityCatalogScope,
  MAX_MODEL_ID_BYTES,
  type ModelsRecord,
  validThinkingSuffix,
} from "./models.ts";

/** `AntigravityModelSelection`: a positive `maxOutputTokens` means a thinking group matched. */
export interface AntigravityModelSelection {
  readonly id: string;
  readonly enum: string;
  readonly maxOutputTokens: number;
  readonly webSearch: boolean;
  /** The requested thinking level the selection used (`""` without one). */
  readonly level: string;
}

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** `validAntigravityModelEnum`. */
const validEnum = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "" && utf8Length(value) <= MAX_MODEL_ID_BYTES;

/** `AntigravityExcludedModels`: the credential's own patterns, else the `antigravity` channel's. */
export const antigravityExcludedModels = (
  credential: CredentialSnapshot,
  config: Config,
): ReadonlyArray<string> => {
  const own = (credential.attributes["excluded_models"] ?? "").trim();

  if (own !== "") return own.split(",");

  return config.oauth["excluded-models"]["antigravity"] ?? [];
};

/** The plain selection: the requested model, no enum, no group. */
export const plainSelection = (id: string, level = ""): AntigravityModelSelection => ({
  id,
  enum: "",
  maxOutputTokens: 0,
  webSearch: false,
  level,
});

/**
 * `SelectAntigravityModel`: the enum of `upstreamModelId`, and with a `level` the `<group>-<level>` member of the
 * model's thinking group when it has a positive output limit, an enum and is not excluded.
 */
export const selectAntigravityModel = (
  record: ModelsRecord | undefined,
  credential: CredentialSnapshot,
  upstreamModelId: string,
  rawLevel: string,
  excluded: ReadonlyArray<string>,
): AntigravityModelSelection => {
  let level = rawLevel.toLowerCase();

  if (!validThinkingSuffix(level)) level = "";
  const selection = plainSelection(upstreamModelId, level);
  const hints = record?.hints;

  if (
    hints === undefined ||
    upstreamModelId === "" ||
    utf8Length(upstreamModelId) > MAX_MODEL_ID_BYTES ||
    record?.scope === undefined ||
    record.scope !== antigravityCatalogScope(credential.attributes, credential.metadata)
  )
    return selection;

  const enums = hints.modelEnums ?? {};

  const lookupEnum = (id: string): string => {
    const value = Object.hasOwn(enums, id) ? enums[id] : undefined;

    return validEnum(value) ? value : "";
  };

  const groups = hints.thinkingGroups;
  const found: AntigravityModelSelection = { ...selection, enum: lookupEnum(upstreamModelId) };

  if (level === "" || groups === undefined || Object.keys(groups).length === 0) return found;

  /** -1 for a missing member, 0 for one that is no switch target; whether `group` is a group at all. */
  const lookupLimit = (group: string, member: string): readonly [number, boolean] => {
    if (!Object.hasOwn(groups, group)) return [-1, false];
    const levels = groups[group] ?? {};
    const limit = Object.hasOwn(levels, member) ? levels[member] : undefined;

    return [limit !== undefined && limit >= 0 ? limit : -1, true];
  };

  let group = upstreamModelId;
  let [limit, isGroup] = lookupLimit(group, level);

  if (!isGroup) {
    // The longest group first; a shared prefix is no membership, the whole suffix must be listed in the group.
    let end = upstreamModelId.length;

    while (end > 0) {
      end = upstreamModelId.lastIndexOf("-", end - 1);

      if (end <= 0) break;
      group = upstreamModelId.slice(0, end);
      const suffix = upstreamModelId.slice(end + 1);

      if (!validThinkingSuffix(suffix)) continue;

      if (lookupLimit(group, suffix)[0] >= 0) {
        [limit] = lookupLimit(group, level);
        isGroup = true;
        break;
      }
    }
  }

  if (!isGroup || limit <= 0 || utf8Length(group) + 1 + utf8Length(level) > MAX_MODEL_ID_BYTES)
    return found;
  const target = `${group}-${level}`;

  if (
    isModelExcluded(
      excluded.map((pattern) => pattern.trim().toLowerCase()),
      target,
    )
  )
    return found;
  const targetEnum = lookupEnum(target);

  if (targetEnum === "") return found;

  return {
    id: target,
    enum: targetEnum,
    maxOutputTokens: limit,
    webSearch: (hints.thinkingWebSearch ?? []).includes(target),
    level,
  };
};
