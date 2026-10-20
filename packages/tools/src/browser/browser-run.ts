/**
 * Browser Run, Cloudflare's browser (ADR 0039, ADR 0041), as a browser provider: the deployment's own `browser` binding
 * and its `quickAction()` (no Cloudflare API token). Each Quick Action of the toolkit is one call of the binding with
 * Browser Run's options built from the client's arguments (`provider.ts`), with its cache off (`cacheTTL: 0`): results
 * go back to the client and are kept nowhere, Browser Run's cache included.
 *
 * A failure is Browser Run's own message about the page (its `errors`), or a short one of Commissary's when it could not
 * be reached or answered something unreadable. A screenshot or PDF larger than {@link MAX_FILE_BYTES} is refused rather
 * than returned, as a tool result travels in one JSON answer.
 */
import { Effect, Schema } from "effect";
import {
  BrowserProviderError,
  type BrowserProvider,
  type PageArguments,
  type QuickActionArguments,
  type QuickActionName,
  type QuickActionResult,
} from "./provider.ts";

/** The provider's id: the browser toolkit's source. */
export const BROWSER_RUN = "browser-run";

/** What the adapter uses of Browser Run's binding (`BrowserRun`, the Workers runtime types). */
export type BrowserRunBinding = Pick<BrowserRun, "quickAction">;

/** The largest screenshot or PDF returned (base64 grows it by a third in the answer). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** How long one Quick Action may take: the page's navigation, its waits and the action. */
const QUICK_ACTION_TIMEOUT = "3 minutes";

/** The longest message of Browser Run's that is passed on. */
const MAX_MESSAGE_LENGTH = 500;

/** `value` without the keys whose values are undefined (`exactOptionalPropertyTypes`). */
const compact = <T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  // SAFETY: the entries kept are `value`'s own, minus those that are undefined.
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** Browser Run's options for loading the page, never from its cache. */
const pageOptions = (args: PageArguments) => ({
  url: args.url,
  cacheTTL: 0,
  ...(args.waitUntil === undefined && args.timeout === undefined
    ? {}
    : { gotoOptions: compact({ waitUntil: args.waitUntil, timeout: args.timeout }) }),
  ...(args.waitForSelector === undefined
    ? {}
    : { waitForSelector: { selector: args.waitForSelector } }),
  ...(args.viewport === undefined
    ? {}
    : {
        viewport: {
          width: args.viewport.width,
          height: args.viewport.height,
          ...compact({
            deviceScaleFactor: args.viewport.deviceScaleFactor,
            isMobile: args.viewport.isMobile,
          }),
        },
      }),
  ...(args.rejectResourceTypes === undefined
    ? {}
    : { rejectResourceTypes: [...args.rejectResourceTypes] }),
  ...compact({
    waitForTimeout: args.waitForTimeout,
    userAgent: args.userAgent,
    setJavaScriptEnabled: args.javaScriptEnabled,
  }),
});

const ErrorBody = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.String })),
});

const TextBody = Schema.Struct({ result: Schema.String });

const JsonBody = Schema.Struct({ result: Schema.Json });

const AccessibilityTreeBody = Schema.Struct({
  result: Schema.Struct({ accessibilityTree: Schema.Json }),
});

const fail = (message: string, status?: number) =>
  new BrowserProviderError({
    message,
    ...(status === undefined ? {} : { status }),
  });

const unreadable = (status: number) =>
  fail("Browser Run answered something Commissary could not read", status);

/** The JSON body of `response`, decoded with `schema`. */
const decoded = <S extends Schema.Decoder<unknown>>(response: Response, schema: S) =>
  Effect.tryPromise({
    try: () => response.json(),
    catch: () => unreadable(response.status),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(() => unreadable(response.status)),
      ),
    ),
  );

/** Browser Run's own words about a refused or failed action. */
const refusal = (response: Response) =>
  decoded(response, ErrorBody).pipe(
    Effect.map(({ errors }) => errors.map((error) => error.message).join("; ")),
    Effect.orElseSucceed(() => ""),
    Effect.flatMap((message) =>
      Effect.fail(
        fail(
          message === ""
            ? `Browser Run answered ${response.status}`
            : message.slice(0, MAX_MESSAGE_LENGTH),
          response.status,
        ),
      ),
    ),
  );

/** Stops reading a body; a stream that fails to cancel is left to the runtime, never a defect. */
const cancel = (stream: { cancel(): Promise<void> }) =>
  Effect.tryPromise(() => stream.cancel()).pipe(Effect.ignore);

/**
 * The bytes of `response`'s body, read chunk by chunk and given up (the rest cancelled) as soon as they pass
 * {@link MAX_FILE_BYTES}: an oversized file is never held whole.
 */
const cappedBody = (response: Response, tooLarge: BrowserProviderError) =>
  Effect.gen(function* () {
    if (response.body === null) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Array<Uint8Array> = [];
    let size = 0;

    for (;;) {
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(),
        catch: () => unreadable(response.status),
      }).pipe(Effect.onInterrupt(() => cancel(reader)));

      if (chunk.done) break;
      size += chunk.value.byteLength;

      if (size > MAX_FILE_BYTES) {
        yield* cancel(reader);

        return yield* tooLarge;
      }

      chunks.push(chunk.value);
    }

    const data = new Uint8Array(size);
    let offset = 0;

    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return data;
  });

