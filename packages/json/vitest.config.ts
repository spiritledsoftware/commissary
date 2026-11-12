// Plain Node.js tests (test/**/*.test.ts) with the workspace's shared package settings (tools/vitest).
import { defineConfig } from "vite-plus";
import { nodePackageTests } from "../../tools/vitest/node-package.ts";

export default defineConfig(nodePackageTests("json"));
