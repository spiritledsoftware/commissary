// The panel's theme choice (src/lib/theme.ts): what a stored value means and how the metas follow a choice.
import { describe, expect, it } from "vite-plus/test";
import {
  colorSchemeContent,
  parseThemeChoice,
  THEME_CHOICES,
  themeColorMedia,
} from "../src/lib/theme.ts";

describe("parseThemeChoice", () => {
  it("keeps Light and Dark", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("dark")).toBe("dark");
  });

  it("follows the system for nothing stored and for anything else", () => {
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice("system")).toBe("system");
    expect(parseThemeChoice("Dark")).toBe("system");
    expect(parseThemeChoice("")).toBe("system");
  });
});

describe("themeColorMedia", () => {
  it("leaves the choice of bar colour to the system preference", () => {
    expect(themeColorMedia("system", "light")).toBe("(prefers-color-scheme: light)");
    expect(themeColorMedia("system", "dark")).toBe("(prefers-color-scheme: dark)");
  });

  it("pins the chosen scheme's bar colour and switches the other off", () => {
    expect(themeColorMedia("dark", "dark")).toBe("all");
    expect(themeColorMedia("dark", "light")).toBe("not all");
    expect(themeColorMedia("light", "light")).toBe("all");
    expect(themeColorMedia("light", "dark")).toBe("not all");
  });
});

describe("colorSchemeContent", () => {
  it("offers both schemes while following the system, else only the chosen one", () => {
    expect(THEME_CHOICES.map(colorSchemeContent)).toEqual(["light dark", "light", "dark"]);
  });
});
