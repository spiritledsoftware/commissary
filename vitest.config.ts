import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          include: ["**/*.test.ts"],
          exclude: ["./apps/**", "./packages/**", "./tools/**"],
        },
      },
      "./apps/*",
      "./packages/*",
      "./tools/*",
    ],
  },
});
