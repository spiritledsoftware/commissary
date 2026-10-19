/**
 * The server side of MCP's Streamable HTTP transport as Commissary's MCP endpoint speaks it (#197), pure: what one POST
 * carries, which protocol era it is in, and the JSON-RPC answers. Both eras on one endpoint, chosen per request (the
 * spec's "dual-era" server):
 *
 * - **modern** (2026-07-28): no handshake and no session; every request names its revision and the client's
 *   capabilities in `params._meta`, mirrored in the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers, which
 *   must match the body (`400`, `HeaderMismatch`); an unknown revision is `400 UnsupportedProtocolVersion`, an unknown
 *   method `404`;
 * - **legacy** (2025-11-25 and the 2025 revisions before it): `initialize` answers the revision asked for when it is
 *   one of {@link LEGACY_VERSIONS}, else the latest; no session is minted (Streamable HTTP lets a server go without one),
 *   so the requests that follow are served alike, `MCP-Protocol-Version` or not.
 *
 * Every answer is one JSON object, never an SSE stream; a notification (or a client's response) is `202`. Commissary
 * serves tools only: `tools/list` and `tools/call`, besides `initialize`, `server/discover` and `ping`.
 */
import { Buffer } from "node:buffer";
import { Option, Schema } from "effect";

/** The stateless revision. */
export const MODERN_VERSION = "2026-07-28";

/** The handshake revisions `initialize` accepts, the latest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Every revision the endpoint speaks, as `server/discover` and `UnsupportedProtocolVersion` list them. */
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [MODERN_VERSION, ...LEGACY_VERSIONS];

export const SERVER_INFO = { name: "commissary", version: "1.0.0" } as const;

const META_VERSION = "io.modelcontextprotocol/protocolVersion";

const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** JSON-RPC and MCP error codes the endpoint answers with. */
export const RpcCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  headerMismatch: -32020,
  unsupportedProtocolVersion: -32022,
} as const;

export type RequestId = string | number;

/** A JSON-RPC answer and the HTTP status it goes with. */
export interface Answer {
  readonly status: number;
  /** Undefined: no body (`202`). */
  readonly body: Schema.JsonObject | undefined;
}

const RequestIdSchema = Schema.Union([Schema.String, Schema.Finite]);

/** A request or a notification: a `method`, and an `id` for a request. */
const RpcMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(RequestIdSchema),
  method: Schema.String,
  params: Schema.optionalKey(Schema.JsonObject),
});

/** A client's answer to a request of the server (a 2025 client may send one): accepted and ignored. */
const RpcResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.NullOr(RequestIdSchema)),
});

const decodeMessage = Schema.decodeUnknownOption(RpcMessage);

const decodeResponse = Schema.decodeUnknownOption(RpcResponse);

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const isJsonObject = Schema.is(Schema.JsonObject);

/** One JSON-RPC request the endpoint answers. */
export interface RpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: Schema.JsonObject;
}

/** What one POST carries: a request to answer, or something answered at once (a notification, a malformed body). */
export type Incoming =
  | { readonly kind: "request"; readonly request: RpcRequest }
  | { readonly kind: "answered"; readonly answer: Answer };

export const errorAnswer = (
  status: number,
  id: RequestId | null,
  code: number,
  message: string,
  data?: Schema.Json,
): Answer => ({
  status,
  body: {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  },
});

export const resultAnswer = (id: RequestId, result: Schema.JsonObject): Answer => ({
  status: 200,
  body: { jsonrpc: "2.0", id, result },
});

const ACCEPTED: Answer = { status: 202, body: undefined };

/** Reads one POST's body: a single JSON-RPC message (batches went with 2025-06-18). */
export const incoming = (text: string): Incoming => {
  const json = parseJson(text);

  if (Option.isNone(json))
    return {
      kind: "answered",
      answer: errorAnswer(400, null, RpcCode.parseError, "Parse error"),
    };

  const message = decodeMessage(json.value);

  if (Option.isSome(message)) {
    const { id, method, params } = message.value;

    return id === undefined
      ? { kind: "answered", answer: ACCEPTED }
      : { kind: "request", request: { id, method, params: params ?? {} } };
  }

  if (Option.isSome(decodeResponse(json.value)) && !Array.isArray(json.value))
    return { kind: "answered", answer: ACCEPTED };

  return {
    kind: "answered",
    answer: errorAnswer(400, null, RpcCode.invalidRequest, "Invalid Request"),
  };
};

/** The era of a request and what it says of its client. */
export interface Era {
  readonly modern: boolean;
  /** The client's capabilities: a modern request's `_meta`; none for a legacy one (they were the handshake's). */
  readonly capabilities: Schema.JsonObject;
}

