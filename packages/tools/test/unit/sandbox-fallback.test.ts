// The fallback rule of Cloudflare's sandbox (#223, ADR 0041): a command line goes to the computer only when just-bash
// could not run any of it, decided before it runs from just-bash's own parser and command lookup; anything just-bash
// can start stays with it, whatever it exits with. The rule's just-bash is the one the session's shell runs.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import shellModules from "@cloudflare/computer/shell/core";
import { shellRefusal } from "../../src/sandbox/cloudflare/fallback.ts";

describe("the computer fallback rule", () => {
  it("leaves to just-bash every line it can run, failing or not", async () => {
    for (const command of [
      "ls -la",
      "cat missing.txt",
      "echo hi > a.txt && grep hi a.txt | sort | uniq -c",
      'for f in *.txt; do wc -l "$f"; done',
      "cd sub && pwd",
      "curl -sS https://example.com/",
      "f() { echo inner; }; f",
      "exit 127",
      // A name known only when it runs is just-bash's to answer, also behind a wrapper.
      "tool=node; $tool --version",
      "env $tool --version",
      'bash -c "$script"',
      // Wrappers of commands just-bash has, and lookups that run nothing.
      "env FOO=1 ls",
      "timeout 5 cat a.txt",
      "xargs -I {} echo {} < list.txt",
      "find . -name '*.txt' -exec cat {} \\;",
      "bash -c 'echo hi | wc -c'",
      "command -v node",
      "exec ls",
    ])
      expect([command, await shellRefusal(command)]).toEqual([command, undefined]);
  });

  it("sends a line naming a command just-bash lacks, wherever it is, before any of it runs", async () => {
    for (const [command, name] of [
      ["node --version", "node"],
      ["mise use node@22", "mise"],
      ["echo hi >> log.txt; python3 app.py", "python3"],
      ["cat data.json | npx prettier --stdin-filepath x.json", "npx"],
      ['echo "v=$(node -v)"', "node"],
      ["(cd app && npm install)", "npm"],
      ["git clone https://github.com/example/repo", "git"],
      ["./build.sh", "./build.sh"],
      ['n"o"de -e 1', "node"],
      // Behind a wrapper, past its options and operands.
      ["env FOO=1 -u BAR node app.js", "node"],
      ["xargs -n 1 -P 4 node < files.txt", "node"],
      ["timeout -s KILL 30 python3 slow.py", "python3"],
      ["nice -n 10 cargo build", "nice"],
      ["command -p node app.js", "node"],
      ["exec npm start", "npm"],
      ["time go test ./...", "go"],
      ["find . -name '*.ts' -execdir tsc {} +", "tsc"],
      ["find . -type f -exec cat {} \\; -exec node {} \\;", "node"],
      ["bash -c 'cd app && npm test'", "npm"],
      ["sh -ec 'node -v'", "node"],
      ["bash -c \"bash -c 'deno run x.ts'\"", "deno"],
      ["env timeout 5 node x.js", "node"],
    ] as const)
      expect([command, await shellRefusal(command)]).toEqual([command, { kind: "command", name }]);
  });

  it("sends a line whose syntax just-bash does not support", async () => {
    for (const command of ["cat <(echo a)", "select x in a b; do echo $x; done", "{ls;\n}"]) {
      const refusal = await shellRefusal(command);

      expect([command, refusal?.kind]).toEqual([command, "syntax"]);
    }
  });

  it("asks the just-bash the session's shell runs: the worker shell's modules are the installed version's", () => {
    // `@cloudflare/computer` bundles just-bash's content-hashed chunks into its worker-shell modules, each with the path
    // it came from; every one is a file of the installed just-bash only if both are one version.
    const installed = dirname(
      dirname(dirname(createRequire(import.meta.url).resolve("just-bash"))),
    );

    const bundled = new Set(
      Object.values(shellModules).flatMap(({ js }) =>
        [...js.matchAll(/node_modules\/just-bash\/(dist\/[\w./-]+\.js)/g)].map(
          ([, path]) => path ?? "",
        ),
      ),
    );

    expect(bundled.size).toBeGreaterThan(10);
    expect([...bundled].filter((path) => !existsSync(join(installed, path)))).toEqual([]);
  });
});
