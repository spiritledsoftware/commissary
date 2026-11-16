// Models: every model id clients can call, problems first, with how many of its routes (the accounts and keys that
// could serve it) take requests, its providers, where the id comes from and its context length. A row opens its
// routes: who serves it under which upstream name, each route's state with the time it is back, and why a rule
// takes it away. The channel rules themselves are edited on their own page (ModelRules.tsx); account and key rules
// are shown here only, their homes are the Account page's Routing section (`#routing`) and the provider keys pages.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ChevronDown, ChevronRight, Search, Timer } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import type { ModelRoute, RoutedModel, RoutingModels } from "@commissary/contract/routing";
import {
  providerKeysAtom,
  CREDENTIALS,
  nowAtom,
  resetCooldownAtom,
  ROUTING,
  routingModelsAtom,
} from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { ResetBlade, TrailMark } from "../components/Signs.tsx";
import { failureMessage } from "../lib/failure.ts";
import { formatClock, formatCount, formatDuration, formatTokens } from "../lib/format.ts";
import {
  isHidden,
  type KeyHome,
  keyHomes,
  modelMatches,
  modelOrigins,
  modelProviders,
  modelStanding,
  needsAttention,
  routeOrigin,
  routeProvenance,
  routeStanding,
  routeWho,
  type RouteWho,
  sortModels,
  upstreamNote,
} from "../lib/models.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Models.module.css";
import { ModelsCatalog } from "./ModelsCatalog.tsx";

type Filter = "all" | "attention" | "hidden";

const FILTERS: ReadonlyArray<{
  readonly id: Filter;
  readonly label: string;
  readonly keep: (model: RoutedModel) => boolean;
}> = [
  { id: "all", label: "All", keep: () => true },
  { id: "attention", label: "Needs attention", keep: needsAttention },
  { id: "hidden", label: "Hidden from clients", keep: isHidden },
];

/** The last thing done to a route (a cleared cooldown), said under its state. */
interface Note {
  readonly tone: "done" | "problem";
  readonly text: string;
}

const RulesLink = ({
  channel,
  children,
}: {
  readonly channel: string;
  readonly children: string;
}) => (
  <Link to="/models/rules" hash={`channel-${channel}`}>
    {children}
  </Link>
);

/** An account's own rules live in its page's Routing section. */
const AccountRulesLink = ({
  route,
  children,
}: {
  readonly route: ModelRoute;
  readonly children: string;
}) =>
  route.source === "file" ? (
    <Link to="/accounts/$authIndex" params={{ authIndex: route.auth_index }} hash="routing">
      {children}
    </Link>
  ) : (
    children
  );

/** Why a rule takes the route away or renames it, pointing at the rule's home. */
const Provenance = ({ route }: { readonly route: ModelRoute }) => {
  const provenance = routeProvenance(route);

  if (provenance === undefined) return null;
  const { kind, scope, pattern, channel } = provenance;
  const rule = pattern === undefined ? null : <span className={styles["pattern"]}>{pattern}</span>;

  if (kind === "alias") {
    return (
      <span className={styles["provenance"]}>
        {scope === "channel" && channel !== undefined ? (
          <>
            Alias from the <RulesLink channel={channel}>{`${channel} channel rules`}</RulesLink>
          </>
        ) : (
          <>
            Alias from{" "}
            <AccountRulesLink route={route}>this account&rsquo;s own rules</AccountRulesLink>
          </>
        )}
      </span>
    );
  }

  return (
    <span className={styles["provenance"]}>
      {scope === "channel" && channel !== undefined ? (
        <>
          By the <RulesLink channel={channel}>{`${channel} channel rule`}</RulesLink> {rule}
        </>
      ) : scope === "account" ? (
        <>
          By <AccountRulesLink route={route}>this account&rsquo;s own rule</AccountRulesLink> {rule}
        </>
      ) : scope === "key" ? (
        <>By its key group&rsquo;s rule {rule}</>
      ) : (
        <>By a rule {rule}</>
      )}
    </span>
  );
};

/** A route's account or provider key, linked to its page; a key the list does not know links to the provider keys page. */
const WhoLink = ({ home, name }: { readonly home: RouteWho["home"]; readonly name: string }) => {
  switch (home.kind) {
    case "account":
      return (
        <Link
          to="/accounts/$authIndex"
          params={{ authIndex: home.authIndex }}
          className={styles["whoName"]}
        >
          {name}
        </Link>
      );
    case "key":
      return (
        <Link
          to="/keys/$family/$index"
          params={{ family: home.family, index: String(home.index) }}
          className={styles["whoName"]}
        >
          {name}
        </Link>
      );
    default:
      return (
        <Link to="/keys" className={styles["whoName"]}>
          {name}
        </Link>
      );
  }
};

