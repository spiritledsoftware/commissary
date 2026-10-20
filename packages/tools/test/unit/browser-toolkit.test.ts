// The browser toolkit's tools (#212) over Browser Run's adapter and a fake `browser` binding: the Quick Actions it lists,
// the options a call asks Browser Run for, and the MCP tool results it answers, invalid arguments, Browser Run's
// refusals, oversized files and a Browser Run that does not answer (driven by TestClock) included.
import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, type Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  browserRun,
  type BrowserRunBinding,
  MAX_FILE_BYTES,
} from "../../src/browser/browser-run.ts";
import { BROWSER_TOOLS, callBrowserTool } from "../../src/browser/toolkit.ts";
import { fakeBrowserRun, PDF_BYTES, PNG_BYTES } from "../support/fake-browser.ts";

const call = (binding: BrowserRunBinding, tool: string, args?: Schema.JsonObject) =>
  callBrowserTool(browserRun(binding), tool, args);

/** A binding that answers every Quick Action with `answer()`. */
const answering = (answer: () => Promise<Response>): BrowserRunBinding => ({
  // SAFETY: one implementation answers every overload of `quickAction`.
  quickAction: answer as BrowserRunBinding["quickAction"],
});

const TOO_LARGE = {
  content: [{ type: "text", text: "the file is larger than 10 MiB" }],
  isError: true,
};

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

