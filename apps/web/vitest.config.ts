// Tests of the panel's DOM-free modules (src/lib) in plain Node.js. Times are formatted in UTC, the zone the Worker's
// tests run in (workerd), so expected clock times do not depend on the machine.
import { defineConfig } from "vitest/config";
import { testWorkerOptions } from "../../tools/vitest/test-workers.ts";

export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The local test budget (tools/vitest/test-workers.ts): Vitest's default workers in CI.
    ...testWorkerOptions(),
    env: { TZ: "UTC" },
  },
});
