/**
 * Models' entries of the Worker's role table (ADR 0022, the permission matrix of `docs/ACCESS.md`; the app Worker's
 * `management/policy.ts` combines them with its own): the Models routes a plain member may use. Every other Models route
 * needs an org admin.
 */
import type { AccessRule } from "@commissary/auth";

const MANAGEMENT = "/v9/management";

const CREDENTIAL = `${MANAGEMENT}/credentials`;

const PROVIDER_KEYS = `${MANAGEMENT}/provider-keys`;

/** A route a plain member may use with `methods`. */
const member = (methods: ReadonlyArray<string>, path: string): AccessRule => ({
  path,
  methods,
  role: "member",
});

export const accessRules: ReadonlyArray<AccessRule> = [
  // Reading usage (a plain member sees only their own requests, `usage-routes.ts`) and the models the caller may use
  // (ADR 0023): the registry as their own grants leave it.
  member(["GET", "HEAD"], `${MANAGEMENT}/observability/usage/records`),
  member(["GET", "HEAD"], `${MANAGEMENT}/observability/usage/summary`),
  member(["GET", "HEAD"], `${MANAGEMENT}/observability/usage/series`),
  member(["GET", "HEAD"], `${MANAGEMENT}/models/mine`),
  // Connecting and managing their own private credentials (ADR 0023). The handlers scope every operation to what the
  // caller reaches, so a plain member never sees or changes a shared credential, nor another member's private one
  // (`credentials/ownership.ts`).
  member(["GET", "POST", "DELETE"], CREDENTIAL),
  member(["GET"], `${CREDENTIAL}/download`),
  member(["GET"], `${CREDENTIAL}/models`),
  member(["PATCH"], `${CREDENTIAL}/status`),
  member(["PATCH"], `${CREDENTIAL}/fields`),
  member(["POST"], `${CREDENTIAL}/refresh`),
  member(["POST"], `${CREDENTIAL}/batch`),
  member(["POST"], `${CREDENTIAL}/quota`),
  member(["POST"], `${CREDENTIAL}/quota/all`),
  member(["GET"], `${CREDENTIAL}/reset-grants`),
  member(["POST"], `${CREDENTIAL}/reset-grants/claim`),
  member(["POST"], `${MANAGEMENT}/routing/cooldown/reset`),
  member(["GET"], `${MANAGEMENT}/oauth/auth-url`),
  member(["GET"], `${MANAGEMENT}/oauth/status`),
  member(["DELETE"], `${MANAGEMENT}/oauth/session`),
  member(["POST"], `${MANAGEMENT}/oauth/callback`),
  member(["POST"], `${MANAGEMENT}/oauth/import`),
  member(["GET"], PROVIDER_KEYS),
  member(["PUT", "DELETE"], `${PROVIDER_KEYS}/groups`),
  member(["POST"], `${PROVIDER_KEYS}/probe`),
];
