/**
 * The workspace's import boundaries, as Oxlint rules (`pnpm lint`). `models-imports`, `billing-imports`,
 * `tools-imports` and `agents-imports` keep an area package (`@commissary/models`, `@commissary/billing`,
 * `@commissary/tools`, `@commissary/agents`: `packages/<area>/`) one the Workers reach through its entry points only
 * (#134 "The area package convention", #151):
 *
 * - its sources (`packages/<area>/src/`) import only their own files, the dependencies its manifest declares and the
 *   runtime modules {@link RUNTIME_MODULES} lists (nothing from `apps/`, no other package's files by a relative path);
 * - the apps (`apps/*`) import the area only as `@commissary/<area>/api`, `/management` and `/state` (and, in tests,
 *   `/testing`): not its other exports (Models' `/auth-index-key` and `/models-dev` are for the deploy and the catalog
 *   sync script) and never a file of the package by a relative path;
 * - another package's sources import it only through the entries `packageEntries` lists: none for Models, Tools and
 *   Agents, `/api` for Billing, which Models calls to count requests.
 *
 * Every module specifier counts: imports and re-exports (types too), `import()` calls and `import("…")` types. An
 * `import()` of a computed specifier cannot be checked and is refused in both places.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule, eslintCompatPlugin } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const APPS = path.join(ROOT, "apps");

const PACKAGES = path.join(ROOT, "packages");

/** Runtime modules an area's sources may import besides the dependencies of its manifest. */
const RUNTIME_MODULES: ReadonlySet<string> = new Set([
  "cloudflare:workers",
  "node:buffer",
  "node:crypto",
  "node:zlib",
]);

/** An area package whose boundary a rule keeps. */
interface Area {
  /** The rule's name, and the word the messages call the area by. */
  readonly rule: string;
  readonly title: string;
  /** `packages/<dir>`. */
  readonly dir: string;
  readonly packageName: string;
  /** The exports of the package an app may import (`./testing` in its tests only: `no-restricted-imports`). */
  readonly appEntries: ReadonlyArray<string>;
  /** The exports another package's sources may import: none for an area no package depends on. */
  readonly packageEntries: ReadonlyArray<string>;
}

const MODELS: Area = {
  rule: "models-imports",
  title: "Models",
  dir: "models",
  packageName: "@commissary/models",
  appEntries: ["api", "management", "state", "testing"],
  packageEntries: [],
};

/** Billing (`@commissary/billing`) is the one area whose `/api` another area's sources import (Models counts requests). */
const BILLING: Area = {
  rule: "billing-imports",
  title: "Billing",
  dir: "billing",
  packageName: "@commissary/billing",
  appEntries: ["api", "management", "state", "testing"],
  packageEntries: ["api"],
};

const TOOLS: Area = {
  rule: "tools-imports",
  title: "Tools",
  dir: "tools",
  packageName: "@commissary/tools",
  appEntries: ["api", "management", "state", "testing"],
  packageEntries: [],
};

/**
 * The Agents area (`@commissary/agents`, #226): it reaches Models and Tools through the app Worker's adapter
 * (`AgentReferences`), never by import.
 */
const AGENTS: Area = {
  rule: "agents-imports",
  title: "Agents",
  dir: "agents",
  packageName: "@commissary/agents",
  appEntries: ["api", "management", "state", "testing"],
  packageEntries: [],
};

