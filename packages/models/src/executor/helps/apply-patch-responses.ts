/**
 * Executor-owned `apply_patch` Responses state for non-native executors (xAI, Kimi `/responses`, Meta) and the xAI
 * folded-dispatcher expansion.
 *
 * Go source: internal/runtime/executor/helps/apply_patch_responses.go (NormalizeApplyPatchResponsesRequest,
 * ApplyPatchResponsesState, patchDispatcherCall, preferChatFunctionPatchTools) on top of the common bridge
 * (`translator/common/apply-patch-responses.ts`).
 *
 * The state is owned explicitly by a non-native executor, never inferred from the wire format or a configured function
 * schema; supporting state stays request-local. xAI folds large namespace tools into one dispatcher function whose
 * arguments are `{"name": <child>, "arguments": <child arguments>}`: `addDispatcher` marks the folded namespaces that
 * hold a winning custom patch, `rememberDispatcherEvent` keeps the upstream evidence before namespace restoration, and
 * `transform` expands the dispatcher envelope into the child call before the common bridge sees it.
 */
import {
  asInt,
  asString,
  cloneJson,
  get,
  isJsonArray,
  type Json,
  set,
  tryParseJson,
} from "@commissary/json";
import {
  isApplyPatchCustomTool,
  unwrapApplyPatchInput,
  ApplyPatchResponsesBridge,
  normalizeApplyPatchResponsesRequest,
  collectResponsesToolWinners,
  qualifyResponsesNamespaceToolName,
  type ResponsesToolDescriptor,
} from "@commissary/translation";
import type { Format } from "@commissary/translation/formats";

/** `ApplyPatchUpstreamErrorMessage`: deliberately excludes upstream JSON and patch text. */
export const APPLY_PATCH_UPSTREAM_ERROR_MESSAGE =
  "Invalid apply_patch tool arguments received from upstream.";

const str = (value: Json | undefined, path: string): string => asString(get(value, path));

/** `preferChatFunctionPatchTools`: an ordinary Chat function named like the patch tool keeps winning. */
export const preferChatFunctionPatchTools = (
  original: Json | undefined,
  declarations: Json,
): Json => {
  const ordinary = new Set<string>();
  const originalTools = get(original, "tools");

  if (isJsonArray(originalTools)) {
    for (const tool of originalTools)
      if (str(tool, "type") === "function") ordinary.add(str(tool, "function.name"));
  }

  if (ordinary.size === 0) return declarations;
  const declared = get(declarations, "tools");
  const declaredTools = isJsonArray(declared) ? declared : [];
  const available = new Set<string>();

  for (const tool of declaredTools)
    if (str(tool, "type") === "function") available.add(str(tool, "name"));

  const tools = declaredTools.filter((tool) => {
    const name = str(tool, "name");

    return !(isApplyPatchCustomTool(tool) && ordinary.has(name) && available.has(name));
  });

  const out = cloneJson(declarations);
  set(out, "tools", cloneJson(tools));

  return out;
};

/** `helps.NormalizeApplyPatchResponsesRequest`: opts a non-Codex executor into the patch contract. Throws on bad history. */
export const normalizeApplyPatchResponses = (body: Json, original?: Json): Json =>
  normalizeApplyPatchResponsesRequest(
    original === undefined ? body : preferChatFunctionPatchTools(original, body),
  );

interface DispatcherCall {
  namespace: string;
  events: Json[];
  snapshots: Json[];
  source: string;
  originals: Json[];
  completed: boolean;
  ordinary: boolean;
  index: number;
  name: string;
  arguments: string;
}

export interface StateResult {
  readonly events: Json[];
  readonly error?: Error | undefined;
}

export interface StreamLinesResult {
  readonly lines: string[];
  readonly error?: Error | undefined;
}

const dispatcherKeys = (root: Json): string[] => {
  const keys: string[] = [];

  for (const path of ["item.id", "item_id"]) {
    const id = str(root, path);

    if (id !== "") keys.push(`item:${id}`);
  }

  for (const path of ["item.call_id", "call_id"]) {
    const id = str(root, path);

    if (id !== "") keys.push(`call:${id}`);
  }

  const index = get(root, "output_index");

  if (index !== undefined) keys.push(`index:${asInt(index)}`);

  return keys;
};

