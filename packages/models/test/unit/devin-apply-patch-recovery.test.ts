// Bare Codex patches in Devin's invalid_json_str (CLIProxyAPI b4f59d70, helps/devin_apply_patch_diagnostic_test.go
// `TestRecoverDevinBareApplyPatch`).
import { describe, expect, it } from "vitest";
import {
  canBeDevinBareApplyPatchPrefix,
  recoverDevinBareApplyPatch,
} from "../../src/executor/devin/apply-patch-recovery.ts";

describe("recoverDevinBareApplyPatch", () => {
  const valid: ReadonlyArray<readonly [string, string, string]> = [
    [
      "add file",
      "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch",
      '{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"}',
    ],
    [
      "update move delete and environment id with surrounding newlines",
      "\n*** Begin Patch\n*** Environment ID: env-1\n*** Delete File: old.txt\n*** Update File: a.txt\n*** Move to: b.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n*** End of File\n*** End Patch\n",
      '{"input":"*** Begin Patch\\n*** Environment ID: env-1\\n*** Delete File: old.txt\\n*** Update File: a.txt\\n*** Move to: b.txt\\n@@ -1,2 +1,2 @@\\n keep\\n-old\\n+new\\n*** End of File\\n*** End Patch"}',
    ],
    [
      "update file without initial hunk header",
      "*** Begin Patch\n*** Update File: a.txt\n-old\n+new\n*** End Patch",
      '{"input":"*** Begin Patch\\n*** Update File: a.txt\\n-old\\n+new\\n*** End Patch"}',
    ],
  ];

  for (const [name, input, want] of valid) {
    it(`recovers: ${name}`, () => {
      expect(canBeDevinBareApplyPatchPrefix(input.slice(0, 10))).toBe(true);
      expect(canBeDevinBareApplyPatchPrefix(input)).toBe(true);
      expect(recoverDevinBareApplyPatch(input)).toBe(want);
    });
  }

  const invalid: ReadonlyArray<readonly [string, string, boolean]> = [
    ["truncated missing end patch", "*** Begin Patch\n*** Add File: a.txt\n+hi", true],
    ["empty patch without file operations", "*** Begin Patch\n*** End Patch", true],
    ["add file without content lines", "*** Begin Patch\n*** Add File: a.txt\n*** End Patch", true],
    [
      "update file without changes or move",
      "*** Begin Patch\n*** Update File: a.txt\n*** End Patch",
      true,
    ],
    [
      "update file with empty hunk only",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n*** End Patch",
      true,
    ],
    [
      "update file with empty trailing hunk",
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n@@\n*** End Patch",
      true,
    ],
    [
      "update file with move only and no hunks",
      "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch",
      true,
    ],
    [
      "duplicate environment id",
      "*** Begin Patch\n*** Environment ID: env-1\n*** Environment ID: env-2\n*** Add File: a.txt\n+hi\n*** End Patch",
      true,
    ],
    [
      "missing space after add file colon",
      "*** Begin Patch\n*** Add File:a.txt\n+hi\n*** End Patch",
      true,
    ],
    [
      "missing space after update file colon",
      "*** Begin Patch\n*** Update File:a.txt\n@@\n-old\n+new\n*** End Patch",
      true,
    ],
    [
      "missing space after delete file colon",
      "*** Begin Patch\n*** Delete File:a.txt\n*** End Patch",
      true,
    ],
    [
      "missing space after move to colon",
      "*** Begin Patch\n*** Update File: a.txt\n*** Move to:b.txt\n@@\n-old\n+new\n*** End Patch",
      true,
    ],
    [
      "missing space after environment id colon",
      "*** Begin Patch\n*** Environment ID:env-1\n*** Add File: a.txt\n+hi\n*** End Patch",
      true,
    ],
    [
      "delete file with unexpected content line",
      "*** Begin Patch\n*** Delete File: a.txt\n+unexpected\n*** End Patch",
      true,
    ],
    [
      "nested begin patch marker",
      "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Begin Patch\n*** End Patch",
      true,
    ],
    [
      "json object in invalid_json_str",
      '{"input":"*** Begin Patch\\n*** Add File: a.txt\\n+hi\\n*** End Patch"}',
      false,
    ],
    ["ordinary text", "ls -la", false],
  ];

  for (const [name, input, canPrefix] of invalid) {
    it(`refuses: ${name}`, () => {
      expect(canBeDevinBareApplyPatchPrefix(input)).toBe(canPrefix);
      expect(recoverDevinBareApplyPatch(input)).toBeUndefined();
    });
  }
});
