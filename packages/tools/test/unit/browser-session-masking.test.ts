// A browser session's snapshot masking (#213) over Playwright's rendering of a snapshot for a model (`renderAriaTree`):
// on a page where some element matches a masked selector, the value of each element that matches one, whatever its
// role, on its line or in its `- text:` lines, in any frame (refs `f1e3`), however Playwright quoted its key; elements
// without a ref are masked whatever they are, and nothing else is touched. A page without any such element is shown as
// it is.
//
// `test/fixtures/sign-in-snapshot-1.3.6.yaml` is a sign-in page as `@cloudflare/playwright` 1.3.6 renders it
// (`_snapshotForAI`'s `full`), written by hand after its `renderAriaTree` and `snapshotFrameForAI`; the `.masked.yaml`
// beside it is what the session shows. Masking reads a rendering Playwright keeps internal: when the package is
// upgraded, capture the page's snapshot with the new version (a password field with and without a placeholder, an
// iframe, a field without a ref) and check it against these (docs/ARCHITECTURE.md "Tools").
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { BrowserProviderError, type BrowserTab } from "../../src/browser/provider.ts";
import { MASK, maskSnapshot, PASSWORD_FIELDS } from "../../src/browser/session.ts";

const unused = () => Effect.die("not used");

const SELECTOR = `${PASSWORD_FIELDS}, #otp`;

/**
 * A tab whose elements `masked` names match the masked selectors, and on which `count` elements match them; it
 * records which refs it was asked about.
 */
const tabMasking = (masked: ReadonlyArray<string>, count = masked.length) => {
  const asked: Array<[ReadonlyArray<string>, string]> = [];

  const tab: BrowserTab = {
    url: () => "https://example.com/",
    title: unused,
    goto: unused,
    back: unused,
    forward: unused,
    snapshot: unused,
    countMatching: () => Effect.succeed(count),
    maskedRefs: (refs, selector) =>
      Effect.sync(() => {
        asked.push([refs, selector]);

        return new Set(refs.filter((ref) => masked.includes(ref)));
      }),
    click: unused,
    fill: unused,
    press: unused,
    selectOption: unused,
    hover: unused,
    waitFor: unused,
    screenshot: unused,
    focus: unused,
    handoff: unused,
    handoffActive: unused,
    endHandoff: unused,
    liveView: unused,
    watchInputs: unused,
    unwatchInputs: unused,
    filledFields: unused,
  };

  return { tab, asked };
};

const mask = (snapshot: ReadonlyArray<string>, masked: ReadonlyArray<string>, count?: number) => {
  const { tab, asked } = tabMasking(masked, count);

  return Effect.map(maskSnapshot(tab, snapshot.join("\n"), [PASSWORD_FIELDS, "#otp"]), (text) => ({
    lines: text.split("\n"),
    asked,
  }));
};

const fixture = (name: string) =>
  readFileSync(`${import.meta.dirname}/../fixtures/${name}`, "utf8");

