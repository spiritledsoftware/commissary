// Settings (/settings): the config settings that apply on Workers, one form per section (research
// .scratch/p5-settings-research.md (c)). A status line says the config version and when it was saved; a jump list
// leads to each section (a sticky rail beside the column on wide screens) and counts each one's unsaved changes. Each
// section saves on its own (`SettingsForm.tsx`); leaving the page with unsaved changes asks first. Payload and account
// error rules are read-only here, set by importing a Go config document. The view carries no secret, and nothing here
// shows one.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useBlocker } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { SettingsView } from "@commissary/contract/settings";
import { settingsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatAgo, formatCount } from "../lib/format.ts";
import type { SectionId } from "../lib/settings.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { CATALOG_OPTIONS, CLAUDE_CLOAKING_NOTE } from "./SettingsCopy.ts";
import { SettingsSection } from "./SettingsForm.tsx";
import { DangerBody } from "./SettingsDanger.tsx";
import { ErrorRules, PayloadRules, PlainSection } from "./SettingsFacts.tsx";
import { RetentionBody } from "./SettingsRetention.tsx";
import styles from "./Settings.module.css";

/** Sections without a form: nothing to leave unsaved. */
type PlainId = "payload" | "retention" | "danger";

type JumpId = SectionId | PlainId;

const isPlain = (id: JumpId): id is PlainId =>
  id === "payload" || id === "retention" || id === "danger";

const JUMPS: ReadonlyArray<readonly [JumpId, string]> = [
  ["routing", "Routing"],
  ["retries", "Retries & cooldowns"],
  ["requests", "Requests & streaming"],
  ["payload", "Payload rules"],
  ["images", "Images & video"],
  ["providers", "Providers"],
  ["catalogs", "Model catalog"],
  ["refresh", "Account refresh"],
  ["retention", "Usage records"],
  ["danger", "Danger zone"],
];

/** Unsaved changes by section. */
type Dirty = Readonly<Partial<Record<SectionId, number>>>;

const totalOf = (dirty: Dirty): number =>
  Object.values(dirty).reduce((sum, count) => sum + (count ?? 0), 0);

/** The page title, and once the view is in: the version and when it was saved. */
const Head = ({ view }: { readonly view: SettingsView | undefined }) => (
  <header className={styles["head"]}>
    <div className={styles["titleRow"]}>
      <h1 className={styles["title"]}>Settings</h1>
    </div>
    {view === undefined ? null : <Status view={view} />}
  </header>
);

/** The sections, each marked with its unsaved changes ("Routing · 2"). */
const Jumps = ({ dirty }: { readonly dirty: Dirty }) => (
  <nav className={styles["jumps"]} aria-label="Sections">
    {JUMPS.map(([id, title]) => {
      const count = isPlain(id) ? 0 : (dirty[id] ?? 0);

      return (
        <a key={id} href={`#${id}`}>
          {title}
          {count === 0 ? null : (
            <span className={styles["jumpCount"]}>
              {" · "}
              {formatCount(count)}
              <span className={kit["visuallyHidden"]}> unsaved</span>
            </span>
          )}
        </a>
      );
    })}
  </nav>
);

/** Asks before leaving the page (in the panel or the browser) while a section has unsaved changes. */
const LeaveGuard = ({ dirty }: { readonly dirty: Dirty }) => {
  const total = totalOf(dirty);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const blocker = useBlocker({
    // A jump within the page is not leaving it.
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    enableBeforeUnload: total > 0,
    disabled: total === 0,
    withResolver: true,
  });

  useEffect(() => {
    if (blocker.status === "blocked") dialog.current?.showModal();
    else dialog.current?.close();
  }, [blocker.status]);

  const sections = JUMPS.flatMap(([id, title]) =>
    !isPlain(id) && (dirty[id] ?? 0) > 0 ? [title] : [],
  );

  return (
    <dialog
      ref={dialog}
      className={kit["dialog"]}
      aria-labelledby={titleId}
      onCancel={() => blocker.reset?.()}
    >
      <div className={kit["dialogBody"]}>
        <h2 id={titleId} className={kit["dialogTitle"]}>
          Leave without saving?
        </h2>
        <p>
          {total === 1 ? "A change" : `${formatCount(total)} changes`} in {sections.join(", ")}{" "}
          {total === 1 ? "is" : "are"} not saved and will be lost.
        </p>
        <div className={kit["dialogActions"]}>
          <button type="button" className={kit["primary"]} onClick={() => blocker.reset?.()}>
            Stay
          </button>
          <button type="button" className={kit["secondary"]} onClick={() => blocker.proceed?.()}>
            Leave
          </button>
        </div>
      </div>
    </dialog>
  );
};

