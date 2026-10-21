// The endpoint URL builder (/tools/endpoint, #208, ADR 0037, ADR 0045, docs/CLIENTS.md): Commissary's MCP endpoint
// on this deployment, narrowed to some toolkits with `?toolkits=`, how many tools the URL gives the member (with an
// API key's tool scope when one is picked), the suggestion to narrow a URL above 100 tools, and how to set the common
// clients up with it. A self-hosted Commissary shows the app host's URL behind Access and, with an API host, the API
// host's for API keys; one with a single host shows the first only, and says why. API keys never appear: the snippets
// read one from an environment variable.
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";
import type { ApiKeyView } from "@commissary/contract/api-keys";
import type { Me } from "@commissary/contract/orgs";
import type { UsableTools } from "@commissary/contract/tools";
import { apiKeysAtom, meAtom, panelOrgSlug, usableToolsAtom } from "../api/client.ts";
import { CopyValue } from "../components/CopyValue.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import {
  accessTokenSnippets,
  API_KEY_VARIABLE,
  type Endpoint,
  type EndpointPlace,
  type EndpointVia,
  endpointsOf,
  narrowingNote,
  oneHostNote,
  type Snippet,
  snippetsOf,
  toolCount,
  type ToolkitSelection,
  WITHOUT_MANAGED_OAUTH,
} from "../lib/mcp-endpoint.ts";
import { toolCountText } from "../lib/tool-scope.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Tools.module.css";

const TITLES: Readonly<Record<EndpointVia, { readonly title: string; readonly lead: string }>> = {
  access: {
    title: "Through Access",
    lead: "On this host, behind Cloudflare Access: a client signs in as you in the browser, and gets the tools you may use.",
  },
  key: {
    title: "With an API key",
    lead: "On the API host: a client sends one of your API keys, and gets the tools its tool scope gives.",
  },
  cloud: {
    title: "Commissary's MCP endpoint",
    lead: "A client signs in to Commissary in the browser, picking the tools it gets, or sends one of your API keys.",
  },
};

const placeOf = (me: Me): EndpointPlace => ({
  origin: window.location.origin,
  slug: panelOrgSlug ?? "default",
  hosted: me.deployment.hosted,
  apiUrl: me.api_url,
});

/** The caller's keys that still work. */
const liveKeys = (keys: ReadonlyArray<ApiKeyView>, now: number): ReadonlyArray<ApiKeyView> =>
  keys.filter(
    (key) =>
      key.mine &&
      key.revoked_at === undefined &&
      (key.expires_at === undefined || Date.parse(key.expires_at) > now),
  );

const Snippets = ({ snippets }: { readonly snippets: ReadonlyArray<Snippet> }) => (
  <ul className={styles["snippets"]}>
    {snippets.map((snippet) => (
      <li key={`${snippet.client}-${snippet.how}`} className={styles["snippet"]}>
        <span className={styles["client"]}>{snippet.client}</span>
        <p className={styles["lead"]}>{snippet.how}</p>
        {snippet.code === undefined ? null : (
          <pre className={styles["code"]}>
            <code>{snippet.code}</code>
          </pre>
        )}
      </li>
    ))}
  </ul>
);

const EndpointBlock = ({
  endpoint,
  count,
}: {
  readonly endpoint: Endpoint;
  readonly count: number;
}) => {
  const narrowing = narrowingNote(count);

  return (
    <section className={styles["endpoint"]} aria-label={TITLES[endpoint.via].title}>
      <h3 className={styles["endpointTitle"]}>{TITLES[endpoint.via].title}</h3>
      <p className={styles["lead"]}>{TITLES[endpoint.via].lead}</p>
      <CopyValue label="MCP endpoint URL" value={endpoint.url} />
      <p className={styles["count"]}>{toolCountText(count)}</p>
      {narrowing === undefined ? null : <p className={styles["note"]}>{narrowing}</p>}
      <Snippets snippets={snippetsOf(endpoint.via, endpoint.url)} />
      {endpoint.via === "access" ? (
        <>
          <p className={styles["note"]}>{WITHOUT_MANAGED_OAUTH}</p>
          <Snippets snippets={accessTokenSnippets(endpoint.url)} />
        </>
      ) : null}
      {endpoint.via === "cloud" ? (
        <>
          <p className={styles["note"]}>
            Or with an API key, from {API_KEY_VARIABLE} in the client&rsquo;s environment:
          </p>
          <Snippets snippets={snippetsOf("key", endpoint.url)} />
        </>
      ) : null}
    </section>
  );
};

