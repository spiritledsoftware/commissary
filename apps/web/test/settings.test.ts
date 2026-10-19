// The Settings page's model (src/lib/settings.ts): inputs for values and back, the client checks that mirror the
// server's, the patch a draft becomes, the rebase of a draft onto a newer view, and saves re-applied after a 409.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Predicate, Schema } from "effect";
import { ManagementError } from "@commissary/contract/errors";
import {
  type SaveSettings,
  SettingsValues,
  type SettingsView,
} from "@commissary/contract/settings";
import {
  changedFields,
  draftErrors,
  draftPatch,
  durationReading,
  type Edits,
  fieldId,
  fieldOfPath,
  fieldSpec,
  FIELDS,
  inputOf,
  isDefault,
  parseGoDuration,
  parseInput,
  rebaseDraft,
  draftSave,
  saveDraft,
  type FieldSpec,
  spellDuration,
  valueAt,
  valueText,
} from "../src/lib/settings.ts";

const DEFAULTS: SettingsValues = {
  routing: {
    strategy: "round-robin",
    "session-affinity": false,
    "session-affinity-ttl": "1h",
    "session-affinity-subagents": true,
    "force-model-prefix": false,
    retry: { "request-retry": 0, "max-retry-credentials": 0, "max-retry-interval": 0 },
    cooldown: {
      "disable-cooling": false,
      "transient-error-cooldown-seconds": 0,
    },
  },
  requests: {
    "passthrough-headers": false,
    "nonstream-keepalive-interval": 0,
    streaming: { "keepalive-seconds": 0, "bootstrap-retries": 0 },
  },
  upstream: {
    codex: {
      "response-steering": false,
      "disable-codex-cloaking": false,
      "stream-bootstrap-buffering": false,
      "stream-bootstrap-timeout": "0",
      "orphan-delegation-compatibility": false,
      "model-level-cooling": false,
    },
    claude: {
      "model-level-cooling": false,
      "disable-claude-cloak-mode": false,
      "cloak-level": "full",
      "disable-cloaking-model-list": false,
      "header-defaults": {
        "user-agent": "",
        "package-version": "",
        "runtime-version": "",
        os: "",
        arch: "",
        timeout: "",
        timezone: "",
        "stabilize-device-profile": null,
      },
    },
    xai: { "inject-x-search": false },
    opencode: { "disable-cloaking": false },
  },
  client: { codex: { "enable-apply-patch": false, "optimize-multi-agent-v2": false } },
  oauth: {
    "auth-auto-refresh-workers": 0,
    providers: {
      codex: { "header-defaults": { "user-agent": "", "beta-features": "" } },
      antigravity: {
        "sensitive-words": [],
        "antigravity-credits": false,
        "signature-cache-enabled": null,
        "signature-bypass-strict": null,
      },
      devin: { "sensitive-words": [] },
    },
  },
  multimedia: {
    "disable-image-generation": false,
    "gpt-image-2-base-model": "",
    "video-result-auth-cache-ttl": "3h",
  },
  models: { catalog: "" },
};

const decodeValues = Schema.decodeUnknownSync(SettingsValues);

/** The defaults with the values at the given dotted paths replaced. */
const values = (...writes: ReadonlyArray<readonly [string, unknown]>): SettingsValues => {
  const copy: unknown = structuredClone(DEFAULTS);

  for (const [path, value] of writes) {
    const keys = path.split(".");
    let node = copy;

    for (const key of keys.slice(0, -1)) node = Predicate.hasProperty(node, key) ? node[key] : {};

    if (Predicate.isObject(node)) Reflect.set(node, keys.at(-1) ?? "", value);
  }

  return decodeValues(copy);
};

const view = (overrides: Partial<SettingsView> = {}): SettingsView => ({
  version: 7,
  revisions: {},
  updated_at: "2026-10-11T11:00:00Z",
  values: DEFAULTS,
  defaults: DEFAULTS,
  payload: { default: 0, "default-raw": 0, override: 0, "override-raw": 0, filter: 0 },
  prefixed_credentials: 0,
  request_scoped_errors: {},
  ...overrides,
});

