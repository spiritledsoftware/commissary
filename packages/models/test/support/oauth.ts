// Test helpers for the OAuth login flows: the real service over an in-memory session table and credential sink, a
// recording HttpClient and the virtual clock.
import { Effect } from "effect";
import type { HttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import type { JsonObject } from "@commissary/json";
import { sha256 } from "../../src/oauth/encoding.ts";
import { base64Url } from "../../src/oauth/encoding.ts";
import { type CredentialSink } from "../../src/oauth/record.ts";
import { makeOAuthService, type OAuthService, type StatusResult } from "../../src/oauth/service.ts";
import { MemorySessionTable, OAuthSessions } from "../../src/oauth/session-store.ts";
import { type MockHandler, mockHttp, T0 } from "./refresh.ts";
import { GLOBAL_ORG } from "@commissary/core";

export { jwt, routes, T0 } from "./refresh.ts";

export const makeOAuth = (
  handler: MockHandler,
  seed: Record<string, JsonObject> = {},
  options: { readonly metaMintUrl?: string; readonly claudeIncludeCreateApiKey?: boolean } = {},
) => {
  const table = new MemorySessionTable();
  const files = new Map<string, JsonObject>(Object.entries(seed));
  const removed: string[] = [];

  const sink: CredentialSink = {
    get: (name) => files.get(name),
    list: () =>
      [...files].map(([id, metadata]) => ({
        id,
        type: typeof metadata.type === "string" ? metadata.type : "",
        metadata,
      })),
    save: async (name, metadata) => {
      files.set(name, structuredClone(metadata));

      return await Promise.resolve({ ok: true } as const);
    },
    remove: async (id) => {
      files.delete(id);
      removed.push(id);
      await Promise.resolve();
    },
  };

  const service: OAuthService = makeOAuthService({
    org: GLOBAL_ORG,
    sessions: new OAuthSessions(table),
    sink,
    metaMintUrl: options.metaMintUrl,
    claudeIncludeCreateApiKey: () => options.claudeIncludeCreateApiKey ?? true,
  });

  const http = mockHttp(handler);

  return {
    service,
    table,
    files,
    removed,
    requests: http.requests,
    /** Provides the recording HttpClient. */
    run: <A>(effect: Effect.Effect<A, never, HttpClient.HttpClient>): Effect.Effect<A> =>
      effect.pipe(Effect.provide(http.layer)),
  };
};

export type OAuthHarness = ReturnType<typeof makeOAuth>;

/** Virtual time starts at `T0` (2027-01-15T08:00:00Z). */
export const startClock = TestClock.setTime(T0);

export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** S256 challenge of a verifier, independently of the implementation under test. */
export const s256 = async (verifier: string): Promise<string> => base64Url(await sha256(verifier));

/** The only file a login produced. */
export const onlyFile = (harness: OAuthHarness) => {
  const entries = [...harness.files];

  const [entry] = entries;

  if (entries.length !== 1 || entry === undefined) {
    throw new Error(`expected one credential, got ${entries.length}`);
  }

  const [name, file] = entry;

  return { name, file };
};

export const statusOf = (harness: OAuthHarness, state: string): Effect.Effect<StatusResult> =>
  harness.run(harness.service.status(state));

/** Starts a login and returns its `state`; fails the test when it did not start. */
export const begin = (
  harness: OAuthHarness,
  provider: string,
  extra: { domain?: string; flow?: string } = {},
) =>
  Effect.gen(function* () {
    const started = yield* harness.run(harness.service.start({ provider, ...extra }));

    if (!started.ok) throw new Error(`start failed: ${started.error}`);

    return started;
  });

/** Simple decoded query of an authorization URL. */
export const query = (url: string): Record<string, string> =>
  Object.fromEntries(new URL(url).searchParams);
