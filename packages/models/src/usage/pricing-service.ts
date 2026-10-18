/**
 * Costs a usage record when it is written (ADR 0024): the org's price overrides (`ConfigReader`) and the catalog's
 * models.dev prices (`CatalogStore`) feed `pricing.ts`. New in the Workers port.
 *
 * The cost is looked up once, in the detached write of the record (`d1-sink.ts`), so a request never waits for it, and
 * it is stored with the record: a price changed later (an override edited, the catalog refreshed) never moves it.
 *
 * Catalog prices come from the active catalog first, then from the models.dev snapshot compiled into the Worker: a
 * catalog stored in KV before models.dev costs were kept has no prices, and the bundled snapshot prices the models it
 * lists until the next refresh replaces the stored copy. Models models.dev does not list are priced from the bundled
 * catalog additions (never fetched).
 *
 * An attempt with no tokens (a request refused before the model ran) costs nothing whether or not its model has a
 * price, so it is not listed as unpriced traffic; every other attempt of a model without a price is.
 */
import { Context, Effect, Layer } from "effect";
import { ConfigReader } from "../config/reader.ts";
import { usesEmbeddedCatalog } from "../registry/catalog-source.ts";
import { catalogAdditions, embeddedModelsDev } from "../registry/catalog.ts";
import { CatalogStore } from "../registry/catalog-store.ts";
import { CurrentOrg } from "@commissary/core";
import { ensureTokenBreakdown } from "./accounting.ts";
import { costOf, findPrice, type PriceSources, type UsageCost } from "./pricing.ts";
import type { UsageRecord } from "./record.ts";
import type { ModelsEnv } from "../env.ts";

const NO_COST: UsageCost = { micros: 0, unpriced: false };

export class UsagePricing extends Context.Service<
  UsagePricing,
  {
    /** The cost of `record`; `undefined` when it cannot be costed (the record is stored without one). */
    readonly costOf: (
      record: UsageRecord,
    ) => Effect.Effect<UsageCost | undefined, never, ModelsEnv>;
  }
>()("commissary/usage/UsagePricing") {
  /** Stores records without a cost (tests that do not look at it). */
  static readonly none = Layer.succeed(
    UsagePricing,
    UsagePricing.of({ costOf: () => Effect.undefined }),
  );

  /** Needs `ConfigReader` (the org's price overrides) and `CatalogStore` (the catalog prices). */
  static readonly layer = Layer.effect(
    UsagePricing,
    Effect.gen(function* () {
      const reader = yield* ConfigReader;
      const catalogStore = yield* CatalogStore;

      /** The prices that apply to `record`'s org; the catalog alone when the config cannot be read. */
      const sourcesOf = (record: UsageRecord) =>
        Effect.gen(function* () {
          const snapshot = yield* reader.get.pipe(
            Effect.provideService(CurrentOrg, record.orgId),
            Effect.catch((error) =>
              Effect.logWarning(
                `price overrides unavailable, pricing from the catalog: ${error.message}`,
              ).pipe(Effect.as(undefined)),
            ),
          );

          const catalogs = yield* catalogStore.load(
            snapshot !== undefined && usesEmbeddedCatalog(snapshot.config.models.catalog),
          );

          const sources: PriceSources = {
            docs: [catalogs.modelsDev, embeddedModelsDev()],
            overrides: snapshot?.priceOverrides ?? [],
            additions: catalogAdditions(),
          };

          return sources;
        });

      return UsagePricing.of({
        costOf: (record) =>
          Effect.gen(function* () {
            const breakdown = ensureTokenBreakdown(
              record.detail,
              record.provider,
              record.executorType,
            ).tokenBreakdown;

            if (breakdown === undefined) return undefined;
            const price = findPrice(yield* sourcesOf(record), record.provider, record.model);

            if (price === undefined && breakdown.totalTokens === 0) return NO_COST;

            return costOf(price, breakdown);
          }),
      });
    }),
  );
}
