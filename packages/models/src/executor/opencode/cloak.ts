/**
 * OpenCode Zen free-tier cloak (ADR 0033): which requests are cloaked, the stub `read` tool, and the removal of the
 * stub's calls from the answer.
 *
 * Workers addition (no OpenCode provider in Go). Zen serves its free models only to requests that look like OpenCode's
 * own client (probed 2026-10-18): a User-Agent with an `opencode/<channel>/<version>/<name>` token (version >= 1.18.0,
 * else 426 `UpgradeRequired`), an OpenCode-format `x-opencode-session` (`session-id.ts`), `stream: true`, and a tool
 * named exactly `read` (any description and schema). A cloaked request carries those markers and nothing else of
 * OpenCode's: the client identity stays `commissary`, and the stub tool is marked unavailable so the model leaves it
 * alone; a call it makes anyway is removed before the client sees it.
 */
import { Predicate } from "effect";
import { cloneJson, get, type Json, type JsonObject, tryParseJson } from "@commissary/json";
import { isArr, isObj } from "@commissary/translation";
import type { Config, OpenCodeProtocol } from "../../config/schema.ts";
import { isFreeModel, type OpenCodeCatalogModel } from "../../registry/opencode-catalog.ts";
import type { CredentialSnapshot } from "../picker.ts";
import { resolveOpenCodeKeyConfig } from "./protocol.ts";
import {
  CLOAK_MODE_ATTRIBUTE,
  openCodeCloakMode,
  type OpenCodeCloakMode,
  type OpenCodeProvider,
} from "./providers.ts";

/** Name of the tool Zen's free tier requires. */
export const STUB_TOOL_NAME = "read";

const STUB_TOOL: JsonObject = {
  type: "function",
  function: {
    name: STUB_TOOL_NAME,
    description: "Unavailable in this environment. Never call this tool.",
    parameters: { type: "object", properties: {} },
  },
};

/** The effective mode of an attempt's credential (its config key's `cloak.mode`, else the attribute). */
export const resolveOpenCodeCloakMode = (
  config: Config,
  credential: CredentialSnapshot,
  provider: OpenCodeProvider,
): OpenCodeCloakMode => {
  const configured = resolveOpenCodeKeyConfig(config, credential, provider)?.cloakMode;

  return openCodeCloakMode({
    provider,
    disabled: config.upstream.opencode["disable-cloaking"],
    mode: configured ?? credential.attributes[CLOAK_MODE_ATTRIBUTE],
  });
};

/** Whether an attempt is cloaked: chat protocol only, free catalog models in `auto`, every model in `always`. */
export const isCloakedRequest = (
  mode: OpenCodeCloakMode,
  protocol: OpenCodeProtocol,
  catalogModel: OpenCodeCatalogModel | undefined,
): boolean =>
  protocol === "chat" &&
  (mode === "always" ||
    (mode === "auto" && catalogModel !== undefined && isFreeModel(catalogModel)));

const toolName = (tool: Json): string | undefined => {
  const name = get(tool, "function.name");

  return Predicate.isString(name) ? name : undefined;
};

/** A cloaked Chat Completions body, and whether it carries the injected stub (whose calls are then removed). */
export interface CloakedChatBody {
  readonly body: Json;
  readonly stubInjected: boolean;
}

/**
 * The Chat Completions body of a cloaked attempt: `stream: true` (the translation copies the client's flag), and the
 * stub `read` tool appended when the client declares no `read` (a client without tools also gets
 * `tool_choice: "none"`).
 */
export const cloakChatBody = (body: Json): CloakedChatBody => {
  if (!isObj(body)) return { body, stubInjected: false };
  const tools = isArr(body.tools) ? body.tools : [];

  if (tools.some((tool) => toolName(tool) === STUB_TOOL_NAME))
    return { body: { ...body, stream: true }, stubInjected: false };
  const out: JsonObject = { ...body, stream: true, tools: [...tools, cloneJson(STUB_TOOL)] };

  if (tools.length === 0) out.tool_choice = "none";

  return { body: out, stubInjected: true };
};

