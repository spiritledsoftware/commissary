/**
 * `@commissary/billing/management`, Billing's entry for the app Worker (#134 "The area package convention"): its
 * management API routes and their entries of the role table (the writes are for org owners), the billing provider's
 * webhook route (public, on the app host) and its org-deletion step. Every route answers 404 on a self-hosted
 * Commissary. The apps import Billing only through this entry, `./api`, `./state` and (in tests) `./testing` (the lint
 * rule `boundaries/billing-imports`).
 */
export { orgDeletionStep } from "./org-deletion.ts";

export { accessRules, BillingRoutes } from "./routes.ts";

export { BillingWebhookRoutes, POLAR_WEBHOOK_PATH } from "./webhook.ts";
