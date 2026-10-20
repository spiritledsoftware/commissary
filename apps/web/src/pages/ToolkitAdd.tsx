// Adding a toolkit (/tools/add, #208, #207): pick where it comes from (a service of the toolkit catalog and one of its
// sources; what a domain looks up to, with integrations.sh's slower `discover` only when asked; a URL as it was typed;
// or an uploaded OpenAPI, GraphQL or Discovery document), then its name, whose it is and which credentials it accepts.
// Adding it opens its page, where its sign-ins are connected. The catalog shows no icons: the panel's CSP loads images
// from its own origin only.
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, Plus, Search } from "lucide-react";
import { type FormEvent, useDeferredValue, useId, useState } from "react";
import type {
  CatalogServiceSummary,
  CatalogSource,
  DomainLookup,
} from "@commissary/contract/toolkit-catalog";
import type {
  AddedToolkitKind,
  CredentialsAccepted,
  ToolkitCredentialKind,
} from "@commissary/contract/tools";
import {
  addToolkitAtom,
  CATALOG_PAGE,
  catalogPageKey,
  discoverDomainAtom,
  lookupDomainAtom,
  meAtom,
  TOOLKITS,
  toolkitCatalogAtom,
  toolkitCatalogServiceAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatCount } from "../lib/format.ts";
import {
  type AddDetails,
  type AddOrigin,
  addBody,
  documentProblem,
  domainOf,
  isWholeUrl,
} from "../lib/toolkit-add.ts";
import { wayLabel, wayName } from "../lib/toolkit-credentials.ts";
import {
  ACCEPTS,
  canAdd,
  documentLabel,
  isAccepted,
  kindLabel,
  problemOf,
  toolkitNameProblem,
  type ToolsCaller,
  toolsCallerOf,
} from "../lib/toolkits.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { SpecField } from "./ToolkitFields.tsx";
import styles from "./Tools.module.css";

const ADDED_KINDS: ReadonlyArray<AddedToolkitKind> = ["mcp", "openapi", "graphql", "discovery"];

const UPLOADED_KINDS: ReadonlyArray<AddedToolkitKind> = ["openapi", "graphql", "discovery"];

const isAddedKind = (value: string): value is AddedToolkitKind =>
  ADDED_KINDS.some((kind) => kind === value);

/** The sign-in ways a source names, in a phrase. */
const waysText = (source: CatalogSource): string =>
  source.credentials.length === 0
    ? "Sign-in not known"
    : source.credentials.map((credential) => wayName(credential.kind)).join(", ");

/** A source's name, with its kind where the name does not say it already ("Linear MCP server" does). */
const sourceTitle = (source: CatalogSource): string => {
  const kind = kindLabel(source.kind);

  return source.name.toLowerCase().includes(kind.toLowerCase()) ||
    source.name.toLowerCase().includes(source.kind)
    ? source.name
    : `${source.name} · ${kind}`;
};

/** A service's sources, each with what it is and how it signs in, and the button that picks it. */
const Sources = ({
  sources,
  onPick,
}: {
  readonly sources: ReadonlyArray<CatalogSource>;
  readonly onPick: (source: CatalogSource) => void;
}) =>
  sources.length === 0 ? (
    <p className={styles["empty"]}>It names nothing a toolkit can be built from.</p>
  ) : (
    <ul className={styles["services"]}>
      {sources.map((source) => (
        <li key={source.id} className={styles["service"]}>
          <span className={styles["serviceText"]}>
            <span className={styles["serviceName"]}>{sourceTitle(source)}</span>
            <span className={styles["secondary"]}>{source.url}</span>
            <span className={styles["secondary"]}>{waysText(source)}</span>
          </span>
          <button type="button" className={kit["secondary"]} onClick={() => onPick(source)}>
            Use this
          </button>
        </li>
      ))}
    </ul>
  );

/** The chosen catalog service's sources, loaded when it is chosen. */
const ServiceSources = ({
  id,
  onPick,
}: {
  readonly id: string;
  readonly onPick: (origin: AddOrigin) => void;
}) => {
  const result = useAtomValue(toolkitCatalogServiceAtom(id));

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading its sources…
      </p>
    ),
    onFailure: (failure) => (
      <Problem>Could not load the service. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => (
      <Sources
        sources={value.sources}
        onPick={(source) => onPick({ from: "catalog", service: value, source })}
      />
    ),
  });
};

