// The browser toolkit's Browser sessions pages (#216, ADR 0039): the list (/tools/sessions) and each session's page
// (/tools/sessions/$sessionId), the link a handoff answers. A member sees the open sessions they may watch (their own),
// watches each in its Live View (minted when the page opens, for them only, connecting within 60 seconds) and answers a
// handoff there; an org admin also sees the org's other sessions (whose, when, which profile) and may end any, but never
// watches one. The server decides all of it (`own`, `watchable`); where the deployment has no browser toolkit (ADR 0043)
// the pages are not found and nothing links to them. A session a hosted agent run opened links its run's page (`run`,
// #234).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Power, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { BrowserLiveView, BrowserSessionView } from "@commissary/contract/browser-sessions";
import {
  BROWSER_SESSIONS,
  browserLiveViewAtom,
  browserSessionAtom,
  browserSessionsAtom,
  endBrowserSessionAtom,
  meAtom,
  nowAtom,
} from "../api/client.ts";
import { ConfirmDialog, type ConfirmRequest } from "../components/Confirm.tsx";
import { FromRun } from "../components/FromRun.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import {
  BROWSER_SESSIONS_PAGE,
  emptySessionsText,
  endConfirmText,
  endProblem,
  handoffWaitsText,
  liveViewProblem,
  notWatchableText,
  openedHowText,
  profileText,
  ownerText,
  sessionRow,
  sessionTitle,
  sortSessions,
} from "../lib/browser-sessions.ts";
import { failureMessage } from "../lib/failure.ts";
import { hasBrowser } from "../lib/hosted.ts";
import { atLeast } from "../lib/role.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import { NotFound } from "./NotFound.tsx";
import styles from "./Tools.module.css";
import own from "./BrowserSessions.module.css";

const route = getRouteApi("/tools/sessions/$sessionId");

/** The page, where the deployment has the browser toolkit; elsewhere Not found, as if it did not exist. */
const WithBrowser = ({ children }: { readonly children: ReactNode }) => {
  const me = useAtomValue(meAtom);

  if (!AsyncResult.isSuccess(me)) return null;

  return hasBrowser(me.value) ? children : <NotFound />;
};

/** Ending a session: the confirmation, the call, and what came of it. */
const useEnd = (onEnded: () => void) => {
  const end = useAction(endBrowserSessionAtom);
  const [confirm, setConfirm] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const ask = (session: BrowserSessionView) => {
    setProblem(undefined);

    setConfirm({
      title: "End this browser session?",
      body: <p>{endConfirmText(session)}</p>,
      action: "End session",
      busyAction: "Ending…",
      tone: "primary",
      keep: "Keep it open",
      run: async () => {
        const outcome = await end.run({
          params: { id: session.id },
          reactivityKeys: BROWSER_SESSIONS,
        });

        if (outcome.ok) onEnded();
        else setProblem(endProblem(outcome.error, outcome.message));
      },
    });
  };

  const dialog = (
    <>
      {problem === undefined ? null : <Problem>Could not end the session. {problem}</Problem>}
      <ConfirmDialog request={confirm} busy={end.busy} onClose={() => setConfirm(undefined)} />
    </>
  );

  return { ask, busy: end.busy, dialog } as const;
};

// ---------------------------------------------------------------------------------------------------------------
// The list

const Sessions = ({ admin }: { readonly admin: boolean }) => {
  const result = useAtomValue(browserSessionsAtom);
  const retry = useAtomRefresh(browserSessionsAtom);
  const now = useAtomValue(nowAtom);
  const end = useEnd(() => undefined);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the sessions…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the sessions. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const rows = sortSessions(value.sessions).map((session) => sessionRow(session, now));

      return rows.length === 0 ? (
        <p className={styles["empty"]}>{emptySessionsText(admin)}</p>
      ) : (
        <div className={`${styles["section"]} ${styles["scroll"]}`}>
          <table className={styles["table"]}>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col" className={styles["wide"]}>
                  Handoff
                </th>
                <th scope="col">Opened</th>
                <th scope="col">
                  <span className={kit["visuallyHidden"]}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.session.id}>
                  <td>
                    <div className={styles["name"]}>
                      <Link to="/tools/sessions/$sessionId" params={{ sessionId: row.session.id }}>
                        {row.owner}
                      </Link>
                      <span className={styles["secondary"]}>{row.about}</span>
                    </div>
                    {/* On a narrow screen the handoff column folds in here. */}
                    {row.handoff === undefined ? null : (
                      <div className={styles["narrowOnly"]}>
                        <span className={own["waits"]}>{row.handoff}</span>
                      </div>
                    )}
                  </td>
                  <td className={styles["wide"]}>
                    {row.handoff === undefined ? (
                      <span className={styles["secondary"]}>None waiting</span>
                    ) : (
                      <span className={own["waits"]}>{row.handoff}</span>
                    )}
                  </td>
                  <td className={own["nowrap"]}>{row.opened}</td>
                  <td className={styles["number"]}>
                    <button
                      type="button"
                      className={styles["linkButton"]}
                      aria-label={`End ${row.session.own ? "your" : `${row.owner}'s`} session opened ${row.opened}`}
                      disabled={end.busy}
                      onClick={() => end.ask(row.session)}
                    >
                      End
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {end.dialog}
        </div>
      );
    },
  });
};

