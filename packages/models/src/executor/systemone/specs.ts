/**
 * The System One providers' specs (ADR 0032): what `makeSystemOneExecutor` (`executor.ts`) does differently per
 * provider. Workers addition, no Go counterpart.
 *
 * - TypeSafe (`typesafe`): the client's request as it is, multipart staying multipart with the file parts untouched;
 *   the `TypeSafe-Danger-Zone-Images` and `-Long-Context` opt-ins are forwarded; a missing key's 403 cools the key.
 * - SubQ (`subq`): always JSON, the Danger Zone headers dropped (SubQ has none); 402 (no credits) cools the key.
 *   Images are not converted yet: an image request is refused locally.
 */
import { Effect } from "effect";
import { countImages } from "@commissary/translation/systemone";
import { ExecutionError } from "../errors.ts";
import { systemOneUpstreamError, typeSafeUpstreamError } from "./errors.ts";
import { type SystemOneSpec, typeSafeBody } from "./executor.ts";
import { SUBQ, SYSTEM_ONE_PROVIDER_SPECS, type SystemOneProvider, TYPESAFE } from "./providers.ts";

/** TypeSafe's opt-in request headers (images and Box; longer context). */
export const TYPESAFE_DANGER_ZONE_HEADERS = [
  "TypeSafe-Danger-Zone-Images",
  "TypeSafe-Danger-Zone-Long-Context",
] as const;

export const SYSTEM_ONE_SPECS: Readonly<Record<SystemOneProvider, SystemOneSpec>> = {
  [TYPESAFE]: {
    ...SYSTEM_ONE_PROVIDER_SPECS[TYPESAFE],
    forwardHeaders: TYPESAFE_DANGER_ZONE_HEADERS,
    buildBody: typeSafeBody,
    classifyError: typeSafeUpstreamError,
  },
  [SUBQ]: {
    ...SYSTEM_ONE_PROVIDER_SPECS[SUBQ],
    forwardHeaders: [],
    buildBody: (body, parts) =>
      countImages(body) > 0 || (parts?.size ?? 0) > 0
        ? Effect.fail(
            new ExecutionError({
              status: 400,
              message: "SubQ image requests are not supported yet",
              requestScoped: true,
            }),
          )
        : Effect.succeed({ json: body }),
    classifyError: systemOneUpstreamError,
  },
};
