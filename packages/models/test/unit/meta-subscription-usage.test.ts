// The Meta `response.subscription_usage` line filter (Go meta_executor_stream.go / translateMetaCompleted).
import { describe, expect, it } from "vitest";
import { makeSubscriptionUsageFilter } from "../../src/executor/meta/subscription-usage.ts";

const usage = 'data: {"type":"response.subscription_usage","subscription":{"tier":"t"}}';

const created = 'data: {"type":"response.created"}';

/** Feeds lines like the stream does: a kept data line is followed by `takeHeld` before it is emitted. */
const run = (lines: string[]): string[] => {
  const filter = makeSubscriptionUsageFilter();
  const out: string[] = [];

  for (const line of lines) {
    for (const kept of filter.push(line)) {
      if (kept.startsWith("data:")) out.push(...filter.takeHeld());
      out.push(kept);
    }
  }

  return [...out, ...filter.flush()];
};

describe("subscription usage filter", () => {
  it("drops an event-named telemetry frame with its blank line", () => {
    expect(
      run([
        "event: response.subscription_usage",
        usage,
        "",
        "event: response.created",
        created,
        "",
      ]),
    ).toEqual(["event: response.created", created, ""]);
  });

  it("drops a bare telemetry data frame", () => {
    expect(run(['data: {"subscription":{"tier":"t"}}', "", created, ""])).toEqual([created, ""]);
  });

  it("keeps a non-telemetry event that follows a filtered one", () => {
    expect(
      run([
        "event: response.subscription_usage",
        usage,
        "",
        "event: response.output_text.delta",
        'data: {"type":"response.output_text.delta","delta":"x"}',
        "",
      ]),
    ).toEqual([
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"x"}',
      "",
    ]);
  });

  it("drops the data of a telemetry event line that has no type, and ends at its blank line", () => {
    expect(
      run(["event: response.subscription_usage", 'data: {"tier":"t"}', "", created, ""]),
    ).toEqual([created, ""]);
  });

  it("ends a telemetry event that has no data at its blank line", () => {
    expect(run(["event: response.subscription_usage", "", created, ""])).toEqual([created, ""]);
  });

  it("releases a held event line ahead of a non-data line", () => {
    expect(run(["event: ping", ": keep-alive", ""])).toEqual(["event: ping", ": keep-alive", ""]);
  });

  it("flushes an event line still held at EOF", () => {
    expect(run([created, "", "event: response.created"])).toEqual([
      created,
      "",
      "event: response.created",
    ]);
  });

  it("drops a held event line whose frame is telemetry", () => {
    expect(run(["event: response.created", usage, ""])).toEqual([]);
  });

  it("holds an event line back until takeHeld", () => {
    const filter = makeSubscriptionUsageFilter();
    expect(filter.push("event: error")).toEqual([]);
    expect(filter.push('data: {"type":"error"}')).toEqual(['data: {"type":"error"}']);
    expect(filter.takeHeld()).toEqual(["event: error"]);
    expect(filter.takeHeld()).toEqual([]);
  });
});