describe("a session's snapshot masking", () => {
  it.effect("replaces the value of a masked field, on its line or in its text lines", () =>
    Effect.gen(function* () {
      const { lines, asked } = yield* mask(
        [
          "- generic [ref=e1]:",
          '  - textbox "Username" [ref=e2]: alice',
          '  - textbox "Password" [ref=e3]: hunter2',
          '  - textbox "Password again" [ref=e4] [cursor=pointer]:',
          "    - /placeholder: Repeat it",
          "    - text: hunter2",
          '  - button "Sign in" [ref=e5]: "hunter2"',
        ],
        ["e3", "e4"],
      );

      expect(lines).toEqual([
        "- generic [ref=e1]:",
        '  - textbox "Username" [ref=e2]: alice',
        `  - textbox "Password" [ref=e3]: ${MASK}`,
        '  - textbox "Password again" [ref=e4] [cursor=pointer]:',
        "    - /placeholder: Repeat it",
        `    - text: ${MASK}`,
        '  - button "Sign in" [ref=e5]: "hunter2"',
      ]);
      // Every element that shows a value, asked at once with every masked selector.
      expect(asked).toEqual([[["e2", "e3", "e4", "e5"], SELECTOR]]);
    }),
  );

  it.effect(
    "masks an element that matches whatever its role, as an input of another role shows its value",
    () =>
      Effect.gen(function* () {
        const { lines } = yield* mask(
          [
            '- button "Show" [ref=e6]: hunter2',
            "- generic [ref=e7]:",
            "  - text: hunter2",
            '  - link "Help" [ref=e8]:',
            "    - /url: /help",
            '- paragraph [ref=e9]: "Forgot it?"',
          ],
          ["e6", "e7"],
        );

        expect(lines).toEqual([
          `- button "Show" [ref=e6]: ${MASK}`,
          "- generic [ref=e7]:",
          `  - text: ${MASK}`,
          '  - link "Help" [ref=e8]:',
          "    - /url: /help",
          '- paragraph [ref=e9]: "Forgot it?"',
        ]);
      }),
  );

  it.effect("reads keys Playwright quoted, names that look like refs, and refs in frames", () =>
    Effect.gen(function* () {
      const { lines } = yield* mask(
        [
          "- 'textbox \"Code: one-time\" [ref=e7]': 908172",
          '- textbox "Hint [ref=e1]" [ref=e8]: "-secret: yes"',
          "- iframe [ref=e9]:",
          '  - searchbox "Card PIN" [ref=f1e2]: 1234',
          '  - spinbutton "Amount" [ref=f1e3]: "12"',
        ],
        ["e7", "e8", "f1e2"],
      );

      expect(lines).toEqual([
        `- 'textbox "Code: one-time" [ref=e7]': ${MASK}`,
        `- textbox "Hint [ref=e1]" [ref=e8]: ${MASK}`,
        "- iframe [ref=e9]:",
        `  - searchbox "Card PIN" [ref=f1e2]: ${MASK}`,
        '  - spinbutton "Amount" [ref=f1e3]: "12"',
      ]);
    }),
  );

  it.effect("masks an element without a ref whatever it is, as it cannot be asked", () =>
    Effect.gen(function* () {
      const { lines, asked } = yield* mask(
        [
          '- textbox "Remembered PIN": "4321"',
          '- textbox "Empty"',
          '- combobox "Country":',
          "- paragraph: Signed out",
        ],
        [],
        1,
      );

      expect(lines).toEqual([
        `- textbox "Remembered PIN": ${MASK}`,
        '- textbox "Empty"',
        '- combobox "Country":',
        `- paragraph: ${MASK}`,
      ]);
      expect(asked).toEqual([]);
    }),
  );

  it.effect("shows a page on which nothing matches the masked selectors as it is", () =>
    Effect.gen(function* () {
      const snapshot = ['- textbox "Search" [ref=e1]: shoes', '- textbox "Note": "4321"'];
      const { lines, asked } = yield* mask(snapshot, [], 0);

      expect(lines).toEqual(snapshot);
      expect(asked).toEqual([]);
    }),
  );

  it.effect("masks Playwright 1.3.6's snapshot of a sign-in page as its golden masked copy", () =>
    Effect.gen(function* () {
      const { tab, asked } = tabMasking(["e9", "e10", "f1e2"]);

      const masked = yield* maskSnapshot(tab, fixture("sign-in-snapshot-1.3.6.yaml"), [
        PASSWORD_FIELDS,
        "#otp",
      ]);

      expect(masked).toBe(fixture("sign-in-snapshot-1.3.6.masked.yaml"));
      expect(asked).toEqual([[["e6", "e7", "e8", "e9", "e10", "e11", "f1e2", "e16"], SELECTOR]]);
    }),
  );

  it.effect("fails with the provider's failure when the page cannot be asked", () =>
    Effect.gen(function* () {
      const { tab } = tabMasking(["e3"]);
      const failure = new BrowserProviderError({ message: "Target closed" });

      for (const failing of [
        { ...tab, countMatching: () => Effect.fail(failure) },
        { ...tab, maskedRefs: () => Effect.fail(failure) },
      ] satisfies ReadonlyArray<BrowserTab>) {
        const failed = yield* Effect.flip(
          maskSnapshot(failing, '- textbox "Password" [ref=e3]: hunter2', [PASSWORD_FIELDS]),
        );

        expect(failed.message).toBe("Target closed");
      }
    }),
  );
});
