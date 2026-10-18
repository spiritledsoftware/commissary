// TypeSafe's System One API (ADR 0032): reading requests and the upstream error shapes every provider answers.
import { describe, expect, it } from "vitest";
import {
  assetRefs,
  countImages,
  hasBoxQuestion,
  parseUpstreamSystemOneError,
  systemOneAssets,
} from "../src/systemone/index.ts";

const request = {
  model: "jev-preview",
  state: { photo: "<image:a>", text: "see <image:b>" },
  questions: {
    billing: { type: "noul", instructions: "Is this about billing?" },
    where: { type: "box", instructions: "Where is the total?" },
  },
  assets: {
    "<image:a>": { type: "image", part: "asset-0" },
    "<image:b>": { format: "png", data_base64: "iVBORw0K" },
    broken: "not an object",
  },
};

describe("System One requests", () => {
  it("list the assets in order and count them as images", () => {
    expect(assetRefs(request)).toEqual(["<image:a>", "<image:b>"]);
    expect(systemOneAssets(request)[0]?.asset).toEqual({ type: "image", part: "asset-0" });
    expect(countImages(request)).toBe(2);
    expect(countImages({ model: "jev-latest", state: "x", questions: {} })).toBe(0);
  });

  it("find Box questions", () => {
    expect(hasBoxQuestion(request)).toBe(true);
    expect(hasBoxQuestion({ questions: { q: { type: "noul" } } })).toBe(false);
    expect(hasBoxQuestion("not a request")).toBe(false);
  });
});

describe("upstream System One errors", () => {
  it("keep TypeSafe's and SubQ's detail", () => {
    expect(
      parseUpstreamSystemOneError(
        401,
        '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate"}}',
      ),
    ).toEqual({ error_type: "authentication_error", message: "Cannot authenticate" });
  });

  it("read FastAPI validation lists and plain details", () => {
    expect(
      parseUpstreamSystemOneError(
        422,
        '{"detail":[{"loc":["body","questions"],"msg":"field required","type":"missing"}]}',
      ),
    ).toEqual({ error_type: "validation_error", message: "body.questions: field required" });
    expect(parseUpstreamSystemOneError(400, '{"detail":"bad"}')).toEqual({ message: "bad" });
  });

  it("take only the message of OpenCode Zen's and OpenAI-shaped errors", () => {
    expect(
      parseUpstreamSystemOneError(
        401,
        '{"type":"error","error":{"type":"AuthError","message":"Missing API key."}}',
      ),
    ).toEqual({ message: "Missing API key." });
    expect(
      parseUpstreamSystemOneError(
        400,
        '{"error":{"type":"server_error","message":"Upstream request failed: Model is unavailable."}}',
      ),
    ).toEqual({ message: "Upstream request failed: Model is unavailable." });
  });

  it("keep a bounded piece of a text body", () => {
    expect(parseUpstreamSystemOneError(502, "  Bad Gateway ")).toEqual({ message: "Bad Gateway" });
    expect(parseUpstreamSystemOneError(502, "x".repeat(800)).message).toHaveLength(501);
    expect(parseUpstreamSystemOneError(500, "")).toEqual({ message: "" });
  });
});
