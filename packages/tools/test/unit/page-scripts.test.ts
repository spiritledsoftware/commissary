// The scripts a browser session runs in its pages (#216, `src/browser/page-scripts.ts`), run in a fake document: the
// input listener marks the fields a person types into, a React controlled input's included (its value kept equal to
// its default); the filled-field script names them and the changed ones, and only those, but every text field that is
// not empty in a frame without the listener; and a page's answer is taken only as a short list of short strings.
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  FILLED_FIELDS,
  filledSelectorsOf,
  MAX_FILLED_SELECTORS,
  MAX_SELECTOR_LENGTH,
  NONEMPTY_FIELDS,
  UNWATCH_INPUTS,
  WATCH_INPUTS,
} from "../../src/browser/page-scripts.ts";

interface FakeField {
  readonly tagName: string;
  readonly type: string;
  value: string;
  readonly defaultValue: string;
  readonly id: string;
  readonly attributes: Map<string, string>;
  readonly getAttribute: (name: string) => string | null;
  readonly hasAttribute: (name: string) => boolean;
  readonly setAttribute: (name: string, value: string) => void;
  readonly shadowRoot: null;
}

interface FieldOptions {
  readonly type?: string;
  readonly value?: string;
  readonly defaultValue?: string;
  readonly id?: string;
  readonly name?: string;
}

const fieldOf = (tagName: string, options: FieldOptions = {}): FakeField => {
  const { type = "text", value = "", id = "", name = "" } = options;
  const defaultValue = options.defaultValue ?? value;
  const attributes = new Map<string, string>(name === "" ? [] : [["name", name]]);

  return {
    tagName,
    type,
    value,
    defaultValue,
    id,
    attributes,
    getAttribute: (key) => attributes.get(key) ?? null,
    hasAttribute: (key) => attributes.has(key),
    setAttribute: (key, text) => void attributes.set(key, text),
    shadowRoot: null,
  };
};

/** An `input` event as the scripts read it. */
interface FakeInputEvent {
  readonly isTrusted: boolean;
  readonly target: FakeField;
  readonly composedPath: () => ReadonlyArray<FakeField>;
}

type Listener = (event: FakeInputEvent) => void;

/** A page of `fields`: its window, its document's capturing input listeners, and a script run in it. */
const pageOf = (fields: ReadonlyArray<FakeField>) => {
  const listeners: Array<Listener> = [];

  const document = {
    querySelectorAll: (selector: string) => (selector === "*" ? fields : []),
    addEventListener: (type: string, listener: Listener, capture: boolean) => {
      if (type === "input" && capture) listeners.push(listener);
    },
  };

  const context = { window: {}, document };

  return {
    /** Runs `script` in the page: its answer as a provider takes it (`filledSelectorsOf`), undefined when refused. */
    run: (script: string): ReadonlyArray<string> | undefined =>
      filledSelectorsOf([runInNewContext(script, context)]),
    /** An input event on `target`: a person's (trusted), or the page's own script's. */
    input: (target: FakeField, isTrusted = true) => {
      for (const listener of listeners)
        listener({ isTrusted, target, composedPath: () => [target] });
    },
    listeners,
  };
};

describe("the input listener", () => {
  it("marks a controlled field a person typed into, which comparing values misses", () => {
    const controlled = fieldOf("INPUT", { value: "", id: "password", type: "password" });
    const page = pageOf([controlled]);

    expect(page.run(FILLED_FIELDS)).toEqual([]);

    page.run(WATCH_INPUTS);
    // The person types; the page keeps the value equal to its default, as React's controlled inputs can.
    page.input(controlled);

    expect(controlled.value).toBe(controlled.defaultValue);
    expect(controlled.hasAttribute("data-commissary-typed")).toBe(true);
    expect(page.run(FILLED_FIELDS)).toEqual(["[data-commissary-filled]", 'input[id="password"]']);
  });

  it("marks a person's input only, once installed however often it is, and not after it stops", () => {
    const field = fieldOf("INPUT", { name: "user" });
    const scripted = fieldOf("INPUT", { name: "other" });
    const page = pageOf([field, scripted]);

    page.run(WATCH_INPUTS);
    page.run(WATCH_INPUTS);
    expect(page.listeners).toHaveLength(1);

    // The page's own script's input is no person's.
    page.input(scripted, false);
    expect(scripted.hasAttribute("data-commissary-typed")).toBe(false);

    page.run(UNWATCH_INPUTS);
    page.input(field);
    expect(field.hasAttribute("data-commissary-typed")).toBe(false);

    page.run(WATCH_INPUTS);
    page.input(field);
    expect(field.hasAttribute("data-commissary-typed")).toBe(true);
  });
});

describe("the filled-field scripts", () => {
  it("name the fields whose value changed, by id or name, and leave the rest and the buttons out", () => {
    const page = pageOf([
      fieldOf("INPUT", { value: "alice", defaultValue: "", name: "user" }),
      fieldOf("TEXTAREA", { value: "kept" }),
      fieldOf("INPUT", { type: "submit", value: "Go", defaultValue: "" }),
      fieldOf("INPUT", { value: "x", defaultValue: "", id: "has space" }),
    ]);

    page.run(WATCH_INPUTS);
    expect(page.run(FILLED_FIELDS)).toEqual(["[data-commissary-filled]", 'input[name="user"]']);
  });

  it("name every text field that is not empty in a frame the listener never reached, which fails closed", () => {
    const fields = () => [
      fieldOf("INPUT", { value: "typed-unseen", name: "search" }),
      fieldOf("INPUT", { value: "" }),
    ];

    const unarmed = pageOf(fields());

    expect(unarmed.run(FILLED_FIELDS)).toEqual([
      "[data-commissary-filled]",
      'input[name="search"]',
    ]);

    // The same frame with the listener names only what changed: nothing here.
    const armed = pageOf(fields());

    armed.run(WATCH_INPUTS);
    expect(armed.run(FILLED_FIELDS)).toEqual([]);
  });

  it("name every text field that is not empty when typing could not be marked", () => {
    const page = pageOf([
      fieldOf("INPUT", { value: "kept", name: "search" }),
      fieldOf("INPUT", { value: "" }),
      fieldOf("INPUT", { type: "checkbox", value: "on" }),
    ]);

    expect(page.run(NONEMPTY_FIELDS)).toEqual(["[data-commissary-filled]", 'input[name="search"]']);
  });
});

describe("a page's answer", () => {
  it("is taken as a list of strings without repeats, over every frame", () => {
    expect(filledSelectorsOf([["a", "b"], ["b"], []])).toEqual(["a", "b"]);
    expect(filledSelectorsOf([])).toEqual([]);
  });

  it("is refused when it is anything else, too long or too many", () => {
    expect(filledSelectorsOf([null])).toBeUndefined();
    expect(filledSelectorsOf(["input"])).toBeUndefined();
    expect(filledSelectorsOf([[1]])).toBeUndefined();
    expect(filledSelectorsOf([[{ toString: () => "input" }]])).toBeUndefined();
    expect(filledSelectorsOf([["x".repeat(MAX_SELECTOR_LENGTH + 1)]])).toBeUndefined();
    expect(
      filledSelectorsOf([
        Array.from({ length: MAX_FILLED_SELECTORS + 1 }, (_, index) => `#f${index}`),
      ]),
    ).toBeUndefined();
    expect(
      filledSelectorsOf([Array.from({ length: MAX_FILLED_SELECTORS }, (_, index) => `#f${index}`)]),
    ).toHaveLength(MAX_FILLED_SELECTORS);
  });
});
