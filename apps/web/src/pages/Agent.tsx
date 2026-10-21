// One agent (/agents/$agentId, #233, ADR 0040): its definition as an editor (name, instructions, model, tools, sandbox,
// enabled), the notice when it starts runs unattended with write tools no approval rule covers (ADR 0044), its
// triggers and, for a shared agent, who may use it, its watchers (part of the definition) and its Spend limit, and
// removing it, which is at once and deletes its runs (ADR 0027). Only the agent's manager opens it: its member for a
// private agent, an org admin for a shared one; the list holds every agent the caller manages. The head links to a new
// chat with it (#234) when the caller may use it (`GET /agents/mine`: enabled, and theirs or granted to them).
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft, MessageSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import type { AgentView } from "@commissary/contract/agents";
import {
  AGENT_GRANTS,
  AGENTS,
  agentsAtom,
  meAtom,
  removeAgentAtom,
  SPEND,
  usableAgentsAtom,
} from "../api/client.ts";
import { AgentEditor } from "../components/AgentEditor.tsx";
import { AgentGrants } from "../components/AgentGrants.tsx";
import { AgentUnattended } from "../components/AgentUnattended.tsx";
import { AgentSpend } from "../components/AgentSpend.tsx";
import { AgentTriggers } from "../components/AgentTriggers.tsx";
import { type ConfirmRequest, ConfirmDialog } from "../components/Confirm.tsx";
import { kit, Problem, Section } from "../components/Kit.tsx";
import { ifMatch, problemOf } from "../lib/agents.ts";
import { failureMessage } from "../lib/failure.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import styles from "./Tools.module.css";
import { NotFound } from "./NotFound.tsx";

const route = getRouteApi("/agents/$agentId");

/** Removing the agent: at once, with its grants, Spend limits and every run of it. */
const RemoveAgent = ({ agent }: { readonly agent: AgentView }) => {
  const remove = useAction(removeAgentAtom);
  const navigate = useNavigate();
  const [request, setRequest] = useState<ConfirmRequest | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);

  return (
    <Section title="Remove" className={styles["section"]}>
      <p className={styles["intro"]}>
        Removing {agent.name} deletes it at once
        {agent.private ? "" : ", with its grants and Spend limits"}, and every run of it. There is
        no restore. Disabling it instead keeps everything and starts no new runs.
      </p>
      {problem === undefined ? null : <Problem>{problem}</Problem>}
      <div className={styles["actions"]}>
        <button
          type="button"
          className={kit["danger"]}
          disabled={remove.busy}
          onClick={() =>
            setRequest({
              title: `Remove ${agent.name}?`,
              body: (
                <p>
                  The agent, its triggers{agent.private ? "" : ", its grants, its Spend limits"} and
                  all its runs are deleted now, and nothing brings them back.
                </p>
              ),
              action: "Remove agent",
              busyAction: "Removing…",
              run: async () => {
                setProblem(undefined);

                const outcome = await remove.run({
                  params: { id: agent.id },
                  headers: ifMatch(agent),
                  // Its grants and Spend limits go with it.
                  reactivityKeys: [...AGENTS, ...AGENT_GRANTS, ...SPEND],
                });

                if (outcome.ok) void navigate({ to: "/agents" });
                else setProblem(problemOf(outcome));
              },
            })
          }
        >
          <Trash2 aria-hidden="true" size={18} strokeWidth={2.25} />
          Remove {agent.name}
        </button>
      </div>
      <ConfirmDialog request={request} busy={remove.busy} onClose={() => setRequest(undefined)} />
    </Section>
  );
};

const Details = ({ agent }: { readonly agent: AgentView }) => (
  <>
    <AgentUnattended agent={agent} />
    {/* Keyed by the agent: a saved edit (or another's) re-reads the definition into the form, which keeps its note. */}
    <AgentEditor key={agent.id} agent={agent} />
    <AgentTriggers agent={agent.id} agentEnabled={agent.enabled} />
    {agent.private ? null : (
      <>
        <AgentGrants agent={agent.id} />
        <AgentSpend agent={agent.id} />
      </>
    )}
    <RemoveAgent agent={agent} />
  </>
);

/** The page once the deployment is known to have the Agents area: only then is the agents list read. */
const Loaded = ({ agentId }: { readonly agentId: string }) => {
  const result = useAtomValue(agentsAtom);
  const retry = useAtomRefresh(agentsAtom);

  const agent = AsyncResult.isSuccess(result)
    ? result.value.agents.find((each) => each.id === agentId)
    : undefined;

  const usable = useAtomValue(usableAgentsAtom);

  const chat =
    agent !== undefined &&
    AsyncResult.isSuccess(usable) &&
    usable.value.agents.some((each) => each.id === agent.id);

  usePageTitle(agent?.name ?? "Agent");

  return (
    <>
      <header className={styles["head"]}>
        <Link to="/agents" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Agents
        </Link>
        <div className={styles["titleRow"]}>
          <h1 className={styles["title"]}>{agent?.name ?? "Agent"}</h1>
          {chat ? (
            <div className={styles["actions"]}>
              <Link to="/agents/$agentId/chat" params={{ agentId }} className={kit["primary"]}>
                <MessageSquare aria-hidden="true" size={18} strokeWidth={2.25} />
                Start a chat
              </Link>
            </div>
          ) : null}
        </div>
        {agent === undefined ? null : (
          <p className={styles["intro"]}>
            {agent.private
              ? "Private agent: yours alone."
              : "Shared agent: an org admin manages it."}{" "}
            {agent.enabled ? "Enabled." : "Disabled: it starts no new runs."}
          </p>
        )}
      </header>
      {AsyncResult.match(result, {
        onInitial: () => (
          <p className={kit["muted"]} aria-busy="true">
            Loading the agent…
          </p>
        ),
        onFailure: (failure) => (
          <Problem onRetry={retry}>Could not load the agent. {failureMessage(failure)}</Problem>
        ),
        onSuccess: () =>
          agent === undefined ? (
            <Problem>
              That agent is gone, or is not one you manage. A member manages their private agents,
              and an org admin the shared ones.
            </Problem>
          ) : (
            <Details agent={agent} />
          ),
      })}
    </>
  );
};

export const AgentPage = () => {
  const { agentId } = route.useParams();
  const me = useAtomValue(meAtom);
  const present = AsyncResult.isSuccess(me) ? me.value.deployment.agents : undefined;

  if (present === false) return <NotFound />;

  return (
    <div className={kit["page"]}>
      {present === true ? (
        <Loaded agentId={agentId} />
      ) : (
        <p className={kit["muted"]} aria-busy="true">
          Loading the agent…
        </p>
      )}
    </div>
  );
};
