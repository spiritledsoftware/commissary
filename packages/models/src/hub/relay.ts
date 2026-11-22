/**
 * A relayed call of the hub API (ADR 0052), from the Worker: the matched entry (`calls.ts`) sent with the token target
 * the ControlPlane resolved (`hubCallTarget`), with the quota check's headers (`probeHeaders`) and a body Commissary
 * built, never followed to another host, within the quota check's 15 s bound and a 1 MiB answer. The answer is the
 * provider's status and body text, with every copy of the token replaced; headers are dropped.
 */
import { Effect } from "effect";
import { FetchHttpClient, type HttpClient, HttpClientRequest } from "effect/http";
import { type ProbeFailure, probeHeaders, type RawAnswer, sendRaw } from "../quota/probe.ts";
import type { QuotaProbeTarget } from "../quota/target.ts";
import type { MatchedCall } from "./calls.ts";

/** The longest provider answer relayed. */
export const MAX_RELAYED_BYTES = 1024 * 1024;

export const REDACTED = "[redacted]";

const withBody = (
  request: HttpClientRequest.HttpClientRequest,
  call: MatchedCall,
  target: QuotaProbeTarget,
): HttpClientRequest.HttpClientRequest => {
  switch (call.body.kind) {
    case "none":
      return request;
    case "json":
      return HttpClientRequest.bodyText(
        request,
        JSON.stringify(call.body.value),
        "application/json",
      );
    case "project":
      return HttpClientRequest.bodyText(
        request,
        JSON.stringify({ project: target.projectId ?? "" }),
        "application/json",
      );
  }
};

/**
 * `text` with every copy of `token` replaced by {@link REDACTED}: as it is, as a JSON string would escape it and as a
 * URL component would encode it (a provider may echo it in a JSON body or a link).
 */
export const redactToken = (text: string, token: string): string => {
  if (token === "") return text;
  const spellings = new Set([token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token)]);

  return [...spellings].reduce(
    (redacted, spelling) => redacted.replaceAll(spelling, REDACTED),
    text,
  );
};

/** Sends `call` for `target`; fails (a 502) when the provider cannot be reached in time or answers too much. */
export const relayHubCall = (
  call: MatchedCall,
  target: QuotaProbeTarget,
): Effect.Effect<RawAnswer, ProbeFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const headers = yield* probeHeaders(target);

    const request = withBody(
      HttpClientRequest.make(call.entry.method)(call.entry.url).pipe(
        HttpClientRequest.setHeaders(headers),
      ),
      call,
      target,
    );

    const answer = yield* sendRaw(request, { maxBytes: MAX_RELAYED_BYTES });

    return { status: answer.status, text: redactToken(answer.text, target.token) };
  }).pipe(
    // A provider's redirect is relayed as its status: the token is never sent to another host.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  );
