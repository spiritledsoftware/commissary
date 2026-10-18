// System One models (ADR 0032) as credentials register them: TypeSafe and SubQ key groups without `models` take their
// catalog additions, configured models and aliases are typed `systemone`.
import { describe, expect, it } from "vitest";
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
});
