import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "apps/**", "packages/**", "tools/**", ".repos/**"],
        },
      },
      "./apps/*",
      "./packages/*",
      "./tools/*",
    ],
  },
});
