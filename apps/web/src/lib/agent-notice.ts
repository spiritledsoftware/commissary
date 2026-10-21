// The notice on an unattended agent (#233, ADR 0044, `docs/THREAT-MODEL.md`): a hosted agent with a schedule or webhook
// trigger starts runs no person is watching, and a steered run (a webhook body can steer it) can call write tools that
// nothing asks to approve. Commissary does not force approvals (ADR 0038), so the panel says so: for each toolkit of the
// agent's tool scope, how many write tools it gives that no approval rule covers. Pure: no DOM, tested in
// test/agent-notice.test.ts.
import type { ToolScope } from "@commissary/contract/api-keys";
import type { ConfiguredTriggerKind } from "@commissary/contract/agent-triggers";
import type { ToolClass, ToolkitView, ToolView } from "@commissary/contract/tools";
import { isServed } from "./approval-rules.ts";

/** The trigger kinds that start a run with no one there (the chat and MCP kinds always have someone). */
const UNATTENDED: ReadonlyArray<ConfiguredTriggerKind> = ["schedule", "webhook"];

/** The part of a trigger the notice looks at. */
export interface TriggerLike {
  readonly kind: ConfiguredTriggerKind;
  readonly enabled: boolean;
}

/** Whether a trigger starts runs unattended: an enabled schedule or webhook (a disabled one starts nothing). */
export const startsUnattended = (trigger: TriggerLike): boolean =>
  trigger.enabled && UNATTENDED.includes(trigger.kind);

/** The part of a tool the notice looks at: its stable id and its class. */
export interface ToolLike {
  readonly id: string;
  readonly class: ToolClass;
}

/** The tools a toolkit serves, as the notice reads them: a hidden, missing or shadowed tool is one no client can call. */
export const servedTools = (
  tools: ReadonlyArray<Pick<ToolView, "id" | "class" | "flags">>,
): ReadonlyArray<ToolLike> =>
  tools.flatMap((tool) => (isServed(tool) ? [{ id: tool.id, class: tool.class }] : []));

/** What one toolkit of the scope gives without approval. */
export interface UncoveredToolkit {
  readonly toolkit: string;
  readonly name: string;
  /** The write tools of the scope in this toolkit that no approval rule covers. */
  readonly tools: ReadonlyArray<string>;
}

/**
 * Whether an approval rule covers a tool: the toolkit's "write tools require approval" covers every tool whose class is
 * write; a mark on the tool covers it, whatever its class (a mark wins over the toolkit-wide rule, ADR 0038).
 */
export const covered = (rules: ToolkitView["approval_rules"], tool: ToolLike): boolean =>
  rules?.tools?.some((mark) => mark.id === tool.id) === true ||
  (rules?.writes !== undefined && tool.class === "write");

/** The tools of a toolkit that a scope entry gives, from the toolkit's tool list. */
const given = (
  selection: ToolScope[number]["tools"],
  tools: ReadonlyArray<ToolLike>,
): ReadonlyArray<ToolLike> => {
  switch (selection.kind) {
    case "all":
      return tools;
    case "read":
      return tools.filter((tool) => tool.class === "read");
    case "named":
      return tools.filter((tool) => selection.ids.includes(tool.id));
  }
};

/**
 * The toolkits of `scope` that give write tools no approval rule covers. `listed` answers a toolkit's tool list, or
 * `undefined` while it has not loaded (that toolkit is left out until it has); `toolkits` are the toolkits as the
 * caller sees them, for names and approval rules (a toolkit that is no longer there gives nothing).
 */
export const uncoveredWrites = (
  scope: ToolScope,
  toolkits: ReadonlyArray<Pick<ToolkitView, "id" | "name" | "approval_rules">>,
  listed: (toolkit: string) => ReadonlyArray<ToolLike> | undefined,
): ReadonlyArray<UncoveredToolkit> =>
  scope.flatMap((entry) => {
    const toolkit = toolkits.find((each) => each.id === entry.toolkit);
    const tools = listed(entry.toolkit);

    if (toolkit === undefined || tools === undefined) return [];

    const open = given(entry.tools, tools).filter(
      (tool) => tool.class === "write" && !covered(toolkit.approval_rules, tool),
    );

    return open.length === 0
      ? []
      : [{ toolkit: toolkit.id, name: toolkit.name, tools: open.map((tool) => tool.id) }];
  });

/** The notice: which toolkits give write tools unattended, and which trigger kinds start runs unattended. */
export interface UnattendedNotice {
  readonly kinds: ReadonlyArray<ConfiguredTriggerKind>;
  readonly toolkits: ReadonlyArray<UncoveredToolkit>;
}

/**
 * The notice an agent shows, or `undefined`: it needs an enabled schedule or webhook trigger and a write tool in its tool
 * scope with no approval rule on it. It goes away once those tools are under a rule, or with no such trigger.
 */
export const unattendedNotice = (
  triggers: ReadonlyArray<TriggerLike>,
  uncovered: ReadonlyArray<UncoveredToolkit>,
): UnattendedNotice | undefined => {
  const kinds = UNATTENDED.filter((kind) =>
    triggers.some((trigger) => trigger.kind === kind && startsUnattended(trigger)),
  );

  return kinds.length === 0 || uncovered.length === 0 ? undefined : { kinds, toolkits: uncovered };
};

const KIND_WORDS: Readonly<Record<ConfiguredTriggerKind, string>> = {
  schedule: "schedule",
  webhook: "webhook",
};

/** "a schedule", "a webhook", "a schedule or a webhook". */
export const kindsText = (kinds: ReadonlyArray<ConfiguredTriggerKind>): string =>
  kinds.map((kind) => `a ${KIND_WORDS[kind]}`).join(" and ");

/** "3 write tools", "1 write tool". */
export const writeToolsText = (count: number): string =>
  count === 1 ? "1 write tool" : `${count} write tools`;
