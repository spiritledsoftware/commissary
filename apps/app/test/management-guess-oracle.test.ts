// A stored secret must not be confirmable by typing a guess, and a typed key must never delete a stored one: a write
// answers the same whether the typed key equals a stored one or not (provider-keys group writes), and stored keys win
// over typed ones. The state after the write is asserted, not only the reply, through
// the router and the real ControlPlane.
import { afterAll, beforeEach, describe, expect, it } from "vite-plus/test";
import type { JsonObject } from "@commissary/json";
import { controlPlane, jsonInit, makeHarness, resetControlPlane } from "./support/management.ts";

const harness = makeHarness();

afterAll(harness.dispose);

beforeEach(resetControlPlane);

const { json } = harness;

const KEY_A = "AIzaSy-ORACLE-KEY-ONE-4242";

const KEY_B = "AIzaSy-ORACLE-KEY-TWO-7373";

/** A guess of `secret` with the same length and alphabet that is wrong. */
const wrongGuess = (secret: string): string => `X${secret.slice(1)}`;

const seed = async (document: Record<string, unknown>): Promise<number> => {
  const result = await controlPlane().models().importConfig(JSON.stringify(document), "test");

  if (!result.ok) throw new Error(result.message);

  return result.version;
};

/**
 * A write reply with its change counter, group id and revision replaced, so replies of different runs compare as
 * text (a new group gets a fresh id either way).
 */
const comparableReply = (response: Awaited<ReturnType<typeof json>>): string => {
  // SAFETY: a 200 reply of a group write is a JSON object.
  const reply = { ...(response.body as Record<string, unknown>) };

  for (const field of ["version", "id", "revision"])
    if (field in reply) reply[field] = `<${field}>`;

  return JSON.stringify(reply);
};

/**
 * What is really stored of a family's groups (not what a reply says): per group its first `excluded-models` entry, a
 * marker that tells groups apart whatever their keys, then its keys' secrets. `-` is no marker.
 */
const storedSecrets = async (family = "gemini"): Promise<string[][]> => {
  const { document } = await controlPlane().models().getConfig();

  // SAFETY: the stored document is a serialized JSON object of the config shape (this test seeds it).
  const parsed = JSON.parse(document ?? "{}") as {
    "api-keys"?: Record<
      string,
      | ReadonlyArray<{
          "excluded-models"?: ReadonlyArray<string>;
          keys?: ReadonlyArray<{ "api-key"?: string }>;
        }>
      | undefined
    >;
  };

  return (parsed["api-keys"]?.[family] ?? []).map((group) => [
    group["excluded-models"]?.[0] ?? "-",
    ...(group.keys ?? []).map((key) => key["api-key"] ?? ""),
  ]);
};

interface Listed {
  readonly version: number;
  readonly families: Record<
    string,
    ReadonlyArray<{
      readonly id: string;
      readonly revision: number;
      readonly group: { readonly keys: ReadonlyArray<{ readonly auth_index?: string }> };
    }>
  >;
}