const spec = (path: string): FieldSpec => {
  const found = fieldSpec(path);

  if (found === undefined) throw new Error(`no field ${path}`);

  return found;
};

describe("fields", () => {
  it("covers every Settings leaf once and finds the field of a server path", () => {
    const paths = FIELDS.map((entry) => entry.path);

    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.every((path) => valueAt(DEFAULTS, path) !== undefined)).toBe(true);
    expect(fieldOfPath("routing.session-affinity-ttl")?.path).toBe("routing.session-affinity-ttl");
    expect(fieldOfPath("oauth.providers.devin.sensitive-words.2")?.path).toBe(
      "oauth.providers.devin.sensitive-words",
    );
    expect(fieldOfPath("oauth.providers.devin.sensitive-words[2]")?.path).toBe(
      "oauth.providers.devin.sensitive-words",
    );
    expect(fieldOfPath("upstream.opencode.disable-cloaking")?.path).toBe(
      "upstream.opencode.disable-cloaking",
    );
    expect(fieldOfPath("access.admin-emails")).toBeUndefined();
    expect(fieldOfPath("routing.retry")).toBeUndefined();
    expect(fieldOfPath(undefined)).toBeUndefined();
    expect(fieldId("routing.retry.request-retry")).toBe("setting-routing-retry-request-retry");
  });
});

