import { describe, expect, it } from "vitest";
import {
  buildCodexClientModels,
  supportsApplyPatchProviders,
} from "../../src/registry/codex-client-models.ts";
import {
  resolveClaudeModelIdPrefix,
  ensureClaudeModelIdPrefix,
} from "../../src/registry/listings.ts";
import { asString, type JsonObject } from "@commissary/json";
import {
  respondGeminiDetail,
  respondGeminiList,
  respondModels,
} from "../../src/registry/models-api.ts";
import {
  catalogs,
  fixture,
  fixtureNow,
  type FixtureRequest,
  goCompactBytes,
  scenarioIndex,
  sortedBody,
} from "../support/registry.ts";

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * Ported ahead of the fixture. B6 (#366) ports CLIProxyAPI 8df4e42a (direct tool mode, no Responses-Lite or effort
 * updates on non-Codex routes), a1eeb60e (no original image detail there) and 19398539 (the refreshed
 * `codex_client_models.json`, with `allow_only_*`). The committed fixture predates all three, so every Codex client
 * case changed. Each row is what Go answers with those three commits applied to the tree the fixture was generated
 * from (`tools/fixturegen/UPSTREAM_COMMIT`, 67465884) and the same fixturegen: `entries` is the SHA-256 of the sorted
 * `slug<TAB>entry hash` lines of Go's `entries` map, `sha256` and `size` are Go's whole-body values (not compared for
 * `catalog-all`, whose ties follow Go's map order). The per-model summary of the old fixture is not compared for these
 * cases; the four flags are checked against `AHEAD_NATIVE_FLAGS` instead. The fixture stays untouched: F2 (#388)
 * regenerates it and deletes this table.
 */
const AHEAD_OF_FIXTURE = new Map<string, { entries: string; sha256?: string; size?: number }>([
  [
    "catalog-all default ",
    { entries: "adace2189acb0892aed182ed370b85d724cb59fc6b3d3e6a65e178fa7366a468" },
  ],
  [
    "catalog-all default 0.100.0",
    { entries: "e78eec491ab094c31d530e6dcf90a730667d46742c10658f6f640bb6e45f3f13" },
  ],
  [
    "catalog-all default 0.150.0",
    { entries: "adace2189acb0892aed182ed370b85d724cb59fc6b3d3e6a65e178fa7366a468" },
  ],
  [
    "catalog-all default v0.144.0-beta",
    { entries: "adace2189acb0892aed182ed370b85d724cb59fc6b3d3e6a65e178fa7366a468" },
  ],
  [
    "catalog-all default cpa",
    { entries: "176d8fcfdb1df5eb2233b5885411ef9c04dc72a8de5f2e27632c40a7a6546566" },
  ],
  [
    "catalog-all multi-agent-v2 ",
    { entries: "b03a26fb0a6630b16e8102b0716c0811c01e2677b82440a970f3aa94f2f71ebb" },
  ],
  [
    "catalog-all multi-agent-v2 0.100.0",
    { entries: "ca247819a1a018a3af7d7bbf9d1a6e3789594c5ee3252a66f37905d9d09299a8" },
  ],
  [
    "catalog-all multi-agent-v2 0.150.0",
    { entries: "b03a26fb0a6630b16e8102b0716c0811c01e2677b82440a970f3aa94f2f71ebb" },
  ],
  [
    "catalog-all multi-agent-v2 v0.144.0-beta",
    { entries: "b03a26fb0a6630b16e8102b0716c0811c01e2677b82440a970f3aa94f2f71ebb" },
  ],
  [
    "catalog-all multi-agent-v2 cpa",
    { entries: "f3cff5274b9ad681300f02d9e7c6cb8b08c312be22e87dae5c1fa3964d794565" },
  ],
  [
    "catalog-all apply-patch-flag ",
    { entries: "046304c025a1a0ed1343d12b7cdaa6e387d4dcc521fee2986d4a3d3f8c73a4e8" },
  ],
  [
    "catalog-all apply-patch-flag 0.100.0",
    { entries: "0f2c9e14aeedb7d715f59f31862b0b283d6085231ec187790bfea3d84aa0763c" },
  ],
  [
    "catalog-all apply-patch-flag 0.150.0",
    { entries: "046304c025a1a0ed1343d12b7cdaa6e387d4dcc521fee2986d4a3d3f8c73a4e8" },
  ],
  [
    "catalog-all apply-patch-flag v0.144.0-beta",
    { entries: "046304c025a1a0ed1343d12b7cdaa6e387d4dcc521fee2986d4a3d3f8c73a4e8" },
  ],
  [
    "catalog-all apply-patch-flag cpa",
    { entries: "bf5f19d2c5dc10dca601d7c9a118c12f4021da2b31d8fd46bda6298bfa57db85" },
  ],
  [
    "overlap-providers default ",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers default 0.100.0",
    {
      entries: "08a92928104f5a68be9a0bdad34f55f33908531f53ec27184451ba6d5e9a909b",
      sha256: "672bbf602a0e1c2774cbeb47285aa1b4e5acffa72c88e3bea80eef4e400f1d28",
      size: 8028,
    },
  ],
  [
    "overlap-providers default 0.150.0",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers default v0.144.0-beta",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers default cpa",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers multi-agent-v2 ",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers multi-agent-v2 0.100.0",
    {
      entries: "08a92928104f5a68be9a0bdad34f55f33908531f53ec27184451ba6d5e9a909b",
      sha256: "672bbf602a0e1c2774cbeb47285aa1b4e5acffa72c88e3bea80eef4e400f1d28",
      size: 8028,
    },
  ],
  [
    "overlap-providers multi-agent-v2 0.150.0",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers multi-agent-v2 v0.144.0-beta",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers multi-agent-v2 cpa",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers apply-patch-flag ",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers apply-patch-flag 0.100.0",
    {
      entries: "08a92928104f5a68be9a0bdad34f55f33908531f53ec27184451ba6d5e9a909b",
      sha256: "672bbf602a0e1c2774cbeb47285aa1b4e5acffa72c88e3bea80eef4e400f1d28",
      size: 8028,
    },
  ],
  [
    "overlap-providers apply-patch-flag 0.150.0",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers apply-patch-flag v0.144.0-beta",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "overlap-providers apply-patch-flag cpa",
    {
      entries: "a51aec376a5b41c2d9a571a60a8c875fc36ec5b0dbb780bbcbeff725d8b90da9",
      sha256: "0d79c195432362871882b10a8c7853d3136841b7e3d0f8a17906a12a55b40be5",
      size: 8526,
    },
  ],
  [
    "quota-and-suspension default ",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension default 0.100.0",
    {
      entries: "09ce1810f207a6b76b667ab45942dcdd4769aff78bc816595770db7cc16ccfe2",
      sha256: "f11b3749b8538942be52886d0001c67b1866448fc95655c9c846b344dde1b158",
      size: 10736,
    },
  ],
  [
    "quota-and-suspension default 0.150.0",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension default v0.144.0-beta",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension default cpa",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension multi-agent-v2 ",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension multi-agent-v2 0.100.0",
    {
      entries: "09ce1810f207a6b76b667ab45942dcdd4769aff78bc816595770db7cc16ccfe2",
      sha256: "f11b3749b8538942be52886d0001c67b1866448fc95655c9c846b344dde1b158",
      size: 10736,
    },
  ],
  [
    "quota-and-suspension multi-agent-v2 0.150.0",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension multi-agent-v2 v0.144.0-beta",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension multi-agent-v2 cpa",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension apply-patch-flag ",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension apply-patch-flag 0.100.0",
    {
      entries: "09ce1810f207a6b76b667ab45942dcdd4769aff78bc816595770db7cc16ccfe2",
      sha256: "f11b3749b8538942be52886d0001c67b1866448fc95655c9c846b344dde1b158",
      size: 10736,
    },
  ],
  [
    "quota-and-suspension apply-patch-flag 0.150.0",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension apply-patch-flag v0.144.0-beta",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "quota-and-suspension apply-patch-flag cpa",
    {
      entries: "efe5ce6466a6fc96450c4f1738f2de032fba720bf5978bd1cf1ac0acca118518",
      sha256: "ab830e1a882ba403e8be0b5f6d31d0a402c16d87d9e7d65b73c51df2efd2046b",
      size: 11400,
    },
  ],
  [
    "custom-shapes default ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes default 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes default 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes default v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes default cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes multi-agent-v2 ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes multi-agent-v2 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes multi-agent-v2 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes multi-agent-v2 v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes multi-agent-v2 cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes apply-patch-flag ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes apply-patch-flag 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes apply-patch-flag 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes apply-patch-flag v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes apply-patch-flag cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking default ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking default 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes-no-cloaking default 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking default v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking default cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking multi-agent-v2 ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking multi-agent-v2 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes-no-cloaking multi-agent-v2 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking multi-agent-v2 v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking multi-agent-v2 cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking apply-patch-flag ",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking apply-patch-flag 0.100.0",
    {
      entries: "2ed33963ce97d2f193bd9bf42b615297d0698e776adbec0e8bbd50e8e288dbbc",
      sha256: "5fb4e8bb1c8f766a5ed65562769afc259ce0369b5ba345ddad48a2a11fa28aa4",
      size: 18808,
    },
  ],
  [
    "custom-shapes-no-cloaking apply-patch-flag 0.150.0",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking apply-patch-flag v0.144.0-beta",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
  [
    "custom-shapes-no-cloaking apply-patch-flag cpa",
    {
      entries: "baddc3ba5950caa44efe04c50a2cc3e8176be63aa324429e642e82b15f3db70c",
      sha256: "3fb44be8118676bf72b1b4dfa06a4217c519fd697fc169cfa9f497505f5dd951",
      size: 19970,
    },
  ],
]);

/** Pure Codex entries of `catalog-all` that keep the template's flags; every other entry is direct with no lite. */
const AHEAD_NATIVE_FLAGS = new Map([
  ["gpt-5.5", { tool_mode: "direct", use_responses_lite: false, effort: false }],
  ["gpt-6.1-sol", { tool_mode: "code_mode_only", use_responses_lite: true, effort: true }],
  ["gpt-6-astra", { tool_mode: "code_mode_only", use_responses_lite: true, effort: true }],
  ["gpt-6-sol", { tool_mode: "code_mode_only", use_responses_lite: true, effort: true }],
  ["gpt-6-luna", { tool_mode: "code_mode_only", use_responses_lite: true, effort: true }],
  ["gpt-5.6-sol", { tool_mode: "code_mode_only", use_responses_lite: true, effort: false }],
  ["gpt-5.6-terra", { tool_mode: "code_mode_only", use_responses_lite: true, effort: false }],
  ["gpt-5.6-luna", { tool_mode: "code_mode_only", use_responses_lite: true, effort: false }],
  ["codex-auto-review", { tool_mode: "code_mode_only", use_responses_lite: true, effort: false }],
]);

const usedAhead = new Set<string>();

const entriesDigest = async (hashes: Readonly<Record<string, string>>): Promise<string> =>
  sha256Hex(
    Object.keys(hashes)
      .toSorted()
      .map((slug) => `${slug}\t${hashes[slug]}\n`)
      .join(""),
  );

const replyFor = (scenario: (typeof fixture.scenarios)[number], request: FixtureRequest) => {
  const index = scenarioIndex(scenario);
  const models = index.availableModels(fixtureNow());
  const headers = request.headers ?? {};

  const info = {
    userAgent: headers["User-Agent"] ?? "",
    anthropicVersion: headers["Anthropic-Version"] ?? "",
    clientVersion: undefined,
  };

  const options = { disableCloaking: scenario.disableCloaking === true, codexClient: () => ({}) };

  if (request.path.startsWith("/v1beta/models/")) {
    return respondGeminiDetail(models, request.path.slice("/v1beta/models/".length));
  }

  if (request.path === "/v1beta/models") return respondGeminiList(models);

  const rest = request.path.startsWith("/v1/models/")
    ? request.path.slice("/v1/models/".length)
    : undefined;

  return respondModels(models, info, options, rest);
};

/** Lists whose order is Go map-iteration order are compared after sorting. */
const UNORDERED = new Map([
  ["openai list", { data: "id" }],
  ["gemini list", { models: "name" }],
]);

describe("listing parity with the Go handlers", () => {
  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      it.each(scenario.requests.map((request) => [request.name, request] as const))(
        "%s",
        (_name, request) => {
          const reply = replyFor(scenario, request);
          expect(reply.status).toBe(request.status);
          const sort = UNORDERED.get(request.name);

          // Structural: key order and HTML escaping are not part of the contract.
          expect(sortedBody(reply.body, sort ?? {})).toEqual(sortedBody(request.body, sort ?? {}));
        },
      );
    });
  }
});

