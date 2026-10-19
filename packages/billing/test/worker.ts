// The test Worker's entry (vitest.config.ts): a test-only ControlPlane, `@commissary/state`'s org-wide base composed with
// the Billing part the way a Worker composes it (`composeControlPlane`), the Platform registry and SessionState, on real
// SQLite storage. Billing's tests depend on no other area and on no app.
import { composeControlPlane } from "@commissary/state";
import { BillingPart } from "../src/state.ts";

export { Platform, SessionState } from "@commissary/state";

export class ControlPlane extends composeControlPlane({
  billing: (ctx) => new BillingPart(ctx),
}) {}

export default {
  fetch: () => new Response("Billing's test Worker serves no requests", { status: 404 }),
} satisfies ExportedHandler;