describe("inputs and checks", () => {
  it("parses Go durations as the server does", () => {
    expect(parseGoDuration("1h30m")).toBe(5_400_000);
    expect(parseGoDuration("1.5s")).toBe(1500);
    expect(parseGoDuration("0")).toBe(0);
    expect(parseGoDuration("-2m")).toBe(-120_000);
    expect(parseGoDuration("90")).toBeUndefined();
    expect(parseGoDuration("1d")).toBeUndefined();
    expect(parseGoDuration("")).toBeUndefined();
  });

  it("refuses what the server refuses and normalises what it would rewrite", () => {
    const ttl = spec("routing.session-affinity-ttl");

    expect(parseInput(ttl, " 1h30m ")).toEqual({ ok: true, value: "1h30m" });
    expect(parseInput(ttl, "0s").ok).toBe(false);
    expect(parseInput(ttl, "soon").ok).toBe(false);

    const retry = spec("routing.retry.request-retry");

    expect(parseInput(retry, " 3 ")).toEqual({ ok: true, value: 3 });
    expect(parseInput(retry, "-1").ok).toBe(false);
    expect(parseInput(retry, "1.5").ok).toBe(false);
    expect(parseInput(retry, "").ok).toBe(false);

    const model = spec("multimedia.gpt-image-2-base-model");

    expect(parseInput(model, "GPT-5.4")).toEqual({ ok: true, value: "GPT-5.4" });
    expect(parseInput(model, "")).toEqual({ ok: true, value: "" });
    expect(parseInput(model, "dall-e-3").ok).toBe(false);

    const zone = spec("upstream.claude.header-defaults.timezone");

    expect(parseInput(zone, "Europe/Berlin").ok).toBe(true);
    expect(parseInput(zone, "Local").ok).toBe(true);
    expect(parseInput(zone, "").ok).toBe(true);
    expect(parseInput(zone, "Mars/Olympus").ok).toBe(false);

    const timeout = spec("upstream.codex.stream-bootstrap-timeout");

    expect(parseInput(timeout, "45s")).toEqual({ ok: true, value: "45s" });
    expect(parseInput(timeout, "20")).toEqual({ ok: true, value: "20" });
    expect(parseInput(timeout, "unlimited")).toEqual({ ok: true, value: "unlimited" });
    expect(parseInput(timeout, "")).toEqual({ ok: true, value: "0" });
    expect(parseInput(timeout, "later").ok).toBe(false);

    const words = spec("oauth.providers.devin.sensitive-words");

    expect(parseInput(words, "proxy\n  API \n")).toEqual({ ok: true, value: ["proxy", "API"] });
  });

  it("maps catalog sources to a choice and back", () => {
    const catalog = spec("models.catalog");

    expect(inputOf(catalog, "")).toEqual({ choice: "official", text: "" });
    expect(inputOf(catalog, "embed")).toEqual({ choice: "embed", text: "" });
    expect(inputOf(catalog, "https://example.com/models.json")).toEqual({
      choice: "custom",
      text: "https://example.com/models.json",
    });
    expect(parseInput(catalog, { choice: "official", text: "ignored" })).toEqual({
      ok: true,
      value: "",
    });
    expect(parseInput(catalog, { choice: "disabled", text: "" })).toEqual({
      ok: true,
      value: "disabled",
    });
    expect(parseInput(catalog, { choice: "custom", text: " https://x.test/m.json " })).toEqual({
      ok: true,
      value: "https://x.test/m.json",
    });
    expect(parseInput(catalog, { choice: "custom", text: "ftp://x.test/m.json" }).ok).toBe(false);
    expect(parseInput(catalog, { choice: "custom", text: "" }).ok).toBe(false);
  });

  it("maps the transient error cooldown radio to its number and back", () => {
    const cooldown = spec("routing.cooldown.transient-error-cooldown-seconds");

    expect(inputOf(cooldown, 0)).toEqual({ choice: "default", text: "" });
    expect(inputOf(cooldown, -1)).toEqual({ choice: "off", text: "" });
    expect(inputOf(cooldown, 90)).toEqual({ choice: "custom", text: "90" });
    expect(parseInput(cooldown, { choice: "default", text: "" })).toEqual({ ok: true, value: 0 });
    expect(parseInput(cooldown, { choice: "off", text: "" })).toEqual({ ok: true, value: -1 });
    expect(parseInput(cooldown, { choice: "custom", text: "120" })).toEqual({
      ok: true,
      value: 120,
    });
    expect(parseInput(cooldown, { choice: "custom", text: "0" }).ok).toBe(false);

    // Every negative value turns it off: choosing Off over a stored -5 is no change.
    const stored = values(["routing.cooldown.transient-error-cooldown-seconds", -5]);

    expect(
      changedFields({ [cooldown.path]: { choice: "off", text: "" } }, stored).map((f) => f.path),
    ).toEqual([]);
  });

  it("maps image generation modes and tri-states", () => {
    const images = spec("multimedia.disable-image-generation");

    expect(inputOf(images, "chat")).toBe("chat");
    expect(parseInput(images, "true")).toEqual({ ok: true, value: true });
    expect(parseInput(images, "false")).toEqual({ ok: true, value: false });

    const cache = spec("oauth.providers.antigravity.signature-cache-enabled");

    expect(inputOf(cache, null)).toBe(true);
    expect(inputOf(cache, false)).toBe(false);
  });

  it("reads durations out", () => {
    expect(spellDuration(5_400_000)).toBe("1 hour 30 minutes");
    expect(spellDuration(3_600_000)).toBe("1 hour");
    expect(spellDuration(172_800_000 + 60_000)).toBe("2 days 1 minute");
    expect(spellDuration(1500)).toBe("1 second 500 milliseconds");
    expect(durationReading(spec("routing.session-affinity-ttl"), "90m")).toBe(
      "= 1 hour 30 minutes",
    );
    expect(durationReading(spec("routing.session-affinity-ttl"), "0")).toBeUndefined();
    expect(durationReading(spec("routing.session-affinity-ttl"), "x")).toBeUndefined();
    expect(durationReading(spec("upstream.codex.stream-bootstrap-timeout"), "off")).toBe(
      "= no limit",
    );
    expect(durationReading(spec("upstream.codex.stream-bootstrap-timeout"), "20")).toBe(
      "= 20 seconds",
    );
  });

  it("says a value in a few words", () => {
    expect(valueText(spec("routing.session-affinity"), true)).toBe("on");
    expect(valueText(spec("routing.strategy"), "fill-first")).toBe("fill-first");
    expect(valueText(spec("upstream.claude.cloak-level"), "minimal")).toBe("minimal");
    expect(valueText(spec("oauth.providers.devin.sensitive-words"), [])).toBe("none");
    expect(valueText(spec("oauth.providers.devin.sensitive-words"), ["a", "b"])).toBe("a, b");
    expect(valueText(spec("routing.cooldown.transient-error-cooldown-seconds"), 0)).toBe("60 s");
    expect(valueText(spec("models.catalog"), "embed")).toBe("embedded copy");
    expect(valueText(spec("multimedia.gpt-image-2-base-model"), "")).toBe("empty");
  });
});

