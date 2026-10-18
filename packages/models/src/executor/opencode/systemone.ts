/**
 * OpenCode Zen's `systemone` protocol (ADR 0032): System One requests (TypeSafe's System One API, `POST /v1/systemone`)
 * to Zen's Jev at `POST {base}/systemone`. Workers addition, no Go counterpart; see docs/ARCHITECTURE.md "System One",
 * "OpenCode Zen".
 *
 * Zen relays TypeSafe's API, so the client's JSON goes on with the upstream model, after the payload rules (protocol
 * `systemone`, the final mutation), through the shared System One exchange (`executor/systemone/executor.ts`). Zen
 * drops TypeSafe's `TypeSafe-Danger-Zone-Images` opt-in and rejects multipart: images are refused locally from the
 * catalog fact (`images: false`, `executor/systemone/capabilities.ts`) and file parts always. The Danger Zone headers
 * are forwarded all the same. Headers and error classification are the gateway's (`headers.ts`, `errors.ts`), so a
 * model fault such as "Model is unavailable" keeps its model-level cooldown and a 401 or 402 cools the key.
 */
import { Effect } from "effect";
import { ExecutionError } from "../errors.ts";
import { postSystemOne, prepareSystemOneBody, type SystemOneSpec } from "../systemone/executor.ts";
import { systemOneRefusal } from "../systemone/capabilities.ts";
import { TYPESAFE_DANGER_ZONE_HEADERS } from "../systemone/specs.ts";
import { type OpenCodeShaping, openCodeEndpoint } from "./attempt.ts";
import { openCodeUpstreamError } from "./errors.ts";
import { openCodeHeaders } from "./headers.ts";
import { OPENCODE_SPECS } from "./providers.ts";

/** Zen takes JSON only: a multipart request's file parts are refused (images are refused before, by the catalog). */
const zenBody =
  (displayName: string): SystemOneSpec["buildBody"] =>
  (body, parts) =>
    parts !== undefined && parts.size > 0
      ? Effect.fail(
          new ExecutionError({
            status: 400,
            message: `${displayName} does not accept file uploads (multipart System One requests)`,
            requestScoped: true,
          }),
        )
      : Effect.succeed({ json: body });

/** One System One attempt on the gateway: refusals, the body with payload rules, the exchange and its usage. */
export const executeOpenCodeSystemOne = Effect.fnUntraced(function* (shaping: OpenCodeShaping) {
  const { provider, context, request, options } = shaping;
  const { displayName } = OPENCODE_SPECS[provider];

  const refusal = systemOneRefusal({
    provider,
    displayName,
    model: request.model,
    body: request.payload,
  });

  if (refusal !== undefined) return yield* refusal;
  const endpoint = yield* openCodeEndpoint(context, provider);

  const body = yield* prepareSystemOneBody({
    provider,
    context,
    request,
    options,
    buildBody: zenBody(displayName),
  });

  return yield* postSystemOne({
    context,
    url: `${endpoint.baseUrl}/systemone`,
    headers: openCodeHeaders({
      credential: context.credential,
      options,
      protocol: "systemone",
      providerKey: endpoint.providerKey,
      stream: false,
      forward: TYPESAFE_DANGER_ZONE_HEADERS,
    }),
    body,
    classifyError: (input) => openCodeUpstreamError({ provider, ...input }),
  });
});
