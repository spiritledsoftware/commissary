/**
 * The System One providers' specs (ADR 0032): what `makeSystemOneExecutor` (`executor.ts`) does differently per
 * provider. Workers addition, no Go counterpart.
 *
 * - TypeSafe (`typesafe`): the client's request as it is, multipart staying multipart with the file parts untouched;
 *   the `TypeSafe-Danger-Zone-Images` and `-Long-Context` opt-ins are forwarded; a missing key's 403 cools the key.
 * - SubQ (`subq`): always JSON, images converted to SubQ's `images` within its limits (`subq.ts`), the Danger Zone
 *   headers dropped (SubQ has none); 402 (no credits) cools the key.
 */
import { systemOneUpstreamError, typeSafeUpstreamError } from "./errors.ts";
import { type SystemOneSpec, typeSafeBody } from "./executor.ts";
import { SUBQ, SYSTEM_ONE_PROVIDER_SPECS, type SystemOneProvider, TYPESAFE } from "./providers.ts";
import { subqBody } from "./subq.ts";

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
    buildBody: subqBody,
    classifyError: systemOneUpstreamError,
  },
};
