// Connect an account: choose how, then follow the steps. Sign-in flows either show a device code and wait for the
// provider to confirm (polling `/oauth/status`, which also advances the provider check), or open the provider's page
// and take the localhost address it lands on. Vertex takes a service-account key; auth files upload as they are.
import { useAtomRefresh } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Check, Copy, ExternalLink, LoaderCircle, Upload } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { Option, Schema } from "effect";
import { type OAuthStart, VertexImported, VertexImportFailed } from "@commissary/contract/oauth";
import {
  credentialsAtom,
  oauthCallbackAtom,
  oauthCancelAtom,
  oauthStartAtom,
  oauthStatusAtom,
  panelOrgSlug,
  uploadAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { addsPrivately, Ownership } from "../components/Ownership.tsx";
import {
  authFileName,
  CONNECT_OPTIONS,
  type ConnectOption,
  connectNotices,
  linkHost,
  MAX_AUTH_FILE_BYTES,
  readPastedAddress,
} from "../lib/connect.ts";
import { asSentence } from "../lib/failure.ts";
import { formatDuration } from "../lib/format.ts";
import { scopedApiUrl } from "@commissary/contract/api";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { useRole } from "../lib/use-role.ts";
import styles from "./Connect.module.css";

/** How often the page asks whether the sign-in finished (the server polls the provider no faster than it allows). */
const POLL_MS = 3000;

type Flow =
  | { readonly step: "idle" }
  | { readonly step: "starting" }
  | {
      readonly step: "open";
      readonly start: OAuthStart;
      readonly mode: "paste" | "code";
      readonly expiresAt: number | undefined;
    }
  | { readonly step: "finishing"; readonly start: OAuthStart }
  | { readonly step: "done" }
  | { readonly step: "failed"; readonly message: string };

const Steps = ({ children }: { readonly children: React.ReactNode }) => (
  <ol className={styles["steps"]}>{children}</ol>
);

const Step = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children?: React.ReactNode;
}) => (
  <li className={styles["step"]}>
    <h3 className={styles["stepTitle"]}>{title}</h3>
    {children}
  </li>
);

const OpenLink = ({ url, label }: { readonly url: string; readonly label: string }) => (
  <a className={kit["primary"]} href={url} target="_blank" rel="noopener noreferrer">
    <ExternalLink aria-hidden="true" size={16} strokeWidth={2.25} />
    {label}
    <span className={kit["visuallyHidden"]}> (opens in a new tab)</span>
  </a>
);

const DeviceCode = ({ code }: { readonly code: string }) => {
  const [copied, setCopied] = useState(false);

  return (
    <div className={styles["code"]}>
      <output className={styles["codeValue"]} aria-label="Code">
        {code}
      </output>
      <button
        type="button"
        className={kit["secondary"]}
        onClick={async () => {
          await navigator.clipboard.writeText(code);
          setCopied(true);
        }}
      >
        {copied ? (
          <Check aria-hidden="true" size={16} strokeWidth={2.5} />
        ) : (
          <Copy aria-hidden="true" size={16} strokeWidth={2.25} />
        )}
        {copied ? "Copied" : "Copy code"}
      </button>
    </div>
  );
};

const Countdown = ({ until }: { readonly until: number }) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);

    return () => clearInterval(timer);
  }, []);

  return (
    <span className={kit["muted"]}>
      {until > now ? `The code works for ${formatDuration(until - now)}.` : "The code has expired."}
    </span>
  );
};

/** What the provider's terms say, and that the org shares the account, beside the steps; it informs, never gates. */
const Notices = ({
  option,
  shared,
}: {
  readonly option: ConnectOption;
  /** The account becomes a shared credential. */
  readonly shared: boolean;
}) =>
  connectNotices(option, shared).map((text) => (
    <p key={text} className={styles["notice"]}>
      {text}
    </p>
  ));

const Waiting = ({ text }: { readonly text: string }) => (
  <p className={styles["waiting"]} role="status">
    <LoaderCircle aria-hidden="true" size={18} strokeWidth={2.5} className={kit["spinning"]} />
    {text}
  </p>
);

/** What the connect flows send for an account that is the caller's own (ADR 0023). */
const privateQuery = (privately: boolean) => (privately ? ({ private: "true" } as const) : {});

