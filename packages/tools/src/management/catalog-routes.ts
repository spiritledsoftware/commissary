/**
 * `/v9/management/toolkit-catalog` (`ToolkitCatalogGroup` in `@commissary/contract/toolkit-catalog`, #207): the toolkit
 * catalog an org's members add toolkits from (`catalog/`), the same for every org. Listing, searching and reading a
 * service never fetch: they read the catalog the cron task keeps (`catalog/store.ts`). A domain the catalog lacks is
 * looked up live at integrations.sh (`detect`; `discover` only when asked, `catalog/lookup.ts`), the domain and every
 * source URL in the answer through the outbound guard, and nothing of the answer is kept. `GET /status` tells which
 * copy is in use and how the last refresh went; `POST /refresh` runs the cron task's refresh now (org admins,
 * `access-rules.ts`). Adding a toolkit from the catalog is `POST /toolkits` with
 * `catalog` (`routes.ts`).
 */
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest } from "effect/http";
import type { ToolkitCatalogStatus } from "@commissary/contract/toolkit-catalog";
import { AddedToolkitKind } from "@commissary/contract/tools";
import { currentViewer } from "@commissary/auth";
import { jsonReply, OutboundHttpClientLive, replyError } from "@commissary/core";
import {
  type CatalogEntry,
  embeddedCatalog,
  serviceView,
  summaryView,
} from "../catalog/catalog.ts";
import {
  type CheckedDomain,
  type LookupError,
  type LookupVia,
  checkedDomain,
  lookupDomain,
} from "../catalog/lookup.ts";
import { refreshToolkitCatalog } from "../catalog/refresh.ts";
import { currentCatalog } from "../catalog/store.ts";
import { readRefreshStatus } from "../catalog/stored.ts";
import { deploymentKvOf } from "../kv.ts";
import { ToolsEnv, toolsControlPlane } from "../env.ts";

/**
 * Whether Commissary Cloud's managed OAuth app with `service` is available on this deployment: the Tools part knows (the
 * State Worker binds the apps' secrets, this Worker does not).
 */
const managedApp = (service: CatalogEntry) =>
  toolsControlPlane("hasManagedApp", (stub) => stub.tools().hasManagedApp(service.id));

/** A number of the query, or undefined when absent or not a number. */
const numberOf = (value: string | null): number | undefined => {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

const list = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const query = new URL(request.originalUrl, "http://localhost").searchParams;
  const kind = query.get("kind") ?? undefined;

  if (kind !== undefined && !Schema.is(AddedToolkitKind)(kind))
    return yield* replyError(422, "invalid", {
      message: "kind is mcp, openapi, graphql or discovery",
      path: "kind",
    });
  const catalog = yield* currentCatalog;

  const page = catalog.search({
    q: query.get("q") ?? undefined,
    kind,
    limit: numberOf(query.get("limit")),
    offset: numberOf(query.get("offset")),
  });

  return jsonReply(200, { services: page.services.map(summaryView), total: page.total });
});

const service = Effect.gen(function* () {
  const { id } = yield* HttpRouter.params;
  const entry = (yield* currentCatalog).service(id ?? "");

  if (entry === undefined)
    return yield* replyError(404, "not_found", { message: "the catalog has no such service" });

  return jsonReply(200, serviceView(entry, yield* managedApp(entry)));
});

/** What a lookup's failure answers: the domain's `422`, integrations.sh's `429`, or `502`. */
const lookupReply = (error: LookupError) => {
  switch (error.reason) {
    case "invalid":
      return replyError(422, "invalid", { message: error.message, path: "domain" });
    case "refused":
      // The outbound guard's refusal answers as a refused source does: its message, and the field's path.
      return replyError(422, error.message, { path: "domain" });
    case "rate_limited":
      return replyError(429, "lookup_rate_limited", { message: error.message });
    case "failed":
      return replyError(502, "lookup_failed", { message: error.message });
  }
};

const domainParam = Effect.map(HttpRouter.params, ({ domain }) => domain ?? "");

/**
 * `domain` looked up at integrations.sh (`via`), unless the org asked too often lately (the Tools part counts:
 * `catalog/lookup-throttle.ts`): `429 lookup_rate_limited`, saying how long to wait.
 */
const throttledLookup = (domain: CheckedDomain, via: LookupVia) =>
  Effect.gen(function* () {
    const viewer = yield* currentViewer;

    const taken = yield* toolsControlPlane("takeCatalogLookup", (stub) =>
      stub.tools().takeCatalogLookup(viewer, via),
    );

    if (!taken.ok)
      return yield* replyError(429, "lookup_rate_limited", {
        message: `the org looked up too many domains lately: try again in ${Math.ceil(taken.retryAfterMs / 1000)} s`,
      });

    return jsonReply(200, yield* lookupDomain(domain, via));
  });

/** A domain's catalog service, else what integrations.sh's `detect` finds. */
const lookup = Effect.gen(function* () {
  const domain = yield* checkedDomain(yield* domainParam);
  const entry = (yield* currentCatalog).forDomain(domain);

  if (entry !== undefined)
    return jsonReply(200, {
      via: "catalog",
      service: serviceView(entry, yield* managedApp(entry)),
    });

  return yield* throttledLookup(domain, "detect");
}).pipe(Effect.catchTag("CatalogLookupError", lookupReply), Effect.provide(OutboundHttpClientLive));

const discover = Effect.gen(function* () {
  const domain = yield* checkedDomain(yield* domainParam);

  return yield* throttledLookup(domain, "discover");
}).pipe(Effect.catchTag("CatalogLookupError", lookupReply), Effect.provide(OutboundHttpClientLive));

const iso = (ms: number): string => new Date(ms).toISOString();

/** Which copy of the catalog this isolate serves, and what the last refresh attempt left (a KV failure: none). */
const status = Effect.gen(function* () {
  const catalog = yield* currentCatalog;
  const stored = catalog !== embeddedCatalog();
  const kv = deploymentKvOf(yield* ToolsEnv);

  const attempt = yield* Effect.tryPromise(() => readRefreshStatus(kv)).pipe(
    Effect.orElseSucceed(() => undefined),
  );

  return jsonReply(200, {
    stored,
    ...(stored && attempt?.refreshedAt !== undefined
      ? { refreshed_at: iso(attempt.refreshedAt) }
      : {}),
    ...(attempt === undefined
      ? {}
      : {
          last_attempt: {
            at: iso(attempt.attemptedAt),
            status: attempt.status,
            ...(attempt.message === undefined ? {} : { message: attempt.message }),
          },
        }),
    services: catalog.services.length,
    sources: catalog.services.reduce((total, service) => total + service.sources.length, 0),
  } satisfies ToolkitCatalogStatus);
});

const refresh = Effect.gen(function* () {
  const outcome = yield* refreshToolkitCatalog("panel");

  if (outcome.status === "running")
    return yield* replyError(409, "catalog_refresh_running", {
      message: outcome.message ?? "another refresh is running",
    });

  return jsonReply(200, {
    status: outcome.status,
    ...(outcome.message === undefined ? {} : { message: outcome.message }),
    ...(outcome.sources === undefined ? {} : { sources: outcome.sources }),
  });
}).pipe(Effect.provide(OutboundHttpClientLive));

/** The catalog's handlers; `routes.ts` mounts them. */
export const catalogHandlers = { list, service, lookup, discover, status, refresh };