const LEGACY: Era = { modern: false, capabilities: {} };

/** The `_meta` of a request's params, if it has one. */
const metaOf = (params: Schema.JsonObject): Schema.JsonObject | undefined => {
  const meta = params["_meta"];

  return isJsonObject(meta) ? meta : undefined;
};

const SENTINEL = /^=\?base64\?(.*)\?=$/;

/** A header value as the spec's value encoding carries it: `=?base64?…?=` decoded, anything else as it is. */
const decodedHeader = (value: string): string => {
  const encoded = SENTINEL.exec(value)?.[1];

  return encoded === undefined ? value : Buffer.from(encoded, "base64").toString("utf8");
};

const mismatch = (id: RequestId, message: string): Answer =>
  errorAnswer(400, id, RpcCode.headerMismatch, `Header mismatch: ${message}`);

/**
 * The era of `request` given its HTTP headers (lowercased names), or the refusal of a modern request whose headers do
 * not match its body or whose revision the endpoint does not speak. A request is modern when it names a revision in
 * `_meta` or a modern revision in `MCP-Protocol-Version`; `initialize` is always the handshake's.
 */
export const eraOf = (
  request: RpcRequest,
  headers: Readonly<Record<string, string | undefined>>,
): { readonly era: Era } | { readonly refused: Answer } => {
  if (request.method === "initialize") return { era: LEGACY };
  const meta = metaOf(request.params);
  const named = meta?.[META_VERSION];
  const header = headers["mcp-protocol-version"]?.trim();

  if (named === undefined && (header === undefined || !header.startsWith("2026")))
    return { era: LEGACY };

  if (header === undefined)
    return { refused: mismatch(request.id, "missing MCP-Protocol-Version") };

  if (named !== header)
    return {
      refused: mismatch(request.id, "MCP-Protocol-Version does not match the request's _meta"),
    };

  if (header !== MODERN_VERSION)
    return {
      refused: errorAnswer(
        400,
        request.id,
        RpcCode.unsupportedProtocolVersion,
        "Unsupported protocol version",
        { supported: [...SUPPORTED_VERSIONS], requested: header },
      ),
    };

  if (headers["mcp-method"] !== request.method)
    return { refused: mismatch(request.id, "Mcp-Method does not match the request's method") };

  if (request.method === "tools/call") {
    const name = headers["mcp-name"];

    if (name === undefined || decodedHeader(name) !== request.params["name"])
      return { refused: mismatch(request.id, "Mcp-Name does not match the tool's name") };
  }

  const capabilities = meta?.[META_CAPABILITIES];

  return {
    era: {
      modern: true,
      capabilities: isJsonObject(capabilities) ? capabilities : {},
    },
  };
};

/** Whether a modern client declared URL-mode elicitation. */
export const elicitsUrls = (era: Era): boolean => {
  const elicitation = era.capabilities["elicitation"];

  return era.modern && isJsonObject(elicitation) && isJsonObject(elicitation["url"]);
};

/** A result as `era` frames it: a modern one names its kind and the server. */
export const framed = (era: Era, result: Schema.JsonObject): Schema.JsonObject => {
  if (!era.modern) return result;
  const meta = result["_meta"];
  const fields: Readonly<Record<string, Schema.Json>> = result;
  const metaFields: Readonly<Record<string, Schema.Json>> = isJsonObject(meta) ? meta : {};

  return {
    resultType: "complete",
    ...fields,
    _meta: { ...metaFields, [META_SERVER_INFO]: SERVER_INFO },
  };
};

const CAPABILITIES = { tools: {} };

/** `initialize`: the revision asked for when the endpoint speaks it, else the latest handshake revision. */
export const initializeResult = (params: Schema.JsonObject): Schema.JsonObject => {
  const asked = params["protocolVersion"];

  const version = LEGACY_VERSIONS.find((known) => known === asked) ?? LEGACY_VERSIONS[0];

  return { protocolVersion: version, capabilities: CAPABILITIES, serverInfo: SERVER_INFO };
};

/** `server/discover`: the same for every caller, so caches may share it. */
export const discoverResult = (): Schema.JsonObject => ({
  supportedVersions: [...SUPPORTED_VERSIONS],
  capabilities: CAPABILITIES,
  ttlMs: 3_600_000,
  cacheScope: "public",
});

/** A method the endpoint does not serve: `404` for a modern client, as the transport asks. */
export const methodNotFound = (era: Era, id: RequestId, method: string): Answer =>
  errorAnswer(era.modern ? 404 : 200, id, RpcCode.methodNotFound, `Method not found: ${method}`);