const SignIn = ({
  option,
  privately,
  shared,
}: {
  readonly option: ConnectOption;
  /** The account becomes the caller's private one. */
  readonly privately: boolean;
  /** The account becomes a shared credential. */
  readonly shared: boolean;
}) => {
  if (option.method.kind !== "sign-in") throw new Error("SignIn needs a sign-in option");
  const { provider, flow: defaultFlow, codeAlternative } = option.method;
  const [useCode, setUseCode] = useState(false);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [pasted, setPasted] = useState("");
  const [pasteProblem, setPasteProblem] = useState<string | undefined>(undefined);
  const start = useAction(oauthStartAtom);
  const status = useAction(oauthStatusAtom);
  const cancel = useAction(oauthCancelAtom);
  const callback = useAction(oauthCallbackAtom);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const pasteId = useId();
  const mode = defaultFlow === "code" || useCode ? "code" : "paste";

  // The latest callables, for the poller and the unmount cleanup (they change identity between renders).
  const latest = useRef({ status: status.run, cancel: cancel.run, refreshCredentials });
  latest.current = { status: status.run, cancel: cancel.run, refreshCredentials };

  const pendingState =
    flow.step === "open" || flow.step === "finishing" ? flow.start.state : undefined;

  const polling = (flow.step === "open" && flow.mode === "code") || flow.step === "finishing";

  // Leaving the page or choosing another provider mid-flow abandons the sign-in.
  const pendingRef = useRef<string | undefined>(undefined);
  pendingRef.current = pendingState;

  useEffect(
    () => () => {
      const state = pendingRef.current;

      if (state !== undefined) void latest.current.cancel({ query: { state } });
    },
    [],
  );

  useEffect(() => {
    if (!polling || pendingState === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const outcome = await latest.current.status({ query: { state: pendingState } });

      if (stopped) return;

      if (!outcome.ok) {
        setFlow({ step: "failed", message: outcome.message });
      } else if (outcome.value.status === "ok") {
        latest.current.refreshCredentials();
        setFlow({ step: "done" });
      } else if (outcome.value.status === "error") {
        setFlow({ step: "failed", message: asSentence(outcome.value.error) });
      } else {
        timer = setTimeout(tick, POLL_MS);
      }
    };

    timer = setTimeout(tick, POLL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [polling, pendingState]);

  const begin = async () => {
    setFlow({ step: "starting" });
    setPasted("");
    setPasteProblem(undefined);

    const outcome = await start.run({
      query: {
        provider,
        ...(mode === "code" && defaultFlow !== "code" ? { flow: "device" } : {}),
        ...privateQuery(privately),
      },
    });

    if (!outcome.ok) {
      setFlow({ step: "failed", message: outcome.message });

      return;
    }

    const started = outcome.value;

    setFlow({
      step: "open",
      start: started,
      mode: started.flow === "device" ? "code" : "paste",
      expiresAt:
        started.expires_in === undefined ? undefined : Date.now() + started.expires_in * 1000,
    });
  };

  const stop = async () => {
    if (pendingState !== undefined) await cancel.run({ query: { state: pendingState } });
    setFlow({ step: "idle" });
  };

  const finish = async (event: FormEvent) => {
    event.preventDefault();

    if (flow.step !== "open") return;
    const address = readPastedAddress(pasted);

    if (!address.ok) {
      setPasteProblem(address.problem);

      return;
    }

    setPasteProblem(undefined);
    const outcome = await callback.run({ payload: { provider, redirect_url: address.url } });

    if (outcome.ok) {
      setFlow({ step: "finishing", start: flow.start });
    } else {
      setPasteProblem(outcome.message);
    }
  };

  switch (flow.step) {
    case "idle":
    case "starting":
      return (
        <div className={styles["panelBody"]}>
          <p className={styles["lead"]}>{option.how}</p>
          <Notices option={option} shared={shared} />
          {codeAlternative === true ? (
            <label className={styles["check"]}>
              <input
                type="checkbox"
                checked={useCode}
                onChange={(event) => setUseCode(event.target.checked)}
              />
              Use a device code instead (it must be turned on in your ChatGPT security settings)
            </label>
          ) : null}
          <button
            type="button"
            className={kit["primary"]}
            disabled={flow.step === "starting"}
            onClick={begin}
          >
            {flow.step === "starting" ? "Starting…" : `Sign in to ${option.name}`}
          </button>
        </div>
      );
    case "open":
      return flow.mode === "code" ? (
        <div className={styles["panelBody"]}>
          <Steps>
            <Step title={`Open ${linkHost(flow.start.url)}`}>
              <OpenLink url={flow.start.url} label={`Open ${linkHost(flow.start.url)}`} />
            </Step>
            {flow.start.user_code === undefined ? null : (
              <Step title="Enter this code and approve">
                <DeviceCode code={flow.start.user_code} />
                {flow.expiresAt === undefined ? null : <Countdown until={flow.expiresAt} />}
              </Step>
            )}
            <Step title="Come back here">
              <Waiting text={`Waiting for ${option.name} to confirm…`} />
            </Step>
          </Steps>
          <button type="button" className={kit["secondary"]} onClick={stop}>
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles["panelBody"]}>
          <Steps>
            <Step title={`Sign in on ${linkHost(flow.start.url)} and approve`}>
              <OpenLink url={flow.start.url} label={`Open ${linkHost(flow.start.url)}`} />
            </Step>
            <Step title="Copy the address you land on">
              <p className={styles["stepText"]}>
                After you approve, your browser goes to a page on localhost that does not load. That
                is expected: the sign-in answer is in its address. Copy the whole address from the
                address bar.
              </p>
            </Step>
            <Step title="Paste it here">
              <form className={styles["paste"]} onSubmit={finish} noValidate>
                <label htmlFor={pasteId} className={kit["visuallyHidden"]}>
                  Address from your browser
                </label>
                <input
                  id={pasteId}
                  className={kit["input"]}
                  value={pasted}
                  placeholder="http://localhost:…/callback?code=…"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={pasteProblem !== undefined}
                  aria-describedby={pasteProblem === undefined ? undefined : `${pasteId}-problem`}
                  onChange={(event) => setPasted(event.target.value)}
                />
                <button type="submit" className={kit["primary"]} disabled={callback.busy}>
                  {callback.busy ? "Finishing…" : "Finish"}
                </button>
                {pasteProblem === undefined ? null : (
                  <span id={`${pasteId}-problem`} className={kit["fieldError"]}>
                    {pasteProblem}
                  </span>
                )}
              </form>
            </Step>
          </Steps>
          <button type="button" className={kit["secondary"]} onClick={stop}>
            Cancel
          </button>
        </div>
      );
    case "finishing":
      return (
        <div className={styles["panelBody"]}>
          <Waiting text={`Finishing the ${option.name} sign-in…`} />
        </div>
      );
    case "done":
      return (
        <Connected
          text={`${option.name} is connected. Commissary can send it requests now.`}
          again={() => setFlow({ step: "idle" })}
        />
      );
    case "failed":
      return (
        <div className={styles["panelBody"]}>
          <Problem onRetry={() => setFlow({ step: "idle" })} retryLabel="Start again">
            The sign-in did not finish. {flow.message}
          </Problem>
        </div>
      );
  }
};

const Connected = ({ text, again }: { readonly text: string; readonly again: () => void }) => (
  <div className={styles["panelBody"]} role="status">
    <p className={styles["done"]}>
      <Check aria-hidden="true" size={20} strokeWidth={2.75} />
      {text}
    </p>
    <div className={styles["row"]}>
      <Link to="/accounts" className={kit["primary"]}>
        See accounts
      </Link>
      <button type="button" className={kit["secondary"]} onClick={again}>
        Connect another
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------------------------------------------
// Vertex

type VertexResult =
  | { readonly ok: true; readonly project: string; readonly email: string; readonly file: string }
  | { readonly ok: false; readonly message: string };

/** `POST /oauth/import?provider=vertex` is multipart, which the typed client does not send; a plain request does. */
const importVertex = async (
  file: File,
  location: string,
  privately: boolean,
): Promise<VertexResult> => {
  const form = new FormData();
  form.set("file", file);

  if (location.trim() !== "") form.set("location", location.trim());

  let response: Response;

  try {
    response = await fetch(
      scopedApiUrl(
        `/v9/management/oauth/import?provider=vertex${privately ? "&private=true" : ""}`,
        panelOrgSlug,
      ),
      {
        method: "POST",
        body: form,
        credentials: "same-origin",
      },
    );
  } catch {
    return {
      ok: false,
      message:
        "The server did not answer. If your Access session expired, reload the page to sign in again.",
    };
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const failed = Schema.decodeUnknownOption(VertexImportFailed)(body);

    if (Option.isNone(failed)) {
      return { ok: false, message: `The import failed (HTTP ${response.status}).` };
    }

    const { error, message } = failed.value;

    return {
      ok: false,
      message: asSentence(message === undefined ? error : `${error}: ${message}`),
    };
  }

  const imported = Schema.decodeUnknownOption(VertexImported)(body);

  if (Option.isNone(imported)) {
    return { ok: false, message: "The server answered the import with something unexpected." };
  }

  return {
    ok: true,
    project: imported.value.project_id ?? "",
    email: imported.value.email ?? "",
    file: imported.value["auth-file"] ?? "",
  };
};

const Vertex = ({ privately }: { readonly privately: boolean }) => {
  const ids = useId();
  const [file, setFile] = useState<File | undefined>(undefined);
  const [location, setLocation] = useState("us-central1");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VertexResult | undefined>(undefined);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const form = useRef<HTMLFormElement>(null);

  if (result?.ok === true) {
    return (
      <Connected
        text={`Imported ${result.project || "the project"}${result.email === "" ? "" : ` (${result.email})`}. Commissary can send it Vertex AI requests now.`}
        again={() => {
          setResult(undefined);
          setFile(undefined);
          form.current?.reset();
        }}
      />
    );
  }

  return (
    <form
      ref={form}
      className={styles["panelBody"]}
      onSubmit={async (event) => {
        event.preventDefault();

        if (file === undefined) {
          setResult({ ok: false, message: "Choose the service-account key file first." });

          return;
        }

        setBusy(true);
        const outcome = await importVertex(file, location, privately);
        setBusy(false);
        setResult(outcome);

        if (outcome.ok) refreshCredentials();
      }}
    >
      <p className={styles["lead"]}>
        Create a key for a service account with the Vertex AI User role in Google Cloud (IAM,
        Service accounts, Keys, Add key, JSON), then choose the downloaded file.
      </p>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-file`}>
          Service-account key (JSON)
        </label>
        <input
          id={`${ids}-file`}
          type="file"
          accept=".json,application/json"
          className={styles["file"]}
          onChange={(event) => setFile(event.target.files?.[0])}
        />
      </div>
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={`${ids}-location`}>
          Region
        </label>
        <input
          id={`${ids}-location`}
          className={kit["input"]}
          value={location}
          spellCheck={false}
          onChange={(event) => setLocation(event.target.value)}
        />
      </div>
      {result?.ok === false ? <Problem>{result.message}</Problem> : null}
      <button type="submit" className={kit["primary"]} disabled={busy}>
        <Upload aria-hidden="true" size={16} strokeWidth={2.25} />
        {busy ? "Importing…" : "Import key"}
      </button>
    </form>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Auth files

interface FileResult {
  readonly name: string;
  readonly problem: string | undefined;
}

const Files = ({
  option,
  privately,
  shared,
}: {
  readonly option: ConnectOption;
  readonly privately: boolean;
  readonly shared: boolean;
}) => {
  const id = useId();
  const upload = useAction(uploadAtom);
  const refreshCredentials = useAtomRefresh(credentialsAtom);
  const [files, setFiles] = useState<ReadonlyArray<File>>([]);
  const [results, setResults] = useState<ReadonlyArray<FileResult>>([]);
  const [busy, setBusy] = useState(false);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const done: FileResult[] = [];

    for (const file of files) {
      const name = authFileName(file.name);

      if (name === undefined) {
        done.push({ name: file.name, problem: "Not added: the name must end in .json." });
      } else if (file.size > MAX_AUTH_FILE_BYTES) {
        done.push({ name, problem: "Not added: larger than 10 MB, so not an auth file." });
      } else {
        const outcome = await upload.run({
          query: { name, ...privateQuery(privately) },
          payload: await file.text(),
        });

        done.push({ name, problem: outcome.ok ? undefined : `Not added. ${outcome.message}` });
      }

      setResults([...done]);
    }

    setBusy(false);

    if (done.some((result) => result.problem === undefined)) refreshCredentials();
  };

  return (
    <form className={styles["panelBody"]} onSubmit={send}>
      <p className={styles["lead"]}>
        Each file becomes one account; a file with the same name replaces the account saved under
        it.
      </p>
      <Notices option={option} shared={shared} />
      <div className={kit["field"]}>
        <label className={kit["fieldLabel"]} htmlFor={id}>
          Auth files (JSON)
        </label>
        <input
          id={id}
          type="file"
          multiple
          accept=".json,application/json"
          className={styles["file"]}
          onChange={(event) => {
            setFiles(Array.from(event.target.files ?? []));
            setResults([]);
          }}
        />
      </div>
      <button type="submit" className={kit["primary"]} disabled={busy || files.length === 0}>
        <Upload aria-hidden="true" size={16} strokeWidth={2.25} />
        {busy ? "Uploading…" : files.length > 1 ? `Upload ${files.length} files` : "Upload"}
      </button>
      {results.length === 0 ? null : (
        <ul className={styles["results"]} aria-live="polite">
          {results.map((result) => (
            <li key={result.name} data-bad={result.problem !== undefined}>
              <span className={styles["resultName"]}>{result.name}</span>
              <span>{result.problem ?? "Added."}</span>
            </li>
          ))}
        </ul>
      )}
      {results.some((result) => result.problem === undefined) && !busy ? (
        <Link to="/accounts" className={kit["sectionLink"]}>
          See accounts
        </Link>
      ) : null}
    </form>
  );
};

// ---------------------------------------------------------------------------------------------------------------
// Page

const Panel = ({
  option,
  privately,
  shared,
}: {
  readonly option: ConnectOption;
  readonly privately: boolean;
  /** The account will be a shared credential. */
  readonly shared: boolean;
}) => {
  switch (option.method.kind) {
    case "sign-in":
      return (
        <SignIn
          key={`${option.id}-${privately}`}
          option={option}
          privately={privately}
          shared={shared}
        />
      );
    case "vertex":
      return <Vertex key={String(privately)} privately={privately} />;
    case "file":
      return (
        <Files key={String(privately)} option={option} privately={privately} shared={shared} />
      );
  }
};

export const ConnectPage = () => {
  usePageTitle("Connect an account");
  const [chosen, setChosen] = useState<ConnectOption | undefined>(undefined);
  const [mine, setMine] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const role = useRole();
  const caller = role.kind === "ready" ? role.caller : undefined;
  const privately = addsPrivately(caller, mine);

  useEffect(() => {
    if (chosen !== undefined && window.matchMedia("(max-width: 48rem)").matches) {
      panel.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [chosen]);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <Link to="/accounts" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Accounts
        </Link>
        <h1 className={styles["title"]}>Connect an account</h1>
        <Ownership caller={caller} noun="account" chosen={mine} onChange={setMine} />
      </header>
      <div className={styles["columns"]}>
        <fieldset className={styles["options"]}>
          <legend className={styles["legend"]}>Provider</legend>
          {CONNECT_OPTIONS.map((option) => (
            <label key={option.id} className={styles["option"]}>
              <input
                type="radio"
                name="connect-with"
                value={option.id}
                checked={chosen?.id === option.id}
                onChange={() => setChosen(option)}
              />
              <span className={styles["optionText"]}>
                <span className={styles["optionName"]}>{option.name}</span>
                <span className={styles["optionHow"]}>{option.how}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <section
          ref={panel}
          className={styles["panel"]}
          aria-label={chosen === undefined ? "Steps" : `Connect ${chosen.name}`}
        >
          {chosen === undefined ? (
            <p className={styles["prompt"]}>Choose a provider to see the steps.</p>
          ) : (
            <>
              <h2 className={styles["panelTitle"]}>{chosen.name}</h2>
              <Panel option={chosen} privately={privately} shared={!privately} />
            </>
          )}
        </section>
      </div>
    </div>
  );
};