describe("the browser toolkit's tools", () => {
  it("are Browser Run's Quick Actions, each reading a page by its URL", () => {
    expect(BROWSER_TOOLS.map((tool) => tool.name)).toEqual([
      "markdown",
      "html",
      "screenshot",
      "pdf",
      "links",
      "scrape",
      "accessibility_tree",
    ]);

    for (const tool of BROWSER_TOOLS) {
      expect(tool.annotations).toEqual({ readOnlyHint: true });
      expect(tool.inputSchema["type"]).toBe("object");
      expect(tool.inputSchema["required"]).toContain("url");
    }

    const scrape = BROWSER_TOOLS.find((tool) => tool.name === "scrape");

    expect(scrape?.inputSchema["required"]).toEqual(["url", "selectors"]);
  });

  it.effect(
    "asks Browser Run for the page as Markdown, never from its cache, and answers it as text",
    () =>
      Effect.gen(function* () {
        const binding = fakeBrowserRun();

        const result = yield* call(binding, "markdown", {
          url: "https://example.com/docs",
          waitUntil: "networkidle0",
          timeout: 10_000,
          waitForSelector: "main",
          viewport: { width: 800, height: 600 },
          rejectResourceTypes: ["image", "font"],
          javaScriptEnabled: false,
        });

        expect(result).toEqual({
          content: [{ type: "text", text: "# Page at https://example.com/docs" }],
        });
        expect(binding.calls).toEqual([
          {
            action: "markdown",
            options: {
              url: "https://example.com/docs",
              cacheTTL: 0,
              gotoOptions: { waitUntil: "networkidle0", timeout: 10_000 },
              waitForSelector: { selector: "main" },
              viewport: { width: 800, height: 600 },
              rejectResourceTypes: ["image", "font"],
              setJavaScriptEnabled: false,
            },
          },
        ]);
      }),
  );

  it.effect("answers HTML, links, scraped elements and the accessibility tree", () =>
    Effect.gen(function* () {
      const binding = fakeBrowserRun();
      const url = "https://example.com";

      expect(yield* call(binding, "html", { url })).toEqual({
        content: [{ type: "text", text: "<html><body>Page at https://example.com</body></html>" }],
      });

      expect(yield* call(binding, "links", { url, excludeExternalLinks: true })).toEqual({
        content: [{ type: "text", text: '["https://example.com/a","https://example.com/b"]' }],
      });

      const scraped = yield* call(binding, "scrape", { url, selectors: ["h1", ".price"] });

      // SAFETY: the toolkit answers scraped elements as one text content.
      expect(JSON.parse(String((scraped["content"] as Array<{ text: string }>)[0]?.text))).toEqual([
        { selector: "h1", results: [{ text: "h1 text", html: "", attributes: [] }] },
        { selector: ".price", results: [{ text: ".price text", html: "", attributes: [] }] },
      ]);

      expect(yield* call(binding, "accessibility_tree", { url, root: "main" })).toEqual({
        content: [{ type: "text", text: '{"role":"RootWebArea","name":"https://example.com"}' }],
      });

      expect(binding.calls.map(({ action, options }) => ({ action, options }))).toEqual([
        { action: "content", options: { url, cacheTTL: 0 } },
        { action: "links", options: { url, cacheTTL: 0, excludeExternalLinks: true } },
        {
          action: "scrape",
          options: { url, cacheTTL: 0, elements: [{ selector: "h1" }, { selector: ".price" }] },
        },
        { action: "accessibilityTree", options: { url, cacheTTL: 0, root: "main" } },
      ]);
    }),
  );

  it.effect("answers a screenshot as an image and a PDF as an embedded resource", () =>
    Effect.gen(function* () {
      const binding = fakeBrowserRun();
      const url = "https://example.com/report";

      expect(yield* call(binding, "screenshot", { url, fullPage: true, type: "png" })).toEqual({
        content: [{ type: "image", data: base64(PNG_BYTES), mimeType: "image/png" }],
      });

      expect(yield* call(binding, "pdf", { url, format: "a0", landscape: true })).toEqual({
        content: [
          {
            type: "resource",
            resource: { uri: url, mimeType: "application/pdf", blob: base64(PDF_BYTES) },
          },
        ],
      });

      expect(binding.calls.map((recorded) => recorded.options)).toEqual([
        {
          url,
          cacheTTL: 0,
          screenshotOptions: { fullPage: true, type: "png", encoding: "binary" },
        },
        { url, cacheTTL: 0, pdfOptions: { format: "a0", landscape: true } },
      ]);
    }),
  );

  it.effect("refuses invalid arguments as a tool error, without asking Browser Run", () =>
    Effect.gen(function* () {
      const binding = fakeBrowserRun();

      for (const args of [
        undefined,
        { url: "ftp://example.com/file" },
        { url: "https://example.com", timeout: 600_000 },
      ]) {
        const result = yield* call(binding, "markdown", args);

        expect(result["isError"]).toBe(true);
        expect(JSON.stringify(result)).toContain("Invalid arguments");
      }

      expect(
        (yield* call(binding, "scrape", { url: "https://example.com", selectors: [] }))["isError"],
      ).toBe(true);
      expect(yield* call(binding, "crawl", { url: "https://example.com" })).toEqual({
        content: [{ type: "text", text: "The browser has no tool crawl." }],
        isError: true,
      });
      expect(binding.calls).toEqual([]);
    }),
  );

  it.effect("answers Browser Run's refusal as a tool error in its own words", () =>
    Effect.gen(function* () {
      const result = yield* call(fakeBrowserRun(), "markdown", {
        url: "https://unreachable.invalid/",
      });

      expect(result).toEqual({
        content: [
          { type: "text", text: "net::ERR_NAME_NOT_RESOLVED at https://unreachable.invalid/" },
        ],
        isError: true,
      });
    }),
  );

  it.effect("refuses a screenshot larger than it returns", () =>
    Effect.gen(function* () {
      const binding = fakeBrowserRun(new Uint8Array(MAX_FILE_BYTES + 1));

      expect(yield* call(binding, "screenshot", { url: "https://example.com" })).toEqual(TOO_LARGE);
    }),
  );

  it.effect(
    "stops reading a file without a length once it passes 10 MiB, and cancels the rest",
    () =>
      Effect.gen(function* () {
        const chunk = new Uint8Array(1024 * 1024);
        let pulled = 0;
        let cancelled = false;

        // An endless PDF: reading it whole would never end.
        const body = new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              pulled++;
              controller.enqueue(chunk);
            },
            cancel: () => {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );

        const binding = answering(
          async () => new Response(body, { headers: { "content-type": "application/pdf" } }),
        );

        expect(yield* call(binding, "pdf", { url: "https://example.com" })).toEqual(TOO_LARGE);
        expect(pulled).toBe(11);
        expect(cancelled).toBe(true);
      }),
  );

  it.effect(
    "refuses a file whose declared length is too large without reading it, even when cancelling fails",
    () =>
      Effect.gen(function* () {
        let pulled = 0;

        const body = new ReadableStream<Uint8Array>(
          {
            pull: (controller) => {
              pulled++;
              controller.enqueue(new Uint8Array(1));
            },
            cancel: () => Promise.reject(new Error("the stream is gone")),
          },
          { highWaterMark: 0 },
        );

        const binding = answering(
          async () =>
            new Response(body, {
              headers: {
                "content-type": "image/png",
                "content-length": String(MAX_FILE_BYTES + 1),
              },
            }),
        );

        expect(yield* call(binding, "screenshot", { url: "https://example.com" })).toEqual(
          TOO_LARGE,
        );
        expect(pulled).toBe(0);
      }),
  );

  it.effect("gives Browser Run three minutes to answer, then answers a tool error", () =>
    Effect.gen(function* () {
      const binding = answering(() => new Promise<Response>(() => {}));

      const fiber = yield* call(binding, "markdown", { url: "https://example.com" }).pipe(
        Effect.forkChild,
      );

      yield* TestClock.adjust("179 seconds");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("1 second");
      expect(yield* Fiber.join(fiber)).toEqual({
        content: [{ type: "text", text: "Browser Run did not answer within 3 minutes" }],
        isError: true,
      });
    }),
  );
});