const Builder = ({
  me,
  usable,
  keys,
}: {
  readonly me: Me;
  readonly usable: UsableTools;
  readonly keys: ReadonlyArray<ApiKeyView>;
}) => {
  const ids = useId();
  const place = placeOf(me);
  const names = usable.toolkits.map((toolkit) => toolkit.name);
  const [only, setOnly] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [keyId, setKeyId] = useState("");
  const [now] = useState(() => Date.now());
  const live = liveKeys(keys, now);
  const key = live.find((each) => each.id === keyId);
  const chosen = names.filter((name) => picked.has(name));
  const selection: ToolkitSelection = only && chosen.length > 0 ? chosen : "all";
  const endpoints = endpointsOf(place, selection);
  const withKey = endpoints.some((endpoint) => endpoint.via !== "access");
  const single = oneHostNote(place);

  const countFor = (endpoint: Endpoint): number =>
    toolCount(
      usable,
      selection,
      endpoint.via === "access" || key === undefined ? undefined : (key.tool_scope ?? null),
    );

  return (
    <>
      <Section title="Toolkits" className={styles["section"]}>
        {names.length === 0 ? (
          <p className={styles["empty"]}>
            No tools reach you yet: a URL gives you none until an org admin grants you a
            toolkit&rsquo;s tools, or you add a private toolkit.
          </p>
        ) : (
          <fieldset className={styles["choices"]}>
            <legend>Which toolkits a URL gives</legend>
            <label className={styles["choice"]}>
              <input
                type="radio"
                name={`${ids}-only`}
                checked={!only}
                onChange={() => setOnly(false)}
              />
              Every toolkit you may use, now and later
            </label>
            <label className={styles["choice"]}>
              <input
                type="radio"
                name={`${ids}-only`}
                checked={only}
                onChange={() => setOnly(true)}
              />
              Only these
            </label>
            {only ? (
              <div className={styles["toolkitPicks"]}>
                {usable.toolkits.map((toolkit) => (
                  <label key={toolkit.id} className={styles["check"]}>
                    <input
                      type="checkbox"
                      checked={picked.has(toolkit.name)}
                      onChange={(event) => {
                        const next = new Set(picked);

                        if (event.target.checked) next.add(toolkit.name);
                        else next.delete(toolkit.name);
                        setPicked(next);
                      }}
                    />
                    {toolkit.name}
                    <span className={styles["secondary"]}>
                      {toolCountText(toolkit.tools.length)}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {only && chosen.length === 0 ? (
              <span className={styles["hint"]}>
                Pick one or more: until then the URL gives every toolkit.
              </span>
            ) : null}
          </fieldset>
        )}
        {withKey && live.length > 0 ? (
          <div className={styles["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-key`}>
              Count the tools of an API key
            </label>
            <select
              id={`${ids}-key`}
              className={kit["input"]}
              value={keyId}
              onChange={(event) => setKeyId(event.target.value)}
            >
              <option value="">None: every tool you may use</option>
              {live.map((each) => (
                <option key={each.id} value={each.id}>
                  {each.name}
                </option>
              ))}
            </select>
            <span className={styles["hint"]}>
              A key with a tool scope gives only the tools it names. Set scopes on the{" "}
              <Link to="/api-keys">API keys</Link> page.
            </span>
          </div>
        ) : null}
      </Section>
      <Section title="URL and clients" className={styles["section"]}>
        {single === undefined ? null : <p className={styles["note"]}>{single}</p>}
        {endpoints.map((endpoint) => (
          <EndpointBlock key={endpoint.via} endpoint={endpoint} count={countFor(endpoint)} />
        ))}
      </Section>
    </>
  );
};

export const McpEndpointPage = () => {
  const me = useAtomValue(meAtom);
  const usable = useAtomValue(usableToolsAtom);
  const keys = useAtomValue(apiKeysAtom);

  usePageTitle("Endpoint URL");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/tools" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={styles["title"]}>Endpoint URL</h1>
        <p className={styles["intro"]}>
          Commissary&rsquo;s MCP endpoint gives a client the tools you may use, named
          &lt;toolkit&gt;_&lt;tool&gt;. Narrow a URL to the toolkits a client needs: a model chooses
          better from fewer tools.
        </p>
      </header>
      {AsyncResult.isFailure(usable) ? (
        <Problem>Could not load the tools you may use. {failureMessage(usable)}</Problem>
      ) : AsyncResult.isSuccess(me) && AsyncResult.isSuccess(usable) ? (
        <Builder
          me={me.value}
          usable={usable.value}
          keys={AsyncResult.isSuccess(keys) ? keys.value.keys : []}
        />
      ) : (
        <p className={kit["muted"]} aria-busy="true">
          Loading the tools you may use…
        </p>
      )}
    </div>
  );
};
