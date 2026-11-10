// Unit tests of the hosted image_generation helpers (CLIProxyAPI d1e5cc60 / 714f0526 fixtures).
import { describe, expect, it } from "vitest";
import { type Json, tryParseJson } from "@commissary/json";
import {
  codexModelUsesResponsesLite,
  requestForcesImageGeneration,
  requestHasReasoningForHostedImage,
  stripHostedImageComplexity,
} from "../../src/executor/codex/hosted-images.ts";

const parse = (text: string): Json => {
  const value = tryParseJson(text);

  if (value === undefined) throw new Error(`invalid JSON fixture: ${text}`);

  return value;
};

describe("requestForcesImageGeneration", () => {
  const cases = {
    explicit: [
      '{"tools":[{"type":"image_generation"}],"tool_choice":{"type":"image_generation"}}',
      true,
    ],
    required: ['{"tools":[{"type":"image_generation"}],"tool_choice":"required"}', true],
    explicitWithOtherTools: [
      '{"tools":[{"type":"function","name":"lookup"},{"type":"image_generation"}],"tool_choice":{"type":"image_generation"}}',
      true,
    ],
    allowedRequired: [
      '{"tools":[{"type":"function","name":"lookup"},{"type":"image_generation"}],"tool_choice":{"type":"allowed_tools","mode":"required","tools":[{"type":"image_generation"}]}}',
      true,
    ],
    additionalExplicit: [
      '{"input":[{"type":"additional_tools","tools":[{"type":"image_generation"}]}],"tool_choice":{"type":"image_generation"}}',
      true,
    ],
    additionalRequired: [
      '{"input":[{"type":"additional_tools","tools":[{"type":"image_generation"}]}],"tool_choice":"required"}',
      true,
    ],
    omitted: ['{"tools":[{"type":"image_generation"}]}', false],
    auto: ['{"tools":[{"type":"image_generation"}],"tool_choice":"auto"}', false],
    none: ['{"tools":[{"type":"image_generation"}],"tool_choice":"none"}', false],
    mixedRequired: [
      '{"tools":[{"type":"image_generation"},{"type":"function","name":"lookup"}],"tool_choice":"required"}',
      false,
    ],
    additionalMixedRequired: [
      '{"tools":[{"type":"image_generation"}],"input":[{"type":"additional_tools","tools":[{"type":"function","name":"lookup"}]}],"tool_choice":"required"}',
      false,
    ],
    allowedAuto: [
      '{"tools":[{"type":"image_generation"}],"tool_choice":{"type":"allowed_tools","mode":"auto","tools":[{"type":"image_generation"}]}}',
      false,
    ],
    allowedMixed: [
      '{"tools":[{"type":"image_generation"},{"type":"function","name":"lookup"}],"tool_choice":{"type":"allowed_tools","mode":"required","tools":[{"type":"image_generation"},{"type":"function","name":"lookup"}]}}',
      false,
    ],
    allowedExcludesImages: [
      '{"tools":[{"type":"image_generation"},{"type":"function","name":"lookup"}],"tool_choice":{"type":"allowed_tools","mode":"required","tools":[{"type":"function","name":"lookup"}]}}',
      false,
    ],
    allowedEmpty: [
      '{"tools":[{"type":"image_generation"}],"tool_choice":{"type":"allowed_tools","mode":"required","tools":[]}}',
      false,
    ],
    filteredDeclaration: ['{"tool_choice":{"type":"image_generation"}}', false],
    standaloneFunction: [
      '{"tools":[{"type":"function","name":"image_gen.imagegen"}],"tool_choice":"required"}',
      false,
    ],
  } as const satisfies Record<string, readonly [string, boolean]>;

  it.each(Object.entries(cases))("%s", (_name, [body, forced]) => {
    expect(requestForcesImageGeneration(parse(body))).toBe(forced);
  });
});

describe("requestHasReasoningForHostedImage", () => {
  const cases = {
    none: ["{}", "gpt-6-sol", false],
    modelSuffix: ["{}", "gpt-6-sol(high)", true],
    bodyModelSuffix: ['{"model":"gpt-6-sol(high)"}', "gpt-6-sol", true],
    effort: ['{"reasoning":{"effort":"high"}}', "gpt-6-sol", true],
    emptyEffort: ['{"reasoning":{"effort":" "}}', "gpt-6-sol", false],
    nullReasoning: ['{"reasoning":null}', "gpt-6-sol", false],
    bareString: ['{"reasoning":"high"}', "gpt-6-sol", true],
    emptyBareString: ['{"reasoning":" "}', "gpt-6-sol", false],
    configurationUpdate: [
      '{"input":[{"type":"configuration_update","reasoning":{"effort":"low"}}]}',
      "gpt-6-sol",
      true,
    ],
    otherItemEffort: [
      '{"input":[{"type":"message","reasoning":{"effort":"low"}}]}',
      "gpt-6-sol",
      false,
    ],
  } as const satisfies Record<string, readonly [string, string, boolean]>;

  it.each(Object.entries(cases))("%s", (_name, [body, model, expected]) => {
    expect(requestHasReasoningForHostedImage(parse(body), model)).toBe(expected);
  });
});

describe("codexModelUsesResponsesLite", () => {
  it.each(["gpt-6-sol", "gpt-6.1-sol", "codex/gpt-6-astra(high)", "gpt-5.6-sol", "GPT-RESERVE"])(
    "%s is lite",
    (model) => {
      expect(codexModelUsesResponsesLite(model)).toBe(true);
    },
  );

  it.each(["gpt-5.4", "gpt-5.5", "", "unknown"])("%j is not lite", (model) => {
    expect(codexModelUsesResponsesLite(model)).toBe(false);
  });
});

describe("stripHostedImageComplexity", () => {
  it("removes complexity from top-level and additional_tools hosted tools only", () => {
    const body = parse(
      '{"tools":[{"type":"image_generation","complexity":"high"},{"type":"function","complexity":"x"}],"input":[{"type":"additional_tools","tools":[{"type":"image_generation","complexity":"low","size":"1"}]}]}',
    );

    expect(stripHostedImageComplexity(body)).toEqual({
      tools: [{ type: "image_generation" }, { type: "function", complexity: "x" }],
      input: [{ type: "additional_tools", tools: [{ type: "image_generation", size: "1" }] }],
    });
  });
});