describe("drafts", () => {
  it("patches only the changed leaves, with null for a value back at its default", () => {
    const current = values(
      ["routing.strategy", "fill-first"],
      ["routing.session-affinity-ttl", "2h"],
    );

    const edits: Edits = {
      "routing.strategy": "round-robin",
      "routing.session-affinity": true,
      "routing.session-affinity-ttl": "2h",
      "routing.force-model-prefix": false,
    };

    expect(changedFields(edits, current).map((entry) => entry.path)).toEqual([
      "routing.strategy",
      "routing.session-affinity",
    ]);
    expect(draftPatch(edits, { values: current, defaults: DEFAULTS })).toEqual({
      routing: { strategy: null, "session-affinity": true },
    });
  });

  it("sends a tri-state back to unset when it matches what unset means", () => {
    const current = values(["oauth.providers.antigravity.signature-cache-enabled", false]);

    expect(
      draftPatch(
        { "oauth.providers.antigravity.signature-cache-enabled": true },
        { values: current, defaults: DEFAULTS },
      ),
    ).toEqual({ oauth: { providers: { antigravity: { "signature-cache-enabled": null } } } });
  });

  it("has no patch when nothing changed or an input is invalid, and says what is wrong", () => {
    const edits: Edits = { "routing.session-affinity-ttl": "1h" };

    expect(draftPatch(edits, { values: DEFAULTS, defaults: DEFAULTS })).toBeUndefined();

    const invalid: Edits = {
      "routing.session-affinity-ttl": "soon",
      "routing.strategy": "fill-first",
    };

    expect(draftPatch(invalid, { values: DEFAULTS, defaults: DEFAULTS })).toBeUndefined();
    expect(draftErrors(invalid, DEFAULTS)).toEqual({
      "routing.session-affinity-ttl": "“soon” is not a duration.",
    });
  });

  it("says whether a shown value is the default", () => {
    const ttl = spec("routing.session-affinity-ttl");

    expect(isDefault(ttl, {}, DEFAULTS, DEFAULTS)).toBe(true);
    expect(isDefault(ttl, { [ttl.path]: "60m" }, DEFAULTS, DEFAULTS)).toBe(false);
    expect(isDefault(ttl, { [ttl.path]: "x" }, DEFAULTS, DEFAULTS)).toBe(false);
  });

  it("sends the revision of each changed setting, 0 for one that is not stored", () => {
    const stored = view({
      values: values(["routing.session-affinity-ttl", "2h"]),
      revisions: { "routing.session-affinity-ttl": 4, "routing.strategy": 9 },
    });

    expect(
      draftSave(
        {
          "routing.session-affinity-ttl": "30m",
          "routing.session-affinity": true,
          // Not a change: its revision is not sent.
          "routing.strategy": "round-robin",
        },
        stored,
      ),
    ).toEqual({
      revisions: { "routing.session-affinity-ttl": 4, "routing.session-affinity": 0 },
      patch: { routing: { "session-affinity-ttl": "30m", "session-affinity": true } },
    });
  });

  it("names a setting that goes back to its default with null and its stored revision", () => {
    const stored = view({
      values: values(["routing.strategy", "fill-first"]),
      revisions: { "routing.strategy": 3 },
    });

    expect(draftSave({ "routing.strategy": "round-robin" }, stored)).toEqual({
      revisions: { "routing.strategy": 3 },
      patch: { routing: { strategy: null } },
    });
    expect(draftSave({}, stored)).toBeUndefined();
  });
});

