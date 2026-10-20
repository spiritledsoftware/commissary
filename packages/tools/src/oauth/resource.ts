/**
 * The MCP endpoint as the protected resource of Commissary Cloud's OAuth server (#200, `config.ts`): its RFC 9728
 * metadata, the challenge of its `401`, and the access token a client sends in place of an API key, which the client
 * gate swaps for the key the token stands for before it authenticates the request, so the request is the key's in
 * everything (usage, Spend limits, the tool scope, revocation). Without the OAuth server none of it changes anything.
 */
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { looksLikeApiKey } from "@commissary/auth";
import { isMcpPath } from "@commissary/core";
import { ToolsEnv } from "../env.ts";
import {
  bearerChallenge,
  mcpOAuthConfig,
  PROTECTED_RESOURCE_METADATA_PATH,
  protectedResourceMetadata,
} from "./config.ts";
import { type McpTokenUnavailable, resolveAccessToken } from "./server.ts";

type RequestHeaders = Readonly<Record<string, string | undefined>>;

const BEARER = /^bearer\s+(.+)$/i;

/**
 * `headers` of a request to the MCP endpoint whose bearer token is one of the OAuth server's live access tokens, with
 * the token swapped for its API key; any other request's unchanged (an API key, a token of no live grant: the gate
 * refuses those as before). Fails when the OAuth server's store cannot be read (the gate answers `503`).
 */
export const withMcpAccessToken = (
  headers: RequestHeaders,
  requestUrl: string,
): Effect.Effect<RequestHeaders, McpTokenUnavailable, ToolsEnv> =>
  Effect.gen(function* () {
    const config = mcpOAuthConfig(yield* ToolsEnv);
    const token = BEARER.exec((headers["authorization"] ?? "").trim())?.[1]?.trim();

    if (
      config === undefined ||
      token === undefined ||
      looksLikeApiKey(token) ||
      !isMcpPath(requestUrl)
    )
      return headers;

    const key = yield* resolveAccessToken(config, token);

    return key === undefined ? headers : { ...headers, authorization: `Bearer ${key}` };
  });

/** The `WWW-Authenticate` value of a `401` on the MCP endpoint (`bearerChallenge`). */
export const mcpChallenge: Effect.Effect<string, never, ToolsEnv> = Effect.map(ToolsEnv, (env) =>
  bearerChallenge(mcpOAuthConfig(env)),
);

const notFound = HttpServerResponse.text(JSON.stringify({ error: "Not found" }), {
  status: 404,
  contentType: "application/json; charset=utf-8",
});

/**
 * `GET /.well-known/oauth-protected-resource/mcp`: the MCP endpoint's metadata, on the resource's origin (the API host,
 * or the app host of a stage with one host); unknown anywhere else and without the OAuth server.
 */
const metadata = Effect.gen(function* () {
  const config = mcpOAuthConfig(yield* ToolsEnv);
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (
    config === undefined ||
    (URL.canParse(request.originalUrl) &&
      new URL(request.originalUrl).origin !== new URL(config.resource).origin)
  )
    return notFound;

  return HttpServerResponse.jsonUnsafe(protectedResourceMetadata(config), {
    headers: { "cache-control": "public, max-age=3600" },
  });
});

/** The route of the MCP endpoint's RFC 9728 metadata; mounted by the Worker that answers the resource's origin. */
export const ProtectedResourceMetadataRoutes = HttpRouter.add(
  "GET",
  PROTECTED_RESOURCE_METADATA_PATH,
  metadata,
);
