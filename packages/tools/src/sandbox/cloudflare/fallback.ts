/**
 * The fallback rule of Cloudflare's sandbox (ADR 0041, #223): which commands just-bash cannot run at all, and so go to
 * the computer, and what a session without the computer says about them. `@cloudflare/computer` has no fallback of its
 * own; this is Commissary's.
 *
 * **The rule.** A command line goes to the computer only when just-bash could not run any of it:
 *
 * - its parser rejects the line, or holds a syntax error for a later part of it (`deferredError`): syntax it does not
 *   support;
 * - or a command the line runs is one just-bash lacks: not a function the line defines, and unknown to just-bash's own
 *   lookup (`type -t`, asked of a just-bash with the session shell's command set: its built-in commands and builtins,
 *   `curl`, and `@cloudflare/computer`'s `git`, `assets` and `artifacts`). The commands a line runs are the literal
 *   words in command position, in any pipeline, list, loop, subshell or command substitution, and the commands a
 *   wrapper among them runs: `env`, `xargs`, `timeout`, `nice`, `nohup`, `time`, `command`, `exec` and `sudo` (past
 *   their options), `find`'s `-exec`, `-execdir`, `-ok` and `-okdir`, and the script of `bash -c` and `sh -c`, checked
 *   as a line of its own. A path (`./build.sh`, `/usr/bin/env`) and `git` count as lacking: just-bash's files hold no
 *   binaries, and the Workspace's `git` stays unconfigured (the sandbox's `git` would not fetch through its egress
 *   point, #222).
 *
 * Both are decided **before** the line runs, from just-bash's own parser (`Bash.transform`) and lookup, never from a
 * run's exit code or output: a line that just-bash ran may have done part of its work before failing (`echo x >> log;
 * node app.js` appends before `node` is not found), so a command just-bash ran is never run again, whatever it exited
 * with. A name only known when the line runs (`$tool --version`, `env $tool`) is left to just-bash, which then answers
 * "command not found" itself.
 *
 * **One just-bash.** The session's shell runs the just-bash that `@cloudflare/computer` bundled into its worker-shell
 * modules; the rule asks the just-bash this package imports. The workspace pins both to one version (the `just-bash`
 * override in the root package.json), and a unit test (`test/unit/sandbox-fallback.test.ts`) fails when the bundled
 * modules are not the installed version's, so neither can move alone.
 *
 * just-bash is loaded with a dynamic import the first time a session asks, like the rest of the sandbox (`session.ts`).
 */

/** Why just-bash cannot run a command line, as a session tells the model. */
export type ShellRefusal =
  | { readonly kind: "syntax"; readonly message: string }
  | { readonly kind: "command"; readonly name: string };

/** Commands the sandbox's shell has but cannot use: the Workspace's `git` is unconfigured (#222). */
const LACKING = new Set(["git"]);

/** The commands `@cloudflare/computer`'s worker shell adds to just-bash's own (its `ShellWorker`). */
const SHELL_COMMANDS = ["git", "assets", "artifacts"] as const;

/** How deep `bash -c` scripts within `bash -c` scripts are followed. */
const MAX_DEPTH = 4;

/** just-bash's syntax tree as the walk reads it: plain data, whatever the node's shape. */
type SyntaxTree =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<SyntaxTree>
  | SyntaxNode;

interface SyntaxNode {
  readonly [key: string]: SyntaxTree;
}

const isNode = (tree: SyntaxTree): tree is SyntaxNode =>
  typeof tree === "object" && tree !== null && !Array.isArray(tree);

/** A word's text when it is literal throughout (quotes allowed), or undefined when the shell expands any of it. */
const literalWord = (word: SyntaxTree): string | undefined => {
  if (!isNode(word)) return undefined;
  const parts = word["parts"];

  if (!Array.isArray(parts)) return undefined;
  let text = "";

  for (const part of parts) {
    if (!isNode(part)) return undefined;
    const type = part["type"];
    const value = part["value"];

    if (
      (type === "Literal" || type === "SingleQuoted" || type === "Escaped") &&
      typeof value === "string"
    )
      text += value;
    else if (type === "DoubleQuoted") {
      const inner = literalWord(part);

      if (inner === undefined) return undefined;
      text += inner;
    } else return undefined;
  }

  return text;
};

/** A simple command's words: each one's text, or undefined when it is only known when the line runs. */
type Words = ReadonlyArray<string | undefined>;

/** What a wrapper runs: another command's words, or a script (`bash -c`). */
type Wrapped =
  | { readonly kind: "command"; readonly words: Words }
  | { readonly kind: "script"; readonly source: string };

