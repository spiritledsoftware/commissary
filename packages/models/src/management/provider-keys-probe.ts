/**
 * `POST /v9/management/provider-keys/probe` (`@commissary/contract/provider-keys` `ProbeResult`): one connection test
 * of a provider key.
 *
 * Workers addition, no Go counterpart. The upstream panel tests keys from the browser through Go's (not ported)
 * `POST /requests/api-call` with the raw key (`useConnectivityTest.ts`, `models.ts`); here the ControlPlane hands the
 * Worker a probe target (`providerKeyProbeTarget`, like `quotaProbeTarget`) and the Worker makes the request itself, so
 * the key never reaches the browser and only goes to the base host configured for it (which a key-page write can
 * change while keeping the key). The probe is a model listing (which doubles as model discovery) or, for Vertex (no
 * listing), a one-token `countTokens`. Per family:
 *
 * - gemini / interactions: `GET {base}/v1beta/models` (`x-goog-api-key`, paged by `nextPageToken`, at most 20 pages);
 * - claude: `GET {base}/v1/models` with `x-api-key` + `anthropic-version` on api.anthropic.com, Bearer elsewhere
 *   (and for OAuth tokens), as the executor authenticates;
 * - codex / xai / meta: `GET {base}/models` when the base ends with `/v1`, else `{base}/v1/models` (Bearer);
 * - openai-compatibility: `GET {base}/models` (Bearer);
 * - vertex: `POST {base}/v1/publishers/google/models/{first configured model}:countTokens` (`x-goog-api-key`);
 * - opencode-zen / opencode-go: `POST {base}/chat/completions` (Bearer, the gateway's client headers and a random
 *   `x-opencode-session`) with a body naming no real model, so a working key costs nothing. The gateways' `GET /models`
 *   is public and proves nothing about the key: a 401 means a bad key, and a 400 (the gateway rejected the body or
 *   the model after authenticating) counts as success. No models are listed.
 * - typesafe: `GET {base}/models` (Bearer), whether or not the base ends with `/v1`; the answer is
 *   `{models:[{name,description,release_date}]}`;
 * - subq: `POST {base}/systemone` (Bearer) with the smallest valid request (one noul question about an empty state on
 *   `subq-snap-preview`), so a working key pays for a few dozen input tokens ($0.05 per million). SubQ's
 *   `GET /models` is public, and it validates a request's body and model before it checks the key (an invalid body
 *   answers 422 even with a made-up key; checked live in October 2026, without a real key): only a valid request
 *   proves the key. A 2xx is a working key; 401, 402 (no credits) and 403 fail with their status. No models are
 *   listed.
 *
 * The call is not reported to the credential pool (no counters, no cooldown) and is bounded to 30 s in total. Failures
 * carry a fixed message and the upstream status only: response bodies are never copied (an upstream can echo a key).
 * Unverified against the live services: that Meta serves `/models` and that Vertex provider-key mode accepts `countTokens`.
 */
import { Clock, Effect, Result } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Credential } from "../credentials/model.ts";
import { isAnthropicUpstreamURL, isClaudeOAuthToken } from "../executor/claude/credentials.ts";
import {
  OPENCODE_CLIENT,
  OPENCODE_SESSION_HEADER,
  OPENCODE_USER_AGENT,
} from "../executor/opencode/headers.ts";
import { isJsonObject, type Json, tryParseJson } from "@commissary/json";
import { DEFAULT_BASE_URLS } from "./provider-keys-view.ts";
import type { ProviderKeyFamily, ProbeResult } from "@commissary/contract/provider-keys";

/** What a probe needs from one config credential; carries the key, so it only crosses the RPC boundary to the Worker. */
export interface ProviderKeyProbeTarget {
  readonly id: string;
  readonly family: ProviderKeyFamily;
  /** Configured base URL, or the family's default. */
  readonly baseUrl: string;
  readonly providerKey: string;
  /** Configured headers except the `$name` ones (which copy a client header). */
  readonly headers: Readonly<Record<string, string>>;
  /** Names of the configured models (Vertex tests the first). */
  readonly models: ReadonlyArray<string>;
}

export type ProviderKeyProbeTargetResult =
  | { readonly ok: true; readonly target: ProviderKeyProbeTarget }
  | { readonly ok: false; readonly error: "not_found" };

const PROVIDER_FAMILIES = {
  gemini: "gemini",
  "gemini-interactions": "interactions",
  vertex: "vertex",
  codex: "codex",
  claude: "claude",
  xai: "xai",
  meta: "meta",
  "opencode-zen": "opencode-zen",
  "opencode-go": "opencode-go",
  typesafe: "typesafe",
  subq: "subq",
} as const satisfies Readonly<Record<string, ProviderKeyFamily>>;

