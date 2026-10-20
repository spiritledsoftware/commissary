/**
 * The browser toolkit's tools (ADR 0039, #212): Browser Run's stateless Quick Actions, as Commissary lists and calls them
 * whatever browser provider is behind the toolkit (`provider.ts`). Each is one of `QUICK_ACTIONS`: its description,
 * and its arguments (a URL and options), which are also its input schema. Commissary sets their class: every Quick
 * Action reads.
 *
 * A call decodes the client's arguments, asks the provider, and answers an MCP tool result: the page as text (Markdown,
 * HTML, or JSON for links, scraped elements and the accessibility tree), a screenshot as an image, a PDF as an embedded
 * resource. Invalid arguments and the provider's failures are tool results with `isError`, so the model can correct
 * itself. Nothing of a result is kept. A call answers the browser time the provider says it used (#214), a failed one's
 * too, for its usage record and the toolkit's price per browser hour.
 */
import { Buffer } from "node:buffer";
import { Effect, Result, Schema } from "effect";
import { browserTimeCost, type Timed, untimed } from "./browser-time.ts";
import {
  type BrowserProvider,
  QUICK_ACTION_NAMES,
  QUICK_ACTIONS,
  type QuickActionName,
  type QuickActionRequest,
  type QuickActionResult,
} from "./provider.ts";

/** A tool of the browser toolkit as its tool list holds it. */
export interface BrowserTool {
  /** Its upstream name (the full name is `browser_<name>`). */
  readonly name: QuickActionName;
  readonly description: string;
  readonly inputSchema: Schema.JsonObject;
  /** Every Quick Action reads (ADR 0038): `readOnlyHint`, which gives it the class `read`. */
  readonly annotations: Schema.JsonObject;
}

/** The browser toolkit's tools, in the order it lists them. */
export const BROWSER_TOOLS: ReadonlyArray<BrowserTool> = QUICK_ACTION_NAMES.map((name) => ({
  name,
  description: QUICK_ACTIONS[name].description,
  // SAFETY: a JSON Schema document's schema is a JSON object.
  inputSchema: Schema.toJsonSchemaDocument(QUICK_ACTIONS[name].arguments)
    .schema as Schema.JsonObject,
  annotations: { readOnlyHint: true },
}));

/** Whether `name` is the upstream name of a Quick Action. */
export const isQuickAction = (name: string): name is QuickActionName =>
  Object.hasOwn(QUICK_ACTIONS, name);

/** A tool result that reports a failure to the model. */
const toolError = (text: string): Schema.JsonObject => ({
  content: [{ type: "text", text }],
  isError: true,
});

/** The request of a call of `action` with `args`, or why the arguments are invalid. */
const requestOf = (
  action: QuickActionName,
  args: Schema.JsonObject,
): Result.Result<QuickActionRequest, string> => {
  const decoded = Schema.decodeUnknownResult(QUICK_ACTIONS[action].arguments)(args);

  return Result.isFailure(decoded)
    ? Result.fail(decoded.failure.message)
    : // SAFETY: the arguments were decoded with the schema of `action`.
      Result.succeed({ action, args: decoded.success } as QuickActionRequest);
};

/** A Quick Action's result as an MCP tool result. */
const rendered = (result: QuickActionResult, url: string): Schema.JsonObject => {
  switch (result.kind) {
    case "text":
      return { content: [{ type: "text", text: result.text }] };
    case "json":
      return { content: [{ type: "text", text: JSON.stringify(result.value) }] };
    case "file": {
      const data = Buffer.from(result.data).toString("base64");

      return result.mimeType.startsWith("image/")
        ? { content: [{ type: "image", data, mimeType: result.mimeType }] }
        : {
            content: [
              { type: "resource", resource: { uri: url, mimeType: result.mimeType, blob: data } },
            ],
          };
    }
  }
};

/** `result` with the browser time `browserMs` the provider reported for its call, costed at `hourPriceMicros`. */
const timed = (
  result: Schema.JsonObject,
  browserMs: number | undefined,
  hourPriceMicros: number,
): Timed =>
  browserMs === undefined
    ? untimed(result)
    : {
        result,
        browserTime: { browserMs, costMicros: browserTimeCost(browserMs, hourPriceMicros) },
      };

/**
 * Calls the browser tool `name` (its upstream name) with the client's arguments on `provider`, with the browser time
 * the provider says the call used, a failed one's too, costed at the toolkit's price per browser hour `hourPriceMicros`
 * (#214). Never fails: an unknown tool, invalid arguments and the provider's failures are tool results with `isError`.
 */
export const callBrowserTool = (
  provider: BrowserProvider,
  name: string,
  args: Schema.JsonObject | undefined,
  hourPriceMicros: number,
): Effect.Effect<Timed> => {
  if (!isQuickAction(name))
    return Effect.succeed(untimed(toolError(`The browser has no tool ${name}.`)));
  const request = requestOf(name, args ?? {});

  if (Result.isFailure(request))
    return Effect.succeed(untimed(toolError(`Invalid arguments: ${request.failure}`)));

  return provider.quickAction(request.success).pipe(
    Effect.map(({ result, browserMs }) =>
      timed(rendered(result, request.success.args.url), browserMs, hourPriceMicros),
    ),
    Effect.catchTag("BrowserProviderError", (error) =>
      Effect.logWarning("browser quick action failed").pipe(
        Effect.annotateLogs({
          provider: provider.id,
          action: name,
          ...(error.status === undefined ? {} : { status: error.status }),
        }),
        Effect.as(timed(toolError(error.message), error.browserMs, hourPriceMicros)),
      ),
    ),
  );
};
