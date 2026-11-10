// `withCredentialPolicy`'s probe applies the policy: an alternative the policy rejects is no alternative.
import { env } from "cloudflare:workers";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { ExecutionError } from "../src/executor/errors.ts";
import {
  CredentialPicker,
  type CredentialSnapshot,
  type PickResult,
} from "../src/executor/picker.ts";
import { withCredentialPolicy } from "../src/executor/policy-picker.ts";
import { oauthCredential } from "./support/codex.ts";
import { envContext } from "./support/context.ts";

const free = oauthCredential({ id: "free", attributes: { plan_type: "free" } });

const plus = oauthCredential({ id: "plus", attributes: { plan_type: "plus" } });

const picker = (credentials: ReadonlyArray<CredentialSnapshot>, reports: string[]) =>
  withCredentialPolicy(
    CredentialPicker.of({
      pick: (request) =>
        Effect.suspend(() => {
          const credential = credentials.find((c) => !(request.excludedIds ?? []).includes(c.id));

          if (credential === undefined)
            return Effect.fail(
              new ExecutionError({ status: 503, code: "auth_not_found", message: "none" }),
            );

          return Effect.succeed({
            credential,
            leaseId: credential.id,
            route: {
              requestedModel: request.model,
              routeModel: request.model,
              upstreamModels: [request.model],
              originalAlias: request.model,
              forceMapping: false,
              stateModel: request.model,
              pooled: false,
            },
            lease: {
              id: credential.id,
              credentialId: credential.id,
              credentialVersion: 1,
              provider: credential.provider,
              model: request.model,
              issuedAt: 0,
            },
          } satisfies PickResult);
        }),
      report: (lease) => Effect.sync(() => void reports.push(lease.id)),
      planRetry: () => Effect.succeed({ retry: false }),
      hasAlternative: (request) =>
        Effect.succeed(credentials.some((c) => !(request.excludedIds ?? []).includes(c.id))),
    }),
    (credential) => credential.attributes["plan_type"] !== "free",
    "no eligible credential",
  );

const probe = (credentials: ReadonlyArray<CredentialSnapshot>, reports: string[]) =>
  Effect.runPromise(
    picker(credentials, reports)
      .hasAlternative({
        providers: ["codex"],
        model: "m",
        callerScope: "s",
        excludedIds: ["pinned"],
      })
      .pipe(Effect.provideContext(envContext(env)), Effect.provideService(CurrentOrg, GLOBAL_ORG)),
  );

describe("withCredentialPolicy.hasAlternative", () => {
  it("is false when the only alternative is one the policy rejects", async () => {
    const reports: string[] = [];
    expect(await probe([free], reports)).toBe(false);
    // The leases of the probe are given back, none as a failure that would cool the credential.
    expect(reports).toEqual(["free"]);
  });

  it("is true when an allowed credential comes after a rejected one", async () => {
    expect(await probe([free, plus], [])).toBe(true);
  });
});