const RouteRow = ({
  modelId,
  route,
  homes,
  now,
}: {
  readonly modelId: string;
  readonly route: ModelRoute;
  readonly homes: ReadonlyMap<string, KeyHome>;
  readonly now: number;
}) => {
  const reset = useAction(resetCooldownAtom);
  const [note, setNote] = useState<Note | undefined>(undefined);
  const standing = routeStanding(route, now);
  const who = routeWho(route, homes);
  const upstream = upstreamNote(modelId, route);
  const { home } = who;

  return (
    <tr className={styles["route"]} data-off={standing.tone === "off"}>
      <th scope="row" className={styles["routeWho"]}>
        <div className={styles["who"]}>
          <span className={styles["markSlot"]}>
            {standing.tone === "closed" ? <TrailMark /> : null}
          </span>
          <span className={styles["whoText"]}>
            <WhoLink home={home} name={who.name} />
            {who.detail === undefined ? null : (
              <span className={styles["secondary"]}>{who.detail}</span>
            )}
            {upstream === undefined ? null : (
              <span className={styles["secondary"]}>{upstream}</span>
            )}
          </span>
        </div>
      </th>
      <td className={styles["via"]}>{routeOrigin(route)}</td>
      <td className={styles["routeState"]}>
        <div className={styles["stateStack"]}>
          <span className={styles["standing"]} data-tone={standing.tone}>
            {standing.label}
          </span>
          {standing.backAt === undefined ? null : (
            <ResetBlade
              destination="Back in"
              time={formatDuration(standing.backAt - now)}
              label={`${who.name} serves ${route.upstream} again in ${formatDuration(standing.backAt - now)}`}
              closed={true}
              demanding={false}
              caption={formatClock(standing.backAt)}
            />
          )}
          <Provenance route={route} />
          <span className={styles["note"]} role="status" data-tone={note?.tone}>
            {note?.text}
          </span>
        </div>
      </td>
      <td className={styles["routeActions"]}>
        {route.state === "cooling" ? (
          <button
            type="button"
            className={kit["secondary"]}
            disabled={reset.busy}
            aria-busy={reset.busy}
            aria-label={`Clear the cooldowns of ${who.name}`}
            onClick={async () => {
              setNote(undefined);

              const outcome = await reset.run({
                payload: { auth_index: route.auth_index },
                reactivityKeys: [...ROUTING, ...CREDENTIALS],
              });

              setNote(
                outcome.ok
                  ? { tone: "done", text: "Cooldowns cleared." }
                  : { tone: "problem", text: `Could not clear the cooldowns. ${outcome.message}` },
              );
            }}
          >
            <Timer
              aria-hidden="true"
              size={16}
              strokeWidth={2.25}
              className={reset.busy ? kit["spinning"] : undefined}
            />
            {reset.busy ? "Clearing…" : "Clear cooldown"}
          </button>
        ) : null}
      </td>
    </tr>
  );
};

const Routes = ({
  model,
  homes,
  now,
}: {
  readonly model: RoutedModel;
  readonly homes: ReadonlyMap<string, KeyHome>;
  readonly now: number;
}) => (
  <table className={styles["routes"]} aria-label={`Routes of ${model.id}`}>
    <thead>
      <tr>
        <th scope="col">Account or key</th>
        <th scope="col">Origin</th>
        <th scope="col">State</th>
        <th scope="col">
          <span className={kit["visuallyHidden"]}>Actions</span>
        </th>
      </tr>
    </thead>
    <tbody>
      {model.routes.map((route) => (
        <RouteRow key={route.auth_index} modelId={model.id} route={route} homes={homes} now={now} />
      ))}
    </tbody>
  </table>
);

