// Responses stream output synthesis (Go: internal/runtime/executor/helps/responses_completed_synthesis_test.go;
// upstream ca459712, e442c32d, 2e940ba1).
import { describe, expect, it } from "vite-plus/test";
import { asString, type JsonObject } from "@commissary/json";
import { hasMeaningfulOutputDelta } from "../../src/executor/codex/output.ts";
import { ResponsesStreamOutputTracker } from "../../src/executor/helps/responses-synthesis.ts";

const REFUSAL = "I'm sorry, but I can't help with that request.";

const refusalMessage = (id = "msg_1"): JsonObject => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "refusal", refusal: REFUSAL }],
});

const textMessage = (id: string, text: string): JsonObject => ({
  id,
  type: "message",
  role: "assistant",
  content: [{ type: "output_text", text }],
});

const terminal = (output: JsonObject[], type = "response.completed"): JsonObject => ({
  type,
  sequence_number: 3,
  response: { id: "resp_1", status: "completed", output },
});

const types = (events: ReadonlyArray<JsonObject>) => events.map((event) => event["type"]);

describe("ResponsesStreamOutputTracker", () => {
  it("synthesises an unstreamed refusal and moves the terminal sequence past it", () => {
    const tracker = new ResponsesStreamOutputTracker();
    tracker.observe({ type: "response.created", sequence_number: 0 });
    tracker.observe({ type: "response.in_progress", sequence_number: 1 });

    const { events, terminal: last } = tracker.synthesize(terminal([refusalMessage()]));

    expect(types(events)).toEqual([
      "response.output_item.added",
      "response.content_part.added",
      "response.refusal.delta",
      "response.refusal.done",
      "response.content_part.done",
      "response.output_item.done",
    ]);
    expect(events.map((event) => event["sequence_number"])).toEqual([2, 3, 4, 5, 6, 7]);
    expect(events[0]).toMatchObject({
      output_index: 0,
      item: { id: "msg_1", status: "in_progress", content: [] },
    });
    expect(events[1]).toMatchObject({
      item_id: "msg_1",
      content_index: 0,
      part: { type: "refusal", refusal: "" },
    });
    expect(events[2]).toMatchObject({ item_id: "msg_1", delta: REFUSAL });
    expect(events[3]).toMatchObject({ refusal: REFUSAL });
    expect(events[5]).toMatchObject({ item: refusalMessage() });
    expect(last["sequence_number"]).toBe(8);
  });

  it("skips streamed items and synthesises the rest", () => {
    const tracker = new ResponsesStreamOutputTracker();
    tracker.observe({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "a",
    });

    const { events } = tracker.synthesize(
      terminal([textMessage("msg_1", "a"), textMessage("msg_2", "b")]),
    );

    expect(events.every((event) => event["output_index"] === 1)).toBe(true);
    expect(events.find((event) => event["type"] === "response.output_text.delta")).toMatchObject({
      delta: "b",
    });
  });

  it("does not count an empty delta as streamed", () => {
    const tracker = new ResponsesStreamOutputTracker();
    tracker.observe({
      type: "response.refusal.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "",
    });

    expect(tracker.synthesize(terminal([refusalMessage()])).events).toHaveLength(6);
  });

  it("an unkeyed streamed message or item done suppresses the synthesis", () => {
    const delta = new ResponsesStreamOutputTracker();
    delta.observe({ type: "response.output_text.delta", delta: "x" });
    expect(delta.synthesize(terminal([refusalMessage()])).events).toEqual([]);

    const done = new ResponsesStreamOutputTracker();
    done.observe({ type: "response.output_item.done", item: { type: "message" } });
    expect(done.synthesize(terminal([refusalMessage()])).events).toEqual([]);
  });

  it("ignores unkeyed reasoning deltas and typeless items", () => {
    const tracker = new ResponsesStreamOutputTracker();
    tracker.observe({ type: "response.reasoning_text.delta", delta: "thinking" });
    tracker.observe({ type: "response.output_item.done", output_index: 0, item: {} });

    expect(tracker.synthesize(terminal([refusalMessage()])).events).toHaveLength(6);
  });

  it("matches an id-less terminal item by index, but not an item whose id moved to another index", () => {
    const idLess = new ResponsesStreamOutputTracker();
    idLess.observe({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "a",
    });
    const { id: _, ...withoutId } = textMessage("msg_1", "a");
    expect(idLess.synthesize(terminal([withoutId])).events).toEqual([]);

    const shifted = new ResponsesStreamOutputTracker();
    shifted.observe({
      type: "response.output_text.delta",
      item_id: "msg_1",
      output_index: 0,
      delta: "a",
    });
    const { events } = shifted.synthesize(terminal([textMessage("msg_2", "b")]));
    expect(events.length).toBeGreaterThan(0);
  });

  it("skips the item and part already added", () => {
    const tracker = new ResponsesStreamOutputTracker();
    tracker.observe({
      type: "response.output_item.added",
      output_index: 0,
      item: { id: "msg_1", type: "message" },
    });
    tracker.observe({
      type: "response.content_part.added",
      item_id: "msg_1",
      output_index: 0,
      content_index: 0,
      part: { type: "refusal" },
    });

    expect(types(tracker.synthesize(terminal([refusalMessage()])).events)).toEqual([
      "response.refusal.delta",
      "response.refusal.done",
      "response.content_part.done",
      "response.output_item.done",
    ]);
  });

  it("synthesises an incomplete multipart message, text and refusal parts in order", () => {
    const tracker = new ResponsesStreamOutputTracker();

    const message: JsonObject = {
      id: "msg_1",
      type: "message",
      content: [
        { type: "output_text", text: "partial" },
        { type: "refusal", refusal: "", text: "fallback" },
      ],
    };

    const { events } = tracker.synthesize(terminal([message], "response.incomplete"));

    expect(
      events
        .filter((event) => asString(event["type"]).endsWith(".delta"))
        .map((event) => [event["type"], event["content_index"], event["delta"]]),
    ).toEqual([
      ["response.output_text.delta", 0, "partial"],
      ["response.refusal.delta", 1, "fallback"],
    ]);
  });

  it("refusal deltas count as meaningful output", () => {
    expect(hasMeaningfulOutputDelta({ type: "response.refusal.delta", delta: "no" })).toBe(true);
    expect(hasMeaningfulOutputDelta({ type: "response.refusal.delta", delta: " " })).toBe(false);
  });
});
