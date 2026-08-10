import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@commissary/store/sql-adapter": fileURLToPath(
        new URL("./src/sql-adapter.ts", import.meta.url),
      ),
      "@commissary/store": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