const Status = ({ view }: { readonly view: SettingsView }) => {
  const saved = view.updated_at === undefined ? Number.NaN : Date.parse(view.updated_at);

  return (
    <p className={styles["facts"]}>
      <span>Configuration version {formatCount(view.version)}</span>
      {Number.isNaN(saved) ? null : <span>Saved {formatAgo(Math.max(0, Date.now() - saved))}</span>}
    </p>
  );
};

const KEPT = "Only while sessions are kept.";

const prefixedLine = (count: number) =>
  count === 0 ? (
    "No account or key has a prefix yet."
  ) : (
    <>
      <Link to="/models">
        {formatCount(count)} {count === 1 ? "account or key has" : "accounts and keys have"} a
        prefix
      </Link>
      .
    </>
  );

const Body = ({
  view,
  onReload,
  onChanges,
}: {
  readonly view: SettingsView;
  readonly onReload: () => void;
  readonly onChanges: (id: SectionId, count: number) => void;
}) => {
  const common = { view, onReload, onChanges } as const;

  return (
    <>
      <SettingsSection id="routing" title="Routing" {...common}>
        {({ field, input }) => {
          const affinity = input("routing.session-affinity") === true;

          return (
            <>
              {field("routing.strategy")}
              {field("routing.session-affinity")}
              {field("routing.session-affinity-ttl", { disabled: !affinity, requires: KEPT })}
              {field("routing.session-affinity-subagents", {
                disabled: !affinity,
                requires: KEPT,
              })}
              {field("routing.force-model-prefix", {
                extra: prefixedLine(view.prefixed_credentials),
              })}
            </>
          );
        }}
      </SettingsSection>

      <SettingsSection id="retries" title="Retries & cooldowns" {...common}>
        {({ field }) => (
          <>
            {field("routing.retry.request-retry")}
            {field("routing.retry.max-retry-credentials")}
            {field("routing.retry.max-retry-interval")}
            {field("routing.cooldown.disable-cooling")}
            {field("routing.cooldown.transient-error-cooldown-seconds")}
            {field("upstream.claude.model-level-cooling")}
            {field("upstream.codex.model-level-cooling")}
            <ErrorRules rules={view.request_scoped_errors} />
          </>
        )}
      </SettingsSection>

      <SettingsSection id="requests" title="Requests & streaming" {...common}>
        {({ field }) => (
          <>
            {field("requests.passthrough-headers")}
            {field("requests.nonstream-keepalive-interval")}
            {field("requests.streaming.keepalive-seconds")}
            {field("requests.streaming.bootstrap-retries")}
          </>
        )}
      </SettingsSection>

      <PayloadRules payload={view.payload} />

      <SettingsSection id="images" title="Images & video" {...common}>
        {({ field }) => (
          <>
            {field("multimedia.disable-image-generation")}
            {field("multimedia.gpt-image-2-base-model")}
            {field("multimedia.video-result-auth-cache-ttl")}
          </>
        )}
      </SettingsSection>

      <SettingsSection id="providers" title="Providers" {...common}>
        {({ field, input }) => (
          <>
            <div className={styles["sub"]}>
              <h3 className={styles["subTitle"]}>Claude</h3>
              <p className={styles["hint"]}>{CLAUDE_CLOAKING_NOTE}</p>
              {field("upstream.claude.disable-claude-cloak-mode")}
              {field("upstream.claude.cloak-level")}
              {field("upstream.claude.disable-cloaking-model-list")}
              {field("upstream.claude.header-defaults.stabilize-device-profile")}
              <p className={styles["hint"]}>Headers sent when the client sends none of its own:</p>
              <div className={styles["pair"]}>
                {field("upstream.claude.header-defaults.user-agent")}
                {field("upstream.claude.header-defaults.package-version")}
                {field("upstream.claude.header-defaults.runtime-version")}
                {field("upstream.claude.header-defaults.os")}
                {field("upstream.claude.header-defaults.arch")}
                {field("upstream.claude.header-defaults.timeout")}
                {field("upstream.claude.header-defaults.timezone")}
              </div>
            </div>
            <div className={styles["sub"]}>
              <h3 className={styles["subTitle"]}>Codex</h3>
              {field("upstream.codex.disable-codex-cloaking")}
              {field("upstream.codex.stream-bootstrap-buffering")}
              {field("upstream.codex.stream-bootstrap-timeout", {
                disabled: input("upstream.codex.stream-bootstrap-buffering") !== true,
                requires: "Only while the start is held.",
              })}
              {field("upstream.codex.orphan-delegation-compatibility")}
              {field("upstream.codex.response-steering")}
              {field("client.codex.enable-apply-patch")}
              {field("client.codex.optimize-multi-agent-v2")}
              <div className={styles["pair"]}>
                {field("oauth.providers.codex.header-defaults.user-agent")}
                {field("oauth.providers.codex.header-defaults.beta-features")}
              </div>
            </div>
            <div className={styles["sub"]}>
              <h3 className={styles["subTitle"]}>xAI</h3>
              {field("upstream.xai.inject-x-search")}
            </div>
            <div className={styles["sub"]}>
              <h3 className={styles["subTitle"]}>Antigravity</h3>
              {field("oauth.providers.antigravity.antigravity-credits")}
              {field("oauth.providers.antigravity.signature-cache-enabled")}
              {field("oauth.providers.antigravity.signature-bypass-strict", {
                disabled: input("oauth.providers.antigravity.signature-cache-enabled") !== false,
                requires: "Only while the signature cache is off.",
              })}
              {field("oauth.providers.antigravity.sensitive-words")}
            </div>
            <div className={styles["sub"]}>
              <h3 className={styles["subTitle"]}>Devin</h3>
              {field("oauth.providers.devin.sensitive-words")}
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="catalogs"
        title="Model catalog"
        {...common}
        lead={
          <>
            <p className={styles["lead"]}>
              Where the model list comes from: models.dev, which the models of Claude, Gemini,
              Vertex, Codex, Kimi, xAI, Meta and OpenCode are read from (Antigravity and Devin
              models are built in). A fetched list refreshes every 3 hours; a change applies at the
              next refresh.
            </p>
            <ul className={styles["legend"]}>
              {CATALOG_OPTIONS.map((option) => (
                <li key={option.value}>
                  <b>{option.name}</b>
                  {option.hint}
                </li>
              ))}
            </ul>
          </>
        }
      >
        {({ field }) => <>{field("models.catalog")}</>}
      </SettingsSection>

      <SettingsSection id="refresh" title="Account refresh" {...common}>
        {({ field }) => field("oauth.auth-auto-refresh-workers")}
      </SettingsSection>

      <PlainSection id="retention" title="Usage records">
        <RetentionBody />
      </PlainSection>

      <PlainSection id="danger" title="Danger zone">
        <DangerBody />
      </PlainSection>
    </>
  );
};

/** Scroll to the section the address names once it has rendered (it loads after navigation). */
const useHashOnLoad = (loaded: boolean) => {
  const done = useRef(false);

  useEffect(() => {
    if (!loaded || done.current) return;
    done.current = true;
    const id = window.location.hash.slice(1);

    if (id !== "") document.getElementById(id)?.scrollIntoView();
  }, [loaded]);
};

export const SettingsPage = () => {
  usePageTitle("Settings");
  const result = useAtomValue(settingsAtom);
  const reload = useAtomRefresh(settingsAtom);
  const [dirty, setDirty] = useState<Dirty>({});
  const view = AsyncResult.isSuccess(result) ? result.value : undefined;

  const onChanges = useCallback(
    (id: SectionId, count: number) =>
      setDirty((known) => ((known[id] ?? 0) === count ? known : { ...known, [id]: count })),
    [],
  );

  useHashOnLoad(view !== undefined);

  return (
    <div className={styles["page"]}>
      <Head view={view} />
      <LeaveGuard dirty={dirty} />
      <div className={styles["layout"]}>
        {view === undefined ? null : <Jumps dirty={dirty} />}
        <div className={styles["body"]}>
          {AsyncResult.match(result, {
            onInitial: () => (
              <p className={kit["muted"]} aria-busy="true">
                Loading the settings…
              </p>
            ),
            onFailure: (failure) => (
              <Problem onRetry={reload}>
                Could not load the settings. {failureMessage(failure)}
              </Problem>
            ),
            onSuccess: ({ value }) => <Body view={value} onReload={reload} onChanges={onChanges} />,
          })}
        </div>
      </div>
    </div>
  );
};