const ModelRow = ({
  model,
  homes,
  now,
}: {
  readonly model: RoutedModel;
  readonly homes: ReadonlyMap<string, KeyHome>;
  readonly now: number;
}) => {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const standing = modelStanding(model);

  return (
    <>
      <tr className={styles["row"]} data-open={open} data-tone={standing.tone}>
        <th scope="row" className={styles["modelCell"]}>
          <div className={styles["model"]}>
            <span className={styles["markSlot"]}>
              {standing.tone === "closed" ? <TrailMark /> : null}
            </span>
            <span className={styles["modelText"]}>
              <button
                type="button"
                className={styles["expand"]}
                aria-expanded={open}
                aria-controls={detailId}
                onClick={() => setOpen(!open)}
              >
                {open ? (
                  <ChevronDown aria-hidden="true" size={16} strokeWidth={2.25} />
                ) : (
                  <ChevronRight aria-hidden="true" size={16} strokeWidth={2.25} />
                )}
                <span className={styles["id"]}>{model.id}</span>
              </button>
              {model.display_name === undefined || model.display_name === model.id ? null : (
                <span className={styles["displayName"]}>{model.display_name}</span>
              )}
            </span>
          </div>
        </th>
        <td className={styles["state"]}>
          <span className={styles["standing"]} data-tone={standing.tone}>
            {standing.label}
          </span>
          {standing.details.length === 0 ? null : (
            <span className={styles["secondary"]}>{standing.details.join(" · ")}</span>
          )}
        </td>
        <td className={styles["providers"]}>{modelProviders(model).join(", ")}</td>
        <td className={styles["origin"]}>
          {modelOrigins(model).map((origin) => (
            <span key={origin} data-quiet={origin === "Catalog"}>
              {origin}
            </span>
          ))}
        </td>
        <td className={styles["context"]}>
          {model.context_length === undefined ? (
            <span className={kit["muted"]}>
              <span aria-hidden="true">–</span>
              <span className={kit["visuallyHidden"]}>Not known</span>
            </span>
          ) : (
            formatTokens(model.context_length)
          )}
        </td>
      </tr>
      {open ? (
        <tr className={styles["detailRow"]} id={detailId}>
          <td colSpan={5}>
            <Routes model={model} homes={homes} now={now} />
          </td>
        </tr>
      ) : null}
    </>
  );
};

const EMPTY_FILTER: Readonly<Record<Filter, string>> = {
  all: "",
  attention: "Nothing needs attention: every route that can serve a model is taking requests.",
  hidden: "Every model is listed for clients.",
};

const List = ({ view }: { readonly view: RoutingModels }) => {
  const now = useAtomValue(nowAtom);
  const keys = useAtomValue(providerKeysAtom);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLowerCase());
  const searchId = useId();
  const homes = AsyncResult.isSuccess(keys) ? keyHomes(keys.value) : new Map<string, KeyHome>();
  const keep = FILTERS.find((candidate) => candidate.id === filter)?.keep ?? (() => true);

  const shown = sortModels(view.models).filter(
    (model) => keep(model) && modelMatches(model, query),
  );

  const prefixed = view.models.some((model) => model.routes.some((route) => route.prefix));

  return (
    <>
      {view.force_model_prefix && prefixed ? (
        <p className={styles["fact"]}>
          Accounts and keys with a prefix serve only their prefixed ids (prefix/model), as the{" "}
          <Link to="/settings" hash="routing">
            routing settings
          </Link>{" "}
          require.
        </p>
      ) : null}
      <div className={styles["toolbar"]}>
        <div className={kit["tabs"]} role="radiogroup" aria-label="Show">
          {FILTERS.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="radio"
              aria-checked={filter === candidate.id}
              className={kit["tab"]}
              onClick={() => setFilter(candidate.id)}
            >
              {candidate.label}
              <span className={kit["tabCount"]}>
                {formatCount(view.models.filter(candidate.keep).length)}
              </span>
            </button>
          ))}
        </div>
        <div className={styles["search"]}>
          <label htmlFor={searchId} className={kit["visuallyHidden"]}>
            Search models
          </label>
          <Search
            aria-hidden="true"
            size={16}
            strokeWidth={2.25}
            className={styles["searchIcon"]}
          />
          <input
            id={searchId}
            type="search"
            className={kit["input"]}
            placeholder="Search models"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {shown.length === 0 ? (
        <p className={styles["empty"]}>
          {query === "" ? EMPTY_FILTER[filter] : `No model matches “${search.trim()}”.`}
        </p>
      ) : (
        <>
          <p className={styles["mobileKey"]} aria-hidden="true">
            Context, tokens
          </p>
          <table className={styles["models"]}>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Routes</th>
                <th scope="col">Providers</th>
                <th scope="col">Origin</th>
                <th scope="col" className={styles["number"]}>
                  Context, tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((model) => (
                <ModelRow key={model.id} model={model} homes={homes} now={now} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
};

export const ModelsPage = () => {
  usePageTitle("Models");
  const result = useAtomValue(routingModelsAtom);
  const retry = useAtomRefresh(routingModelsAtom);

  return (
    <div className={styles["page"]}>
      <header className={styles["head"]}>
        <h1 className={styles["title"]}>Models</h1>
        <Link to="/models/rules" className={kit["secondary"]}>
          Model rules
        </Link>
      </header>
      <ModelsCatalog />
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading models…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the models. {failureMessage(failure)}</Problem>
        ),
        onSuccess: ({ value }) =>
          value.models.length === 0 ? (
            <p className={styles["empty"]}>
              No models yet. <Link to="/accounts/connect">Connect an account</Link> or{" "}
              <Link to="/keys/new">add a provider key</Link>, and the models it serves show here.
            </p>
          ) : (
            <List view={value} />
          ),
      })}
    </div>
  );
};
