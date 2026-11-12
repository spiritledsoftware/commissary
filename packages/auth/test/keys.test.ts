// The text of API keys and management keys (ADR 0022, ADR 0026): what a key names, how much secret it carries, and
// that it parses back. Moved from the Worker's api-keys.test.ts.
import { OrgId } from "@commissary/core";
import { describe, expect, it } from "vite-plus/test";
import { mintApiKey, parseApiKey } from "../src/index.ts";

describe("the key text", () => {
  it("names its org and id, carries at least 256 bits of secret, and parses back", () => {
    const org = OrgId.make("acme-1");
    const minted = mintApiKey(org);
    const [, orgPart, id, secret] = /^cms_([a-z0-9-]+)_([0-9a-f]{20})_(.+)$/.exec(minted.key) ?? [];

    expect(orgPart).toBe("acme-1");
    expect(id).toBe(minted.keyId);
    // base64url: 6 bits per character.
    expect((secret ?? "").length * 6).toBeGreaterThanOrEqual(256);
    expect(minted.prefix).toBe(`cms_acme-1_${minted.keyId}_${(secret ?? "").slice(0, 4)}`);
    expect(parseApiKey(minted.key)).toEqual({ org, keyId: minted.keyId, hash: minted.hash });
    expect(mintApiKey(org).key).not.toBe(minted.key);

    for (const malformed of [
      "cms_",
      "cms_acme-1",
      `cms_acme-1_${minted.keyId}`,
      `cms_Acme_${minted.keyId}_${secret}`,
      `cms_acme-1_${minted.keyId.slice(1)}_${secret}`,
      `cms_acme-1_${minted.keyId}_${(secret ?? "").slice(1)}`,
      `sk-${minted.key}`,
    ])
      expect(parseApiKey(malformed), malformed).toBeUndefined();
  });
});
