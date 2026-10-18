/**
 * What a System One model can serve, and the requests Commissary refuses locally instead of sending them upstream
 * (ADR 0032): Box questions on a model without Box, images on a model or provider that takes none. Workers addition,
 * no Go counterpart.
 *
 * The facts are the `systemOne` capabilities of the bundled catalog additions (`registry/catalog/additions.json`), per
 * provider key and model id. A model the catalog does not know (TypeSafe accepts any versioned id) has no facts and is
 * never refused here: the provider decides. A refusal is request-scoped (400), so it ends the request: a model alias
 * spanning a provider that refuses and one that would not does not fail over (see docs/ARCHITECTURE.md "System One").
 */
import { countImages, hasBoxQuestion } from "@commissary/translation/systemone";
import { parseSuffix } from "@commissary/translation/thinking";
import type { Json } from "@commissary/json";
import type { SystemOneCapabilities } from "../../registry/catalog-additions.ts";
import { catalogAdditions } from "../../registry/catalog.ts";
import { ExecutionError } from "../errors.ts";

/** The capabilities of `model` (suffix ignored) under provider key `provider`; `undefined` when the catalog has none. */
export const systemOneCapabilities = (
  provider: string,
  model: string,
): SystemOneCapabilities | undefined => {
  const key = provider.trim().toLowerCase();
  const id = parseSuffix(model).modelName.trim().toLowerCase();

  const entry = Object.entries(catalogAdditions().providers).find(
    ([candidate]) => candidate === key,
  )?.[1];

  return entry?.models?.find((record) => record.id.toLowerCase() === id)?.systemOne;
};

/** A request-scoped 400: the provider cannot serve this request, so it is not sent. */
const refused = (message: string): ExecutionError =>
  new ExecutionError({ status: 400, message, requestScoped: true });

/**
 * The local refusal of a request to `model` on `provider` (`displayName` names it in the message), if any. Image
 * limits (count, sizes, types) are the provider's request conversion's to check, before it reads any image.
 */
export const systemOneRefusal = (input: {
  readonly provider: string;
  readonly displayName: string;
  readonly model: string;
  readonly body: Json;
}): ExecutionError | undefined => {
  const capabilities = systemOneCapabilities(input.provider, input.model);

  if (capabilities === undefined) return undefined;
  const model = parseSuffix(input.model).modelName.trim();

  if (!capabilities.box && hasBoxQuestion(input.body))
    return refused(`${model} on ${input.displayName} does not support Box questions`);

  if (capabilities.images === false && countImages(input.body) > 0)
    return refused(`${model} on ${input.displayName} does not accept images`);

  return undefined;
};
