// Log-safe cause summaries.
import { Cause, Data } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { causeSummary, redactUrls } from "../src/index.ts";

class CatalogError extends Data.TaggedError("CatalogError")<{ readonly message: string }> {}

describe("causeSummary", () => {
  it("keeps the tag and message but drops stacks and URL queries", () => {
    const error = new Error(
      "GET https://cloudcode-pa.googleapis.com/v1:fetch?key=SECRET&alt=json failed",
    );

    const summary = causeSummary(Cause.fail(error));
    expect(summary).toBe("Error: GET https://cloudcode-pa.googleapis.com/v1:fetch?… failed");
    expect(summary).not.toContain("SECRET");
    expect(summary).not.toContain("at ");
    expect(causeSummary(Cause.fail(new CatalogError({ message: "bad" })))).toBe(
      "CatalogError: bad",
    );
    expect(causeSummary(Cause.interrupt())).toBe("interrupted");
    expect(causeSummary(Cause.die("x".repeat(500))).length).toBeLessThanOrEqual(301);
    expect(redactUrls("see http://a.test/p#frag and https://b.test/q")).toBe(
      "see http://a.test/p?… and https://b.test/q",
    );
  });
});
