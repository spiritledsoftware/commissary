// Agents (/agents, #233, ADR 0040): the hosted agents the caller manages, one row each with its model, its tools and
// whether it is enabled, and the shared agents a member may use but does not manage. A member's own are private; an
// org admin manages every shared agent and their own private ones, and sees only that other members' private agents
// exist (their name and owner), which they may disable or remove. The head creates an agent. The Agents area is
// absent where the deployment has no Dynamic Workers binding: the page then is Not found.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { Plus } from "lucide-react";
import type { UsableAgent } from "@commissary/contract/agents";
import {
  AGENTS,
  agentsAtom,
  meAtom,
  removeAgentAtom,
  updateAgentAtom,
  usableAgentsAtom,
} from "../api/client.ts";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { PrivateRows } from "../components/PrivateRows.tsx";
import {
  type AgentRow,
  type AgentsCaller,
  agentRow,
  agentsCallerOf,
  canCreateAgent,
  emptyAgentsText,
  ifMatch,
  otherAgentRows,
  privateOffText,
  problemOf,
  scopeText,
  sharedWithCaller,
  sortAgents,
} from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Tools.module.css";
import { NotFound } from "./NotFound.tsx";

/** What a write of a row the list no longer has says. */
const GONE = "That agent is no longer in the list. Reload the page.";

const Row = ({ row }: { readonly row: AgentRow }) => (
  <tr>
    <td>
      <div className={styles["name"]}>
        <Link to="/agents/$agentId" params={{ agentId: row.agent.id }}>
          {row.agent.name}
        </Link>
        <span className={styles["secondary"]}>
          {row.agent.private ? "Private" : "Shared"}
          {row.agent.description === "" ? "" : ` · ${row.agent.description}`}
        </span>
      </div>
      {/* On a narrow screen the model folds in here. */}
      <div className={styles["narrowOnly"]}>{row.model}</div>
    </td>
    <td className={styles["wide"]}>{row.model}</td>
    <td className={styles["wide"]}>{scopeText(row.agent)}</td>
    <td>{row.agent.enabled ? "Enabled" : "Disabled"}</td>
  </tr>
);

const SharedWithYou = ({ agents }: { readonly agents: ReadonlyArray<UsableAgent> }) =>
  agents.length === 0 ? null : (
    <Section title="Shared with you" className={styles["section"]}>
      <p className={styles["intro"]}>
        Shared agents an org admin granted you. Clients start them through the agents toolkit.
      </p>
      <div className={styles["scroll"]}>
        <table className={styles["table"]}>
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">What it is for</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td className={styles["name"]}>{agent.name}</td>
                <td>{agent.description === "" ? "No description" : agent.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );

/** What an org admin sees of other members' private agents: that each exists and whose, to disable or remove. */
const Others = ({ rows }: { readonly rows: ReturnType<typeof otherAgentRows> }) => {
  const update = useAction(updateAgentAtom);
  const remove = useAction(removeAgentAtom);

  return (
    <PrivateRows
      title="Members' private agents"
      noun="private agent"
      rows={rows.map((row) => ({
        key: row.id,
        label: row.name,
        owner: row.owner,
        disabled: !row.enabled,
      }))}
      onDisable={async ({ key }, disabled) => {
        const row = rows.find((each) => each.id === key);

        if (row === undefined) return { ok: false, message: GONE };

        const outcome = await update.run({
          params: { id: key },
          headers: ifMatch(row),
          payload: { enabled: !disabled },
          reactivityKeys: AGENTS,
        });

        return outcome.ok
          ? { ok: true }
          : { ok: false, message: problemOf(outcome) ?? outcome.message };
      }}
      onRemove={async ({ key }) => {
        const row = rows.find((each) => each.id === key);

        if (row === undefined) return { ok: false, message: GONE };

        const outcome = await remove.run({
          params: { id: key },
          headers: ifMatch(row),
          // These are other members' private agents: they have no grants or Spend limits to refetch.
          reactivityKeys: AGENTS,
        });

        return outcome.ok
          ? { ok: true }
          : { ok: false, message: problemOf(outcome) ?? outcome.message };
      }}
    />
  );
};

const List = ({ caller }: { readonly caller: AgentsCaller }) => {
  const result = useAtomValue(agentsAtom);
  const retry = useAtomRefresh(agentsAtom);
  const usable = useAtomValue(usableAgentsAtom);

  return AsyncResult.match(result, {
    onInitial: () => (
      <p className={kit["muted"]} aria-busy="true">
        Loading the agents…
      </p>
    ),
    onFailure: (failure) => (
      <Problem onRetry={retry}>Could not load the agents. {failureMessage(failure)}</Problem>
    ),
    onSuccess: ({ value }) => {
      const rows = sortAgents(value.agents).map(agentRow);

      const shared = AsyncResult.isSuccess(usable)
        ? sharedWithCaller(value.agents, usable.value.agents)
        : [];

      const off = privateOffText(caller);

      return (
        <>
          {rows.length === 0 ? (
            <p className={styles["empty"]}>{emptyAgentsText(caller)}</p>
          ) : (
            <div className={`${styles["section"]} ${styles["scroll"]}`}>
              <table className={styles["table"]}>
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col" className={styles["wide"]}>
                      Model
                    </th>
                    <th scope="col" className={styles["wide"]}>
                      Tools
                    </th>
                    <th scope="col">State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <Row key={row.agent.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {off === undefined ? null : <p className={styles["intro"]}>{off}</p>}
          <SharedWithYou agents={shared} />
          {value.others === undefined || value.others.length === 0 ? null : (
            <div className={styles["section"]}>
              <Others rows={otherAgentRows(value.others)} />
            </div>
          )}
        </>
      );
    },
  });
};

export const AgentsPage = () => {
  const me = useAtomValue(meAtom);
  const caller = AsyncResult.isSuccess(me) ? agentsCallerOf(me.value) : undefined;
  const present = AsyncResult.isSuccess(me) ? me.value.deployment.agents : undefined;

  usePageTitle("Agents");

  if (present === false) return <NotFound />;

  return (
    <div className={kit["page"]}>
      <header className={styles["head"]}>
        <div className={styles["titleRow"]}>
          <h1 className={styles["title"]}>Agents</h1>
          <div className={styles["actions"]}>
            {caller !== undefined && canCreateAgent(caller) ? (
              <Link to="/agents/new" className={kit["primary"]}>
                <Plus aria-hidden="true" size={18} strokeWidth={2.25} />
                New agent
              </Link>
            ) : null}
          </div>
        </div>
        <p className={styles["intro"]}>
          A hosted agent is a saved definition: a model, instructions and the tools it may use. Each
          run reads it afresh at its next turn. A private agent is one member&rsquo;s and works
          within their reach; a shared agent is made by an org admin, reaches exactly what its
          definition names, and is used by those it is granted to.
        </p>
      </header>
      {caller === undefined || present !== true ? null : <List caller={caller} />}
    </div>
  );
};