/** A screenshot or PDF, at most {@link MAX_FILE_BYTES}. */
const file = (response: Response, fallbackType: string) =>
  Effect.gen(function* () {
    const tooLarge = fail(`the file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MiB`);

    if (Number(response.headers.get("content-length") ?? "0") > MAX_FILE_BYTES) {
      if (response.body !== null) yield* cancel(response.body);

      return yield* tooLarge;
    }

    const data = yield* cappedBody(response, tooLarge);
    const mimeType = (response.headers.get("content-type") ?? fallbackType).split(";")[0]?.trim();

    return {
      kind: "file",
      mimeType: mimeType === undefined || mimeType === "" ? fallbackType : mimeType,
      data,
    } satisfies QuickActionResult;
  });

const text = (response: Response) =>
  decoded(response, TextBody).pipe(
    Effect.map(({ result }): QuickActionResult => ({ kind: "text", text: result })),
  );

const json = (response: Response) =>
  decoded(response, JsonBody).pipe(
    Effect.map(({ result }): QuickActionResult => ({ kind: "json", value: result })),
  );

/** The binding's actions and the options each takes (`BrowserRun.quickAction`'s overloads). */
interface BindingOptions {
  readonly markdown: BrowserRunMarkdownOptions;
  readonly content: BrowserRunContentOptions;
  readonly screenshot: BrowserRunScreenshotOptions;
  readonly pdf: BrowserRunPDFOptions;
  readonly links: BrowserRunLinksOptions;
  readonly scrape: BrowserRunScrapeOptions;
  readonly accessibilityTree: BrowserRunAccessibilityTreeOptions;
}

/**
 * How Browser Run does the Quick Action `K`: the binding's action, its options built from the client's arguments, and
 * what its successful answer holds, decoded. One per binding action, so an action is always asked with its own options.
 */
type BrowserRunAction<K extends QuickActionName> = {
  readonly [A in keyof BindingOptions]: {
    readonly action: A;
    readonly options: (args: QuickActionArguments<K>) => BindingOptions[A];
    readonly result: (
      response: Response,
      args: QuickActionArguments<K>,
    ) => Effect.Effect<QuickActionResult, BrowserProviderError>;
  };
}[keyof BindingOptions];

/** How Browser Run does every Quick Action, one record each. */
type BrowserRunActions = { readonly [K in QuickActionName]: BrowserRunAction<K> };

/** Each Quick Action as Browser Run does it. */
const ACTIONS: BrowserRunActions = {
  markdown: { action: "markdown", options: pageOptions, result: text },
  html: { action: "content", options: pageOptions, result: text },
  screenshot: {
    action: "screenshot",
    options: (args) => ({
      ...pageOptions(args),
      ...compact({ selector: args.selector }),
      screenshotOptions: {
        ...compact({ fullPage: args.fullPage, type: args.type, quality: args.quality }),
        encoding: "binary",
      },
    }),
    result: (response, args) => file(response, `image/${args.type ?? "png"}`),
  },
  pdf: {
    action: "pdf",
    options: (args) => {
      const { format, landscape, printBackground, scale, pageRanges } = args;

      return {
        ...pageOptions(args),
        pdfOptions: compact({ format, landscape, printBackground, scale, pageRanges }),
      };
    },
    result: (response) => file(response, "application/pdf"),
  },
  links: {
    action: "links",
    options: (args) => ({
      ...pageOptions(args),
      ...compact({
        visibleLinksOnly: args.visibleLinksOnly,
        excludeExternalLinks: args.excludeExternalLinks,
      }),
    }),
    result: json,
  },
  scrape: {
    action: "scrape",
    options: (args) => ({
      ...pageOptions(args),
      elements: args.selectors.map((selector) => ({ selector })),
    }),
    result: json,
  },
  accessibility_tree: {
    action: "accessibilityTree",
    options: (args) => ({
      ...pageOptions(args),
      ...compact({ root: args.root, interestingOnly: args.interestingOnly }),
    }),
    result: (response) =>
      decoded(response, AccessibilityTreeBody).pipe(
        Effect.map(({ result }): QuickActionResult => ({
          kind: "json",
          value: result.accessibilityTree,
        })),
      ),
  },
};

/** Asks `binding` for the Quick Action `action` with `args`, and decodes its answer. */
const run = <K extends QuickActionName>(
  binding: BrowserRunBinding,
  action: K,
  args: QuickActionArguments<K>,
) =>
  Effect.gen(function* () {
    const entry: BrowserRunAction<K> = ACTIONS[action];

    // SAFETY: an entry pairs a binding action with that action's options (`BrowserRunAction`), as the overloads do.
    const quickAction = binding.quickAction.bind(binding) as (
      action: keyof BindingOptions,
      options: BindingOptions[keyof BindingOptions],
    ) => Promise<Response>;

    const response = yield* Effect.tryPromise({
      try: () => quickAction(entry.action, entry.options(args)),
      catch: () => fail("Browser Run could not be reached"),
    });

    if (!response.ok) return yield* refusal(response);

    return yield* entry.result(response, args);
  });

/** Browser Run behind the deployment's `browser` binding, as a {@link BrowserProvider}. */
export const browserRun = (binding: BrowserRunBinding): BrowserProvider => ({
  id: BROWSER_RUN,
  quickAction: (request) =>
    run(binding, request.action, request.args).pipe(
      Effect.timeoutOrElse({
        duration: QUICK_ACTION_TIMEOUT,
        orElse: () =>
          Effect.fail(fail(`Browser Run did not answer within ${QUICK_ACTION_TIMEOUT}`)),
      }),
    ),
});