const isInside = (dir: string, file: string): boolean => {
  const relative = path.relative(dir, file);

  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

/** The file a relative specifier names (without a query such as `?raw`); `undefined` for a bare one. */
const resolved = (filename: string, specifier: string): string | undefined =>
  specifier.startsWith(".")
    ? path.resolve(path.dirname(filename), specifier.split("?")[0] ?? specifier)
    : undefined;

const entriesOf = (area: Area, names: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(names.map((name) => `${area.packageName}/${name}`));

const areaImportsRule = (area: Area) => {
  const root = path.join(PACKAGES, area.dir);
  const source = path.join(root, "src");
  const appEntries = entriesOf(area, area.appEntries);
  const packageEntries = entriesOf(area, area.packageEntries);

  /** The dependencies the area's `package.json` declares. */
  const dependencies: ReadonlySet<string> = new Set(
    Object.keys(
      // SAFETY: a workspace package's manifest is a JSON object whose `dependencies`, when present, maps names to ranges.
      (
        JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
          readonly dependencies?: Readonly<Record<string, string>>;
        }
      ).dependencies ?? {},
    ),
  );

  return defineRule({
    meta: {
      type: "problem",
      docs: {
        description: `Keep ${area.packageName} self-contained and reached by the apps only through its entry points (#151).`,
      },
      messages: {
        outsideArea: `${area.title} imports "{{specifier}}", which is neither its own file nor a dependency its package.json declares (tools/oxlint/boundaries).`,
        computedImport: `An import() of a computed specifier cannot be checked against the ${area.title} boundary: import a string literal.`,
        notAnEntry: `"{{specifier}}" is not an entry point of ${area.title} for the apps: import ${area.appEntries
          .filter((name) => name !== "testing")
          .map((name) => `${area.packageName}/${name}`)
          .join(", ")} (tests also /testing).`,
        notAPackageEntry:
          area.packageEntries.length === 0
            ? `"{{specifier}}": no other package imports ${area.title} (${area.packageName} is reached by the apps only; a package's tests may use its entry points).`
            : `"{{specifier}}" is not an entry point of ${area.title} for other packages: import ${area.packageEntries
                .map((name) => `${area.packageName}/${name}`)
                .join(", ")}.`,
        intoArea: `"{{specifier}}" reaches into packages/${area.dir} by a path: import its entry points (${area.packageName}/api, /management, /state).`,
      },
    },
    create(context) {
      const filename = context.filename;
      const inArea = isInside(source, filename);
      const inApps = isInside(APPS, filename);

      // The area's own tests reach its files by relative paths, as its sources do.
      if ((isInside(root, filename) && !inArea) || (!inApps && !isInside(PACKAGES, filename)))
        return {};

      const check = (node: ESTree.Node, specifier: string) => {
        const target = resolved(filename, specifier);

        if (inArea) {
          const allowed =
            target === undefined
              ? dependencies.has(packageOf(specifier)) || RUNTIME_MODULES.has(specifier)
              : isInside(source, target);

          if (!allowed) context.report({ node, messageId: "outsideArea", data: { specifier } });
        } else if (target !== undefined) {
          if (isInside(root, target))
            context.report({ node, messageId: "intoArea", data: { specifier } });
        } else if (packageOf(specifier) === area.packageName) {
          if (inApps) {
            if (!appEntries.has(specifier))
              context.report({ node, messageId: "notAnEntry", data: { specifier } });
          } else if (!packageEntries.has(specifier) && !isTestFile(filename))
            context.report({ node, messageId: "notAPackageEntry", data: { specifier } });
        }
      };

      return {
        ImportDeclaration: (node) => check(node.source, node.source.value),
        ExportNamedDeclaration: (node) => {
          if (node.source !== null) check(node.source, node.source.value);
        },
        ExportAllDeclaration: (node) => check(node.source, node.source.value),
        TSImportType: (node) => check(node.source, node.source.value),
        TSExternalModuleReference: (node) => check(node.expression, node.expression.value),
        ImportExpression: (node) => {
          const specifier = node.source;

          if (specifier.type === "Literal" && typeof specifier.value === "string")
            check(specifier, specifier.value);
          else if (specifier.type === "TemplateLiteral" && specifier.expressions.length === 0)
            check(specifier, specifier.quasis[0]?.value.cooked ?? "");
          else context.report({ node: specifier, messageId: "computedImport" });
        },
      };
    },
  });
};

/** A package's test file (`packages/<package>/test/`): it may reach what another package's `./testing` and entries export. */
const isTestFile = (filename: string): boolean => {
  const [, directory] = path.relative(PACKAGES, filename).split(path.sep);

  return isInside(PACKAGES, filename) && directory === "test";
};

/**
 * The helpers that wrap Workers KV (`packages/core/src/kv.ts`, `packages/models/src/kv.ts`): the only source files that
 * may read a `CACHE` binding or take a `KVNamespace`.
 */
const isKvHelper = (relative: string): boolean =>
  relative === "packages/core/src/kv.ts" || relative === "packages/models/src/kv.ts";

/** The declarations of the bindings (`env.ts`, `env.d.ts`): they may name the `KVNamespace` type, nothing more. */
const isEnvDeclaration = (relative: string): boolean => /(^|\/)env(\.d)?\.ts$/.test(relative);

/** Whether `file` is a source file of a package or an app (`test/` folders and the infrastructure are not). */
const isWorkspaceSource = (file: string): boolean => {
  const relative = path.relative(ROOT, file).split(path.sep);

  return (relative[0] === "packages" || relative[0] === "apps") && relative[2] === "src";
};

const orgScopedKvRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep org data out of raw KV and Cache API calls: access goes through OrgKv / DeploymentKv (ADR 0044, #250).",
    },
    messages: {
      rawBinding:
        "Do not read the `CACHE` KV binding here: org data goes through `orgKvOf(env, org)` and deployment-wide data through `deploymentKvOf(env)` (packages/models/src/kv.ts, `OrgKv` in @commissary/core). ADR 0044.",
      rawType:
        "Do not take a raw `KVNamespace` here: take an `OrgKv` (org data) or a `DeploymentKv` (deployment-wide names) from @commissary/core. ADR 0044.",
      cacheApi:
        "Do not use the Worker Cache API directly: add an org-scoped helper for it to @commissary/core first (a per-isolate cache of org data is an `OrgCache`, `makeOrgCache`). ADR 0044.",
    },
  },
  create(context) {
    const filename = context.filename;
    const relative = path.relative(ROOT, filename).split(path.sep).join("/");

    if (!isWorkspaceSource(filename) || isKvHelper(relative)) return {};

    const mayNameKvType = isEnvDeclaration(relative);

    const isCacheName = (node: ESTree.Node): boolean =>
      (node.type === "Identifier" && node.name === "CACHE") ||
      (node.type === "Literal" && node.value === "CACHE");

    const isGlobalScope = (node: ESTree.Node): boolean =>
      node.type === "Identifier" && (node.name === "globalThis" || node.name === "self");

    return {
      MemberExpression: (node) => {
        if (isCacheName(node.property) && (!node.computed || node.property.type === "Literal"))
          context.report({ node, messageId: "rawBinding" });
        else if (
          // `caches.open(…)`, `caches.default` and `globalThis.caches`.
          (node.object.type === "Identifier" &&
            node.object.name === "caches" &&
            !node.computed &&
            node.property.type === "Identifier" &&
            (node.property.name === "open" || node.property.name === "default")) ||
          (isGlobalScope(node.object) &&
            !node.computed &&
            node.property.type === "Identifier" &&
            node.property.name === "caches")
        )
          context.report({ node, messageId: "cacheApi" });
      },
      Property: (node) => {
        // A destructuring pattern: `const { CACHE } = env`.
        if (!node.computed && node.parent.type === "ObjectPattern" && isCacheName(node.key))
          context.report({ node, messageId: "rawBinding" });
      },
      // `typeof env.CACHE`.
      TSQualifiedName: (node) => {
        if (isCacheName(node.right)) context.report({ node, messageId: "rawBinding" });
      },
      // `Env["CACHE"]`.
      TSIndexedAccessType: (node) => {
        const index = node.indexType;

        if (index.type === "TSLiteralType" && isCacheName(index.literal))
          context.report({ node, messageId: "rawBinding" });
      },
      TSTypeReference: (node) => {
        if (
          !mayNameKvType &&
          node.typeName.type === "Identifier" &&
          node.typeName.name === "KVNamespace"
        )
          context.report({ node, messageId: "rawType" });
      },
    };
  },
});

/** Import boundaries between the workspace's areas, apps and packages, and the org-scoped KV rule. */
export default eslintCompatPlugin({
  meta: { name: "boundaries" },
  rules: {
    "models-imports": areaImportsRule(MODELS),
    "billing-imports": areaImportsRule(BILLING),
    "org-scoped-kv": orgScopedKvRule,
    "tools-imports": areaImportsRule(TOOLS),
    "agents-imports": areaImportsRule(AGENTS),
  },
});