/** `patchDispatcherArguments`: a wrapper's `arguments` as text (strings as is, other values as raw JSON). */
const patchDispatcherArguments = (wrapper: Json | undefined): string => {
  const args = get(wrapper, "arguments");

  if (typeof args === "string") return args;

  return args === undefined ? "" : JSON.stringify(args);
};

const dispatcherEventName = (root: Json): string =>
  get(root, "item") !== undefined ? str(root, "item.name") : str(root, "name");

const sameJson = (left: Json | undefined, right: Json | undefined): boolean =>
  left === right ||
  (left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right));

const isDone = (event: Json | undefined): boolean =>
  typeof event === "string" && event.trim() === "[DONE]";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

const CUSTOM_INPUT_PREFIX = "response.custom_tool_call_input.";

export class ApplyPatchResponsesState {
  readonly bridge: ApplyPatchResponsesBridge;
  readonly #tools: Map<string, ResponsesToolDescriptor>;
  readonly #dispatchers = new Map<string, string>();
  #byDispatcherKey = new Map<string, DispatcherCall>();
  #records: DispatcherCall[] = [];
  #upstream: Json | undefined;
  #eventLine: string | undefined;
  #active = false;
  #failed = false;
  /** The upstream emitted a custom apply_patch call (Go 949b43b3 `sawPatch`). */
  #sawPatch = false;
  #closed = false;
  #transportDone = false;

  /** `NewApplyPatchResponsesState`: `declarations` are resolved before any normalisation. */
  constructor(source: Format, original: Json | undefined, declarations: Json | undefined) {
    let declared = declarations;

    if (source === "openai" && declared !== undefined)
      declared = preferChatFunctionPatchTools(original, declared);
    this.bridge = new ApplyPatchResponsesBridge(declared);
    this.#tools = collectResponsesToolWinners(declared);

    for (const descriptor of this.#tools.values())
      if (isApplyPatchCustomTool(descriptor.tool)) this.#active = true;
  }

  /** Whether this explicitly non-native state owns a winning patch declaration. */
  get active(): boolean {
    return this.#active;
  }

  /** `AddDispatcher`: marks only xAI folded namespaces that contain a winning custom patch. */
  addDispatcher(name: string, namespace: string): void {
    for (const descriptor of this.#tools.values()) {
      if (descriptor.namespace === namespace && isApplyPatchCustomTool(descriptor.tool)) {
        this.#dispatchers.set(name, namespace);

        return;
      }
    }
  }

  #dispatcher(root: Json): DispatcherCall | undefined {
    const matched = new Set<DispatcherCall>();

    for (const key of dispatcherKeys(root)) {
      const call = this.#byDispatcherKey.get(key);

      if (call !== undefined) matched.add(call);
    }

    return this.#records.find((call) => matched.has(call));
  }

  #newCandidate(root: Json): DispatcherCall {
    const call: DispatcherCall = {
      namespace: "",
      events: [],
      snapshots: [],
      source: "",
      originals: [],
      completed: false,
      ordinary: false,
      index: -1,
      name: "",
      arguments: "",
    };

    this.#records.push(call);

    for (const key of dispatcherKeys(root))
      if (!this.#byDispatcherKey.has(key)) this.#byDispatcherKey.set(key, call);

    return call;
  }