/** One service of the catalog, with its sources under it while it is chosen. */
const ServiceItem = ({
  service,
  chosen,
  onChoose,
  onPick,
}: {
  readonly service: CatalogServiceSummary;
  readonly chosen: boolean;
  readonly onChoose: (chosen: boolean) => void;
  readonly onPick: (origin: AddOrigin) => void;
}) => (
  <li className={styles["service"]} data-chosen={chosen}>
    <span className={styles["serviceText"]}>
      <span className={styles["serviceName"]}>{service.name}</span>
      <span className={styles["secondary"]}>
        {service.domain} · {service.kinds.map(kindLabel).join(", ")}
      </span>
      {service.description === undefined ? null : (
        <span className={styles["serviceAbout"]}>{service.description}</span>
      )}
    </span>
    <button
      type="button"
      className={kit["secondary"]}
      aria-expanded={chosen}
      onClick={() => onChoose(!chosen)}
    >
      {chosen ? "Close" : "Choose"}
    </button>
    {chosen ? (
      <div className={styles["sources"]}>
        <ServiceSources id={service.id} onPick={onPick} />
      </div>
    ) : null}
  </li>
);

interface ServiceList {
  readonly chosen: string | undefined;
  readonly onChoose: (id: string | undefined) => void;
  readonly onPick: (origin: AddOrigin) => void;
}

const ServiceItems = ({
  services,
  list,
}: {
  readonly services: ReadonlyArray<CatalogServiceSummary>;
  readonly list: ServiceList;
}) =>
  services.map((service) => (
    <ServiceItem
      key={service.id}
      service={service}
      chosen={list.chosen === service.id}
      onChoose={(open) => list.onChoose(open ? service.id : undefined)}
      onPick={list.onPick}
    />
  ));

/** A later page of the catalog, loaded when "Show more" asks for it. */
const MoreServices = ({
  query,
  offset,
  list,
}: {
  readonly query: string;
  readonly offset: number;
  readonly list: ServiceList;
}) => {
  const page = useAtomValue(toolkitCatalogAtom(catalogPageKey(query, offset)));

  return AsyncResult.match(page, {
    onInitial: () => (
      <li className={styles["service"]} aria-busy="true">
        <span className={kit["muted"]}>Loading more services…</span>
      </li>
    ),
    onFailure: (failure) => (
      <li className={styles["service"]}>
        <Problem>Could not load more services. {failureMessage(failure)}</Problem>
      </li>
    ),
    onSuccess: ({ value }) => <ServiceItems services={value.services} list={list} />,
  });
};

/** The services matching a search, a page at a time. */
const CatalogResults = ({
  query,
  onPick,
}: {
  readonly query: string;
  readonly onPick: (origin: AddOrigin) => void;
}) => {
  const first = useAtomValue(toolkitCatalogAtom(catalogPageKey(query, 0)));
  const [pages, setPages] = useState(1);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const list: ServiceList = { chosen, onChoose: setChosen, onPick };

  return AsyncResult.match(first, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the catalog…
      </p>
    ),
    onFailure: (failure) => (
      <Problem>Could not load the catalog. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      if (value.services.length === 0)
        return (
          <p className={styles["empty"]}>
            Nothing in the catalog matches. Look its domain up below instead.
          </p>
        );

      const shown = Math.min(pages * CATALOG_PAGE, value.total);
      const offsets = Array.from({ length: pages - 1 }, (_, page) => (page + 1) * CATALOG_PAGE);

      return (
        <>
          <ul className={styles["services"]} aria-label="Services">
            <ServiceItems services={value.services} list={list} />
            {offsets.map((offset) => (
              <MoreServices key={offset} query={query} offset={offset} list={list} />
            ))}
          </ul>
          {value.total > shown ? (
            <div className={styles["actions"]}>
              <button
                type="button"
                className={kit["secondary"]}
                onClick={() => setPages(pages + 1)}
              >
                Show more
              </button>
              <span className={styles["hint"]}>
                {formatCount(shown)} of {formatCount(value.total)} services
                {query === "" ? "; search to find one faster" : ""}.
              </span>
            </div>
          ) : null}
        </>
      );
    },
  });
};

