// A new chat with a hosted agent (/agents/$agentId/chat, #234, ADR 0040): the first message starts a run with the chat
// trigger kind, started by the caller, and the run's page takes the chat from there (steering, new turns, Stop). Any
// agent the caller may use opens it: their private agents and the shared agents granted to them (`GET /agents/mine`),
// enabled ones only; anything else says so.
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeft } from "lucide-react";
import type { UsableAgent } from "@commissary/contract/agents";
import { AGENT_RUNS, meAtom, startRunAtom, usableAgentsAtom } from "../api/client.ts";
import { kit, Problem } from "../components/Kit.tsx";
import { RunComposer } from "../components/RunComposer.tsx";
import { runProblem } from "../lib/agent-runs.ts";
import { failureMessage } from "../lib/failure.ts";
import { useAction } from "../lib/use-action.ts";
import { usePageTitle } from "../lib/use-page-title.ts";
import { NotFound } from "./NotFound.tsx";
import styles from "./Tools.module.css";

const route = getRouteApi("/agents/$agentId/chat");

const Start = ({ agent }: { readonly agent: UsableAgent }) => {
  const start = useAction(startRunAtom);
  const navigate = useNavigate();

  return (
    <div className={styles["section"]}>
      <RunComposer
        send="Start chat"
        sending="Starting…"
        hint={`Your first message starts a run of ${agent.name}, as you. You can steer it while it works, and stop it.`}
        label={`Message ${agent.name}`}
        busy={start.busy}
        onSend={async (text) => {
          const outcome = await start.run({
            params: { id: agent.id },
            payload: { input: text },
            reactivityKeys: AGENT_RUNS,
          });

          if (!outcome.ok)
            return { problem: runProblem(outcome.error, outcome.message, outcome.detail) };

          void navigate({ to: "/agent-runs/$runId", params: { runId: outcome.value.run.id } });

          return { note: undefined };
        }}
      />
    </div>
  );
};

const Loaded = ({ agentId }: { readonly agentId: string }) => {
  const result = useAtomValue(usableAgentsAtom);
  const retry = useAtomRefresh(usableAgentsAtom);

  const agent = AsyncResult.isSuccess(result)
    ? result.value.agents.find((each) => each.id === agentId)
    : undefined;

  usePageTitle(agent === undefined ? "Chat" : `Chat with ${agent.name}`);

  return (
    <>
      <header className={styles["head"]}>
        <Link to="/agents" className={styles["back"]}>
          <ArrowLeft aria-hidden="true" size={16} strokeWidth={2.25} />
          Agents
        </Link>
        <h1 className={styles["title"]}>
          {agent === undefined ? "Chat" : `Chat with ${agent.name}`}
        </h1>
        {agent === undefined ? null : (
          <p className={styles["intro"]}>
            {agent.description === "" ? "No description." : agent.description}{" "}
            {agent.private
              ? "Your private agent: it works within your reach."
              : "A shared agent: it reaches what its definition names, whoever chats with it."}
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
              You cannot chat with that agent: it is gone, disabled, or not granted to you.
            </Problem>
          ) : (
            <Start agent={agent} />
          ),
      })}
    </>
  );
};

export const AgentChatPage = () => {
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
