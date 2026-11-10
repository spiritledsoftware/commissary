// Go `internal/util/sanitize_test.go` `TestCleanClaudeToolArguments` and `…_ImplicitOpenObjectPreservesArguments`
// (CLIProxyAPI 202b8b8c, e1fb2521): argument cleaning against the original and the translated (sent) tool schemas.
import { describe, expect, it } from "vitest";
import { tryParseJson } from "@commissary/json";
import {
  claudeToolIsParameterless,
  cleanClaudeToolArguments,
  cleanClaudeToolArgumentsWithTranslated,
} from "../src/translator/common/claude-tool-args.ts";
import { sanitizedFunctionNameMap } from "../src/translator/common/tool-names.ts";
import {
  cleanJsonSchemaForAntigravity,
  cleanJsonSchemaForGeminiJsonSchema,
} from "../src/translator/gemini/util/json-schema.ts";

const parse = (text: string) => tryParseJson(text);

/** The requests of the Go table, keyed by their Go variable names (nil -> no request). */
const GO_REQUESTS = {
  origRequest:
    '{"tools": [{"name": "EnterPlanMode", "input_schema": {"type": "object", "properties": {}}}, {"name": "CronList", "input_schema": {"type": "object"}}, {"name": "Bash", "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}, {"name": "CustomToolWithReason", "input_schema": {"type": "object", "properties": {"reason": {"type": "string"}}}}, {"name": "DynamicTool", "input_schema": {"type": "object", "properties": {"name": {"type": "string"}}, "additionalProperties": true}}, {"name": "UnionTool", "input_schema": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}}]}}]}',
  dynamicRequest:
    '{"tools": [{"name": "MapTool", "input_schema": {"type": "object", "additionalProperties": true}}, {"name": "TypedMapTool", "input_schema": {"type": "object", "properties": {}, "additionalProperties": {"type": "string"}}}]}',
  caseCollisionRequest:
    '{"tools": [{"name": "Read", "input_schema": {"type": "object", "properties": {}}}, {"name": "read", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}]}',
  composedRequest:
    '{"tools": [{"name": "AllOfEmpty", "input_schema": {"type": "object", "allOf": [{"type": "object", "properties": {}}]}}, {"name": "AllOfArgs", "input_schema": {"type": "object", "allOf": [{"type": "object", "properties": {"path": {"type": "string"}}}]}}, {"name": "RefEmpty", "input_schema": {"$ref": "#/$defs/empty", "$defs": {"empty": {"type": "object", "properties": {}}}}}, {"name": "NestedTool", "input_schema": {"type": "object", "properties": {"opts": {"type": "object", "properties": {}}, "cfg": {"type": "object", "properties": {"mode": {"type": "string"}}}}}}]}',
  transferredRequest:
    '{"model": "gemini-3.8-flash-high", "request": {"tools": [{"functionDeclarations": [{"name": "Bash", "parametersJsonSchema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}]}]}}',
  translatedReasonRequired:
    '{"model": "gemini-3.8-flash-high", "request": {"tools": [{"functionDeclarations": [{"name": "Bash", "parametersJsonSchema": {"type": "object", "properties": {"command": {"type": "string"}, "reason": {"type": "string"}}, "required": ["command", "reason"]}}]}]}}',
  uniqueItemsRequest:
    '{"tools": [{"name": "BatchUnique", "input_schema": {"type": "object", "properties": {"rows": {"type": "array", "uniqueItems": true, "items": {"type": "object", "properties": {"tag": {"type": "string"}}}}}, "required": ["rows"], "additionalProperties": false}}]}',
  translatedUniqueItems:
    '{"model": "claude-sonnet-4-6", "request": {"tools": [{"functionDeclarations": [{"name": "BatchUnique", "parametersJsonSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {"tag": {"type": "string"}, "_": {"type": "boolean"}}, "required": ["_"]}}}, "required": ["rows"]}}]}]}}',
  minPropsRequest:
    '{"tools": [{"name": "StoreMetadata", "input_schema": {"type": "object", "properties": {}, "minProperties": 1}}]}',
  translatedMinProps:
    '{"model": "claude-sonnet-4-6", "request": {"tools": [{"functionDeclarations": [{"name": "StoreMetadata", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"], "minProperties": 1}}]}]}}',
  siblingAllOfRequest:
    '{"tools": [{"name": "ConfigureSibling", "input_schema": {"type": "object", "required": ["cfg"], "anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {}}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "properties": {"other": {"type": "string"}}, "required": ["other"], "additionalProperties": false}], "allOf": [{"properties": {"cfg": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}]}}]}',
  translatedSiblingAllOf:
    '{"model": "gemini-2.5-pro", "tools": [{"functionDeclarations": [{"name": "ConfigureSibling", "parametersJsonSchema": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, "required": ["cfg"]}}]}]}',
  arrayContainsRequest:
    '{"tools": [{"name": "BatchContains", "input_schema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {}}, "contains": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}, "required": ["rows"], "additionalProperties": false}}]}',
  translatedArrayContains:
    '{"model": "claude-sonnet-4-6", "request": {"tools": [{"functionDeclarations": [{"name": "BatchContains", "parametersJsonSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}, "required": ["rows"]}}]}]}}',
  arrayEnumRequest:
    '{"tools": [{"name": "BatchEnum", "input_schema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {}}, "enum": [[{"reason": "business"}]]}}, "required": ["rows"], "additionalProperties": false}}]}',
  translatedArrayEnum:
    '{"model": "claude-sonnet-4-6", "request": {"tools": [{"functionDeclarations": [{"name": "BatchEnum", "parametersJsonSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}, "required": ["rows"]}}]}]}}',
  enumUnionRequest:
    '{"tools": [{"name": "ExplainFixed", "input_schema": {"type": "object", "enum": [{"reason": "business"}], "anyOf": [{"type": "object", "properties": {}}]}}]}',
  enumRequest:
    '{"tools": [{"name": "ExplainFixed", "input_schema": {"type": "object", "enum": [{"reason": "business"}]}}, {"name": "ConstTool", "input_schema": {"type": "object", "const": {"reason": "fixed"}}}]}',
  translatedEnum:
    '{"model": "claude-sonnet-4-6", "request": {"tools": [{"functionDeclarations": [{"name": "ExplainFixed", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, {"name": "ConstTool", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}]}]}}',
  collisionSeed: '{"tools": [{"name": "1"}, {"name": "_1"}]}',
  collisionRequest:
    '{"tools": [{"name": "1", "input_schema": {"type": "object", "properties": {}, "required": ["reason"]}}, {"name": "_1", "input_schema": {"type": "object", "properties": {}}}]}',
  round15Request:
    '{"tools": [{"name": "Batch", "input_schema": {"type": "object", "anyOf": [{"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {}, "additionalProperties": false}}}, "required": ["rows"], "additionalProperties": false}, {"type": "object", "properties": {"rows": {}}, "required": ["rows"], "additionalProperties": false}]}}, {"name": "BatchStrict", "input_schema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {}, "additionalProperties": false}}}, "required": ["rows"]}}]}',
  translatedRound15:
    '{"model": "gemini-2.5-pro", "tools": [{"functionDeclarations": [{"name": "Batch", "parametersJsonSchema": {"type": "object", "anyOf": [{"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {}}}}, "required": ["rows"]}, {"type": "object", "properties": {"rows": {}}, "required": ["rows"]}]}}, {"name": "BatchStrict", "parametersJsonSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}, "required": ["rows"]}}]}]}',
  round14Request:
    '{"tools": [{"name": "ConfigureAltFree", "input_schema": {"type": "object", "anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {}, "additionalProperties": false}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "properties": {"cfg": {}}, "required": ["cfg"], "additionalProperties": false}]}}]}',
  translatedRound14:
    '{"model": "gemini-2.5-pro", "tools": [{"functionDeclarations": [{"name": "ConfigureAltFree", "parametersJsonSchema": {"type": "object", "anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {}}}, "required": ["cfg"]}, {"type": "object", "properties": {"cfg": {}}, "required": ["cfg"]}]}}]}]}',
  round13Request:
    '{"tools": [{"name": "DeepAlt", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {"opts": {"type": "object", "properties": {"mode": {"type": "string"}}, "additionalProperties": false}}, "required": ["opts"], "additionalProperties": false}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"tag": {"type": "string"}}, "required": ["tag"]}}, "required": ["cfg"], "additionalProperties": false}]}}, "required": ["choice"], "additionalProperties": false}}]}',
  translatedRound13:
    '{"model": "gemini-3-pro-high", "request": {"tools": [{"functionDeclarations": [{"name": "DeepAlt", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"opts": {"type": "object", "properties": {"mode": {"type": "string"}, "_": {"type": "boolean"}}, "required": ["_"]}}, "required": ["opts"]}}, "required": ["cfg"]}}, "required": ["choice"]}}]}]}}',
  round12Request:
    '{"tools": [{"name": "ConfigureAlt", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {}, "additionalProperties": false}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}, "required": ["mode"]}}, "required": ["cfg"], "additionalProperties": false}]}}, "required": ["choice"], "additionalProperties": false}}]}',
  translatedRound12:
    '{"model": "gemini-3-pro-high", "request": {"tools": [{"functionDeclarations": [{"name": "ConfigureAlt", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, "required": ["cfg"]}, {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}, "required": ["mode"]}}, "required": ["cfg"]}]}}, "required": ["choice"]}}]}]}}',
  round11Request:
    '{"tools": [{"name": "ChooseImplicit", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {}, "additionalProperties": false}, {"type": "object", "properties": {"tag": {"type": "string"}}, "required": ["tag"]}]}}, "required": ["choice"]}}]}',
  translatedRound11:
    '{"model": "gemini-3-pro-high", "request": {"tools": [{"functionDeclarations": [{"name": "ChooseImplicit", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}, {"type": "object", "properties": {"tag": {"type": "string"}}, "required": ["tag"]}]}}, "required": ["choice"]}}]}]}}',
  round10Request:
    '{"tools": [{"name": "ImplicitBranch", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}, "additionalProperties": false}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "properties": {"tag": {"type": "string"}}, "required": ["tag"]}]}}, "required": ["choice"], "additionalProperties": false}}]}',
  translatedRound10:
    '{"model": "gemini-3.1-pro", "request": {"tools": [{"functionDeclarations": [{"name": "ImplicitBranch", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}, "_": {"type": "boolean"}}, "required": ["_"]}}, "required": ["cfg"]}}, "required": ["choice"]}}]}]}}',
  round9Request:
    '{"tools": [{"name": "ConfigureNested", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}, "additionalProperties": false}}, "required": ["cfg"], "additionalProperties": false}, {"type": "object", "patternProperties": {"^cfg$": {"type": "object", "additionalProperties": true}}, "additionalProperties": false}]}}, "required": ["choice"]}}]}',
  translatedRound9:
    '{"model": "gemini-3.1-pro", "request": {"tools": [{"functionDeclarations": [{"name": "ConfigureNested", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}, "_": {"type": "boolean"}}, "required": ["_"]}}, "required": ["cfg"]}}, "required": ["choice"]}}]}]}}',
  round8Request:
    '{"tools": [{"name": "ExplainPattern", "input_schema": {"type": "object", "properties": {}, "patternProperties": {"^reason$": {"type": "string"}}, "additionalProperties": false}}, {"name": "PatternData", "input_schema": {"type": "object", "properties": {}, "patternProperties": {"^x-": {"type": "string"}}, "additionalProperties": false}}]}',
  translatedRound8:
    '{"model": "gemini-3.1-pro", "request": {"tools": [{"functionDeclarations": [{"name": "ExplainPattern", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, {"name": "PatternData", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}]}]}}',
  round7Request:
    '{"tools": [{"name": "Configure", "input_schema": {"type": "object", "properties": {"cfg": {"anyOf": [{"type": "object", "properties": {}, "additionalProperties": false}, {"type": "object", "additionalProperties": true}]}}, "required": ["cfg"]}}]}',
  translatedRound7:
    '{"model": "gemini-3.1-pro", "request": {"tools": [{"functionDeclarations": [{"name": "Configure", "parametersJsonSchema": {"type": "object", "properties": {"cfg": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}, {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}]}}, "required": ["cfg"]}}]}]}}',
  round6Request:
    '{"tools": [{"name": "PlainOptions", "input_schema": {"type": "object", "properties": {"flag": {"type": "string"}}}}, {"name": "StrictOptions", "input_schema": {"type": "object", "properties": {"flag": {"type": "string"}}, "additionalProperties": false}}, {"name": "BranchChoice", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "additionalProperties": true}}, "required": ["cfg"]}, {"type": "object", "properties": {"cfg": {"type": "object", "properties": {}, "additionalProperties": false}}, "required": ["cfg"]}]}}, "required": ["choice"]}}]}',
  translatedRound6:
    '{"model": "gemini-2.5-pro", "tools": [{"functionDeclarations": [{"name": "PlainOptions", "parametersJsonSchema": {"type": "object", "properties": {"flag": {"type": "string"}}}}, {"name": "StrictOptions", "parametersJsonSchema": {"type": "object", "properties": {"flag": {"type": "string"}}}}, {"name": "BranchChoice", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"cfg": {"type": "object", "additionalProperties": true}}, "required": ["cfg"]}, {"type": "object", "properties": {"cfg": {"type": "object", "properties": {}}}, "required": ["cfg"]}]}}, "required": ["choice"]}}]}]}',
  round5Request:
    '{"tools": [{"name": "Explain", "input_schema": {"type": "object", "required": ["reason"], "additionalProperties": true}}, {"name": "Choose", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"opts": {"type": "object", "properties": {}, "additionalProperties": false}}, "required": ["opts"]}, {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}]}}, "required": ["choice"]}}, {"name": "Options", "input_schema": {"type": "object", "properties": {"flag": {"type": "string"}}, "additionalProperties": true}}]}',
  translatedRound5:
    '{"model": "gemini-3.8-flash-high", "tools": [{"functionDeclarations": [{"name": "Explain", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, {"name": "Choose", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"type": "object", "properties": {"opts": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, "required": ["opts"]}}, "required": ["choice"]}}, {"name": "Options", "parametersJsonSchema": {"type": "object", "properties": {"flag": {"type": "string"}}, "additionalProperties": true}}]}]}',
  round4Request:
    '{"tools": [{"name": "UnionChoice", "input_schema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}, {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}]}}, "required": ["choice"]}}, {"name": "AllOfChildMerge", "input_schema": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}}}, "allOf": [{"properties": {"cfg": {"type": "object", "properties": {}}}}]}}, {"name": "NestedRefTool", "input_schema": {"type": "object", "properties": {"opts": {"$ref": "#/$defs/Empty"}}, "$defs": {"Empty": {"type": "object", "properties": {}, "additionalProperties": false}}}}, {"name": "WrappedPlaceholder", "input_schema": {"type": "object", "properties": {"flag": {"type": "string"}}, "additionalProperties": false}}]}',
  translatedRound4:
    '{"model": "gemini-3.8-flash-high", "request": {"tools": [{"functionDeclarations": [{"name": "UnionChoice", "parametersJsonSchema": {"type": "object", "properties": {"choice": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}, {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}]}}, "required": ["choice"]}}, {"name": "AllOfChildMerge", "parametersJsonSchema": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}}}}}, {"name": "NestedRefTool", "parametersJsonSchema": {"type": "object", "properties": {"opts": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}}, {"name": "WrappedPlaceholder", "parametersJsonSchema": {"type": "object", "properties": {"flag": {"type": "string"}}}}]}]}}',
  extraRequest:
    '{"tools": [{"name": "AllOfDynamicConflict", "input_schema": {"type": "object", "properties": {}, "additionalProperties": false, "allOf": [{"additionalProperties": true}]}}, {"name": "MultiUnionEmpty", "input_schema": {"anyOf": [{"type": "object", "properties": {}, "additionalProperties": false}, {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"], "additionalProperties": false}]}}, {"name": "DupTool", "input_schema": {"type": "object", "properties": {}}}, {"name": "DupTool", "input_schema": {"type": "object", "properties": {}}}, {"name": "ConflictingDup", "input_schema": {"type": "object", "properties": {}}}, {"name": "ConflictingDup", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}, {"name": "MatrixTool", "input_schema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "array", "items": {"type": "object", "properties": {}}}}}}}]}',
  translatedExtra:
    '{"model": "gemini-3.8-flash-high", "request": {"tools": [{"functionDeclarations": [{"name": "AllOfDynamicConflict", "parametersJsonSchema": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}, {"name": "MultiUnionEmpty", "parametersJsonSchema": {"anyOf": [{"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}, {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}]}}, {"name": "MatrixTool", "parametersJsonSchema": {"type": "object", "properties": {"rows": {"type": "array", "items": {"type": "array", "items": {"type": "object", "properties": {"reason": {"type": "string"}}, "required": ["reason"]}}}}}}]}]}}',
  deepRequest:
    '{"tools": [{"name": "FreeFormNested", "input_schema": {"type": "object", "properties": {"payload": {}}, "required": ["payload"]}}, {"name": "AllOfMerge", "input_schema": {"type": "object", "properties": {"cfg": {"type": "object", "properties": {"mode": {"type": "string"}}}}, "allOf": [{"type": "object", "properties": {"cfg": {"type": "object", "properties": {"reason": {"type": "string"}}}}}]}}, {"name": "SingleUnionEmpty", "input_schema": {"anyOf": [{"type": "object", "properties": {}}]}}, {"name": "DynamicParent", "input_schema": {"type": "object", "properties": {"opts": {"type": "object", "properties": {}}}, "additionalProperties": true}}, {"name": "RefArray", "input_schema": {"type": "object", "properties": {"items": {"$ref": "#/$defs/list"}}, "$defs": {"list": {"type": "array", "items": {"type": "object", "properties": {"v": {"type": "string"}}}}}}}, {"name": "PropRef", "input_schema": {"type": "object", "properties": {"template": {"type": "object", "properties": {}}, "copy": {"$ref": "#/properties/template"}}}}]}',
} satisfies Record<string, string>;

