/**
 * `@commissary/agents/api`, Agents' entry for the API Worker (#134 "The area package convention"): its view of `env`.
 * The client API of agents (the agents toolkit, #229) comes later. The apps import Agents only through this entry,
 * `./management` and `./state` (the lint rule `boundaries/agents-imports`).
 */
export { type AgentsBindings, AgentsEnv, agentsPresent } from "./env.ts";