/**
 * A non-stream `chat.completion` without the model's calls to the injected stub; a choice left without calls finishes
 * with `stop`.
 */
export const removeStubCalls = (completion: Json): Json => {
  if (!isObj(completion) || !isArr(completion.choices)) return completion;

  return {
    ...completion,
    choices: completion.choices.map((choice) => {
      if (!isObj(choice) || !isObj(choice.message) || !isArr(choice.message.tool_calls))
        return choice;
      const calls = choice.message.tool_calls.filter((call) => toolName(call) !== STUB_TOOL_NAME);

      if (calls.length === choice.message.tool_calls.length) return choice;
      const { tool_calls: _removed, ...message } = choice.message;

      return {
        ...choice,
        message: calls.length === 0 ? message : { ...message, tool_calls: calls },
        ...(calls.length === 0 && choice.finish_reason === "tool_calls"
          ? { finish_reason: "stop" }
          : {}),
      };
    }),
  };
};

/** Per-choice bookkeeping of the tool calls in a stream: stub indices and the client's renumbering. */
interface ChoiceCalls {
  readonly stub: Set<number>;
  readonly renumber: Map<number, number>;
}

/**
 * Removes the model's calls to the injected stub from upstream Chat Completions SSE lines (a call is recognised by the
 * delta that names it, the first one of its index; the client's own tool calls are renumbered to stay contiguous). A choice that only called the stub finishes with `stop`.
 */
export class StubCallFilter {
  readonly #choices = new Map<number, ChoiceCalls>();

  #choice(index: number): ChoiceCalls {
    let calls = this.#choices.get(index);

    if (calls === undefined) {
      calls = { stub: new Set(), renumber: new Map() };
      this.#choices.set(index, calls);
    }

    return calls;
  }

  /** Rewrites one choice in place; returns whether it changed. */
  #filterChoice(choice: JsonObject, delta: JsonObject | undefined): boolean {
    const calls = this.#choice(Predicate.isNumber(choice.index) ? choice.index : 0);
    let changed = false;

    if (delta !== undefined && isArr(delta.tool_calls)) {
      const kept: Json[] = [];

      for (const call of delta.tool_calls) {
        if (!isObj(call)) {
          kept.push(call);
          continue;
        }

        const index = Predicate.isNumber(call.index) ? call.index : 0;

        if (toolName(call) === STUB_TOOL_NAME) calls.stub.add(index);

        if (calls.stub.has(index)) {
          changed = true;
          continue;
        }

        let renumbered = calls.renumber.get(index);

        if (renumbered === undefined) {
          renumbered = calls.renumber.size;
          calls.renumber.set(index, renumbered);
        }

        if (renumbered !== index) changed = true;
        kept.push({ ...call, index: renumbered });
      }

      if (changed) {
        if (kept.length === 0) delete delta.tool_calls;
        else delta.tool_calls = kept;
      }
    }

    if (choice.finish_reason === "tool_calls" && calls.stub.size > 0 && calls.renumber.size === 0) {
      choice.finish_reason = "stop";
      changed = true;
    }

    return changed;
  }

  /** Filters one SSE line (without terminator); other lines pass unchanged. */
  push(line: string): string {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) return line;
    const payload = trimmed.slice(5).trim();
    const parsed = payload === "[DONE]" ? undefined : tryParseJson(payload);

    if (!isObj(parsed) || !isArr(parsed.choices)) return line;
    let changed = false;

    for (const choice of parsed.choices) {
      if (!isObj(choice)) continue;
      const delta = isObj(choice.delta) ? choice.delta : undefined;

      if (this.#filterChoice(choice, delta)) changed = true;
    }

    return changed ? `data: ${JSON.stringify(parsed)}` : line;
  }
}
