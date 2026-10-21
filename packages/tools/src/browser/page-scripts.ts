/**
 * The scripts Commissary runs in a browser session's pages (#216): its own fixed code, taking no argument, which answers
 * CSS selectors only, never a field's value; and the check of what a page answered, as a hostile page may answer
 * anything. A browser provider runs them in every frame (Browser Run's adapter, `browser-run-sessions.ts`: the listener
 * in the session's current tab, the fields' scripts in every tab); they are kept here, apart from it, so that they are
 * tested in Node.js. They run in the page's own world, so a hostile page can defeat the marks: they keep the model from
 * reading what a person typed, not the page, which holds the value already.
 *
 * - {@link WATCH_INPUTS}, while a person may type in the tab (a handoff, or a Live View the session's member opened):
 *   a capturing `input` listener on the document that marks the target of every trusted input event (a person's typing,
 *   not the page's own script) with `data-commissary-typed`. It catches a field whose value the page keeps equal to its
 *   default (a React controlled input), which comparing values would miss. Installed in each frame's current document,
 *   and again in each new one while the watch lasts (the provider's on-new-document script).
 * - {@link UNWATCH_INPUTS}: the listener stops marking.
 * - {@link FILLED_FIELDS}: marks with `data-commissary-filled`, and names, every field the person typed into or whose
 *   value differs from its default, open shadow roots included; in a frame the listener never reached (a tab or a frame
 *   it was not installed in), every text field that is not empty, so that frame fails closed.
 * - {@link NONEMPTY_FIELDS}: the same for every text field that is not empty: what is masked when the listener could not
 *   be installed, so masking fails closed.
 */

/** The global that keeps a document's listener, so that it is installed once and switched on and off. */
const STATE = "__commissaryInputs";

/** Marks the targets of a person's input events in the document, from now on. */
export const WATCH_INPUTS = `(() => {
  const known = window["${STATE}"];
  if (known !== undefined && typeof known === "object" && known !== null) {
    known.on = true;
    return true;
  }
  const state = { on: true };
  Object.defineProperty(window, "${STATE}", { value: state });
  document.addEventListener("input", (event) => {
    if (!state.on || event.isTrusted !== true) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const target = path[0] ?? event.target;
    if (target !== null && typeof target === "object" && typeof target.setAttribute === "function")
      target.setAttribute("data-commissary-typed", "");
  }, true);
  return true;
})()`;

/** Stops marking a person's input in the document. */
export const UNWATCH_INPUTS = `(() => {
  const known = window["${STATE}"];
  if (known !== undefined && typeof known === "object" && known !== null) known.on = false;
  return true;
})()`;

/**
 * A script that marks and names the fields `condition` holds for: a fixed expression over `element`, `field` (it takes
 * text), `typed` (the listener marked it) and `armed` (the frame's document has the listener, on).
 */
const fieldsWhere = (condition: string) => `(() => {
  const known = window["${STATE}"];
  const armed = typeof known === "object" && known !== null && known.on === true;
  const skipped = new Set(["hidden", "submit", "button", "reset", "image", "checkbox", "radio", "file", "range", "color"]);
  const plain = (value) => typeof value === "string" && /^[A-Za-z][\\w.:-]{0,127}$/.test(value);
  const selectors = new Set();
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const tag = String(element.tagName).toLowerCase();
      const field = tag === "textarea" || (tag === "input" && !skipped.has(String(element.type).toLowerCase()));
      const typed = element.hasAttribute("data-commissary-typed");
      if (!(${condition})) continue;
      element.setAttribute("data-commissary-filled", "");
      selectors.add("[data-commissary-filled]");
      if (plain(element.id)) selectors.add(tag + '[id="' + element.id + '"]');
      else if (plain(element.getAttribute("name"))) selectors.add(tag + '[name="' + element.getAttribute("name") + '"]');
    }
  };
  visit(document);
  return [...selectors];
})()`;

/**
 * Marks and names the fields a person typed into, or whose value differs from its default; where the listener is not
 * installed, every text field that is not empty.
 */
export const FILLED_FIELDS = fieldsWhere(
  "typed || (field && (armed ? element.value !== element.defaultValue : " +
    'typeof element.value === "string" && element.value !== ""))',
);

/** Marks and names every text field that is not empty, and every field a person typed into. */
export const NONEMPTY_FIELDS = fieldsWhere(
  'typed || (field && typeof element.value === "string" && element.value !== "")',
);

/** The most selectors a page's answer may name, over all its frames. */
export const MAX_FILLED_SELECTORS = 64;

/** The longest selector a page's answer may name. */
export const MAX_SELECTOR_LENGTH = 256;

/**
 * The selectors the frames of a page answered ({@link FILLED_FIELDS}, {@link NONEMPTY_FIELDS}), without repeats, when
 * every answer is a list of strings, together at most {@link MAX_FILLED_SELECTORS} of at most
 * {@link MAX_SELECTOR_LENGTH} characters each; `undefined` for anything else, which the session treats as a failure
 * (it masks every text field).
 */
export const filledSelectorsOf = (
  answers: ReadonlyArray<unknown>,
): ReadonlyArray<string> | undefined => {
  const selectors = new Set<string>();

  for (const answer of answers) {
    if (!Array.isArray(answer)) return undefined;

    for (const selector of answer) {
      if (typeof selector !== "string" || selector.length > MAX_SELECTOR_LENGTH) return undefined;
      selectors.add(selector);
    }
  }

  return selectors.size > MAX_FILLED_SELECTORS ? undefined : [...selectors];
};