/** The probe target of a config credential; `undefined` for a credential of another provider. */
export const buildProviderKeyProbeTarget = (
  credential: Pick<Credential, "id" | "provider" | "attributes" | "headers" | "models">,
): ProviderKeyProbeTarget | undefined => {
  const compat = credential.attributes.compat_name !== undefined;

  const family: ProviderKeyFamily | undefined = compat
    ? "openai-compatibility"
    : Object.entries(PROVIDER_FAMILIES).find(([provider]) => provider === credential.provider)?.[1];

  if (family === undefined) return undefined;
  const configured = (credential.attributes.base_url ?? "").trim();

  const base =
    configured === "" && family !== "openai-compatibility" ? DEFAULT_BASE_URLS[family] : configured;

  return {
    id: credential.id,
    family,
    baseUrl: base,
    providerKey: (credential.attributes.api_key ?? "").trim(),
    headers: Object.fromEntries(
      Object.entries(credential.headers).filter(([, value]) => !value.startsWith("$")),
    ),
    models: (credential.models ?? []).map((model) => model.name),
  };
};

const TIMEOUT = "30 seconds";

const MAX_PAGES = 20;

const MAX_MODELS = 1000;

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

interface Exchange {
  readonly status: number;
  readonly body: Json | undefined;
}

type ProbedModel = { id: string; display_name?: string };

/** An answered probe request with the models its body listed. */
interface Probed extends Exchange {
  readonly models: ReadonlyArray<ProbedModel>;
  /** Overrides the 2xx-and-JSON rule: the status alone decides (the OpenCode auth check). */
  readonly accepted?: boolean;
}

/** A failed probe: a fixed message safe to show, and the upstream status when there was one. */
interface Failure {
  readonly message: string;
  readonly status?: number;
}

const failure = (message: string, status?: number): Failure =>
  status === undefined ? { message } : { message, status };

const send = (
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Exchange, Failure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(request);
    const body = yield* response.text;

    return { status: response.status, body: tryParseJson(body) };
  }).pipe(
    Effect.mapError(() => failure("request failed")),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  );

const ok = (exchange: Exchange): boolean => exchange.status >= 200 && exchange.status < 300;

/** Request headers: the configured ones first, so the authentication headers always win. */
const headersOf = (target: ProviderKeyProbeTarget, auth: Readonly<Record<string, string>>) => ({
  accept: "application/json",
  ...target.headers,
  ...auth,
});

const bearer = (key: string) => (key === "" ? {} : { authorization: `Bearer ${key}` });

const claudeAuth = (target: ProviderKeyProbeTarget) => {
  const first = (() => {
    try {
      return isAnthropicUpstreamURL(new URL(target.baseUrl));
    } catch {
      return false;
    }
  })();

  if (target.providerKey === "") return { "anthropic-version": "2023-06-01" };

  return first && !isClaudeOAuthToken(target.providerKey)
    ? { "x-api-key": target.providerKey, "anthropic-version": "2023-06-01" }
    : { ...bearer(target.providerKey), "anthropic-version": "2023-06-01" };
};

const modelIdOf = (value: string): string => value.replace(/^models\//, "");

/** Models of a listing: OpenAI `{data:[{id}]}`, Anthropic `{data:[{id,display_name}]}`, Gemini `{models:[{name,displayName}]}`. */
export const parseModelList = (
  body: Json | undefined,
): ReadonlyArray<{ id: string; display_name?: string }> => {
  if (!isJsonObject(body)) return [];
  const list = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
  const models: Array<{ id: string; display_name?: string }> = [];

  for (const item of list) {
    if (!isJsonObject(item)) continue;

    const id =
      typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : "";

    const label = item.display_name ?? item.displayName;

    if (id === "") continue;
    models.push({
      id: modelIdOf(id),
      ...(typeof label === "string" && label !== "" ? { display_name: label } : {}),
    });

    if (models.length >= MAX_MODELS) break;
  }

  return models;
};

const listing = Effect.fnUntraced(function* (
  target: ProviderKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const base = trimSlash(target.baseUrl);
  const { family } = target;

  if (family === "gemini" || family === "interactions") {
    const headers = headersOf(
      target,
      target.providerKey === "" ? {} : { "x-goog-api-key": target.providerKey },
    );

    const models: Array<{ id: string; display_name?: string }> = [];
    let token: string | undefined;
    let last: Exchange = { status: 0, body: undefined };

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ pageSize: "1000" });

      if (token !== undefined) params.set("pageToken", token);

      const request = HttpClientRequest.get(`${base}/v1beta/models?${params.toString()}`).pipe(
        HttpClientRequest.setHeaders(headers),
      );

      last = yield* send(request);

      if (!ok(last)) return { ...last, models: [] };
      models.push(...parseModelList(last.body));
      const next = isJsonObject(last.body) ? last.body.nextPageToken : undefined;
      token = typeof next === "string" && next !== "" ? next : undefined;

      if (token === undefined) break;
    }

    return { status: last.status, body: last.body, models };
  }

  const url =
    family === "claude"
      ? `${base}/v1/models?limit=1000`
      : family === "openai-compatibility" || family === "typesafe" || base.endsWith("/v1")
        ? `${base}/models`
        : `${base}/v1/models`;

  const auth = family === "claude" ? claudeAuth(target) : bearer(target.providerKey);

  const exchange = yield* send(
    HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headersOf(target, auth))),
  );

  return { ...exchange, models: ok(exchange) ? parseModelList(exchange.body) : [] };
});

