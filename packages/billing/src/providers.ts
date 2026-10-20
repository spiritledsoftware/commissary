/**
 * Which billing provider (`provider.ts`) a Worker invocation uses: by default Polar's when the deployment has its
 * settings (`polar.ts` `polarProviderOf`), none otherwise (a self-hosted Commissary, a Commissary Cloud stage without
 * them), and then Billing bills nothing. Tests provide a fake through the same reference.
 */
import { Context } from "effect";
import type { BillingBindings } from "./env.ts";
import { polarProviderOf } from "./polar.ts";
import type { BillingProvider } from "./provider.ts";

export const BillingProviders = Context.Reference<
  (env: BillingBindings) => BillingProvider | undefined
>("commissary/billing/BillingProviders", { defaultValue: () => polarProviderOf });
