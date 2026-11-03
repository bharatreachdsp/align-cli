import { defineProject } from "vitest/config";

// Runs after all other projects (`groupOrder`), on its own: the hook fast-path timings (docs/15 §Guarantees 2).
export default defineProject({
  test: { name: "cli-latency", include: ["test/latency.test.ts"], sequence: { groupOrder: 1 } },
});
