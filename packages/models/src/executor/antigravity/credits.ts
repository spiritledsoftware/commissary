/**
 * Google One AI credits: request mutation, balance probe and the fallback candidate rules.
 *
 * Go source: internal/runtime/executor/antigravity_executor_credits.go (`injectEnabledCreditTypes`,
 * `updateAntigravityCreditsBalanceForTask`), sdk/cliproxy/auth/conductor_home.go (`tryAntigravityCreditsExecute`,
 * `shouldAttemptAntigravityCreditsFallback`). The config gate is `quota-exceeded.antigravity-credits`
 * (`oauth.providers.antigravity.antigravity-credits`); only Claude models use credits.
 */
import { Effect } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { Config } from "../../config/schema.ts";
import { asString, get, isJsonArray, type Json, set, tryParseJson } from "@commissary/json";
import { ExecutionError } from "../errors.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { requestBaseUrl } from "./envelope.ts";
import { type AntigravityState, type CreditsRecord } from "./state.ts";

/** `antigravityCreditsRetryEnabled`. */
export const creditsEnabled = (config: Config): boolean =>
  config.oauth.providers.antigravity["antigravity-credits"];

/** Credits only apply to Claude models (`route model contains claude`). */
export const creditsModel = (model: string): boolean => model.toLowerCase().includes("claude");

/** `injectEnabledCreditTypes`: `"enabledCreditTypes":["GOOGLE_ONE_AI"]` on the final body. */
export const injectEnabledCreditTypes = (payload: Json): Json =>
  set(payload, "enabledCreditTypes", ["GOOGLE_ONE_AI"]);

/** `shouldAttemptAntigravityCreditsFallback`: the rotation ended with a capacity-type failure. */
export const shouldAttemptCreditsFallback = (error: ExecutionError): boolean =>
  error.status === 429 ||
  error.status === 503 ||
  error.code === "auth_not_found" ||
  error.code === "auth_unavailable" ||
  error.code === "model_cooldown";

/** Outcome of {@link parseCreditsReply}: `known` is false when the reply carries no GOOGLE_ONE_AI entry. */
export interface CreditsReply {
  readonly record: CreditsRecord | undefined;
  readonly known: boolean;
}

/** Parses a `loadCodeAssist` reply into a credits record (`undefined` = no GOOGLE_ONE_AI entry). */
export const parseCreditsReply = (body: Json | undefined, now: number): CreditsReply => {
  const paidTierId = asString(get(body, "paidTier.id")).trim();
  const credits = get(body, "paidTier.availableCredits");

  // Not an array: the hint is known and unavailable.
  if (!isJsonArray(credits))
    return {
      record: { creditAmount: 0, minCreditAmount: 1, paidTierId, updatedAt: now },
      known: true,
    };

  for (const credit of credits) {
    if (asString(get(credit, "creditType")).toUpperCase() !== "GOOGLE_ONE_AI") continue;
    const creditAmount = Number.parseFloat(asString(get(credit, "creditAmount")).trim());

    const minCreditAmount = Number.parseFloat(
      asString(get(credit, "minimumCreditAmountForUsage")).trim(),
    );

    if (Number.isNaN(creditAmount) || Number.isNaN(minCreditAmount)) continue;

    return { record: { creditAmount, minCreditAmount, paidTierId, updatedAt: now }, known: true };
  }

  return { record: undefined, known: false };
};

/** The credits balance probe (`POST loadCodeAssist`); failures are silent like Go. */
export const probeCredits = (
  credential: CredentialSnapshot,
  accessToken: string,
  userAgent: string,
  state: AntigravityState,
  now: number,
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (accessToken === "") return;
    const client = yield* HttpClient.HttpClient;
    const url = `${requestBaseUrl(credential.attributes, credential.metadata)}/v1internal:loadCodeAssist`;

    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeaders({
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        "user-agent": userAgent,
      }),
      HttpClientRequest.bodyText(
        JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
        "application/json",
      ),
    );

    const response = yield* client.execute(request).pipe(Effect.timeout("5 seconds"));

    if (response.status < 200 || response.status >= 300) return;
    const parsed = parseCreditsReply(tryParseJson(yield* response.text), now);

    const { record } = parsed;

    if (record !== undefined) yield* Effect.promise(() => state.setCredits(credential.id, record));
  }).pipe(Effect.catchCause(() => Effect.void));