/**
 * `args` past a wrapper's options (`-x`, `--long`, `--long=value`, `--`, and the value after each of `valued`) and
 * `operands` more words; undefined when an option is only known when the line runs.
 */
const pastOptions = (args: Words, valued: ReadonlySet<string>, operands = 0): Words | undefined => {
  let index = 0;

  while (index < args.length) {
    const word = args[index];

    if (word === undefined) return undefined;

    if (word === "--") {
      index += 1;
      break;
    }

    if (!word.startsWith("-") || word === "-") break;
    index += valued.has(word) ? 2 : 1;
  }

  return args.slice(index + operands);
};

/** The wrappers `pastOptions` reads, and their options that take a value, as the next word. */
const VALUED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "xargs",
    new Set([
      "-I",
      "-n",
      "-L",
      "-P",
      "-d",
      "-E",
      "-s",
      "-a",
      "--arg-file",
      "--delimiter",
      "--max-args",
    ]),
  ],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["nice", new Set(["-n", "--adjustment"])],
  ["nohup", new Set<string>()],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["exec", new Set(["-a"])],
  [
    "sudo",
    new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-U", "-T", "--user", "--group"]),
  ],
]);

/** `env`'s arguments past its options and variable assignments. */
const pastEnv = (args: Words): Words | undefined => {
  let index = 0;

  while (index < args.length) {
    const word = args[index];

    if (word === undefined) return undefined;

    if (word === "--") {
      index += 1;
      break;
    }

    if (word === "-u" || word === "-C" || word === "--unset" || word === "--chdir") index += 2;
    else if (word.startsWith("-") || word.includes("=")) index += 1;
    else break;
  }

  return args.slice(index);
};

/** The script of `bash -c` or `sh -c`, when the words name one and it is literal. */
const scriptOf = (args: Words): string | undefined => {
  let command = false;

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];

    if (word === undefined) return undefined;

    if (word === "-o" || word === "+o" || word === "-O" || word === "+O") {
      index += 1;
      continue;
    }

    if (word === "--") return command ? args[index + 1] : undefined;

    if (/^[-+][A-Za-z]+$/.test(word)) {
      if (word.startsWith("-") && word.includes("c")) command = true;
      continue;
    }

    // The first operand: the script with `-c`, a script file without (just-bash reads files).
    return command ? word : undefined;
  }

  return undefined;
};

/** The commands `find`'s `-exec`, `-execdir`, `-ok` and `-okdir` run, each up to its `;` or `+`. */
const findRuns = (args: Words): ReadonlyArray<Wrapped> => {
  const runs: Array<Wrapped> = [];

  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];

    if (word !== "-exec" && word !== "-execdir" && word !== "-ok" && word !== "-okdir") continue;
    const end = args.findIndex((next, at) => at > index && (next === ";" || next === "+"));
    const words = args.slice(index + 1, end === -1 ? args.length : end);

    runs.push({ kind: "command", words });
    index = end === -1 ? args.length : end;
  }

  return runs;
};

/** What a wrapper command named `name` runs with `args`: nothing when it is no wrapper, or runs no command. */
const wrappedBy = (name: string, args: Words): ReadonlyArray<Wrapped> => {
  const command = (words: Words | undefined): ReadonlyArray<Wrapped> =>
    words === undefined || words.length === 0 ? [] : [{ kind: "command", words }];

  switch (name) {
    case "env":
      return command(pastEnv(args));
    case "timeout":
      // Its first operand is the duration.
      return command(pastOptions(args, VALUED.get("timeout") ?? new Set(), 1));
    case "command":
      // `command -v` and `-V` only look a name up.
      return args.some((word) => word === "-v" || word === "-V")
        ? []
        : command(pastOptions(args, new Set()));
    case "bash":
    case "sh": {
      const source = scriptOf(args);

      return source === undefined ? [] : [{ kind: "script", source }];
    }

    case "find":
      return findRuns(args);
    default: {
      const valued = VALUED.get(name);

      return valued === undefined ? [] : command(pastOptions(args, valued));
    }
  }
};

/** What a parsed line names: the commands it runs (literal names only), the functions it defines, its syntax errors. */
interface Named {
  readonly commands: Set<string>;
  readonly functions: Set<string>;
  /** The scripts its `bash -c` and `sh -c` run, checked as lines of their own. */
  readonly scripts: Array<string>;
  deferred: string | undefined;
}

/** Adds the commands a simple command's words run: its own name, and what it runs if it is a wrapper. */
const addRuns = (words: Words, named: Named): void => {
  const [name, ...args] = words;

  if (name === undefined || name === "") return;
  named.commands.add(name);

  for (const wrapped of wrappedBy(name, args))
    if (wrapped.kind === "command") addRuns(wrapped.words, named);
    else named.scripts.push(wrapped.source);
};

