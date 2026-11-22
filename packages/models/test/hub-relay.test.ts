// The relayed call's token redaction (src/hub/relay.ts, ADR 0052): the token as it is, JSON-escaped and URL-encoded.
import { describe, expect, it } from "vite-plus/test";
import { REDACTED, redactToken } from "../src/hub/relay.ts";

describe("redactToken", () => {
  it("replaces every copy of the token", () => {
    expect(redactToken("a tok-1 b tok-1", "tok-1")).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("replaces the token as JSON escapes it and as a URL encodes it", () => {
    const token = 'ab"c\\d/e+f=g';
    const json = JSON.stringify(token).slice(1, -1);
    const url = encodeURIComponent(token);

    expect(json).not.toBe(token);
    expect(url).not.toBe(token);
    expect(redactToken(`${token}|${json}|${url}`, token)).toBe(
      `${REDACTED}|${REDACTED}|${REDACTED}`,
    );
  });

  it("leaves the text alone for an empty token", () => {
    expect(redactToken("text", "")).toBe("text");
  });
});