  /**
   * `RememberDispatcherEvent`: retains upstream evidence before namespace restoration. A wrapper alone never proves
   * dispatcher provenance: only a declared dispatcher name does.
   */
  rememberDispatcherEvent(event: Json): void {
    if (this.#failed || this.#closed || this.#transportDone || this.#dispatchers.size === 0) return;
    this.#upstream = cloneJson(event);
    this.rememberDispatcherArguments(event);
  }

  /** `RememberDispatcherArguments`: keeps full snapshots on every matched candidate, including unnamed calls. */
  rememberDispatcherArguments(event: Json): void {
    if (
      this.#failed ||
      this.#closed ||
      this.#transportDone ||
      this.#dispatchers.size === 0 ||
      str(event, "type") !== "response.function_call_arguments.done"
    ) {
      return;
    }

    this.#upstream = cloneJson(event);

    if (this.#dispatcher(event) === undefined) this.#newCandidate(event);
    const seen = new Set<DispatcherCall>();

    for (const key of dispatcherKeys(event)) {
      const call = this.#byDispatcherKey.get(key);

      if (call !== undefined && !seen.has(call)) {
        call.snapshots.push(cloneJson(event));
        seen.add(call);
      }
    }
  }

  /** `expandDispatcher`: the dispatcher envelope becomes the child call (throws on conflicting evidence). */
  #expandDispatcher(input: Json, original: Json): Json[] {
    const root = input;
    const kind = str(root, "type");
    let call = this.#dispatcher(root);
    let name = dispatcherEventName(original);
    const namespace = this.#dispatchers.get(name);
    const declared = namespace !== undefined;

    if (call === undefined && this.#dispatchers.size > 0) {
      const added =
        kind === "response.output_item.added" && str(original, "item.type") === "function_call";

      if (
        (declared && str(original, "item.type") === "function_call") ||
        added ||
        kind === "response.function_call_arguments.delta" ||
        kind === "response.function_call_arguments.done"
      ) {
        call = this.#newCandidate(root);
      }
    }

    if (call === undefined) return [input];
    const identityError = this.bridge.checkIdentity(input);

    if (identityError !== undefined) throw identityError;

    for (const key of dispatcherKeys(root))
      if (!this.#byDispatcherKey.has(key)) this.#byDispatcherKey.set(key, call);

    if (call.index < 0 && get(root, "output_index") !== undefined)
      call.index = asInt(get(root, "output_index"));

    if (call.ordinary && !declared) return [input];
    call.events.push(cloneJson(input));
    call.originals.push(cloneJson(original));

    if (declared) {
      if (call.namespace !== "" && call.namespace !== namespace) {
        throw new Error("conflicting apply_patch dispatcher namespace");
      }

      call.namespace = namespace;
      call.ordinary = false;
    }

    if (kind === "response.function_call_arguments.delta") {
      if (call.completed && str(root, "delta") !== "") {
        const child = this.#tools.get(qualifyResponsesNamespaceToolName(call.namespace, call.name));

        if (child !== undefined && isApplyPatchCustomTool(child.tool)) {
          throw new Error("apply_patch dispatcher arguments received after completion");
        }

        return [input];
      }

      call.source += str(root, "delta");
    }

    if (call.namespace === "") {
      if (name !== "") {
        // A late ordinary name releases untouched arguments, even if they look like a wrapper.
        call.ordinary = true;
        const events = call.events;
        call.events = [];
        call.originals = [];

        return events;
      }

      return [];
    }

    if (kind === "response.function_call_arguments.delta" && !call.completed) return [];

    if (
      kind !== "response.output_item.done" &&
      !(
        call.completed &&
        (kind === "response.function_call_arguments.done" ||
          kind === "response.function_call_arguments.delta" ||
          kind === "response.output_item.added")
      )
    ) {
      return [];
    }

    const path =
      kind === "response.function_call_arguments.done" ||
      kind === "response.function_call_arguments.delta"
        ? ""
        : "item.";

    let event = cloneJson(input);
    const wrappers: string[] = [];

    if (call.source !== "") wrappers.push(call.source);

    for (const snapshot of call.snapshots) {
      const args = str(snapshot, "arguments");

      if (get(tryParseJson(args), "name") !== undefined) wrappers.push(args);
    }

    for (const pending of call.originals) {
      const args = str(pending, "item.arguments");
      const pendingName = dispatcherEventName(pending);

      if (
        (pendingName === "" || this.#dispatchers.get(pendingName) === call.namespace) &&
        get(tryParseJson(args), "name") !== undefined
      ) {
        wrappers.push(args);
      }
    }

    // For callers without a pre-restoration copy, retain the original full-source contract.
    if (wrappers.length === 0) {
      for (const pending of call.events) {
        const args = str(pending, "arguments");

        if (str(tryParseJson(args), "name") !== "") wrappers.push(args);
      }
    }

    let source: Json | undefined;

    for (const wrapper of wrappers) {
      const parsed = tryParseJson(wrapper);

      if (parsed !== undefined && str(parsed, "name") !== "") source = parsed;
    }

    name = str(event, `${path}name`);

    if (name === "" || this.#dispatchers.get(name) === call.namespace) {
      name = str(source, "name");

      if (name === "") name = call.name;
      set(event, `${path}name`, name);
      set(event, `${path}namespace`, call.namespace);
    }

    if (str(root, `${path}namespace`) === "") set(event, `${path}namespace`, call.namespace);

    if (
      declared ||
      dispatcherEventName(original) === "" ||
      kind === "response.function_call_arguments.done"
    ) {
      const wrapper = tryParseJson(str(original, `${path}arguments`));

      if (str(wrapper, "name") !== "")
        set(event, `${path}arguments`, patchDispatcherArguments(wrapper));
    }

    if (get(root, `${path}arguments`) === undefined) {
      let encoded = patchDispatcherArguments(source);

      if (encoded === "") encoded = call.arguments;

      if (encoded !== "") set(event, `${path}arguments`, encoded);
    }

    const current = event;
    call.events[call.events.length - 1] = cloneJson(current);
    const descriptor = this.#tools.get(qualifyResponsesNamespaceToolName(call.namespace, name));
    const patch = descriptor !== undefined && isApplyPatchCustomTool(descriptor.tool);
    let finalArguments = str(current, `${path}arguments`);

    if (kind === "response.output_item.added" && finalArguments === "")
      finalArguments = call.arguments;

    if (patch) {
      for (const snapshot of call.snapshots) {
        if (typeof get(snapshot, "arguments") !== "string") {
          throw new Error("apply_patch dispatcher arguments snapshot must be a string");
        }
      }
    }

    for (const wrapperRaw of wrappers) {
      const wrapper = tryParseJson(wrapperRaw);

      const child = this.#tools.get(
        qualifyResponsesNamespaceToolName(call.namespace, str(wrapper, "name")),
      );

      if (!patch && !(child !== undefined && isApplyPatchCustomTool(child.tool))) continue;
      const unwrapped = unwrapApplyPatchInput(patchDispatcherArguments(wrapper));
      const final = unwrapApplyPatchInput(finalArguments);

      if (
        wrapper === undefined ||
        str(wrapper, "name") !== name ||
        "error" in unwrapped ||
        "error" in final ||
        unwrapped.input !== final.input
      ) {
        throw new Error("conflicting apply_patch dispatcher arguments");
      }
    }

    // Retain completed aliases and source evidence until the response actually closes. Repeated snapshots validate
    // only the new event, never replay completed progress.
    const start = call.completed ? call.events.length - 1 : 0;
    const out: Json[] = [];

    for (let i = start; i < call.events.length; i++) {
      const p = call.events[i];
      const originalRoot = call.originals[i];

      if (p === undefined || originalRoot === undefined) continue;
      const pending = cloneJson(p);

      if (patch) {
        for (const namespacePath of ["namespace", "item.namespace"]) {
          const supplied = str(originalRoot, namespacePath);

          if (supplied !== "" && supplied !== call.namespace) {
            throw new Error("conflicting apply_patch dispatcher namespace");
          }
        }

        for (const supplied of [dispatcherEventName(originalRoot), dispatcherEventName(p)]) {
          if (
            supplied !== "" &&
            this.#dispatchers.get(supplied) !== call.namespace &&
            qualifyResponsesNamespaceToolName(call.namespace, supplied) !== (descriptor?.name ?? "")
          ) {
            throw new Error("conflicting apply_patch dispatcher child");
          }
        }
      }

      let pendingPath = "";

      switch (str(p, "type")) {
        case "response.function_call_arguments.delta":
          // A dispatcher envelope is not incremental child input.
          if (patch) continue;
          break;
        case "response.output_item.added":
        case "response.output_item.done":
          pendingPath = "item.";
          break;
        case "response.function_call_arguments.done":
          pendingPath = "";
          break;
        default:
          out.push(pending);
          continue;
      }

      if (str(p, "type") !== "response.function_call_arguments.delta") {
        const pendingName = str(p, `${pendingPath}name`);

        if (pendingName === "" || this.#dispatchers.get(pendingName) === call.namespace) {
          set(pending, `${pendingPath}name`, name);
          set(pending, `${pendingPath}namespace`, call.namespace);
        }

        if (str(p, `${pendingPath}namespace`) === "")
          set(pending, `${pendingPath}namespace`, call.namespace);
        // Only actual upstream wrappers are unwrapped, not restored child contents.
        const args = get(originalRoot, `${pendingPath}arguments`);

        if (patch && args !== undefined && typeof args !== "string") {
          throw new Error("apply_patch dispatcher arguments snapshot must be a string");
        }

        const argsText = asString(args);

        if (
          argsText !== "" &&
          (dispatcherEventName(originalRoot) === "" ||
            this.#dispatchers.get(dispatcherEventName(originalRoot)) === call.namespace ||
            pendingPath === "")
        ) {
          const wrapper = tryParseJson(argsText);

          if (str(wrapper, "name") !== "") {
            if (patch && str(wrapper, "name") !== name) {
              throw new Error("conflicting apply_patch dispatcher snapshot");
            }

            set(pending, `${pendingPath}arguments`, patchDispatcherArguments(wrapper));
          }
        }
      }

      out.push(pending);
    }

    call.completed = true;
    call.name = name;
    call.arguments = finalArguments;

    return out;
  }

  #unfinishedDispatcher(): boolean {
    return this.#records.some((call) => call.namespace !== "" && !call.completed);
  }

  #reset(): void {
    this.#byDispatcherKey = new Map();
    this.#records = [];
    this.#upstream = undefined;
  }

