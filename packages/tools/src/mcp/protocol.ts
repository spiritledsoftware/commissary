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
 *   one of {@link LEGACY_VERSIONS}, else the latest; no session is minted (Streamable HTTP lets a server go without
 *   one), so the requests that follow are served alike, with no `MCP-Protocol-Version` (a 2025-03-26 client's) or one
 *   of {@link LEGACY_HEADER_VERSIONS}; another is `400 UnsupportedProtocolVersion`, a notification's too.
 *
 * Every answer is one JSON object, never an SSE stream; a notification (or a client's response) is `202`. Commissary
 * serves tools only: `tools/list` and `tools/call`, besides `initialize`, `server/discover` and `ping`.
 */
import { Option, Schema } from "effect";
import { decodeHeaderValue } from "./header-value.ts";
import { isJsonObject } from "../http/shared.ts";

/** The stateless revision. */
export const MODERN_VERSION = "2026-07-28";

/** The handshake revisions `initialize` accepts, the latest first. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Every revision the endpoint speaks, as `server/discover` and `UnsupportedProtocolVersion` list them. */
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [MODERN_VERSION, ...LEGACY_VERSIONS];

/**
 * The `MCP-Protocol-Version` a legacy request may carry: a handshake revision, or 2024-11-05, whose clients the
 * endpoint serves alike.
 */
export const LEGACY_HEADER_VERSIONS: ReadonlySet<string> = new Set([
  ...LEGACY_VERSIONS,
  "2024-11-05",
]);

/** The `_meta` keys MCP reserves for itself, which an upstream's result does not pass on. */
const RESERVED_META = "io.modelcontextprotocol/";

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

/** One JSON-RPC request the endpoint answers. */
export interface RpcRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: Schema.JsonObject;
}

/**
 * What one POST carries: a request to answer, a notification or a client's response (`202` unless its
 * `MCP-Protocol-Version` is refused, {@link acceptedUnder}), or a malformed body answered at once.
 */
export type Incoming =
  | { readonly kind: "request"; readonly request: RpcRequest }
  | { readonly kind: "accepted" }
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
      ? { kind: "accepted" }
      : { kind: "request", request: { id, method, params: params ?? {} } };
  }

  if (Option.isSome(decodeResponse(json.value)) && !Array.isArray(json.value))
    return { kind: "accepted" };

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

/** A revision the endpoint does not speak: `400`, with the ones it does. */
const unsupported = (id: RequestId | null, requested: string): Answer =>
  errorAnswer(400, id, RpcCode.unsupportedProtocolVersion, "Unsupported protocol version", {
    supported: [...SUPPORTED_VERSIONS],
    requested,
  });

/**
 * The answer to a notification or a client's response given its headers: `202`, or `400 UnsupportedProtocolVersion`
 * when it names a revision the endpoint does not speak (neither era's).
 */
export const acceptedUnder = (headers: Readonly<Record<string, string | undefined>>): Answer => {
  const header = headers["mcp-protocol-version"]?.trim();

  return header === undefined || header === MODERN_VERSION || LEGACY_HEADER_VERSIONS.has(header)
    ? ACCEPTED
    : unsupported(null, header);
};

const mismatch = (id: RequestId, message: string): Answer =>
  errorAnswer(400, id, RpcCode.headerMismatch, `Header mismatch: ${message}`);

/**
 * The era of `request` given its HTTP headers (lowercased names), or the refusal of a request whose revision the
 * endpoint does not speak, or of a modern request whose headers do not match its body. A request is modern when it
 * names a revision in `_meta` or a modern revision in `MCP-Protocol-Version`; `initialize` is always the handshake's.
 */
export const eraOf = (
  request: RpcRequest,
  headers: Readonly<Record<string, string | undefined>>,
): { readonly era: Era } | { readonly refused: Answer } => {
  if (request.method === "initialize") return { era: LEGACY };
  const meta = metaOf(request.params);
  const named = meta?.[META_VERSION];
  const header = headers["mcp-protocol-version"]?.trim();

  if (named === undefined && (header === undefined || !header.startsWith("2026"))) {
    if (header === undefined || LEGACY_HEADER_VERSIONS.has(header)) return { era: LEGACY };

    return { refused: unsupported(request.id, header) };
  }

  if (header === undefined)
    return { refused: mismatch(request.id, "missing MCP-Protocol-Version") };

  if (named !== header)
    return {
      refused: mismatch(request.id, "MCP-Protocol-Version does not match the request's _meta"),
    };

  if (header !== MODERN_VERSION) return { refused: unsupported(request.id, header) };

  if (headers["mcp-method"] !== request.method)
    return { refused: mismatch(request.id, "Mcp-Method does not match the request's method") };

  if (request.method === "tools/call") {
    const name = headers["mcp-name"];

    if (name === undefined || decodeHeaderValue(name) !== request.params["name"])
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

/**
 * Whether a modern client declared form-mode elicitation: `elicitation.form`, or an `elicitation` that names neither
 * mode (form mode only, as the revision reads it).
 */
export const elicitsForms = (era: Era): boolean => {
  const elicitation = era.capabilities["elicitation"];

  if (!era.modern || !isJsonObject(elicitation)) return false;

  return (
    isJsonObject(elicitation["form"]) ||
    (elicitation["form"] === undefined && elicitation["url"] === undefined)
  );
};

/** `meta` without the keys MCP reserves ({@link RESERVED_META}): an upstream's are its own revision's, not ours. */
const unreserved = (meta: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(Object.entries(meta).filter(([key]) => !key.startsWith(RESERVED_META)));

/**
 * The `_meta` key prefixes of Commissary's own (`RUN_WAITS_META`, `RUN_TICKET_META`, `SPEND_REFUSAL_META`, …), which an
 * agent run reads as the endpoint's word: what a call waits on, a gated call's ticket, a spend limit's refusal.
 */
const OWN_META = ["commissary/", "commissary.dev/"] as const;

/**
 * An upstream server's tool `result` without any `_meta` key of Commissary's own ({@link OWN_META}): a server could
 * otherwise make a run park on a wait of its own making (and its starter be asked to open its link, #232), or end a
 * turn as a spend limit would. The endpoint adds its own keys after.
 */
export const withoutOwnMeta = (result: Schema.JsonObject): Schema.JsonObject => {
  const { _meta: meta, ...fields } = result;

  if (!isJsonObject(meta)) return result;
  const kept = Object.entries(meta).filter(([key]) => !OWN_META.some((own) => key.startsWith(own)));

  return kept.length === 0 ? fields : { ...fields, _meta: Object.fromEntries(kept) };
};

/**
 * A result as `era` frames it: any reserved `_meta` key the result came with (an upstream's) left out, and a modern
 * one naming its kind and the server.
 */
export const framed = (era: Era, result: Schema.JsonObject): Schema.JsonObject => {
  const { _meta: meta, ...fields } = result;
  const own: Readonly<Record<string, Schema.Json>> = isJsonObject(meta) ? unreserved(meta) : {};

  if (!era.modern) return Object.keys(own).length === 0 ? fields : { ...fields, _meta: own };

  return {
    resultType: "complete",
    ...fields,
    _meta: { ...own, [META_SERVER_INFO]: SERVER_INFO },
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
