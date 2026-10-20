/**
 * Per-attempt usage collector used by executors.
 *
 * Go source: internal/runtime/executor/helps/usage_helpers.go (UsageReporter: Publish, PublishFailure, TrackFailure,
 * EnsurePublished, ObserveResponseModel, ObserveTokenEvent/MarkFirstResponseByte (TTFT), StreamUsageBuffer keeping
 * the latest stream usage). Executors feed it; the pipeline calls `finish` exactly once when the attempt is over
 * (stream end included) and publishes the record with its v2 token breakdown.
 */
import { ensureTokenBreakdown } from "./accounting.ts";
import { failureDetail, type UsageFailure } from "./failure.ts";
import { mergeStreamUsageDetail } from "./parsers.ts";
import type { UsageDetail, UsageRecord } from "./record.ts";
import { emptyUsageDetail, hasNonZeroTokenUsage } from "./record.ts";
import type { UsageRun } from "@commissary/auth";
import type { OrgId } from "@commissary/core";

export interface UsageReporterInit {
  readonly requestId: string;
  /** Inbound HTTP request id shared by all attempts (usage `trace_id`). */
  readonly traceId?: string;
  readonly provider: string;
  readonly executorType: string;
  readonly model: string;
  readonly alias: string;
  readonly endpoint: string;
  readonly principalId: string;
  readonly orgId: OrgId;
  /** The caller's member id in the org (usage `member_id`), when they have one. */
  readonly memberId?: string;
  /** The credential is private (ADR 0023): the record is its owner's alone to read. */
  readonly private?: boolean;
  /** The agent run the request is of (#227, usage `agent_id`, `run_id`, `starter`). */
  readonly run?: UsageRun;
  readonly authId: string;
  readonly authType: string;
  readonly source: string;
  readonly stream: boolean;
  readonly generate?: boolean;
  readonly serviceTier: string;
  readonly reasoningEffort?: string;
  readonly requestedAt: number;
  /** Canonical session identity of the request (explicit, derived or LCP); see `session-routing/routing.ts`. */
  readonly sessionId?: string;
  readonly parentSessionId?: string;
  /** The credential's configured upstream base URL, when it has one. */
  readonly baseUrl?: string;
}

export class UsageReporter {
  #detail: UsageDetail | undefined;
  #failure: UsageFailure | undefined;
  #responseModel: string | undefined;
  #ttftAt: number | undefined;
  #firstPacketAt: number | undefined;
  #reasoningEffort: string | undefined;
  #finished = false;
  /** Usage of extra models the attempt consumed (`PublishAdditionalModel`, e.g. the Codex image tool). */
  readonly #additional: Array<{ readonly model: string; readonly detail: UsageDetail }> = [];

  constructor(readonly init: UsageReporterInit) {
    this.#reasoningEffort = init.reasoningEffort;
  }

  /**
   * `MarkFirstResponseByte`: the first upstream response byte is the effective TTFT (non-stream attempts and
   * executors that do not inspect token events).
   */
  markFirstByte(now: number): void {
    this.#firstPacketAt ??= now;
    this.#ttftAt ??= now;
  }

  /** `RecordFirstPacket`: arrival of the first frame, the TTFT fallback while no token event was seen. */
  recordFirstPacket(now: number): void {
    this.#firstPacketAt ??= now;
  }

