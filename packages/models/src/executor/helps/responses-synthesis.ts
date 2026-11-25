/**
 * Synthesised Responses message events for a stream whose upstream put a message only in its terminal event.
 *
 * Go source: internal/runtime/executor/helps/responses_completed_synthesis.go (`ResponsesStreamOutputTracker`). The
 * tracker observes the streamed events; before a `response.completed`/`response.incomplete` it emits the
 * `output_item.added`, `content_part.added`, text or refusal delta/done, `content_part.done` and `output_item.done`
 * events of every message item of `response.output` that never streamed, so stream clients see the text. Items are
 * matched by id, else by output index; one unkeyed streamed message suppresses the synthesis altogether.
 */
import {
  asString,
  cloneJson,
  get,
  isJsonArray,
  isJsonObject,
  type Json,
  type JsonObject,
} from "@commissary/json";

const MESSAGE_PART_TYPES = new Set(["output_text", "refusal"]);

/** The integer of a JSON number, `undefined` for anything else. */
const integerOf = (value: Json | undefined): number | undefined =>
  // SAFETY: `typeof` only tells a JSON number from the other JSON kinds; Go reads `Type == ojson.Number`.
  typeof value === "number" ? Math.trunc(value) : undefined;

/** Ids and output indices of a set of message items (Go's `idMap`, `idxMap`, `fallbackIdxMap`). */
class ItemKeys {
  readonly ids = new Set<string>();
  readonly indices = new Set<number>();
  /** Indices of id-bearing events, matched only by unkeyed items. */
  readonly fallbackIndices = new Set<number>();

  /** `markTrackerKey`: `false` when the event carried neither an id nor an index. */
  mark(itemId: string, index: number | undefined): boolean {
    if (itemId !== "") {
      this.ids.add(itemId);

      if (index !== undefined) this.fallbackIndices.add(index);

      return true;
    }

    if (index === undefined) return false;
    this.indices.add(index);

    return true;
  }

  /** `matchesTrackerKey`. */
  matches(itemId: string, index: number): boolean {
    if (itemId !== "") return this.ids.has(itemId) || this.indices.has(index);

    return this.indices.has(index) || this.fallbackIndices.has(index);
  }
}

const partKey = (outer: string | number, contentIndex: number) => `${outer}\u0000${contentIndex}`;

/** The synthesised events and the terminal event that follows them. */
export interface SynthesizedOutput {
  readonly events: JsonObject[];
  readonly terminal: JsonObject;
}

export class ResponsesStreamOutputTracker {
  readonly #added = new ItemKeys();
  readonly #seen = new ItemKeys();
  readonly #addedPartIds = new Set<string>();
  readonly #addedPartIndices = new Set<string>();
  readonly #addedPartFallbackIndices = new Set<string>();
  #sawUnkeyedOutput = false;
  #maxSeq: number | undefined;

  #nextSeq(): number {
    this.#maxSeq = this.#maxSeq === undefined ? 0 : this.#maxSeq + 1;

