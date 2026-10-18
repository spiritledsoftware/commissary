// System One models (ADR 0032) as credentials register them: TypeSafe and SubQ key groups without `models` take their
// catalog additions, configured models and aliases are typed `systemone`; OpenCode Zen adds its Jev models to the
// models.dev ones, OpenCode Go none.
import { describe, expect, it } from "vitest";
import { embeddedModelsDev } from "../src/registry/catalog.ts";
import { assembleCredentialModels } from "../src/registry/credential-models.ts";
import { ids, options, source } from "./support/registry-sources.ts";

describe("System One registration", () => {
  it("registers the four TypeSafe ids and SubQ's model by default, typed systemone, without price facts", () => {
    const typesafe = assembleCredentialModels(
      source("t", "typesafe", { authKind: "apikey" }),
      options(),
    );

    expect(ids(typesafe?.models)).toEqual([
      "jev-1.13.0",
      "jev-1.14.0",
      "jev-latest",
      "jev-preview",
    ]);
    expect(typesafe?.models.every((model) => model.type === "systemone")).toBe(true);
    expect(typesafe?.models[0]).not.toHaveProperty("cost");
    expect(typesafe?.models[0]).not.toHaveProperty("systemOne");

    const subq = assembleCredentialModels(source("s", "subq", { authKind: "apikey" }), options());
    expect(ids(subq?.models)).toEqual(["subq-snap-preview"]);
  });

  it("types configured models and their aliases systemone, with the catalog's details", () => {
    const assembled = assembleCredentialModels(
      source("t", "typesafe", {
        authKind: "apikey",
        prefix: "ts",
        models: [{ name: "jev-1.14.0", alias: "box-jev" }],
      }),
      options(),
    );

    expect(ids(assembled?.models)).toEqual(["box-jev", "ts/box-jev"]);
    expect(assembled?.models[0]).toMatchObject({
      type: "systemone",
      displayName: "Jev 1.14",
      ownedBy: "typesafe",
    });
    expect(assembled?.models[0]?.thinking).toBeUndefined();
  });

  it("registers Zen's jev-1.13 and jev-1.13-free by default while its other free models stay off; Go gets neither", () => {
    const zen = assembleCredentialModels(
      source("z", "opencode-zen", { authKind: "apikey" }),
      options(),
    );

    const jev = zen?.models.filter((model) => model.type === "systemone");
    expect(ids(jev)).toEqual(["jev-1.13", "jev-1.13-free"]);
    expect(jev?.[1]).toMatchObject({ ownedBy: "opencode", displayName: "Jev 1.13 Free" });
    expect(jev?.[1]).not.toHaveProperty("cost");

    // Every other default Zen model is a paid models.dev model (the bundled document has free ones).
    const freeOnModelsDev = Object.values(embeddedModelsDev().opencode.models)
      .filter((model) => model.free === true)
      .map((model) => model.id);

    expect(freeOnModelsDev.length).toBeGreaterThan(0);
    expect(ids(zen?.models).filter((id) => freeOnModelsDev.includes(id))).toEqual([]);
    expect(zen?.models.length).toBeGreaterThan(2);

    const go = assembleCredentialModels(
      source("g", "opencode-go", { authKind: "apikey" }),
      options(),
    );

    expect(go?.models.length).toBeGreaterThan(0);
    expect(ids(go?.models).filter((id) => id.startsWith("jev"))).toEqual([]);
    expect(go?.models.some((model) => model.type === "systemone")).toBe(false);
  });

  it("types a configured Zen Jev model systemone, but not a systemone protocol on Go", () => {
    const zen = assembleCredentialModels(
      source("z", "opencode-zen", {
        authKind: "apikey",
        models: [{ name: "jev-1.13", alias: "my-jev" }, { name: "jev-1.13-free" }],
      }),
      options(),
    );

    expect(ids(zen?.models)).toEqual(["my-jev", "jev-1.13-free"]);
    expect(zen?.models[0]).toMatchObject({
      type: "systemone",
      displayName: "Jev 1.13",
      ownedBy: "opencode",
      contextLength: 65_536,
    });
    expect(zen?.models[0]?.thinking).toBeUndefined();
    expect(zen?.models[1]?.type).toBe("systemone");

    const go = assembleCredentialModels(
      source("g", "opencode-go", {
        authKind: "apikey",
        models: [{ name: "jev-1.13", protocol: "systemone" }],
      }),
      options(),
    );

    expect(go?.models[0]?.type).toBe("openai");
  });
});
