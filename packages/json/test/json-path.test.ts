import { describe, expect, it } from "vite-plus/test";
import {
  asBool,
  asFloat,
  asInt,
  asString,
  del,
  escapePathKey,
  exists,
  get,
  type Json,
  type JsonObject,
  JsonPathError,
  parseJsonOrText,
  set,
  setRaw,
  wildcardMatch,
} from "../src/index.ts";
import fixtures from "./fixtures/json-path.json";

// Golden cases generated from the real tidwall/gjson + sjson by `go run ./tools/fixturegen/jsonpath`.

const parse = (text: string): Json => JSON.parse(text) as Json;

describe("gjson parity (golden fixtures)", () => {
  for (const [index, c] of fixtures.get.entries()) {
    it(`get #${index} ${JSON.stringify(c.path)}`, () => {
      const root = parse(c.json);
      const result = get(root, c.path);
      expect(result !== undefined, "exists").toBe(c.exists);

      if (c.exists) {
        expect(result).toEqual(parse(c.raw ?? ""));
        expect(asString(result)).toBe(c.string);
        expect(asInt(result)).toBe(c.int);
        expect(asFloat(result)).toBe(c.float);
        expect(asBool(result)).toBe(c.bool);
      }
    });
  }
});

describe("sjson parity (golden fixtures)", () => {
  for (const [index, c] of fixtures.set.entries()) {
    it(`${c.kind} #${index} ${JSON.stringify(c.json)} ${JSON.stringify(c.path)}`, () => {
      const root = c.json === "" ? undefined : parse(c.json);

      const run = (): Json | undefined => {
        if (c.kind === "delete") return del(root, c.path);

        if (c.kind === "raw") return setRaw(root, c.path, JSON.stringify(c.value));

        return set(root, c.path, c.value as Json);
      };

      if (c.error) {
        expect(run).toThrow(JsonPathError);

        return;
      }

      const out = run();
      expect(JSON.stringify(out)).toBe(JSON.stringify(parse(c.out ?? "")));
    });
  }
});