  /** `ObserveTokenEvent`: the first substantive token event is the effective TTFT, any first frame the fallback. */
  observeTokenEvent(now: number, isToken: boolean): void {
    if (this.#ttftAt !== undefined) return;
    this.#firstPacketAt ??= now;

    if (isToken) this.#ttftAt = now;
  }

  /** Whether the effective TTFT is already known (callers can skip token-event detection). */
  get ttftObserved(): boolean {
    return this.#ttftAt !== undefined;
  }

  /**
   * `StreamUsageBuffer.Observe`: the latest usage wins; a tier-only update only refreshes the response service tier
   * and an earlier tier survives later updates without one.
   */
  publish(detail: UsageDetail): void {
    const previous = this.#detail;
    const tier = detail.responseServiceTier?.trim() ?? "";

    if (tier === "" || hasNonZeroTokenUsage(detail)) {
      const preserved = previous?.responseServiceTier;
      this.#detail =
        detail.responseServiceTier === undefined && preserved !== undefined
          ? { ...detail, responseServiceTier: preserved }
          : detail;
    } else {
      this.#detail = { ...(previous ?? emptyUsageDetail), responseServiceTier: tier };
    }
  }

  /**
   * `PublishAdditionalModel`: tokens spent on another model during this attempt (the image tool of a Responses request).
   * Becomes its own record, with a fresh id, when the attempt finishes; nothing without token usage.
   */
  publishAdditionalModel(model: string, detail: UsageDetail): void {
    const name = model.trim();

    if (name === "") return;
    const normalized = ensureTokenBreakdown(detail, this.init.provider, this.init.executorType);

    if (hasNonZeroTokenUsage(normalized))
      this.#additional.push({ model: name, detail: normalized });
  }

  /** The records of {@link publishAdditionalModel} (successful, same attempt metadata as the main record). */
  additionalRecords(now: number): UsageRecord[] {
    const { init } = this;
    const ttftAt = this.#ttftAt ?? this.#firstPacketAt;

    return this.#additional.splice(0).map(({ model, detail }) => ({
      requestId: crypto.randomUUID(),
      ...(init.traceId !== undefined ? { traceId: init.traceId } : {}),
      provider: init.provider,
      executorType: init.executorType,
      model,
      alias: init.alias,
      endpoint: init.endpoint,
      principalId: init.principalId,
      orgId: init.orgId,
      ...(init.memberId === undefined ? {} : { memberId: init.memberId }),
      ...(init.private === true ? { private: true } : {}),
      ...(init.run === undefined ? {} : { run: init.run }),
      authId: init.authId,
      authType: init.authType,
      source: init.source,
      stream: init.stream,
      ...(init.generate === false ? { generate: false } : {}),
      requestedAt: init.requestedAt,
      latencyMs: Math.max(0, now - init.requestedAt),
      ...(ttftAt !== undefined ? { ttftMs: Math.max(0, ttftAt - init.requestedAt) } : {}),
      failed: false,
      detail,
      ...(this.#reasoningEffort !== undefined ? { reasoningEffort: this.#reasoningEffort } : {}),
      serviceTier: init.serviceTier,
    }));
  }

  /** `ObserveMergedStreamUsage`: for protocols that report usage across several events (Claude, Interactions). */
  publishMerged(detail: UsageDetail): void {
    this.publish(
      this.#detail === undefined ? detail : mergeStreamUsageDetail(this.#detail, detail),
    );
  }

  /**
   * Marks the attempt failed; the first failure is kept. `body` is the upstream's error text: it is read for the
   * error's type and code and dropped, so the record keeps the status and those two identifiers only (ADR 0027).
   * `code` is Commissary's own code for the error, which wins over the upstream's.
   */
  fail(statusCode: number, body: string, code?: string): void {
    this.#failure ??= {
      statusCode: statusCode > 0 ? statusCode : 500,
      ...failureDetail({ message: body, code }),
    };
  }

  observeResponseModel(model: string | undefined): void {
    if (model !== undefined) this.#responseModel = model;
  }

  /** The reasoning effort actually sent upstream (after translation/thinking). */
  setReasoningEffort(effort: string | undefined): void {
    if (effort !== undefined && effort !== "") this.#reasoningEffort = effort;
  }

  get failed(): boolean {
    return this.#failure !== undefined;
  }

  /** Builds the record once; later calls return `undefined` (exactly one record per attempt). */
  finish(now: number): UsageRecord | undefined {
    if (this.#finished) return undefined;
    this.#finished = true;
    const { init } = this;

    // Go `normalizeUsageDetailTotal`: every record leaves with a valid v2 breakdown for its provider's semantics.
    const detail = ensureTokenBreakdown(
      this.#detail ?? emptyUsageDetail,
      init.provider,
      init.executorType,
    );

    const ttftAt = this.#ttftAt ?? this.#firstPacketAt;

    return {
      requestId: init.requestId,
      ...(init.traceId !== undefined ? { traceId: init.traceId } : {}),
      provider: init.provider,
      executorType: init.executorType,
      model: init.model,
      alias: init.alias,
      endpoint: init.endpoint,
      principalId: init.principalId,
      orgId: init.orgId,
      ...(init.memberId === undefined ? {} : { memberId: init.memberId }),
      ...(init.private === true ? { private: true } : {}),
      ...(init.run === undefined ? {} : { run: init.run }),
      authId: init.authId,
      authType: init.authType,
      source: init.source,
      stream: init.stream,
      ...(init.generate === false ? { generate: false } : {}),
      requestedAt: init.requestedAt,
      latencyMs: Math.max(0, now - init.requestedAt),
      ...(ttftAt !== undefined ? { ttftMs: Math.max(0, ttftAt - init.requestedAt) } : {}),
      failed: this.#failure !== undefined,
      ...(this.#failure !== undefined ? { fail: this.#failure } : {}),
      detail,
      ...(this.#responseModel !== undefined ? { responseModel: this.#responseModel } : {}),
      ...(this.#reasoningEffort !== undefined ? { reasoningEffort: this.#reasoningEffort } : {}),
      serviceTier: init.serviceTier,
      ...(init.sessionId === undefined ? {} : { sessionId: init.sessionId }),
      ...(init.parentSessionId === undefined ? {} : { parentSessionId: init.parentSessionId }),
      ...(init.baseUrl === undefined ? {} : { baseUrl: init.baseUrl }),
    };
  }
}
