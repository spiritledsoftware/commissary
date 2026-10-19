// Vite config of the control panel. `pnpm build` (`vite build`) writes `dist/index.html` and `dist/assets/*` (the bundle
// and the font's licence, `assets/licenses/`), which the Worker serves at `/` and `/assets`
// (apps/app/src/management/web-panel.ts). `pnpm --filter @commissary/web dev` serves the panel with hot reload and
// forwards `/v9` to a running `pnpm dev` Worker, and Commissary Cloud's sign-in calls (`/api`) to its auth Worker
// (ADR 0030).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build, defineConfig, type Plugin } from "vite";

/** `pnpm dev` Worker the dev server forwards API calls to. */
const workerUrl = process.env["COMMISSARY_DEV_URL"] ?? "http://localhost:1337";

/** `pnpm dev` auth Worker (Commissary Cloud only) the dev server forwards sign-in calls to. */
const authWorkerUrl = process.env["COMMISSARY_AUTH_DEV_URL"] ?? "http://localhost:1340";

const themeBootEntry = fileURLToPath(new URL("src/theme-boot.ts", import.meta.url));

/** Name of the emitted theme script (`assets/theme-<hash>.js`) and its path on the dev server. */
const THEME_BOOT_ASSET = "theme.js";

const THEME_BOOT_DEV_PATH = "/theme-boot.js";

/** `src/theme-boot.ts` and what it imports as one classic script: an IIFE with no `import` left in it. */
const compileThemeBoot = async () => {
  const result = await build({
    configFile: false,
    logLevel: "warn",
    publicDir: false,
    build: {
      write: false,
      minify: true,
      target: "es2023",
      rolldownOptions: { input: themeBootEntry, output: { format: "iife" } },
    },
  });

  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) continue;

    const chunk = output.output.find((file) => file.type === "chunk");

    if (chunk !== undefined) return chunk.code;
  }

  throw new Error("src/theme-boot.ts built no script");
};

/**
 * The stored theme choice must apply before the first paint, and the CSP (`apps/app/src/management/web-panel.ts`)
 * allows only same-origin scripts: build `src/theme-boot.ts` separately, emit it under `/assets` (served by the Worker
 * like the rest of the bundle) and load it with a plain, render-blocking `<script src>` at the end of `<head>`, after
 * the metas it updates. A module script would run deferred, after a paint could show the other theme.
 */
const themeBoot = (): Plugin => {
  let building = false;

  return {
    name: "commissary:theme-boot",
    configResolved(config) {
      building = config.command === "build";
    },
    async buildStart() {
      if (building)
        this.emitFile({ type: "asset", name: THEME_BOOT_ASSET, source: await compileThemeBoot() });
    },
    configureServer(server) {
      server.middlewares.use(THEME_BOOT_DEV_PATH, (_request, response, next) => {
        compileThemeBoot().then((code) => {
          response.setHeader("content-type", "text/javascript");
          response.end(code);
        }, next);
      });
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        if (context.bundle === undefined)
          return [{ tag: "script", attrs: { src: THEME_BOOT_DEV_PATH }, injectTo: "head" }];

        const asset = Object.values(context.bundle).find(
          (file) => file.type === "asset" && file.names.includes(THEME_BOOT_ASSET),
        );

        if (asset === undefined) throw new Error("the theme script was not emitted");

        return [{ tag: "script", attrs: { src: `/${asset.fileName}` }, injectTo: "head" }];
      },
    },
  };
};

/** The font package's `LICENSE` (SIL OFL-1.1), read from the installed package; the OFL requires it to ship with the font. */
const fontLicensePath = join(
  dirname(
    createRequire(import.meta.url).resolve(
      "@fontsource-variable/atkinson-hyperlegible-next/package.json",
    ),
  ),
  "LICENSE",
);

/** Where the built panel carries the font's licence (`NOTICE` names it); under `/assets`, which the Worker serves. */
const FONT_LICENSE_FILE = "assets/licenses/atkinson-hyperlegible-next.txt";

/** Emits the Atkinson Hyperlegible Next licence next to the bundle that includes the font files. */
const fontLicense = (): Plugin => ({
  name: "commissary:font-license",
  apply: "build",
  buildStart() {
    this.addWatchFile(fontLicensePath);
    this.emitFile({
      type: "asset",
      fileName: FONT_LICENSE_FILE,
      source: readFileSync(fontLicensePath, "utf8"),
    });
  },
});

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: false,
  plugins: [react(), themeBoot(), fontLicense()],
  build: {
    assetsDir: "assets",
    target: "es2023",
    sourcemap: true,
    // Effect, React and the router make one ~219 kB (gzip) main bundle; the panel is a single admin page, so it is not
    // split further.
    chunkSizeWarningLimit: 800,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The Worker refuses management calls whose Origin is another host (packages/auth/src/csrf.ts); present the
      // Worker's own origin, as the deployed panel does.
      "/v9": {
        target: workerUrl,
        changeOrigin: true,
        headers: { origin: workerUrl },
      },
      // The dev server's page names no auth host (`src/lib/auth-origin.ts`), so its sign-in calls stay on this origin;
      // the auth Worker trusts the app Worker's origin only (`APP_ORIGIN`), which they present.
      "/api": {
        target: authWorkerUrl,
        changeOrigin: true,
        headers: { origin: workerUrl },
      },
    },
  },
});
