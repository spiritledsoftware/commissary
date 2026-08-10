import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@commissary/store/sql/postgres/adapter": fileURLToPath(
        new URL("./src/sql/postgres/adapter.ts", import.meta.url),
      ),
      "@commissary/store/sql/postgres": fileURLToPath(
        new URL("./src/sql/postgres/index.ts", import.meta.url),
      ),
      "@commissary/store/sql/conformance": fileURLToPath(
        new URL("./src/sql/conformance.ts", import.meta.url),
      ),
      "@commissary/store/sql/adapter": fileURLToPath(
        new URL("./src/sql/adapter.ts", import.meta.url),
      ),
      "@commissary/store/sql": fileURLToPath(new URL("./src/sql/index.ts", import.meta.url)),
      "@commissary/store/conformance": fileURLToPath(
        new URL("./src/conformance.ts", import.meta.url),
      ),
      "@commissary/store/transaction-adapter": fileURLToPath(
        new URL("./src/transaction-adapter.ts", import.meta.url),
      ),
      "@commissary/store": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
