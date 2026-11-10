// `withCredentialPolicy`'s probe stays read-only: it cannot tell whether the credential the base probe would find passes
// the policy, so it answers "no alternative" and takes no lease.
import { env } from "cloudflare:workers";
import { CurrentOrg, GLOBAL_ORG } from "@commissary/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { CredentialPicker } from "../src/executor/picker.ts";
import { withCredentialPolicy } from "../src/executor/policy-picker.ts";
import { envContext } from "./support/context.ts";

describe("withCredentialPolicy.hasAlternative", () => {
  it("answers false without asking the base picker to pick or report anything", async () => {
    const calls: string[] = [];

    const picker = withCredentialPolicy(
      CredentialPicker.of({
        pick: () => Effect.sync(() => void calls.push("pick")).pipe(Effect.andThen(Effect.never)),
        report: () => Effect.sync(() => void calls.push("report")),
        planRetry: () => Effect.succeed({ retry: false }),
        hasAlternative: () => Effect.succeed(true),
      }),
      () => true,
      "no eligible credential",
    );

    const answer = await Effect.runPromise(
      picker
        .hasAlternative({ providers: ["codex"], model: "m", callerScope: "s" })
        .pipe(
          Effect.provideContext(envContext(env)),
          Effect.provideService(CurrentOrg, GLOBAL_ORG),
        ),
    );

    expect(answer).toBe(false);
    expect(calls).toEqual([]);
  });
});