const countTokens = Effect.fnUntraced(function* (
  target: ProviderKeyProbeTarget,
  model: string,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const request = HttpClientRequest.post(
    `${trimSlash(target.baseUrl)}/v1/publishers/google/models/${encodeURIComponent(model)}:countTokens`,
  ).pipe(
    HttpClientRequest.setHeaders(
      headersOf(target, target.providerKey === "" ? {} : { "x-goog-api-key": target.providerKey }),
    ),
    HttpClientRequest.bodyText(
      JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      "application/json",
    ),
  );

  const exchange = yield* send(request);

  return { ...exchange, models: [] };
});

/** A model id no gateway serves: the check never runs (or bills) a completion. */
export const OPENCODE_PROBE_MODEL = "commissary-key-check";

const openCodeAuthCheck = Effect.fnUntraced(function* (
  target: ProviderKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const request = HttpClientRequest.post(`${trimSlash(target.baseUrl)}/chat/completions`).pipe(
    HttpClientRequest.setHeaders(
      headersOf(target, {
        ...bearer(target.providerKey),
        "user-agent": OPENCODE_USER_AGENT,
        "x-opencode-client": OPENCODE_CLIENT,
        [OPENCODE_SESSION_HEADER]: crypto.randomUUID(),
      }),
    ),
    HttpClientRequest.bodyText(
      JSON.stringify({
        model: OPENCODE_PROBE_MODEL,
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      "application/json",
    ),
  );

  const exchange = yield* send(request);

  return { ...exchange, models: [], accepted: ok(exchange) || exchange.status === 400 };
});

/** The model and the request of SubQ's key test: valid, and as small as SubQ allows. */
export const SUBQ_PROBE_MODEL = "subq-snap-preview";

const subqAuthCheck = Effect.fnUntraced(function* (
  target: ProviderKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  const request = HttpClientRequest.post(`${trimSlash(target.baseUrl)}/systemone`).pipe(
    HttpClientRequest.setHeaders(headersOf(target, bearer(target.providerKey))),
    HttpClientRequest.bodyText(
      JSON.stringify({
        model: SUBQ_PROBE_MODEL,
        state: "",
        questions: { key_check: { type: "noul", instructions: "Is this a key check?" } },
      }),
      "application/json",
    ),
  );

  const exchange = yield* send(request);

  return { ...exchange, models: [] };
});

const validBase = (value: string): boolean => {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
};

const run = Effect.fnUntraced(function* (
  target: ProviderKeyProbeTarget,
): Effect.fn.Return<Probed, Failure, HttpClient.HttpClient> {
  if (!validBase(target.baseUrl)) return yield* Effect.fail(failure("invalid base url"));

  if (target.family === "vertex") {
    const [model] = target.models;

    if (model === undefined) return yield* Effect.fail(failure("no model configured to test"));

    return yield* countTokens(target, model);
  }

  if (target.family === "opencode-zen" || target.family === "opencode-go")
    return yield* openCodeAuthCheck(target);

  if (target.family === "subq") return yield* subqAuthCheck(target);

  return yield* listing(target);
});

/** Probes one key; always answers a result (a failure is `ok: false`), never fails. */
export const probeProviderKey = (
  target: ProviderKeyProbeTarget,
): Effect.Effect<ProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;

    const outcome = yield* run(target).pipe(
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () => Effect.fail(failure("request timed out")),
      }),
      Effect.result,
    );

    const latency = Math.max(0, (yield* Clock.currentTimeMillis) - started);

    if (Result.isFailure(outcome)) {
      const { message, status } = outcome.failure;

      return {
        ok: false,
        latency_ms: latency,
        error: message,
        ...(status === undefined ? {} : { status_code: status }),
      } satisfies ProbeResult;
    }

    const exchange = outcome.success;

    if (exchange.accepted === true) {
      return { ok: true, status_code: exchange.status, latency_ms: latency } satisfies ProbeResult;
    }

    if (!ok(exchange)) {
      return {
        ok: false,
        status_code: exchange.status,
        latency_ms: latency,
        error: `upstream answered ${exchange.status}`,
      } satisfies ProbeResult;
    }

    // A 2xx that is not JSON is a wrong base URL (a login page, a proxy), not a working key.
    if (exchange.body === undefined) {
      return {
        ok: false,
        status_code: exchange.status,
        latency_ms: latency,
        error: "unexpected response (not JSON)",
      } satisfies ProbeResult;
    }

    return {
      ok: true,
      status_code: exchange.status,
      latency_ms: latency,
      ...(exchange.models.length === 0 ? {} : { models: exchange.models }),
    } satisfies ProbeResult;
  });