describe("Claude ID cloaking", () => {
  it("cloaks ids without the claude- prefix and reverses by code points", () => {
    expect(ensureClaudeModelIdPrefix("gpt-5")).toBe("claude-fable-5-dd-5-tpg");
    expect(ensureClaudeModelIdPrefix("claude-opus")).toBe("claude-opus");
    expect(ensureClaudeModelIdPrefix("")).toBe("");
    expect(ensureClaudeModelIdPrefix("模型-1")).toBe("claude-fable-5-dd-1-型模");
  });

  it("resolves cloaked ids and keeps a thinking suffix", () => {
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg")).toBe("gpt-5");
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-5-tpg(high)")).toBe("gpt-5(high)");
    expect(resolveClaudeModelIdPrefix("claude-fable-5-dd-")).toBe("claude-fable-5-dd-");
    expect(resolveClaudeModelIdPrefix("gpt-5")).toBe("gpt-5");
  });
});

describe("Codex client catalog (client_version) parity with Go", () => {
  const SUMMARY_KEYS = [
    "slug",
    "priority",
    "display_name",
    "description",
    "supported_reasoning_levels",
    "default_reasoning_level",
    "input_modalities",
    "supports_image_detail_original",
    "visibility",
    "apply_patch_tool_type",
    "supports_search_tool",
    "prefer_websockets",
    "multi_agent_version",
    "cpa_capabilities",
    "context_window",
    "max_context_window",
    "max_tokens",
    "service_tiers",
    "available_in_plans",
    "upgrade",
    "availability_nux",
  ];

  for (const scenario of fixture.scenarios) {
    describe(scenario.name, () => {
      const index = scenarioIndex(scenario);

      const build = (variant: string, clientVersion: string) =>
        buildCodexClientModels({
          catalog: catalogs.codexClient,
          models: index.availableModels(fixtureNow()),
          providersForModel: (id) => index.providersForModel(id),
          lookupModelInfo: (id, provider = "") => index.lookupModelInfo(catalogs, id, provider),
          webSearchCapability: (id) => index.responsesWebSearchCapability(id),
          // The Go harness has no auth manager: the flag makes every model unsupported.
          ...(variant === "apply-patch-flag" ? { applyPatchCapability: () => false } : {}),
          optimizeMultiAgentV2: variant === "multi-agent-v2",
          clientVersion,
        });

      it.each(
        scenario.codexClient.map(
          (result) => [`${result.variant} ${result.version || "(empty)"}`, result] as const,
        ),
      )("%s", async (_name, result) => {
        expect(result.status).toBe(200);
        const payload = build(result.variant, result.version);
        const entries = (payload.models ?? []) as JsonObject[];
        const actualHashes: Record<string, string> = {};

        for (const entry of entries)
          actualHashes[entry.slug as string] = await sha256Hex(goCompactBytes(entry));

        const caseKey = `${scenario.name} ${result.variant} ${result.version}`;
        const ahead = AHEAD_OF_FIXTURE.get(caseKey);

        if (ahead !== undefined) {
          usedAhead.add(caseKey);
          // The case must still differ from the fixture, or the entry is stale.
          expect(await entriesDigest(result.entries)).not.toBe(ahead.entries);
          expect(await entriesDigest(actualHashes)).toBe(ahead.entries);

          for (const entry of entries) {
            const native =
              scenario.name === "catalog-all"
                ? AHEAD_NATIVE_FLAGS.get(entry.slug as string)
                : undefined;

            expect(
              [
                entry.tool_mode,
                entry.use_responses_lite,
                entry.supports_reasoning_effort_updates,
                entry.supports_image_detail_original === true,
              ],
              entry.slug as string,
            ).toEqual(
              native === undefined
                ? ["direct", false, false, false]
                : [native.tool_mode, native.use_responses_lite, native.effort, true],
            );
          }
        } else {
          // Readable first: per-model summaries where the fixture keeps them.
          if ((result.models ?? []).length > 0) {
            const summary = entries.map((entry) =>
              Object.fromEntries(
                SUMMARY_KEYS.map((key) => [
                  key,
                  entry[key] === undefined ? "<absent>" : entry[key],
                ]),
              ),
            );

            expect(
              summary.toSorted((a, b) => asString(a.slug).localeCompare(asString(b.slug))),
            ).toEqual(
              (result.models ?? []).toSorted((a, b) =>
                String(a.slug).localeCompare(String(b.slug)),
              ),
            );
          }

          expect(actualHashes).toEqual(result.entries);
        }

        const priorities = entries.map((entry) =>
          typeof entry.priority === "number" ? entry.priority : 100,
        );

        expect(priorities).toEqual(priorities.toSorted((a, b) => a - b));

        // Ties follow Go's map iteration order; scenarios without ties must match the whole body.
        if (scenario.name !== "catalog-all") {
          const wantSha = ahead?.sha256 ?? result.sha256;
          const wantSize = ahead?.size ?? result.size;

          expect(await sha256Hex(goCompactBytes(payload))).toBe(wantSha);
          expect(new TextEncoder().encode(goCompactBytes(payload)).length).toBe(wantSize);
        }
      });
    });
  }

  it("consumed every ahead-of-fixture Codex client entry", () => {
    expect([...AHEAD_OF_FIXTURE.keys()].filter((key) => !usedAhead.has(key))).toEqual([]);
  });

  it("answers the client_version route with the compact catalog and exposes apply_patch support rules", () => {
    expect(supportsApplyPatchProviders(["codex", "claude"])).toBe(true);
    expect(supportsApplyPatchProviders(["codex", "aistudio"])).toBe(false);
    expect(supportsApplyPatchProviders([])).toBe(false);
    expect(supportsApplyPatchProviders(["openai-compatible-foo"])).toBe(true);
  });
});
