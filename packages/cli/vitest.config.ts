import { defineProject } from "vitest/config";

// The latency test has its own project (vitest.latency.config.ts) that runs after every other test, alone, so the
// CPU-heavy suites never share the machine with its timings (docs/15 §Guarantees 2).
export default defineProject({
  test: { name: "cli", include: ["src/**/*.test.ts", "test/**/*.test.ts"], exclude: ["test/latency.test.ts"] },
});