export const BrowserSessionsPage = () => {
  const role = useRole();
  const admin = role.kind === "ready" && atLeast(role.caller.role, "admin");

  usePageTitle("Browser sessions");

  return (
    <WithBrowser>
      <div className={kit["page"]}>
        <header className={styles["head"]}>
          <Link to="/tools" className={styles["back"]}>
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
            Tools
          </Link>
          <h1 className={styles["title"]}>Browser sessions</h1>
          <p className={styles["intro"]}>
            {admin
              ? "The browser toolkit's open sessions in the org. You watch your own and act in them when a client asks; you may end anyone's, but only its member watches it."
              : "Your open sessions of the browser toolkit. Watch one to see what its client does, and act in it when the client asks you to sign in or solve a check."}
          </p>
        </header>
        {role.kind === "ready" ? <Sessions admin={admin} /> : null}
      </div>
    </WithBrowser>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// One session

/**
 * The session's Live View, minted when the page opens and again on Reconnect; the link lives in this state only. The
 * run page (#234) shows it under a handoff its run waits on.
 */
export const LiveView = ({ session }: { readonly session: BrowserSessionView }) => {
  const mint = useAction(browserLiveViewAtom);
  const { run } = mint;
  const [view, setView] = useState<BrowserLiveView | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const connect = useCallback(async () => {
    setProblem(undefined);

    const outcome = await run({ params: { id: session.id } });

    if (outcome.ok) {
      setView(outcome.value);

      return;
    }

    setView(undefined);
    setProblem(liveViewProblem(outcome.error, outcome.message));
  }, [run, session.id]);

  useEffect(() => {
    void connect();
  }, [connect]);

  return (
    <Section
      title="Live View"
      className={own["live"]}
      aside={
        <button
          type="button"
          className={kit["secondary"]}
          disabled={mint.busy}
          aria-busy={mint.busy}
          onClick={() => void connect()}
        >
          <RefreshCw
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={mint.busy ? kit["spinning"] : undefined}
          />
          {mint.busy ? "Connecting…" : "Reconnect"}
        </button>
      }
    >
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {view === undefined ? (
        problem === undefined ? (
          <p className={kit["muted"]} aria-busy="true">
            Connecting to the browser…
          </p>
        ) : null
      ) : (
        <iframe
          // A new link is a new frame.
          key={view.url}
          className={own["frame"]}
          src={view.url}
          title="Live View of the browser session"
          referrerPolicy="no-referrer"
          allow="clipboard-read; clipboard-write"
        />
      )}
      <p className={styles["hint"]}>
        What you do here happens in the session&rsquo;s browser. The view is yours only; if it stops
        updating, Reconnect.
      </p>
    </Section>
  );
};

/** The handoff that waits for the caller: what the client asks, how to answer, until when. */
export const Handoff = ({ session }: { readonly session: BrowserSessionView }) => {
  const now = useAtomValue(nowAtom);

  if (session.handoff === null || !session.watchable) return null;

  return (
    <section className={own["handoff"]} aria-label="Handoff">
      <h2 className={own["handoffTitle"]}>The client asks you to act in this browser</h2>
      {session.handoff.reason === undefined ? null : (
        <blockquote className={own["reason"]}>&ldquo;{session.handoff.reason}&rdquo;</blockquote>
      )}
      <p>
        Do it in the Live View below, then press Done there, or Failed if you cannot. The client
        never sees what you type. {handoffWaitsText(session.handoff, now)}
      </p>
    </section>
  );
};

const Details = ({ session }: { readonly session: BrowserSessionView }) => {
  const now = useAtomValue(nowAtom);
  const navigate = useNavigate();
  const end = useEnd(() => void navigate({ to: BROWSER_SESSIONS_PAGE }));
  const why = notWatchableText(session);

  return (
    <>
      <FromRun view={session} />
      <dl className={styles["facts"]}>
        <dt>Member</dt>
        <dd>{ownerText(session)}</dd>
        <dt>Opened</dt>
        <dd>{openedHowText(session, now)}</dd>
        <dt>Profile</dt>
        <dd>{profileText(session.profile)}</dd>
      </dl>
      <Handoff session={session} />
      {why === undefined ? <LiveView session={session} /> : <p className={kit["muted"]}>{why}</p>}
      <div className={styles["actions"]}>
        <button
          type="button"
          className={kit["secondary"]}
          disabled={end.busy}
          onClick={() => end.ask(session)}
        >
          <Power aria-hidden="true" size={16} strokeWidth={2.25} />
          End session
        </button>
      </div>
      {end.dialog}
    </>
  );
};

export const BrowserSessionPage = () => {
  const { sessionId } = route.useParams();
  const result = useAtomValue(browserSessionAtom(sessionId));
  const retry = useAtomRefresh(browserSessionAtom(sessionId));
  const title = AsyncResult.isSuccess(result) ? sessionTitle(result.value) : "Browser session";

  usePageTitle(title);

  return (
    <WithBrowser>
      <div className={kit["page"]}>
        <header className={styles["head"]}>
          <Link to={BROWSER_SESSIONS_PAGE} className={styles["back"]}>
            <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
            Browser sessions
          </Link>
          <h1 className={styles["title"]}>{title}</h1>
        </header>
        {AsyncResult.match(result, {
          onInitial: () => (
            <p className={kit["muted"]} aria-busy="true">
              Loading the session…
            </p>
          ),
          onFailure: (failure) => (
            <Problem onRetry={retry}>
              Could not load the session. It may have closed, or it is not yours to see.{" "}
              {failureMessage(failure)}
            </Problem>
          ),
          onSuccess: ({ value }) => <Details session={value} />,
        })}
      </div>
    </WithBrowser>
  );
};
