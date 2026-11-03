import { defineProject } from "vitest/config";

// The latency test has its own project (vitest.latency.config.ts) that runs after every other test, alone, so the
// CPU-heavy suites never share the machine with its timings (docs/15 §Guarantees 2).
export default defineProject({
  test: {
    name: "cli",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["test/latency.test.ts"],
    // The git the shim would export (test/setup-git.ts).
    setupFiles: ["test/setup-git.ts"],
    // GitHub's macOS runners (3 vCPUs) run `align init` end to end in 5–10 s under load, and a busy runner can push
    // a hook's git past its 300 ms budget: there, longer timeouts and fewer test files at once. Linux keeps the
    // defaults, so a test that slows down there still shows.
    ...(process.platform === "darwin" ? { testTimeout: 30_000, maxWorkers: 2 } : {}),
  },
});