    return this.#maxSeq;
  }

  #event(type: string, fields: JsonObject): JsonObject {
    return { type, sequence_number: this.#nextSeq(), ...fields };
  }

  /** `Observe`: records a streamed event so the terminal synthesis skips what already streamed. */
  observe(event: Json | undefined): void {
    const seq = integerOf(get(event, "sequence_number"));

    if (seq !== undefined && (this.#maxSeq === undefined || seq > this.#maxSeq)) this.#maxSeq = seq;
    const index = integerOf(get(event, "output_index"));

    switch (asString(get(event, "type"))) {
      case "response.output_item.added": {
        if (asString(get(event, "item.type")) !== "message") return;
        this.#added.mark(asString(get(event, "item.id")), index);

        return;
      }

      case "response.content_part.added": {
        if (!MESSAGE_PART_TYPES.has(asString(get(event, "part.type")))) return;
        const contentIndex = integerOf(get(event, "content_index"));

        if (contentIndex === undefined) return;
        const itemId = asString(get(event, "item_id"));

        if (itemId !== "") {
          this.#addedPartIds.add(partKey(itemId, contentIndex));

          if (index !== undefined) this.#addedPartFallbackIndices.add(partKey(index, contentIndex));
        } else if (index !== undefined) this.#addedPartIndices.add(partKey(index, contentIndex));

        return;
      }

      case "response.output_item.done": {
        if (asString(get(event, "item.type")) !== "message") return;

        if (!this.#seen.mark(asString(get(event, "item.id")), index)) this.#sawUnkeyedOutput = true;

        return;
      }

      case "response.output_text.delta":
      case "response.refusal.delta": {
        if (asString(get(event, "delta")) === "") return;

        if (!this.#seen.mark(asString(get(event, "item_id")), index)) this.#sawUnkeyedOutput = true;
      }
    }
  }

  /**
   * `SynthesizeMissingOutputEvents`: the events of the terminal event's unstreamed message items, and the terminal
   * event itself (its `sequence_number` moved past the synthesised ones when it would not follow them).
   */
  synthesize(terminal: JsonObject): SynthesizedOutput {
    const output = get(terminal, "response.output");

    if (!isJsonArray(output)) return { events: [], terminal };
    const events: JsonObject[] = [];

    output.forEach((item, index) => {
      if (!isJsonObject(item) || asString(item["type"]) !== "message") return;
      const itemId = asString(get(item, "id"));

      if (this.#sawUnkeyedOutput || this.#seen.matches(itemId, index)) return;

      const withId = (fields: JsonObject): JsonObject =>
        itemId !== "" ? { item_id: itemId, ...fields } : fields;

      if (!this.#added.matches(itemId, index)) {
        const added = { ...cloneJson(item), status: "in_progress", content: [] };
        events.push(
          this.#event("response.output_item.added", { output_index: index, item: added }),
        );
      }

      const content = get(item, "content");

      (isJsonArray(content) ? content : []).forEach((part, contentIndex) => {
        const partType = asString(get(part, "type"));

        if (!MESSAGE_PART_TYPES.has(partType)) return;
        const refusal = partType === "refusal";
        const at = { output_index: index, content_index: contentIndex };

        const partAdded =
          (itemId !== "" && this.#addedPartIds.has(partKey(itemId, contentIndex))) ||
          this.#addedPartIndices.has(partKey(index, contentIndex)) ||
          (itemId === "" && this.#addedPartFallbackIndices.has(partKey(index, contentIndex)));

        if (!partAdded) {
          events.push(
            this.#event(
              "response.content_part.added",
              withId({
                ...at,
                part: refusal
                  ? { type: "refusal", refusal: "" }
                  : { type: "output_text", text: "", annotations: [] },
              }),
            ),
          );
        }

        let value = asString(get(part, refusal ? "refusal" : "text"));

        if (refusal && value === "") value = asString(get(part, "text"));

        if (value !== "") {
          events.push(
            this.#event(
              refusal ? "response.refusal.delta" : "response.output_text.delta",
              withId({ ...at, delta: value }),
            ),
          );
        }

        events.push(
          this.#event(
            refusal ? "response.refusal.done" : "response.output_text.done",
            withId({ ...at, [refusal ? "refusal" : "text"]: value }),
          ),
          this.#event("response.content_part.done", withId({ ...at, part: cloneJson(part) })),
        );
      });

      events.push(
        this.#event("response.output_item.done", {
          output_index: index,
          item: cloneJson(item),
        }),
      );
    });

    if (events.length === 0) return { events, terminal };
    const seq = integerOf(get(terminal, "sequence_number"));

    if (seq !== undefined && this.#maxSeq !== undefined && seq <= this.#maxSeq)
      return { events, terminal: { ...terminal, sequence_number: this.#nextSeq() } };

    return { events, terminal };
  }
}
