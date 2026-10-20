/**
 * `@commissary/agents/api`, Agents' entry for the API Worker (#134 "The area package convention"): its view of `env`;
 * the agent run's Durable Object (#227, `AgentRunObject`), which the API Worker's `AgentRun` extends with its run gateway
 * (ADR 0030's amendment), with what it reads from its env (`AgentRunEnv`) and what it asks of the gateway
 * (`RunGateway`); an agent run's principal as the run gateway resolves it (`runPrincipal`); and triggers' (#231): the
 * schedules' Durable Object (`AgentScheduleObject`, the API Worker's `AgentSchedule`) and the webhooks' delivery route
 * (`webhookRoutes`). The agents toolkit (#229) comes later. The apps import Agents only through this entry,
 * `./management` and `./state` (the lint rule `boundaries/agents-imports`).
 */
export { type AgentsBindings, AgentsEnv, agentsPresent } from "./env.ts";

export { runPrincipal } from "./runs/principal.ts";

export { type AgentRunEnv, AgentRunObject, type RunGateway } from "./runs/run-object.ts";

export { type AgentScheduleEnv, AgentScheduleObject } from "./triggers/schedule-object.ts";

export { webhookRoutes } from "./triggers/webhook-route.ts";