describe("rebase", () => {
  const before = DEFAULTS;

  it("keeps a draft whose fields did not move, and takes the new values elsewhere", () => {
    const after = values(["routing.strategy", "fill-first"]);

    const edits: Edits = {
      "routing.session-affinity": true,
      // Touched, but not a change: the field shows the new value.
      "routing.strategy": "round-robin",
    };

    expect(rebaseDraft(edits, before, after)).toEqual({
      edits: { "routing.session-affinity": true },
      moved: [],
    });
  });

  it("lists the changed fields that moved on the server", () => {
    const after = values(["routing.session-affinity-ttl", "2h"]);

    const rebased = rebaseDraft({ "routing.session-affinity-ttl": "30m" }, before, after);

    expect(rebased.edits).toEqual({ "routing.session-affinity-ttl": "30m" });
    expect(rebased.moved.map((entry) => entry.path)).toEqual(["routing.session-affinity-ttl"]);
  });

  it("drops a change the server now holds (the section's own save)", () => {
    const after = values(["routing.session-affinity-ttl", "30m"]);

    expect(rebaseDraft({ "routing.session-affinity-ttl": "30m" }, before, after)).toEqual({
      edits: {},
      moved: [],
    });
  });
});

describe("saving", () => {
  const io = (latest: SettingsView, answers: ReadonlyArray<"ok" | "conflict">) => {
    const calls: SaveSettings[] = [];
    let turn = 0;

    return {
      calls,
      io: {
        read: Effect.succeed(latest),
        write: (save: SaveSettings) => {
          calls.push(save);
          const answer = answers[turn++] ?? "ok";

          return answer === "ok"
            ? Effect.succeed({ version: 7 + calls.length })
            : Effect.fail(new ManagementError({ error: "conflict" }));
        },
      },
    };
  };

  it.effect("writes the delta with the revision of each setting it changes", () =>
    Effect.gen(function* () {
      const base = view({ revisions: { "routing.strategy": 2, "routing.session-affinity": 5 } });
      const { calls, io: fake } = io(base, ["ok"]);
      const outcome = yield* saveDraft({ "routing.strategy": "fill-first" }, base, fake);

      expect(outcome).toEqual({ kind: "saved", version: 8 });
      expect(calls).toEqual([
        { revisions: { "routing.strategy": 2 }, patch: { routing: { strategy: "fill-first" } } },
      ]);
    }),
  );

  it.effect("is unchanged when the draft changes nothing", () =>
    Effect.gen(function* () {
      const { calls, io: fake } = io(view(), []);

      expect(yield* saveDraft({ "routing.strategy": "round-robin" }, view(), fake)).toEqual({
        kind: "unchanged",
      });
      expect(calls).toEqual([]);
    }),
  );

  it.effect("re-reads after a 409 and re-applies the delta once with the fresh revisions", () =>
    Effect.gen(function* () {
      const latest = view({
        version: 9,
        revisions: { "routing.strategy": 6, "routing.session-affinity": 1 },
        values: values(["routing.session-affinity", true]),
      });

      const { calls, io: fake } = io(latest, ["conflict", "ok"]);

      const outcome = yield* saveDraft(
        { "routing.strategy": "fill-first" },
        view({ revisions: { "routing.strategy": 2 } }),
        fake,
      );

      expect(outcome).toEqual({ kind: "saved", version: 9 });
      expect(calls.map((call) => call.revisions)).toEqual([
        { "routing.strategy": 2 },
        { "routing.strategy": 6 },
      ]);
      expect(calls[1]?.patch).toEqual({ routing: { strategy: "fill-first" } });
    }),
  );

  it.effect("stops when a changed field moved meanwhile, and fails on a second 409", () =>
    Effect.gen(function* () {
      const latest = view({
        version: 9,
        values: values(["routing.strategy", "weighted-round-robin"]),
      });

      const moved = io(latest, ["conflict"]);
      const outcome = yield* saveDraft({ "routing.strategy": "fill-first" }, view(), moved.io);

      expect(outcome.kind).toBe("moved");
      expect(outcome.kind === "moved" ? outcome.fields.map((entry) => entry.path) : []).toEqual([
        "routing.strategy",
      ]);
      // The fresh view comes back with the outcome.
      expect(outcome.kind === "moved" ? outcome.view : undefined).toBe(latest);
      expect(moved.calls).toHaveLength(1);

      const twice = io(view({ version: 9 }), ["conflict", "conflict"]);

      const exit = yield* Effect.exit(
        saveDraft({ "routing.strategy": "fill-first" }, view(), twice.io),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(twice.calls).toHaveLength(2);
    }),
  );
});