describe("path engine behaviours", () => {
  it("keeps key order and does not reorder siblings", () => {
    const root = set({ z: 1, a: 2 }, "m", 3);
    expect(Object.keys(root as object)).toEqual(["z", "a", "m"]);
  });

  it("handles the __proto__ key as plain data", () => {
    const root = set({}, "__proto__.x", 1) as Record<string, Json>;
    expect(Object.getPrototypeOf(root)).toBe(Object.prototype);
    expect(Object.keys(root)).toEqual(["__proto__"]);
    expect(get(root, "__proto__.x")).toBe(1);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("mutates containers in place and returns the root", () => {
    const root = { a: [1] };
    expect(set(root, "a.-1", 2)).toBe(root);
    expect(root).toEqual({ a: [1, 2] });
    expect(del(root, "a.0")).toBe(root);
    expect(root).toEqual({ a: [2] });
  });

  it("rejects complex set paths and invalid raw JSON", () => {
    expect(() => set({}, "a.#", 1)).toThrow(JsonPathError);
    expect(() => set({}, "", 1)).toThrow(JsonPathError);
    expect(() => setRaw({}, "a", "{not json")).toThrow(JsonPathError);
    expect(() => set([], "99999999999", 1)).toThrow(JsonPathError);
  });

  it("escapePathKey makes keys round-trip through get and set", () => {
    for (const key of ["a.b", "x*y", "q?", "#hash", "p|q", "at@", "back\\slash", "plain"]) {
      const escaped = escapePathKey(key);
      const root = set({}, `outer.${escaped}`, 7);
      expect(root).toEqual({ outer: { [key]: 7 } });
      expect(get(root, `outer.${escaped}`)).toBe(7);
    }
  });

  it("exists treats null as existing", () => {
    expect(exists({ a: null }, "a")).toBe(true);
    expect(exists({ a: null }, "a.b")).toBe(false);
    expect(exists(undefined, "a")).toBe(false);
    expect(exists("scalar", "a")).toBe(false);
  });

  it("wildcardMatch follows tidwall/match", () => {
    expect(wildcardMatch("gpt-5", "gpt-*")).toBe(true);
    expect(wildcardMatch("gemini-2.5-pro", "gemini-*-pro")).toBe(true);
    expect(wildcardMatch("abc", "a?c")).toBe(true);
    expect(wildcardMatch("a*c", "a\\*c")).toBe(true);
    expect(wildcardMatch("abc", "a\\*c")).toBe(false);
    expect(wildcardMatch("héllo", "h?llo")).toBe(true);
    expect(wildcardMatch("abcabc", "*abc")).toBe(true);
    expect(wildcardMatch("abcabd", "*abc")).toBe(false);
    expect(wildcardMatch("", "*")).toBe(true);
    expect(wildcardMatch("", "?")).toBe(false);
  });
});

/** Wraps `target` so the test can count how often its own keys are listed. */
const countingKeys = (target: JsonObject) => {
  const counter = { enumerations: 0 };

  const proxy = new Proxy(target, {
    ownKeys: (t) => {
      counter.enumerations++;

      return Reflect.ownKeys(t);
    },
  });

  return { proxy, counter };
};

const wide = (): JsonObject => {
  const properties: JsonObject = {};

  for (let i = 0; i < 2000; i++) properties[`p${i}`] = { type: "string" };

  return properties;
};

describe("plain key segments", () => {
  it("a plain key segment does not enumerate its siblings", () => {
    const { proxy, counter } = countingKeys(wide());

    expect(get({ properties: proxy }, "properties.p1999.type")).toBe("string");
    expect(get({ properties: proxy }, "properties.missing")).toBeUndefined();
    expect(counter.enumerations).toBe(0);
  });

  it("a wildcard segment still matches by scanning keys", () => {
    const { proxy, counter } = countingKeys(wide());

    expect(get({ properties: proxy }, "properties.p19?9.type")).toBe("string");
    expect(counter.enumerations).toBeGreaterThan(0);
  });

  it("resolves escaped and unusual keys literally", () => {
    const root = parse(
      '{"a.b":1,"a*b":2,"a?b":3,"0":4,"":{"x":5},"@x":6,"#":7,"__proto__":{"y":8}}',
    );

    expect(get(root, "a\\.b")).toBe(1);
    expect(get(root, "a\\*b")).toBe(2);
    expect(get(root, "a\\?b")).toBe(3);
    expect(get(root, "0")).toBe(4);
    expect(get(root, ".x")).toBe(5);
    expect(get(root, "@x")).toBe(6);
    expect(get(root, "#")).toBe(7);
    expect(get(root, "__proto__.y")).toBe(8);
  });

  it("does not read inherited properties", () => {
    const root = parse('{"a":{}}');

    for (const name of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
      expect(get(root, name)).toBeUndefined();
      expect(get(root, `a.${name}`)).toBeUndefined();
    }
  });

  it("pipes from a plain key and stops at a scalar with path left", () => {
    const root = parse('{"a":{"b":[1,2,3]},"s":"text"}');

    expect(get(root, "a|b")).toEqual([1, 2, 3]);
    expect(get(root, "a.b|#")).toBe(3);
    expect(get(root, "s.length")).toBeUndefined();
  });

  it("a wildcard keeps scanning past a match that cannot hold the rest of the path", () => {
    const root = parse('{"ab":1,"ac":{"x":2}}');

    expect(get(root, "a*.x")).toBe(2);
  });
});

describe("parseJsonOrText", () => {
  it("parses JSON, keeps JSON null, and falls back to the raw text", () => {
    expect(parseJsonOrText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonOrText("null")).toBeNull();
    expect(parseJsonOrText("{not json")).toBe("{not json");
  });
});