/** Walks every node of just-bash's syntax tree, whatever its shape: a command can hide in any of them. */
const walk = (tree: SyntaxTree, named: Named): void => {
  if (Array.isArray(tree)) {
    for (const child of tree) walk(child, named);

    return;
  }

  if (!isNode(tree)) return;
  const type = tree["type"];
  const name = tree["name"];

  if (type === "SimpleCommand") {
    const args = tree["args"];

    addRuns([literalWord(name), ...(Array.isArray(args) ? args.map(literalWord) : [])], named);
  }

  if (type === "FunctionDef" && typeof name === "string") named.functions.add(name);
  const deferred = tree["deferredError"];

  if (type === "Statement" && isNode(deferred) && named.deferred === undefined) {
    const message = deferred["message"];

    named.deferred = typeof message === "string" ? message : "a syntax error";
  }

  for (const value of Object.values(tree)) walk(value, named);
};

/** A word quoted for the shell. */
const quoted = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * A just-bash of its own, loaded once per isolate, only ever asked to parse a line and what it has, with the session
 * shell's command set: a `fetch` (so `curl` is one of its commands, as the shell's is), one that fails, and the worker
 * shell's commands, which do nothing here. Its answers to `type -t` never change within a version.
 */
let loaded: Promise<import("just-bash").Bash> | undefined;

const known = new Map<string, Promise<boolean>>();

const shellOf = (): Promise<import("just-bash").Bash> =>
  (loaded ??= import("just-bash").then(
    ({ Bash, defineCommand }) =>
      new Bash({
        fetch: () => Promise.reject(new Error("no network")),
        customCommands: SHELL_COMMANDS.map((name) =>
          defineCommand(name, () => Promise.resolve({ stdout: "", stderr: "", exitCode: 1 })),
        ),
      }),
  ));

/** Whether just-bash has a command or builtin named `name`, by its own lookup. */
const shellHas = (name: string): Promise<boolean> => {
  const cached = known.get(name);

  if (cached !== undefined) return cached;

  const asked = (async () =>
    (await (await shellOf()).exec(`type -t ${quoted(name)}`)).exitCode === 0)();

  known.set(name, asked);

  return asked;
};

const refusalAt = async (command: string, depth: number): Promise<ShellRefusal | undefined> => {
  const shell = await shellOf();

  const named: Named = {
    commands: new Set(),
    functions: new Set(),
    scripts: [],
    deferred: undefined,
  };

  try {
    // Its parse as `exec` parses (its `transform` with no plugins): the browser build that workerd loads exports no
    // parser of its own.
    const parsed: { readonly ast: SyntaxTree } = shell.transform(command);

    walk(parsed.ast, named);
  } catch (error) {
    return { kind: "syntax", message: error instanceof Error ? error.message : String(error) };
  }

  if (named.deferred !== undefined) return { kind: "syntax", message: named.deferred };

  for (const name of named.commands) {
    if (named.functions.has(name)) continue;

    if (LACKING.has(name) || name.includes("/") || !(await shellHas(name)))
      return { kind: "command", name };
  }

  if (depth < MAX_DEPTH)
    for (const script of named.scripts) {
      const refusal = await refusalAt(script, depth + 1);

      if (refusal !== undefined) return refusal;
    }

  return undefined;
};

/**
 * Why just-bash cannot run `command` at all, or undefined when it can: unsupported syntax, or the first command it
 * lacks (the rule above).
 */
export const shellRefusal = (command: string): Promise<ShellRefusal | undefined> =>
  refusalAt(command, 0);

/** A refusal in words. */
const describeRefusal = (refusal: ShellRefusal): string =>
  refusal.kind === "syntax"
    ? `just-bash does not support its syntax (${refusal.message})`
    : `just-bash has no ${refusal.name} command`;

/**
 * What a session without the computer appends to a failed run of a line just-bash could not run: why, and why the
 * computer is off (the session did not ask for it, or the deployment has none). A run that succeeded (a line that
 * tests for a command and copes without it) gets no note.
 */
export const computerOffNote = (refusal: ShellRefusal, deploymentHasOne: boolean): string =>
  deploymentHasOne
    ? `just-bash could not run this command (${describeRefusal(refusal)}), and this session's computer is off. Open a session with computer: true, where the org allows it, to run such commands on the computer.`
    : `just-bash could not run this command (${describeRefusal(refusal)}), and the computer is off: this deployment has none to run it on.`;