const REQUESTS = new Map(Object.entries(GO_REQUESTS));

// Go builds this one from the request-wide disambiguation map: two tools whose names sanitise alike get hash suffixes.
const sentName =
  sanitizedFunctionNameMap(parse('{"tools":[{"name":"1"},{"name":"_1"}]}'))?.get("1") ?? "";

REQUESTS.set(
  "translatedCollisionDynamic",
  JSON.stringify({
    model: "claude-sonnet-4-6",
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: sentName,
              parametersJsonSchema: {
                type: "object",
                properties: { reason: { type: "string" } },
                required: ["reason"],
              },
            },
          ],
        },
      ],
    },
  }),
);

/** name, raw args, tool, original request, want, translated request. */
const ROWS: ReadonlyArray<readonly [string, string, string, string, string, string]> = [
  [
    "parameterless empty properties",
    '{"reason":"Entering plan mode"}',
    "EnterPlanMode",
    "origRequest",
    "{}",
    "nil",
  ],
  [
    "parameterless missing properties",
    '{"reason":"List jobs"}',
    "CronList",
    "origRequest",
    "{}",
    "nil",
  ],
  [
    "declared args preserved",
    '{"command":"ls -la"}',
    "Bash",
    "origRequest",
    '{"command":"ls -la"}',
    "nil",
  ],
  [
    "undeclared reason stripped",
    '{"command":"ls -la","reason":"why"}',
    "Bash",
    "origRequest",
    '{"command":"ls -la"}',
    "nil",
  ],
  [
    "reason kept when translated schema lacks placeholder",
    '{"command":"ls -la","reason":"why"}',
    "Bash",
    "origRequest",
    '{"command":"ls -la","reason":"why"}',
    "transferredRequest",
  ],
  [
    "reason stripped when translated schema marks placeholder",
    '{"command":"ls -la","reason":"why"}',
    "Bash",
    "origRequest",
    '{"command":"ls -la"}',
    "translatedReasonRequired",
  ],
  [
    "undeclared underscore stripped",
    '{"command":"ls -la","_":true}',
    "Bash",
    "origRequest",
    '{"command":"ls -la"}',
    "nil",
  ],
  [
    "declared reason preserved",
    '{"reason":"valid"}',
    "CustomToolWithReason",
    "origRequest",
    '{"reason":"valid"}',
    "nil",
  ],
  [
    "additional properties preserved",
    '{"name":"x","reason":"dynamic"}',
    "DynamicTool",
    "origRequest",
    '{"name":"x","reason":"dynamic"}',
    "nil",
  ],
  [
    "union schema passthrough",
    '{"reason":"x"}',
    "UnionTool",
    "origRequest",
    '{"reason":"x"}',
    "nil",
  ],
  ["unknown tool passthrough", '{"reason":"x"}', "EnterPlanMode", "nil", '{"reason":"x"}', "nil"],
  ["empty args", "", "EnterPlanMode", "origRequest", "{}", "nil"],
  ["empty object args", "{}", "EnterPlanMode", "origRequest", "{}", "nil"],
  [
    "dynamic map tool preserved",
    '{"key":"value"}',
    "MapTool",
    "dynamicRequest",
    '{"key":"value"}',
    "nil",
  ],
  [
    "typed map tool preserved",
    '{"key":"value"}',
    "TypedMapTool",
    "dynamicRequest",
    '{"key":"value"}',
    "nil",
  ],
  [
    "case collision exact match keeps args",
    '{"path":"/tmp/a"}',
    "read",
    "caseCollisionRequest",
    '{"path":"/tmp/a"}',
    "nil",
  ],
  [
    "case collision exact match parameterless",
    '{"reason":"x"}',
    "Read",
    "caseCollisionRequest",
    "{}",
    "nil",
  ],
  ["allOf empty normalized", '{"reason":"x"}', "AllOfEmpty", "composedRequest", "{}", "nil"],
  [
    "allOf declared args preserved",
    '{"path":"/tmp/a"}',
    "AllOfArgs",
    "composedRequest",
    '{"path":"/tmp/a"}',
    "nil",
  ],
  ["ref to empty normalized", '{"reason":"x"}', "RefEmpty", "composedRequest", "{}", "nil"],
  [
    "nested placeholders stripped",
    '{"opts":{"reason":"x"},"cfg":{"mode":"fast","_":true}}',
    "NestedTool",
    "composedRequest",
    '{"opts":{},"cfg":{"mode":"fast"}}',
    "nil",
  ],
  [
    "free-form nested preserved",
    '{"payload":{"value":1}}',
    "FreeFormNested",
    "deepRequest",
    '{"payload":{"value":1}}',
    "nil",
  ],
  [
    "allOf deep merge keeps declared reason",
    '{"cfg":{"mode":"a","reason":"b"}}',
    "AllOfMerge",
    "deepRequest",
    '{"cfg":{"mode":"a","reason":"b"}}',
    "nil",
  ],
  [
    "single union empty normalized",
    '{"reason":"x"}',
    "SingleUnionEmpty",
    "deepRequest",
    "{}",
    "nil",
  ],
  [
    "dynamic parent still cleans declared child",
    '{"extra":1,"opts":{"reason":"x"}}',
    "DynamicParent",
    "deepRequest",
    '{"extra":1,"opts":{}}',
    "nil",
  ],
  [
    "ref array items cleaned",
    '{"items":[{"v":"a","_":true}]}',
    "RefArray",
    "deepRequest",
    '{"items":[{"v":"a"}]}',
    "nil",
  ],
  [
    "property ref cleaned",
    '{"copy":{"reason":"x"},"template":{}}',
    "PropRef",
    "deepRequest",
    '{"copy":{},"template":{}}',
    "nil",
  ],
  [
    "allOf dynamic conflict uses translated schema",
    '{"reason":"x"}',
    "AllOfDynamicConflict",
    "extraRequest",
    "{}",
    "translatedExtra",
  ],
  [
    "multi-branch union uses translated schema",
    '{"reason":"x"}',
    "MultiUnionEmpty",
    "extraRequest",
    "{}",
    "translatedExtra",
  ],
  ["identical duplicates cleaned", '{"reason":"x"}', "DupTool", "extraRequest", "{}", "nil"],
  [
    "conflicting duplicates passthrough",
    '{"path":"/tmp/a"}',
    "ConflictingDup",
    "extraRequest",
    '{"path":"/tmp/a"}',
    "nil",
  ],
  [
    "conflicting duplicates keep first-declared cleaning",
    '{"reason":"x"}',
    "ConflictingDup",
    "extraRequest",
    '{"reason":"x"}',
    "nil",
  ],
  [
    "matrix nested arrays cleaned",
    '{"rows":[[{"reason":"x"}]]}',
    "MatrixTool",
    "extraRequest",
    '{"rows":[[{}]]}',
    "translatedExtra",
  ],
  [
    "union declared required reason preserved",
    '{"choice":{"reason":"maintenance"}}',
    "UnionChoice",
    "round4Request",
    '{"choice":{"reason":"maintenance"}}',
    "translatedRound4",
  ],
  [
    "allOf child merge keeps mode",
    '{"cfg":{"mode":"fast"}}',
    "AllOfChildMerge",
    "round4Request",
    '{"cfg":{"mode":"fast"}}',
    "translatedRound4",
  ],
  [
    "nested ref placeholder cleaned",
    '{"opts":{"reason":"initialize"}}',
    "NestedRefTool",
    "round4Request",
    '{"opts":{}}',
    "translatedRound4",
  ],
  [
    "required-only reason preserved",
    '{"reason":"maintenance"}',
    "Explain",
    "round5Request",
    '{"reason":"maintenance"}',
    "translatedRound5",
  ],
  [
    "union branch nested placeholder cleaned",
    '{"choice":{"opts":{"reason":"initialize"}}}',
    "Choose",
    "round5Request",
    '{"choice":{"opts":{}}}',
    "translatedRound5",
  ],
  [
    "gemini route keeps dynamic underscore",
    '{"flag":"x","_":true}',
    "Options",
    "round5Request",
    '{"flag":"x","_":true}',
    "translatedRound5",
  ],
  [
    "implicit additional properties keeps underscore",
    '{"flag":"x","_":true}',
    "PlainOptions",
    "round6Request",
    '{"flag":"x","_":true}',
    "translatedRound6",
  ],
  [
    "closed object still strips executor underscore",
    '{"flag":"x","_":true}',
    "StrictOptions",
    "round6Request",
    '{"flag":"x"}',
    "translatedRound6",
  ],
  [
    "alternative branch dynamic data preserved",
    '{"choice":{"cfg":{"value":1}}}',
    "BranchChoice",
    "round6Request",
    '{"choice":{"cfg":{"value":1}}}',
    "translatedRound6",
  ],
  [
    "alternative branch dynamic reason preserved",
    '{"cfg":{"reason":"business"}}',
    "Configure",
    "round7Request",
    '{"cfg":{"reason":"business"}}',
    "translatedRound7",
  ],
  [
    "pattern property reason preserved",
    '{"reason":"business"}',
    "ExplainPattern",
    "round8Request",
    '{"reason":"business"}',
    "translatedRound8",
  ],
  [
    "pattern property non-placeholder data preserved",
    '{"x-note":"keep"}',
    "PatternData",
    "round8Request",
    '{"x-note":"keep"}',
    "translatedRound8",
  ],
  [
    "union branch pattern child preserved",
    '{"choice":{"cfg":{"mode":"fast","_":true}}}',
    "ConfigureNested",
    "round9Request",
    '{"choice":{"cfg":{"mode":"fast","_":true}}}',
    "translatedRound9",
  ],
  [
    "implicit open branch child preserved",
    '{"choice":{"tag":"keep","cfg":{"mode":"fast","_":true}}}',
    "ImplicitBranch",
    "round10Request",
    '{"choice":{"tag":"keep","cfg":{"mode":"fast","_":true}}}',
    "translatedRound10",
  ],
  [
    "implicit open branch field preserved",
    '{"choice":{"tag":"keep","reason":"business"}}',
    "ChooseImplicit",
    "round11Request",
    '{"choice":{"tag":"keep","reason":"business"}}',
    "translatedRound11",
  ],
  [
    "implicit open branch non-matching object cleaned",
    '{"choice":{"reason":"x"}}',
    "ChooseImplicit",
    "round11Request",
    '{"choice":{}}',
    "translatedRound11",
  ],
  [
    "alternative child candidates keep matched data",
    '{"choice":{"cfg":{"mode":"fast","reason":"business"}}}',
    "ConfigureAlt",
    "round12Request",
    '{"choice":{"cfg":{"mode":"fast","reason":"business"}}}',
    "translatedRound12",
  ],
  [
    "alternative child candidates clean unmatched placeholder",
    '{"choice":{"cfg":{"reason":"x"}}}',
    "ConfigureAlt",
    "round12Request",
    '{"choice":{"cfg":{}}}',
    "translatedRound12",
  ],
  [
    "deep alternative candidates keep matched subtree",
    '{"choice":{"cfg":{"tag":"keep","opts":{"mode":"fast","_":true}}}}',
    "DeepAlt",
    "round13Request",
    '{"choice":{"cfg":{"tag":"keep","opts":{"mode":"fast","_":true}}}}',
    "translatedRound13",
  ],
  [
    "deep alternative candidates clean unmatched subtree",
    '{"choice":{"cfg":{"opts":{"mode":"fast","_":true}}}}',
    "DeepAlt",
    "round13Request",
    '{"choice":{"cfg":{"opts":{"mode":"fast"}}}}',
    "translatedRound13",
  ],
  [
    "free-form alternative child preserved",
    '{"cfg":{"reason":"business","value":1}}',
    "ConfigureAltFree",
    "round14Request",
    '{"cfg":{"reason":"business","value":1}}',
    "translatedRound14",
  ],
  [
    "free-form array candidate preserved",
    '{"rows":[{"value":1}]}',
    "Batch",
    "round15Request",
    '{"rows":[{"value":1}]}',
    "translatedRound15",
  ],
  [
    "strict array placeholder cleaned",
    '{"rows":[{"reason":"x"}]}',
    "BatchStrict",
    "round15Request",
    '{"rows":[{}]}',
    "translatedRound15",
  ],
  [
    "fallback keeps required-only reason",
    '{"reason":"business"}',
    "1",
    "collisionRequest",
    '{"reason":"business"}',
    "nil",
  ],
  [
    "object enum value preserved",
    '{"reason":"business"}',
    "ExplainFixed",
    "enumRequest",
    '{"reason":"business"}',
    "translatedEnum",
  ],
  [
    "object enum with union preserved",
    '{"reason":"business"}',
    "ExplainFixed",
    "enumUnionRequest",
    '{"reason":"business"}',
    "translatedEnum",
  ],
  [
    "array enum elements preserved",
    '{"rows":[{"reason":"business"}]}',
    "BatchEnum",
    "arrayEnumRequest",
    '{"rows":[{"reason":"business"}]}',
    "translatedArrayEnum",
  ],
  [
    "array enum elements preserved fallback",
    '{"rows":[{"reason":"business"}]}',
    "BatchEnum",
    "arrayEnumRequest",
    '{"rows":[{"reason":"business"}]}',
    "nil",
  ],
  [
    "array contains elements preserved",
    '{"rows":[{"reason":"business"}]}',
    "BatchContains",
    "arrayContainsRequest",
    '{"rows":[{"reason":"business"}]}',
    "translatedArrayContains",
  ],
  [
    "array contains elements preserved fallback",
    '{"rows":[{"reason":"business"}]}',
    "BatchContains",
    "arrayContainsRequest",
    '{"rows":[{"reason":"business"}]}',
    "nil",
  ],
  [
    "sibling allOf declaration preserved",
    '{"cfg":{"reason":"business"}}',
    "ConfigureSibling",
    "siblingAllOfRequest",
    '{"cfg":{"reason":"business"}}',
    "translatedSiblingAllOf",
  ],
  [
    "minProperties object preserved",
    '{"reason":"store","label":"keep"}',
    "StoreMetadata",
    "minPropsRequest",
    '{"reason":"store","label":"keep"}',
    "translatedMinProps",
  ],
  [
    "minProperties object preserved fallback",
    '{"reason":"store","label":"keep"}',
    "StoreMetadata",
    "minPropsRequest",
    '{"reason":"store","label":"keep"}',
    "nil",
  ],
  [
    "uniqueItems elements preserved",
    '{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}',
    "BatchUnique",
    "uniqueItemsRequest",
    '{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}',
    "translatedUniqueItems",
  ],
  [
    "uniqueItems elements preserved fallback",
    '{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}',
    "BatchUnique",
    "uniqueItemsRequest",
    '{"rows":[{"tag":"same","_":true},{"tag":"same","_":false}]}',
    "nil",
  ],
  [
    "object enum value preserved fallback",
    '{"reason":"business"}',
    "ExplainFixed",
    "enumRequest",
    '{"reason":"business"}',
    "nil",
  ],
  [
    "object const value preserved",
    '{"reason":"fixed"}',
    "ConstTool",
    "enumRequest",
    '{"reason":"fixed"}',
    "translatedEnum",
  ],
  [
    "disambiguated name uses translated schema",
    '{"reason":"business"}',
    "1",
    "collisionRequest",
    '{"reason":"business"}',
    "translatedCollisionDynamic",
  ],
];

