/**
 * `@commissary/auth`: request-side authentication (#132). The principal and its identity, roles, Cloudflare Access JWT
 * verification, the cross-site checks, API keys and management keys with their per-isolate caches, admission and the
 * membership index, the viewer (who asks, for an area's ownership rules), Commissary Cloud's standing, the auth Worker's RPC interface (`SignInService`),
 * the two gates behind the two entry points (`authenticateClient`, `authenticateManagement`) and what a Worker's gate
 * answers around them (`refusal.ts`). It reads its settings from `AuthConfig` and its state through `AuthDirectory`,
 * which the Worker provides; it imports `@commissary/core`, `@commissary/contract`, `effect` and `jose` only. Single sign-on's pure parts are `@commissary/auth/sso`; the
 * in-memory directory and the Access test helpers are `@commissary/auth/testing`.
 */
export * from "./access/config.ts";

export * from "./access/jwks.ts";

export * from "./access/verify.ts";

export { ACCESS_JWT_HEADER, ACCESS_TOKEN_HEADER } from "./access-gate.ts";

export * from "./admission.ts";

export * from "./api-key.ts";

export * from "./authenticate.ts";

export * from "./config.ts";

export * from "./csrf.ts";

export * from "./directory.ts";

export type { AccessError, ManagementRoute } from "./gate.ts";

export { NOT_SIGNED_IN, SignInSessions, type SignedInPerson } from "./hosted-gate.ts";

export * from "./keys.ts";

export * from "./management-key.ts";

export * from "./mode.ts";

export * from "./principal.ts";

export * from "./refusal.ts";

export * from "./roles.ts";

export type { SignInService } from "./sign-in-service.ts";

export * from "./standing.ts";

export * from "./viewer.ts";