const Catalog = ({ onPick }: { readonly onPick: (origin: AddOrigin) => void }) => {
  const id = useId();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim());

  return (
    <Section title="From the catalog" className={styles["section"]}>
      <p className={styles["lead"]}>
        Services with an MCP server or an API Commissary can build tools from, with how to sign in
        to each.
      </p>
      <div className={styles["search"]}>
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={id}>
            Search the catalog
          </label>
          <input
            id={id}
            type="search"
            className={kit["input"]}
            value={search}
            placeholder="linear, crm, payments"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      <CatalogResults key={query} query={query} onPick={onPick} />
    </Section>
  );
};

const VIA_TEXT: Readonly<Record<DomainLookup["via"], string>> = {
  catalog: "In the catalog.",
  detect:
    "Not in the catalog: integrations.sh found this just now. It fills this toolkit only, and is not kept.",
  discover:
    "Not in the catalog: integrations.sh read the service's docs for this. It fills this toolkit only, and is not kept.",
};

/** A domain looked up, or a URL typed in full and added as it is. */
const Lookup = ({ onPick }: { readonly onPick: (origin: AddOrigin) => void }) => {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [kind, setKind] = useState<AddedToolkitKind>("mcp");
  const [found, setFound] = useState<DomainLookup | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const lookup = useAction(lookupDomainAtom);
  const discover = useAction(discoverDomainAtom);
  const domain = domainOf(typed);

  const ask = async (deeper: boolean) => {
    setProblem(undefined);

    if (domain === undefined) {
      setProblem("Type a domain, like linear.app, or a whole URL.");

      return;
    }

    const outcome = deeper
      ? await discover.run({ params: { domain } })
      : await lookup.run({ params: { domain } });

    if (outcome.ok) setFound(outcome.value);
    else setProblem(problemOf(outcome));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void ask(false);
  };

  return (
    <Section title="By domain or URL" className={styles["section"]}>
      <p className={styles["lead"]}>
        A service&rsquo;s domain finds it in the catalog, else integrations.sh looks it up. A whole
        URL of an MCP server, an OpenAPI or Discovery document or a GraphQL endpoint can be added as
        it is.
      </p>
      <form className={styles["search"]} onSubmit={submit} noValidate>
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={id}>
            Domain or URL
          </label>
          <input
            id={id}
            className={kit["input"]}
            value={typed}
            placeholder="linear.app"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setTyped(event.target.value);
              setFound(undefined);
            }}
          />
        </div>
        <button
          type="submit"
          className={kit["secondary"]}
          disabled={lookup.busy || discover.busy}
          aria-busy={lookup.busy}
        >
          <Search aria-hidden="true" size={18} strokeWidth={2.25} />
          {lookup.busy ? "Looking up…" : "Look up"}
        </button>
      </form>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      {isWholeUrl(typed) ? (
        <div className={styles["search"]}>
          <div className={styles["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${id}-kind`}>
              The URL is
            </label>
            <select
              id={`${id}-kind`}
              className={kit["input"]}
              value={kind}
              onChange={(event) => {
                if (isAddedKind(event.target.value)) setKind(event.target.value);
              }}
            >
              {ADDED_KINDS.map((each) => (
                <option key={each} value={each}>
                  {kindLabel(each)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className={kit["secondary"]}
            onClick={() => onPick({ from: "url", url: typed, kind })}
          >
            Add it as it is
          </button>
        </div>
      ) : null}
      {found === undefined ? null : (
        <div className={styles["lines"]} role="status">
          <p className={styles["state"]}>{found.service.name}</p>
          <p className={styles["hint"]}>{VIA_TEXT[found.via]}</p>
          {found.refused === undefined || found.refused.length === 0 ? null : (
            <p className={styles["hint"]}>
              Left out, as Commissary does not reach them: {found.refused.join(", ")}.
            </p>
          )}
        </div>
      )}
      {found === undefined ? null : (
        <Sources
          sources={found.service.sources}
          onPick={(source) => onPick({ from: "lookup", lookup: found, source })}
        />
      )}
      {found === undefined || found.via === "discover" ? null : (
        <div className={styles["actions"]}>
          <button
            type="button"
            className={kit["secondary"]}
            disabled={lookup.busy || discover.busy}
            aria-busy={discover.busy}
            onClick={() => void ask(true)}
          >
            {discover.busy ? "Looking deeper…" : "Look deeper"}
          </button>
          <span className={styles["hint"]}>
            integrations.sh reads the service&rsquo;s docs: it takes up to a minute.
          </span>
        </div>
      )}
    </Section>
  );
};

const Upload = ({ onPick }: { readonly onPick: (origin: AddOrigin) => void }) => {
  const id = useId();
  const [kind, setKind] = useState<AddedToolkitKind>("openapi");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    if (file === undefined) {
      setProblem("Choose a file first.");

      return;
    }

    const tooLarge = documentProblem(kind, file.size);

    if (tooLarge !== undefined) {
      setProblem(tooLarge);

      return;
    }

    onPick({ from: "upload", kind, document: await file.text() });
  };

  return (
    <Section title="From a document" className={styles["section"]}>
      <p className={styles["lead"]}>
        An OpenAPI document (JSON or YAML), a Google Discovery document, or a GraphQL schema (SDL)
        for an endpoint that does not allow introspection.
      </p>
      <form className={styles["search"]} onSubmit={(event) => void submit(event)} noValidate>
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={`${id}-kind`}>
            It is
          </label>
          <select
            id={`${id}-kind`}
            className={kit["input"]}
            value={kind}
            onChange={(event) => {
              if (isAddedKind(event.target.value)) setKind(event.target.value);
            }}
          >
            {UPLOADED_KINDS.map((each) => (
              <option key={each} value={each}>
                {documentLabel(each)}
              </option>
            ))}
          </select>
        </div>
        <div className={styles["field"]}>
          <label className={kit["fieldLabel"]} htmlFor={id}>
            File
          </label>
          <input
            id={id}
            type="file"
            accept=".json,.yaml,.yml,.graphql,.gql,.txt"
            onChange={(event) => {
              setFile(event.target.files?.[0]);
              setProblem(undefined);
            }}
          />
        </div>
        <button type="submit" className={kit["secondary"]}>
          Use this file
        </button>
      </form>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
    </Section>
  );
};

/** What the toolkit is added from, in a line. */
const originText = (origin: AddOrigin): string => {
  switch (origin.from) {
    case "catalog":
      return `${origin.service.name}: ${sourceTitle(origin.source)}`;
    case "lookup":
      return `${origin.lookup.service.name}: ${sourceTitle(origin.source)}`;
    case "url":
      return `${origin.url.trim()}, ${kindLabel(origin.kind)}`;
    case "upload":
      return `An uploaded ${documentLabel(origin.kind)}`;
  }
};

/** The default name a toolkit gets, said under the name field. */
const defaultNameText = (origin: AddOrigin): string => {
  switch (origin.from) {
    case "catalog":
      return `Empty: ${origin.service.id}.`;
    case "lookup":
      return `Empty: ${origin.lookup.service.id}.`;
    case "url":
      return "Empty: named after the URL's host.";
    case "upload":
      return "Empty: named after the document's server or title.";
  }
};

const credentialsOf = (origin: AddOrigin): ReadonlyArray<ToolkitCredentialKind> =>
  origin.from === "catalog" || origin.from === "lookup"
    ? origin.source.credentials.map((credential) => credential.kind)
    : [];

const Details = ({
  origin,
  caller,
  onBack,
}: {
  readonly origin: AddOrigin;
  readonly caller: ToolsCaller;
  readonly onBack: () => void;
}) => {
  const ids = useId();
  const navigate = useNavigate();
  const add = useAction(addToolkitAtom);
  const ways = credentialsOf(origin);
  const [name, setName] = useState("");
  const [owned, setOwned] = useState(!caller.admin);
  const [accepts, setAccepts] = useState<CredentialsAccepted>("shared");
  const [credential, setCredential] = useState<ToolkitCredentialKind | undefined>(ways[0]);
  const [nameProblem, setNameProblem] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(undefined);
    const badName = toolkitNameProblem(name);

    setNameProblem(badName);

    if (badName !== undefined) return;
    const details: AddDetails = { name, private: owned, accepts, credential };

    const outcome = await add.run({
      payload: addBody(origin, details),
      reactivityKeys: TOOLKITS,
    });

    if (outcome.ok) {
      await navigate({ to: "/tools/$toolkitId", params: { toolkitId: outcome.value.id } });

      return;
    }

    const said = problemOf(outcome);

    if (outcome.error === "name_taken" || outcome.path === "name") setNameProblem(said);
    else setProblem(said);
  };

  return (
    <Section title="Add it" className={styles["section"]}>
      <div className={styles["actions"]}>
        <p className={styles["state"]}>{originText(origin)}</p>
        <button type="button" className={styles["linkButton"]} onClick={onBack}>
          Pick another
        </button>
      </div>
      <form className={styles["form"]} onSubmit={(event) => void submit(event)} noValidate>
        <SpecField
          spec={{
            key: "name",
            label: "Name",
            secret: false,
            optional: true,
            hint: `Its tools are called <name>_<tool>. ${defaultNameText(origin)}`,
          }}
          value={name}
          problem={nameProblem}
          onChange={setName}
        />
        {caller.admin && caller.privateToolkits ? (
          <fieldset className={styles["choices"]}>
            <legend>Whose</legend>
            <label className={styles["choice"]}>
              <input
                type="radio"
                name={`${ids}-whose`}
                checked={!owned}
                onChange={() => setOwned(false)}
              />
              <span className={styles["choiceText"]}>
                The org&rsquo;s
                <span className={styles["hint"]}>Members use it under their tool grants.</span>
              </span>
            </label>
            <label className={styles["choice"]}>
              <input
                type="radio"
                name={`${ids}-whose`}
                checked={owned}
                onChange={() => setOwned(true)}
              />
              <span className={styles["choiceText"]}>
                Yours, private
                <span className={styles["hint"]}>Only you see and use it.</span>
              </span>
            </label>
          </fieldset>
        ) : caller.admin ? null : (
          <p className={styles["hint"]}>
            It is your private toolkit: only you see it, and it signs in with your own credential.
          </p>
        )}
        {owned ? null : (
          <div className={styles["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-accepts`}>
              Credentials it accepts
            </label>
            <select
              id={`${ids}-accepts`}
              className={kit["input"]}
              value={accepts}
              onChange={(event) => {
                if (isAccepted(event.target.value)) setAccepts(event.target.value);
              }}
            >
              {ACCEPTS.map((each) => (
                <option key={each.value} value={each.value}>
                  {each.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {ways.length > 1 ? (
          <div className={styles["field"]}>
            <label className={kit["fieldLabel"]} htmlFor={`${ids}-way`}>
              How it signs in
            </label>
            <select
              id={`${ids}-way`}
              className={kit["input"]}
              value={credential}
              onChange={(event) =>
                setCredential(ways.find((way) => way === event.target.value) ?? ways[0])
              }
            >
              {ways.map((way) => (
                <option key={way} value={way}>
                  {wayLabel(way)}
                </option>
              ))}
            </select>
            <span className={styles["hint"]}>
              The toolkit keeps it: a key then goes where the source says.
            </span>
          </div>
        ) : null}
        {problem === undefined ? null : <Problem>{problem}</Problem>}
        <div className={styles["actions"]}>
          <button type="submit" className={kit["primary"]} disabled={add.busy} aria-busy={add.busy}>
            <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
            {add.busy ? "Adding…" : "Add toolkit"}
          </button>
        </div>
        <p className={styles["hint"]}>
          Commissary lists its tools as it adds it. Its sign-ins are connected on its page next.
        </p>
      </form>
    </Section>
  );
};

export const ToolkitAddPage = () => {
  const me = useAtomValue(meAtom);
  const caller = AsyncResult.isSuccess(me) ? toolsCallerOf(me.value) : undefined;
  const [origin, setOrigin] = useState<AddOrigin | undefined>(undefined);

  usePageTitle("Add a toolkit");

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <Link to="/tools" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Tools
        </Link>
        <h1 className={styles["title"]}>Add a toolkit</h1>
        <p className={styles["intro"]}>
          From a service in the catalog, a domain or URL, or a document. Its name prefixes its
          tools&rsquo; names, as clients see them.
        </p>
      </header>
      {caller === undefined ? null : !canAdd(caller) ? (
        <p className={styles["empty"]}>
          This org does not let members add private toolkits. An org admin adds toolkits, and grants
          their tools.
        </p>
      ) : origin === undefined ? (
        <>
          <Catalog onPick={setOrigin} />
          <Lookup onPick={setOrigin} />
          <Upload onPick={setOrigin} />
        </>
      ) : (
        <Details origin={origin} caller={caller} onBack={() => setOrigin(undefined)} />
      )}
    </div>
  );
};
