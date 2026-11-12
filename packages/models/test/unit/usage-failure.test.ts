// What a usage record keeps of a failed attempt (ADR 0027): status code, error type and error code; never the body.
import { describe, expect, it } from "vite-plus/test";
import { failureDetail } from "../../src/usage/failure.ts";
import { GLOBAL_ORG } from "@commissary/core";
import { UsageReporter } from "../../src/usage/reporter.ts";

describe("failureDetail", () => {
  it("reads the type and code of OpenAI, Claude, Codex and Gemini error bodies", () => {
    expect(
      failureDetail({
        message:
          '{"error":{"message":"you said hunter2","type":"invalid_request_error","code":"context_length_exceeded"}}',
      }),
    ).toEqual({ type: "invalid_request_error", code: "context_length_exceeded" });

    expect(
      failureDetail({
        message: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      }),
    ).toEqual({ type: "overloaded_error" });

    expect(
      failureDetail({
        message: '{"error":{"code":429,"message":"quota","status":"RESOURCE_EXHAUSTED"}}',
      }),
    ).toEqual({ type: "RESOURCE_EXHAUSTED", code: "429" });
  });

  it("lets Commissary's own code win over the upstream's", () => {
    expect(
      failureDetail({ message: '{"error":{"code":"upstream_code"}}', code: "auth_unavailable" }),
    ).toEqual({ code: "auth_unavailable" });
  });

  it("drops anything that is not a short identifier, and bodies that are not JSON", () => {
    expect(
      failureDetail({
        message:
          '{"error":{"type":"my prompt was: write me a poem","code":"x".repeat(80)}}'.replace(
            '"x".repeat(80)',
            `"${"x".repeat(80)}"`,
          ),
      }),
    ).toEqual({});

    expect(failureDetail({ message: "plain text echoing the prompt" })).toEqual({});
    expect(failureDetail({ message: "" })).toEqual({});
  });
});

describe("UsageReporter.fail", () => {
  const reporter = () =>
    new UsageReporter({
      requestId: "r",
      provider: "codex",
      executorType: "codex",
      model: "gpt-5",
      alias: "gpt-5",
      endpoint: "POST /v1/responses",
      principalId: "user:a",
      orgId: GLOBAL_ORG,
      authId: "a",
      authType: "oauth",
      source: "a",
      stream: false,
      serviceTier: "",
      requestedAt: 0,
    });

  it("keeps the status, type and code and never the upstream body", () => {
    const usage = reporter();
    usage.fail(
      429,
      '{"error":{"message":"PROMPT TEXT","type":"rate_limit_error","code":"slow_down"}}',
    );
    const record = usage.finish(10);

    expect(record?.fail).toEqual({ statusCode: 429, type: "rate_limit_error", code: "slow_down" });
    expect(JSON.stringify(record)).not.toContain("PROMPT TEXT");
  });

  it("keeps the first failure and a bare status for an unparseable body", () => {
    const usage = reporter();
    usage.fail(502, "echo of the prompt");
    usage.fail(500, '{"error":{"type":"later"}}');

    expect(usage.finish(10)?.fail).toEqual({ statusCode: 502 });
  });
});
