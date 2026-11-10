/**
 * OAuth login orchestration: starting a login, completing it from a pasted/redirected callback or by polling a device
 * code, status reporting and cancellation.
 *
 * Go source: internal/api/handlers/management/{auth_files_provider_oauth,auth_files_devin_oauth,oauth_callback,
 * oauth_sessions}.go (`StartOAuthV8`, `PostOAuthCallback`/`handleOAuthCallback`, `GetAuthStatus`, `CancelAuthSession`).
 * Go runs one goroutine per login that waits for a callback file or polls the device endpoint. On Workers the work is
 * driven by requests instead: the callback request performs the token exchange itself, and every status poll of a
 * device login advances the upstream poll when the provider interval has elapsed (never more often). One poll or
 * exchange runs at a time per session (busy lease), and credentials are only saved while the session is still pending,
 * so a cancel racing with an exchange cannot store a credential.
 * Replies carry statuses/messages only; flow secrets stay in the session row and tokens never reach logs or replies.
 */
import { Clock, Effect, Predicate, Result } from "effect";
import type { HttpClient } from "effect/http";
import { antigravityFlow } from "./flows/antigravity.ts";
import { claudeFlow } from "./flows/claude.ts";
import { codexDeviceFlow, codexFlow } from "./flows/codex.ts";
import { devinFlow } from "./flows/devin.ts";
import { kimiDomain, kimiFlow, kimiStatePrefix } from "./flows/kimi.ts";
import { metaFlow } from "./flows/meta.ts";
import type { CallbackFlow, CredentialRecord, DeviceFlow, Flow } from "./flows/types.ts";
import { xaiFlow } from "./flows/xai.ts";
import { generateState, randomHex } from "./encoding.ts";
import { type OrgId, orgScopedName } from "@commissary/core";
import { isValidOAuthState, normalizeCallbackProvider, type OAuthProvider } from "./names.ts";
import { type CredentialSink, saveCredentialRecord } from "./record.ts";
import type { OAuthSession, OAuthSessions } from "./session-store.ts";

/** How long a callback login waits for the redirect URL (Go: 5 minutes). */
export const CALLBACK_WINDOW_MS = 5 * 60_000;

export interface StartInput {
  /** `?provider=`: `claude`, `codex`, `antigravity`, `kimi`, `kimi-ai`, `xai`, `devin`, `meta`. */
  readonly provider: string;
  /** `?domain=` / `?channel=` of the Kimi login. */
  readonly domain?: string;
  /** `?flow=device` selects the Codex device-code login instead of the pasted redirect URL. */
  readonly flow?: string;
  /** The member the login connects a private credential for; absent: a shared credential (set by the ControlPlane). */
  readonly owner?: string | undefined;
}

export type StartResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly state: string;
      readonly flow?: "device";
      readonly userCode?: string;
      readonly expiresIn?: number;
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

export type StatusResult =
  | { readonly status: "ok" }
  | { readonly status: "wait" }
  | { readonly status: "error"; readonly error: string };

export interface CallbackInput {
  /** Provider named by the caller; defaults to the session's. Public browser routes pin it. */
  readonly provider?: string;
  readonly state: string;
  readonly code: string;
  readonly error: string;
}

export type CallbackResult =
  | { readonly ok: true; readonly outcome: "completed" | "failed" | "cancelled" }
  | { readonly ok: false; readonly status: number; readonly error: string };

export interface OAuthServiceOptions {
  /**
   * The org of the ControlPlane that holds the sessions. Callback states carry it (`orgScopedName`), so the public
   * browser callback, which has no Access identity, can find the org's ControlPlane.
   */
  readonly org: OrgId;
  readonly sessions: OAuthSessions;
  readonly sink: CredentialSink;
  /** `META_MINT_URL` override of the Meta key-mint endpoint. */
  readonly metaMintUrl?: string | undefined;
}

const FINISH_OUTCOMES = { ok: "completed", wait: "cancelled", error: "failed" } as const;

const newDeviceState = (prefix: string, now: number): string => `${prefix}-${now}-${randomHex(4)}`;

const callbackFlows: Readonly<Partial<Record<OAuthProvider, () => CallbackFlow>>> = {
  anthropic: claudeFlow,
  codex: codexFlow,
  antigravity: antigravityFlow,
  devin: devinFlow,
};

const deviceFlows: Readonly<Partial<Record<OAuthProvider, (metaMintUrl?: string) => DeviceFlow>>> =
  {
    codex: codexDeviceFlow,
    xai: xaiFlow,
    meta: metaFlow,
    kimi: () => kimiFlow(kimiDomain("kimi.com")),
    "kimi-ai": () => kimiFlow(kimiDomain("kimi.ai")),
  };

