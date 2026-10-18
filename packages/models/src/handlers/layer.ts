/**
 * Wiring of the client API routes and their services.
 *
 * Services are built once per isolate (the web handler's layer scope); per-request bindings (`ModelsEnv`) and the
 * Access principal are provided per request. Tests swap the upstream transport, config source, usage sink or
 * credential picker through {@link makeClientApiRoutes}.
 */
import { Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/http";
import { ConfigReader } from "../config/reader.ts";
import type { CredentialPicker } from "../executor/picker.ts";
import { ControlPlanePickerLayer } from "../executor/control-plane-picker.ts";
import { CredentialRefresher } from "../executor/helps/credential-refresh.ts";
import { ModelRegistryLive } from "../registry/live.ts";
import { ExecutorRegistry } from "../executor/registry.ts";
import { Thinking } from "../executor/thinking.ts";
import { UpstreamWebSocketConnector } from "../executor/websocket/connector.ts";
import { CatalogStore } from "../registry/catalog-store.ts";
import { D1UsageSink } from "../usage/d1-sink.ts";
import { UsagePricing } from "../usage/pricing-service.ts";
import { UsageSink } from "../usage/sink.ts";
import { ModelCapabilities } from "./model-capabilities.ts";
import { ClaudeRoutes } from "./claude/routes.ts";
import { GeminiRoutes } from "./gemini/routes.ts";
import { ModelProviders } from "./model-providers.ts";
import { AlphaSearchRoutes } from "./codex/alpha-search.ts";
import { ImagesRoutes } from "./openai/images.ts";
import { SpeechRoutes } from "./openai/speech.ts";
import { VideoRoutes } from "./openai/videos.ts";
import { OpenAIRoutes } from "./openai/routes.ts";
import { ResponsesRoutes } from "./responses/routes.ts";
import { SystemOneRoutes } from "./systemone/routes.ts";

export interface ClientApiLayerOptions {
  readonly configReader?: Layer.Layer<ConfigReader>;
  /** Defaults to the ControlPlane Durable Object picker (`StaticCredentialPickerLayer` is for tests). */
  readonly credentialPicker?: Layer.Layer<CredentialPicker, never, ConfigReader>;
  /** Defaults to the model registry (`ModelProviders.configLayer` serves tests without one). */
  readonly modelProviders?: Layer.Layer<ModelProviders, never, ConfigReader>;
  /** Defaults to the model registry snapshot (`ModelCapabilities.configLayer` serves tests without one). */
  readonly modelCapabilities?: Layer.Layer<ModelCapabilities, never, ConfigReader>;
  /** Defaults to the ControlPlane (`CredentialRefresher.none` for tests with provider keys only). */
  readonly credentialRefresher?: Layer.Layer<CredentialRefresher>;
  readonly httpClient?: Layer.Layer<HttpClient.HttpClient>;
  /** Defaults to the D1 sink, which costs each record from the org's config and the catalog. */
  readonly usageSink?: Layer.Layer<UsageSink, never, ConfigReader>;
  /** Upstream WebSocket dialer for the Codex/xAI transports (defaults to `fetch` with `Upgrade: websocket`). */
  readonly websocketConnector?: Layer.Layer<UpstreamWebSocketConnector>;
  readonly thinking?: Layer.Layer<Thinking>;
}

/** The D1 sink with the pricing of records (`UsagePricing`); reads the org's price overrides through `ConfigReader`. */
const usageSinkLayer = D1UsageSink.pipe(
  Layer.provide(UsagePricing.layer),
  Layer.provide(CatalogStore.layer),
);

/** All client API route layers (provider slices add theirs here). */
export const ClientApiRoutes = Layer.mergeAll(
  OpenAIRoutes,
  ResponsesRoutes,
  ImagesRoutes,
  AlphaSearchRoutes,
  ClaudeRoutes,
  GeminiRoutes,
  VideoRoutes,
  SpeechRoutes,
  SystemOneRoutes,
);

/**
 * The client API routes with their services provided. Handlers still read `AccessPrincipal`: wrap the result with
 * `withAccess(...)` (tests use `makeWithAccess` with a fake JWKS).
 */
export const makeClientApiRoutes = (options: ClientApiLayerOptions = {}) => {
  const config = options.configReader ?? ConfigReader.layerControlPlane();

  const services = Layer.mergeAll(
    options.credentialPicker ?? ControlPlanePickerLayer,
    options.modelCapabilities ??
      ModelCapabilities.registryLayer.pipe(Layer.provide(ModelRegistryLive)),
    options.modelProviders ?? ModelProviders.registryLayer.pipe(Layer.provide(ModelRegistryLive)),
    options.credentialRefresher ?? CredentialRefresher.controlPlane,
    ExecutorRegistry.layer,
    options.usageSink ?? usageSinkLayer,
    options.httpClient ?? FetchHttpClient.layer,
    options.websocketConnector ?? UpstreamWebSocketConnector.layerFetch,
    options.thinking ?? Thinking.live,
  ).pipe(Layer.provideMerge(config));

  return ClientApiRoutes.pipe(Layer.provide(services));
};

/** Production client API layer (ControlPlane config, global `fetch`); the app wraps it with `withAccess(...)`. */
export const ClientApiLayer = makeClientApiRoutes();