describe("provider-keys writes: a typed key equal to a stored one", () => {
  const stored = {
    "api-keys": {
      gemini: [
        { "excluded-models": ["m0"], keys: [{ "api-key": KEY_A }] },
        { "excluded-models": ["m1"], keys: [{ "api-key": KEY_B }] },
      ],
    },
  };

  type Indexes = ReadonlyArray<ReadonlyArray<string>>;

  const put = async (
    document: Record<string, unknown>,
    build: (indexes: Indexes) => JsonObject,
    family = "gemini",
  ) => {
    const version = await seed(document);
    const listed = (await json("/v9/management/provider-keys")).body as Listed;

    const groups = listed.families[family] ?? [];
    const indexes = groups.map((entry) => entry.group.keys.map((key) => key.auth_index ?? ""));

    expect(listed.version).toBe(version);

    // `index` names a listed group: the write sends its id and revision (a new group: revision 0).
    const { index, ...body } = build(indexes);
    const target = typeof index === "number" ? groups[index] : undefined;

    const reply = await json(
      "/v9/management/provider-keys/groups",
      jsonInit("PUT", {
        ...body,
        ...(target === undefined ? { revision: 0 } : { id: target.id, revision: target.revision }),
      }),
    );

    return { version, reply, after: await storedSecrets(family) };
  };

  const scenarios: ReadonlyArray<{
    readonly name: string;
    /** The stored secret the guess is a copy of when it is right. */
    readonly secret: string;
    readonly body: (guess: string, indexes: Indexes) => JsonObject;
    readonly right: ReadonlyArray<ReadonlyArray<string>>;
    readonly wrong: (guess: string) => ReadonlyArray<ReadonlyArray<string>>;
  }> = [
    {
      name: "a new group made of the copy: never created, nothing else touched",
      secret: KEY_A,
      body: (guess) => ({
        family: "gemini",
        group: { "excluded-models": ["new"], keys: [{ "api-key": guess }] },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A],
        ["m1", KEY_B],
        ["new", guess],
      ],
    },
    {
      name: "a copy of a LATER group's key beside a kept key: the stored key of the later group stays",
      secret: KEY_B,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 0,
        group: {
          "excluded-models": ["m0"],
          keys: [{ auth_index: indexes[0]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A, guess],
        ["m1", KEY_B],
      ],
    },
    {
      name: "the only key written is a copy of a later group's key: the group is left empty and removed, the later one stays",
      secret: KEY_B,
      body: (guess) => ({
        family: "gemini",
        index: 0,
        group: { "excluded-models": ["m0"], keys: [{ "api-key": guess }] },
      }),
      right: [["m1", KEY_B]],
      wrong: (guess) => [
        ["m0", guess],
        ["m1", KEY_B],
      ],
    },
    {
      name: "a copy of an EARLIER group's key beside a kept key",
      secret: KEY_A,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 1,
        group: {
          "excluded-models": ["m1"],
          keys: [{ auth_index: indexes[1]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A],
        ["m1", KEY_B, guess],
      ],
    },
    {
      name: "a copy of the key the group keeps itself",
      secret: KEY_A,
      body: (guess, indexes) => ({
        family: "gemini",
        index: 0,
        group: {
          "excluded-models": ["m0"],
          keys: [{ auth_index: indexes[0]?.[0] ?? "" }, { "api-key": guess }],
        },
      }),
      right: [
        ["m0", KEY_A],
        ["m1", KEY_B],
      ],
      wrong: (guess) => [
        ["m0", KEY_A, guess],
        ["m1", KEY_B],
      ],
    },
  ];

  for (const scenario of scenarios)
    it(`answers a right and a wrong guess alike and keeps every stored key: ${scenario.name}`, async () => {
      const right = await put(stored, (indexes) => scenario.body(scenario.secret, indexes));
      await resetControlPlane();
      const guess = wrongGuess(scenario.secret);
      const wrong = await put(stored, (indexes) => scenario.body(guess, indexes));

      // `{status, version, id, revision}` with the version one ahead, whatever the typed key was.
      expect(right.reply.status).toBe(200);
      expect(wrong.reply.status).toBe(200);
      expect(right.reply.headers.get("content-type")).toBe(wrong.reply.headers.get("content-type"));

      expect(right.reply.body).toEqual({
        status: "ok",
        version: right.version + 1,
        id: expect.any(String),
        revision: right.version + 1,
      });

      expect(comparableReply(right.reply)).toBe(comparableReply(wrong.reply));

      // The state is what tells them apart (the next read), and no stored key is ever lost.
      expect(right.after).toEqual(scenario.right);
      expect(wrong.after).toEqual(scenario.wrong(guess));
    });

  it("keeps one of two typed copies of each other, and a copy of a key kept in the same request", async () => {
    const twice = await put(stored, () => ({
      family: "gemini",
      group: { keys: [{ "api-key": "typed-twice" }, { "api-key": "typed-twice" }] },
    }));

    expect(twice.reply.status).toBe(200);
    expect(twice.after).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_B],
      ["-", "typed-twice"],
    ]);
  });

  it("answers alike for header values tried on a key kept by auth_index, or on its group (never a 422)", async () => {
    const HEADER = "hdr-secret-value-9191";

    const withHeaders = {
      "api-keys": {
        gemini: [
          {
            prefix: "a",
            "excluded-models": ["m0"],
            keys: [{ "api-key": KEY_A, headers: { "X-Token": HEADER } }],
          },
          { prefix: "b", "excluded-models": ["m1"], keys: [{ "api-key": KEY_A }] },
        ],
      },
    };

    // The edit moves group 1 to prefix "a": its kept key equals group 0's exactly when the header tried is right.
    const tried = (headers: Record<string, string>) => (indexes: Indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        "excluded-models": ["m1"],
        keys: [{ auth_index: indexes[1]?.[0] ?? "", headers }],
      },
    });

    const right = await put(withHeaders, tried({ "X-Token": HEADER }));
    await resetControlPlane();
    const wrong = await put(withHeaders, tried({ "X-Token": wrongGuess(HEADER) }));

    expect(right.reply.status).toBe(200);
    expect(wrong.reply.status).toBe(200);

    expect(comparableReply(right.reply)).toBe(comparableReply(wrong.reply));

    // The copy goes (group 1 is left empty and removed); group 0 keeps its key.
    expect(right.after).toEqual([["m0", KEY_A]]);

    expect(wrong.after).toEqual([
      ["m0", KEY_A],
      ["m1", KEY_A],
    ]);

    // The same through the group's own headers.
    await resetControlPlane();

    const viaGroup = await put(withHeaders, (indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        "excluded-models": ["m1"],
        headers: { "X-Token": HEADER },
        keys: [{ auth_index: indexes[1]?.[0] ?? "" }],
      },
    }));

    expect(viaGroup.reply.status).toBe(200);
    expect(viaGroup.after).toEqual([["m0", KEY_A]]);
  });

  it("refuses a key kept by auth_index that the edit makes equal to a key of another group", async () => {
    const same = {
      "api-keys": {
        gemini: [
          { prefix: "a", keys: [{ "api-key": KEY_A }] },
          { prefix: "b", keys: [{ "api-key": KEY_A }, { "api-key": KEY_B }] },
        ],
      },
    };

    const refused = await put(same, (indexes) => ({
      family: "gemini",
      index: 1,
      group: {
        prefix: "a",
        keys: [{ auth_index: indexes[1]?.[0] ?? "" }, { auth_index: indexes[1]?.[1] ?? "" }],
      },
    }));

    expect(refused.reply.status).toBe(422);
    expect(JSON.stringify(refused.reply.body)).toContain("another group");
    expect(JSON.stringify(refused.reply.body)).not.toContain(KEY_A);
    expect(refused.after).toEqual([
      ["-", KEY_A],
      ["-", KEY_A, KEY_B],
    ]);
    expect((await controlPlane().models().getConfig()).version).toBe(refused.version);
  });

  it("applies the same rule to vertex keys (unique by key and base-url)", async () => {
    const vertex = {
      "api-keys": {
        vertex: [
          {
            "base-url": "https://v.example.test",
            "excluded-models": ["m0"],
            keys: [{ "api-key": KEY_A }],
          },
          {
            "base-url": "https://v.example.test",
            "excluded-models": ["m1"],
            keys: [{ "api-key": KEY_B }],
          },
        ],
      },
    };

    const right = await put(
      vertex,
      () => ({
        family: "vertex",
        index: 0,
        group: {
          "base-url": "https://v.example.test",
          "excluded-models": ["m0"],
          keys: [{ "api-key": KEY_B }],
        },
      }),
      "vertex",
    );

    expect(right.reply.status).toBe(200);
    expect(right.after).toEqual([["m1", KEY_B]]);
  });

  it("keeps duplicates of a family Go does not deduplicate (codex)", async () => {
    const codex = {
      "api-keys": {
        codex: [{ "base-url": "https://c.example.test", keys: [{ "api-key": KEY_A }] }],
      },
    };

    const written = await put(
      codex,
      () => ({
        family: "codex",
        group: { "base-url": "https://c.example.test", keys: [{ "api-key": KEY_A }] },
      }),
      "codex",
    );

    expect(written.reply.status).toBe(200);
    expect(written.after).toEqual([
      ["-", KEY_A],
      ["-", KEY_A],
    ]);
  });

  it("still refuses a group the normaliser drops for its own shape", async () => {
    await seed(stored);

    const reply = await json(
      "/v9/management/provider-keys/groups",
      jsonInit("PUT", { revision: 0, family: "codex", group: { keys: [{ "api-key": KEY_A }] } }),
    );

    expect(reply.status).toBe(422);
    expect(JSON.stringify(reply.body)).toContain("base-url");
    expect(JSON.stringify(reply.body)).not.toContain("duplicate");
    expect(JSON.stringify(reply.body)).not.toContain(KEY_A);
  });
});
