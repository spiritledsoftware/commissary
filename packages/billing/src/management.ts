/**
 * `@commissary/billing/management`, Billing's entry for the app Worker (#134 "The area package convention"): its
 * management API route and its org-deletion step. The route answers 404 on a self-hosted Commissary. The apps import
 * Billing only through this entry, `./api`, `./state` and (in tests) `./testing` (the lint rule
 * `boundaries/billing-imports`).
 */
export { orgDeletionStep } from "./org-deletion.ts";

export { BillingRoutes } from "./routes.ts";