describe("cleanClaudeToolArgumentsWithTranslated (Go TestCleanClaudeToolArguments)", () => {
  it.each(ROWS)("%s", (_name, rawArgs, toolName, request, want, translated) => {
    const original = request === "nil" ? undefined : parse(REQUESTS.get(request) ?? "");
    const sent = translated === "nil" ? undefined : parse(REQUESTS.get(translated) ?? "");

    expect(cleanClaudeToolArgumentsWithTranslated(rawArgs, toolName, original, sent)).toBe(want);
  });
});

const implicit = (schema: string): [string, string] => [
  `{"tools":[{"name":"echo","input_schema":${schema}}]}`,
  `{"tools":[{"functionDeclarations":[{"name":"echo","parametersJsonSchema":${JSON.stringify(cleanJsonSchemaForGeminiJsonSchema(parse(schema) ?? null))}}]}]}`,
];

describe("implicitly open object schemas (Go TestCleanClaudeToolArguments_ImplicitOpenObjectPreservesArguments)", () => {
  const cases: ReadonlyArray<readonly [string, string, string, string, boolean]> = [
    [
      "additionalProperties omitted",
      '{"type":"object","properties":{}}',
      '{"user":"v"}',
      '{"user":"v"}',
      false,
    ],
    [
      "additionalProperties omitted, no properties",
      '{"type":"object"}',
      '{"user":"v"}',
      '{"user":"v"}',
      false,
    ],
    [
      "additionalProperties true",
      '{"type":"object","properties":{},"additionalProperties":true}',
      '{"user":"v"}',
      '{"user":"v"}',
      false,
    ],
    [
      "additionalProperties false",
      '{"type":"object","properties":{},"additionalProperties":false}',
      '{"user":"v"}',
      "{}",
      true,
    ],
    [
      "additionalProperties false, no properties",
      '{"type":"object","additionalProperties":false}',
      '{"user":"v"}',
      "{}",
      true,
    ],
    [
      "nested implicit open keeps the user arg",
      '{"type":"object","properties":{"opts":{"type":"object","properties":{}}}}',
      '{"opts":{"user":"v"}}',
      '{"opts":{"user":"v"}}',
      false,
    ],
    [
      "nested explicit closed erases the user arg",
      '{"type":"object","properties":{"opts":{"type":"object","properties":{},"additionalProperties":false}}}',
      '{"opts":{"user":"v"}}',
      '{"opts":{}}',
      false,
    ],
    [
      "array item implicit open keeps the user arg",
      '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{}}}}}',
      '{"items":[{"user":"v"}]}',
      '{"items":[{"user":"v"}]}',
      false,
    ],
    [
      "array item explicit closed erases the user arg",
      '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{},"additionalProperties":false}}}}',
      '{"items":[{"user":"v"}]}',
      '{"items":[{}]}',
      false,
    ],
    [
      "allOf implicit open keeps the user arg",
      '{"type":"object","allOf":[{"type":"object","properties":{}}]}',
      '{"user":"v"}',
      '{"user":"v"}',
      false,
    ],
    [
      "allOf explicit closed erases the user arg",
      '{"type":"object","allOf":[{"type":"object","properties":{},"additionalProperties":false}]}',
      '{"user":"v"}',
      "{}",
      true,
    ],
    [
      "local ref implicit open keeps the user arg",
      '{"$ref":"#/$defs/open","$defs":{"open":{"type":"object","properties":{}}}}',
      '{"user":"v"}',
      '{"user":"v"}',
      false,
    ],
    [
      "local ref explicit closed erases the user arg",
      '{"$ref":"#/$defs/closed","$defs":{"closed":{"type":"object","properties":{},"additionalProperties":false}}}',
      '{"user":"v"}',
      "{}",
      true,
    ],
  ];

  it.each(cases)("%s", (_name, schema, args, want, parameterless) => {
    const [original, translated] = implicit(schema);

    expect(cleanClaudeToolArguments(args, "echo", parse(original))).toBe(want);
    expect(
      cleanClaudeToolArgumentsWithTranslated(args, "echo", parse(original), parse(translated)),
    ).toBe(want);
    expect(claudeToolIsParameterless("echo", parse(original))).toBe(parameterless);
  });

  it("strips an injected placeholder but keeps the user arg", () => {
    const schema = '{"type":"object","properties":{}}';
    const original = parse(`{"tools":[{"name":"echo","input_schema":${schema}}]}`);

    const translated = parse(
      `{"tools":[{"functionDeclarations":[{"name":"echo","parametersJsonSchema":${JSON.stringify(cleanJsonSchemaForAntigravity(parse(schema) ?? null))}}]}]}`,
    );

    const args = '{"user":"v","reason":"Brief explanation"}';
    expect(cleanClaudeToolArguments(args, "echo", original)).toBe('{"user":"v"}');
    expect(cleanClaudeToolArgumentsWithTranslated(args, "echo", original, translated)).toBe(
      '{"user":"v"}',
    );
  });
});