  #fail(error: Error): StateResult {
    if (this.#failed) return { events: [], error };
    this.#failed = true;
    this.#reset();

    return this.bridge.fail(error);
  }

  /** `Transform`: one JSON event (or the literal string `"[DONE]"`) becomes the events to forward. */
  transform(event: Json): StateResult {
    if (this.#failed || this.#transportDone) return { events: [] };

    if (this.#active && isDone(event)) {
      const finished = this.finish();

      if (finished !== undefined) return this.#fail(finished);
      this.#transportDone = true;

      return { events: [event] };
    }

    if (this.#closed) return { events: [] };
    const original = this.#upstream ?? event;
    this.#upstream = undefined;
    const preceding: Json[] = [];
    const kind = str(event, "type");
    let current = event;

    if (
      kind === "response.completed" ||
      kind === "response.incomplete" ||
      kind === "response.done"
    ) {
      const originalOutput = get(original, "response.output");
      const originalItems = isJsonArray(originalOutput) ? originalOutput : [];
      const output = get(event, "response.output");
      const items = isJsonArray(output) ? output : [];

      for (const [i, item] of items.entries()) {
        const done: Json = { type: "response.output_item.done", item: cloneJson(item) };
        // Explicit ids take priority over array position in a sparse terminal snapshot.
        let call = this.#dispatcher(done);

        if (call === undefined && str(item, "id") === "" && str(item, "call_id") === "") {
          set(done, "output_index", i);
          call = this.#dispatcher(done);
        }

        if (call === undefined || call.ordinary) continue;
        set(done, "output_index", call.index >= 0 ? call.index : i);
        let originalDone = done;

        // Filtering may shift array positions, but restoration preserves both ids.
        const matches = (candidate: Json): boolean =>
          str(candidate, "id") === str(item, "id") &&
          str(candidate, "call_id") === str(item, "call_id");

        const positional = originalItems[i];

        if (positional !== undefined && matches(positional)) {
          originalDone = cloneJson(done);
          set(originalDone, "item", cloneJson(positional));
        } else if (str(item, "id") !== "" || str(item, "call_id") !== "") {
          const found = originalItems.find(matches);

          if (found !== undefined) {
            originalDone = cloneJson(done);
            set(originalDone, "item", cloneJson(found));
          }
        }

        let events: Json[];

        try {
          events = this.#expandDispatcher(done, originalDone);
        } catch (error) {
          return this.#fail(toError(error));
        }

        preceding.push(...events);
        const last = events[events.length - 1];
        const restored = last === undefined ? undefined : get(last, "item");

        if (restored !== undefined) {
          if (current === event) current = cloneJson(event);
          set(current, `response.output.${i}`, cloneJson(restored));
        }
      }

      if (this.#unfinishedDispatcher()) {
        return this.#fail(
          new Error("incomplete apply_patch namespace dispatcher received from upstream"),
        );
      }

      // Unproven candidates remain ordinary; let common resolve or flush their evidence.
      for (const call of this.#records) {
        if (call.namespace === "" && !call.ordinary) {
          preceding.push(...call.events);
          call.events = [];
        }
      }
    }

    let expanded: Json[];

    try {
      expanded = this.#expandDispatcher(current, original);
    } catch (error) {
      return this.#fail(toError(error));
    }

    const events = [...preceding, ...expanded];
    const out: Json[] = [];

    for (const candidate of events) {
      if (this.#isCustomPatchEvent(candidate)) this.#sawPatch = true;
      const converted = this.bridge.transform(candidate);

      if (
        !this.#sawPatch &&
        !str(candidate, "type").startsWith(CUSTOM_INPUT_PREFIX) &&
        converted.events.some((event) => str(event, "type").startsWith(CUSTOM_INPUT_PREFIX))
      )
        this.#sawPatch = true;
      out.push(...converted.events);

      if (converted.error !== undefined) {
        this.#failed = true;
        this.#sawPatch = true;
        this.#reset();

        return { events: out, error: converted.error };
      }
    }

    if (
      kind === "response.completed" ||
      kind === "response.incomplete" ||
      kind === "response.done" ||
      kind === "response.failed"
    ) {
      this.#closed = true;
      this.#reset();
    }

    return { events: out };
  }

  /** `isCustomPatchEvent`: the event names a declared custom apply_patch tool (not an already-custom call). */
  #isCustomPatchEvent(event: Json): boolean {
    if (!this.#active) return false;
    const item = get(event, "item");

    const isPatch = (namespace: string, name: string): boolean => {
      const descriptor = this.#tools.get(qualifyResponsesNamespaceToolName(namespace, name));

      return descriptor !== undefined && isApplyPatchCustomTool(descriptor.tool);
    };

    if (item !== undefined) {
      if (str(item, "type") === "custom_tool_call") return false;

      return isPatch(str(item, "namespace"), str(item, "name"));
    }

    const name = str(event, "name");

    return name !== "" && isPatch(str(event, "namespace"), name);
  }

  /**
   * `HasPatchActivity` (Go 949b43b3): the upstream emitted a custom apply_patch call or left a patch namespace dispatcher
   * unfinished, so an unclosed response is an apply_patch failure rather than an empty or incomplete stream.
   */
  hasPatchActivity(): boolean {
    if (!this.#active) return false;

    if (this.#failed || this.#sawPatch || this.#unfinishedDispatcher()) return true;

    return this.bridge.finish() !== undefined;
  }

  /**
   * `Finish`: validates source response closure independently of completed tool input. The common `finish` stays
   * argument-only because it also runs inside terminal conversion.
   */
  finish(): Error | undefined {
    const bridgeError = this.bridge.finish();

    if (bridgeError !== undefined) return bridgeError;

    if (this.#closed || !this.#active) return undefined;

    if (this.#unfinishedDispatcher())
      return new Error("incomplete apply_patch namespace dispatcher received from upstream");

    return new Error("incomplete apply_patch source response received from upstream");
  }

  /**
   * `Stream`: one SSE line at a time, preserving framing and updating `event:` lines to match converted JSON. A
   * premature `[DONE]` is checked before any success marker is published.
   */
  stream(line: string): StreamLinesResult {
    if (!this.#active) return { lines: [line] };

    if (this.#failed || this.#transportDone) return { lines: [] };

    if (line.startsWith("event:")) {
      this.#eventLine = line;

      return { lines: [] };
    }

    if (!line.startsWith("data:")) return { lines: [line] };
    const payload = line.slice(5).trim();
    let result: StateResult;
    let parsed: Json | undefined;

    if (payload === "[DONE]") {
      const finished = this.finish();

      if (finished === undefined) {
        // JSON completion and transport completion are separate boundaries.
        this.#transportDone = true;
        this.#reset();
        this.#eventLine = undefined;

        return { lines: [line] };
      }

      result = this.#fail(finished);
    } else {
      parsed = tryParseJson(payload);
      result = parsed === undefined ? { events: [payload] } : this.transform(parsed);
    }

    const events = result.events;
    const eventLine = this.#eventLine;

    if (
      events.length === 1 &&
      result.error === undefined &&
      (parsed === undefined ? events[0] === payload : sameJson(events[0], parsed))
    ) {
      this.#eventLine = undefined;

      return { lines: eventLine !== undefined ? [eventLine, line] : [line] };
    }

    const lines: string[] = [];

    for (const event of events) {
      if (eventLine !== undefined) {
        lines.push(sameJson(event, parsed) ? eventLine : `event: ${str(event, "type")}`);
      }

      lines.push(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
    }

    this.#eventLine = undefined;

    return { lines, error: result.error };
  }

  /** `FinishStream`: emits the local failure once on EOF without a validated completion. */
  finishStream(): StreamLinesResult {
    if (this.#failed || this.#transportDone) return { lines: [] };
    const finished = this.finish();

    if (finished === undefined) return { lines: [] };
    const failure = this.#fail(finished);

    return {
      lines: failure.events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
      error: failure.error,
    };
  }
}