export interface OAuthService {
  /** `StartOAuthV8`: resolves the flow of `provider` and registers a session. */
  readonly start: (input: StartInput) => Effect.Effect<StartResult, never, HttpClient.HttpClient>;
  /** `GetAuthStatus`; for device logins this also advances the upstream poll. */
  readonly status: (state: string) => Effect.Effect<StatusResult, never, HttpClient.HttpClient>;
  /** `PostOAuthCallback` / `GetOAuthCallback` / the public browser callbacks. */
  readonly callback: (
    input: CallbackInput,
  ) => Effect.Effect<CallbackResult, never, HttpClient.HttpClient>;
  /** `CancelAuthSession`. */
  readonly cancel: (state: string) => Effect.Effect<{ readonly cancelled: boolean }>;
}

export const makeOAuthService = ({
  org,
  sessions,
  sink,
  metaMintUrl,
}: OAuthServiceOptions): OAuthService => {
  const startCallback = (
    flow: CallbackFlow,
    now: number,
    owner: string | undefined,
  ): Effect.Effect<StartResult> =>
    Effect.gen(function* () {
      const state = orgScopedName(org, (flow.generateState ?? generateState)());
      const started = yield* flow.start({ state }).pipe(Effect.result);

      if (Result.isFailure(started)) {
        yield* Effect.logError(`oauth ${flow.provider}: failed to build the authorization URL`);

        return { ok: false, status: 500, error: "failed to generate authorization url" } as const;
      }

      sessions.register(
        {
          state,
          provider: flow.provider,
          flow: "callback",
          deadlineAt: now + CALLBACK_WINDOW_MS,
          owner,
          data: started.success.data,
        },
        now,
      );

      return { ok: true, url: started.success.url, state } as const;
    });

  const startDevice = (
    flow: DeviceFlow,
    state: string,
    now: number,
    owner: string | undefined,
  ): Effect.Effect<StartResult, never, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const started = yield* flow.start().pipe(Effect.result);

      if (Result.isFailure(started)) {
        yield* Effect.logError(
          `oauth ${flow.provider}: failed to start the device flow: ${started.failure.message}`,
        );

        return { ok: false, status: 500, error: flow.startFailureMessage } as const;
      }

      const device = started.success;
      sessions.register(
        {
          state,
          provider: flow.provider,
          flow: "device",
          deadlineAt: now + device.windowMs,
          nextPollAt: now + device.firstPollDelayMs,
          intervalMs: device.intervalMs,
          owner,
          data: device.data,
        },
        now,
      );

      return {
        ok: true,
        url: device.url,
        state,
        flow: "device",
        ...(device.userCode === undefined ? {} : { userCode: device.userCode }),
        ...(device.expiresIn === undefined ? {} : { expiresIn: device.expiresIn }),
      } as const;
    });

  /** `guardOAuthSessionPendingForSave` + `saveTokenRecord` + `Complete`. */
  const finish = (
    state: string,
    flow: Flow,
    record: CredentialRecord,
  ): Effect.Effect<StatusResult> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;

      // A cancel (or timeout) that raced with the exchange wins: nothing is saved for a dead session.
      if (!sessions.isPending(state, now, flow.provider)) return { status: "wait" } as const;
      // The login saves for whoever started it: a private credential stays its member's.
      const owner = sessions.get(state, now)?.owner;
      const saved = yield* Effect.promise(() => saveCredentialRecord(record, sink, owner));
      const done = yield* Clock.currentTimeMillis;

      if (!saved.ok) {
        yield* Effect.logError(`oauth ${flow.provider}: failed to store the credential`);
        sessions.setError(state, flow.saveMessage, done);

        return { status: "error", error: flow.saveMessage } as const;
      }

      sessions.complete(state, done);

      return { status: "ok" } as const;
    });

  const pollDevice = (
    session: OAuthSession,
    now: number,
  ): Effect.Effect<StatusResult, never, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const flow = deviceFlows[session.provider]?.(metaMintUrl);

      if (flow === undefined) return { status: "error", error: "unsupported provider" } as const;

      if (now > session.deadlineAt) {
        sessions.setError(session.state, flow.expiredMessage, now);

        return { status: "error", error: flow.expiredMessage } as const;
      }

      if (now < session.nextPollAt) return { status: "wait" } as const;

      if (!sessions.acquire(session.state, now)) return { status: "wait" } as const;

      // The lease covers the poll and the save: a second poll must not replay a consumed device code.
      return yield* Effect.gen(function* () {
        const outcome = yield* flow
          .poll({ data: session.data, now, intervalMs: session.intervalMs })
          .pipe(Effect.result);

        const after = yield* Clock.currentTimeMillis;

        if (Result.isFailure(outcome)) {
          sessions.setError(session.state, outcome.failure.message, after);
          yield* Effect.logWarning(`oauth ${session.provider}: device login failed`);

          return { status: "error", error: outcome.failure.message } as const;
        }

        if (Predicate.isTagged(outcome.success, "pending")) {
          const intervalMs = outcome.success.intervalMs ?? session.intervalMs;
          sessions.release(session.state, after, { nextPollAt: now + intervalMs, intervalMs });

          return { status: "wait" } as const;
        }

        return yield* finish(session.state, flow, outcome.success.record);
      }).pipe(Effect.ensuring(Effect.sync(() => sessions.release(session.state, now))));
    });

  return {
    start: (input) =>
      Effect.gen(function* () {
        const provider = input.provider.trim().toLowerCase();

        if (provider === "")
          return { ok: false, status: 400, error: "provider is required" } as const;
        const now = yield* Clock.currentTimeMillis;
        const { owner } = input;

        switch (provider) {
          case "claude":
            return yield* startCallback(claudeFlow(), now, owner);
          case "antigravity":
            return yield* startCallback(antigravityFlow(), now, owner);
          case "devin":
            return yield* startCallback(devinFlow(), now, owner);
          case "codex":
            return input.flow?.trim().toLowerCase() === "device"
              ? yield* startDevice(codexDeviceFlow(), newDeviceState("codex", now), now, owner)
              : yield* startCallback(codexFlow(), now, owner);
          case "xai":
            return yield* startDevice(xaiFlow(), newDeviceState("xai", now), now, owner);
          case "meta":
            return yield* startDevice(
              metaFlow(metaMintUrl),
              newDeviceState("meta", now),
              now,
              owner,
            );
          case "kimi":
          case "kimi-ai": {
            const target = kimiDomain(
              provider === "kimi-ai" ? "kimi.ai" : (input.domain ?? "kimi.com"),
            );

            return yield* startDevice(
              kimiFlow(target),
              newDeviceState(kimiStatePrefix(target), now),
              now,
              owner,
            );
          }

          default:
            return { ok: false, status: 404, error: "provider_not_found" } as const;
        }
      }),

    status: (state) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const session = sessions.get(state, now);

        if (session === undefined)
          return { status: "error", error: "unknown or expired state" } as const;

        if (session.completed) return { status: "ok" } as const;

        if (session.status !== "") return { status: "error", error: session.status } as const;

        if (session.flow === "callback") {
          const flow = callbackFlows[session.provider]?.();

          if (flow !== undefined && now > session.deadlineAt) {
            sessions.setError(state, flow.timeoutMessage, now);

            return { status: "error", error: flow.timeoutMessage } as const;
          }

          return { status: "wait" } as const;
        }

        return yield* pollDevice(session, now);
      }),

    callback: (input) =>
      Effect.gen(function* () {
        const state = input.state.trim();
        const code = input.code.trim();
        const error = input.error.trim();

        if (state === "") return { ok: false, status: 400, error: "state is required" } as const;

        if (!isValidOAuthState(state))
          return { ok: false, status: 400, error: "invalid state" } as const;

        if (code === "" && error === "")
          return { ok: false, status: 400, error: "code or error is required" } as const;

        const now = yield* Clock.currentTimeMillis;
        const found = sessions.get(state, now);

        if (found === undefined)
          return { ok: false, status: 404, error: "unknown or expired state" } as const;

        if (found.completed)
          return { ok: false, status: 409, error: "oauth flow is already completed" } as const;
        const requested = input.provider?.trim() ?? "";
        const provider = normalizeCallbackProvider(requested === "" ? found.provider : requested);

        if (provider === undefined)
          return { ok: false, status: 400, error: "unsupported provider" } as const;

        const flow = found.flow === "callback" ? callbackFlows[found.provider]?.() : undefined;

        // The callback window closed before this request: Go's waiter would have recorded the timeout already.
        if (flow !== undefined && found.status === "" && now > found.deadlineAt) {
          sessions.setError(state, flow.timeoutMessage, now);

          return { ok: false, status: 409, error: flow.timeoutMessage } as const;
        }

        if (found.status !== "") return { ok: false, status: 409, error: found.status } as const;

        if (found.provider !== provider) {
          return { ok: false, status: 400, error: "provider does not match state" } as const;
        }

        // Device logins finish by polling, never through a redirect.
        if (flow === undefined)
          return {
            ok: false,
            status: 409,
            error: "oauth flow does not accept a callback",
          } as const;

        if (!sessions.acquire(state, now))
          return { ok: false, status: 409, error: "oauth flow is not pending" } as const;

        if (error !== "") {
          sessions.setError(state, flow.deniedMessage, now);

          return { ok: true, outcome: "failed" } as const;
        }

        // The lease covers exchange and save, so a duplicate callback cannot exchange the code twice.
        return yield* Effect.gen(function* () {
          const exchanged = yield* flow
            .complete({ state, code, data: found.data, now })
            .pipe(Effect.result);

          const after = yield* Clock.currentTimeMillis;

          if (Result.isFailure(exchanged)) {
            sessions.setError(state, exchanged.failure.message, after);
            yield* Effect.logWarning(`oauth ${flow.provider}: authorization code exchange failed`);

            return { ok: true, outcome: "failed" } as const;
          }

          const finished = yield* finish(state, flow, exchanged.success);

          return {
            ok: true,
            outcome: FINISH_OUTCOMES[finished.status],
          } as const;
        }).pipe(Effect.ensuring(Effect.sync(() => sessions.release(state, now))));
      }),

    cancel: (state) =>
      Clock.currentTimeMillis.pipe(
        Effect.map((now) => ({ cancelled: sessions.cancel(state, now) })),
      ),
  };
};
