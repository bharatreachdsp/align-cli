/**
 * Machine-speed calibration for the hook fast-path budget (docs/15 §Guarantees 2: p95 < 200 ms; D1239).
 *
 * The budget is defined on the build VM, where the G1 gate (`align doctor --bench`) runs it raw. The
 * `ci` build runs on a Cloud Build VM whose single-thread speed differs from build to build (hook p50 120–195 ms for
 * the same code), so a raw 200 ms there fails at random while the code has not changed. There the measurement is
 * divided by a speed factor: how much slower this machine starts node and loads a fixed reference module than the
 * build VM does. The reference is synthetic and generated here, so a heavier bundle or a slower hook is never
 * absorbed by it; it runs interleaved with the hook, so the factor sees the same load the hook does.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The budget, in build-VM milliseconds. */
export const BUDGET_MS = 200;

/**
 * The reference module's median wall time on the build VM (16 vCPUs, Node 24.22, warm compile cache, the other lanes
 * at work): 80.0–81.2 ms on 24 Oct and 82.1–87.1 ms idle on 26 Oct 2026, over every check of `vitest run --config
 * vitest.latency.config.ts` in packages/cli (the "reference p50" it prints). 82 is the stricter end of that range
 * (D1242). Re-measure when the generator below or the CI Node major changes. A lower value would loosen the CI check.
 */
export const REFERENCE_MS = 82;

/**
 * The factor never goes below 1 (a faster machine is held to the raw budget) and never above 1.5: whatever the
 * machine, a raw p95 of 300 ms fails, the same hard ceiling `bestOfThree` already applies to every window.
 */
export const MAX_FACTOR = 1.5;

/**
 * Calibrated in every test run (D3108): the `ci` build (which also sets ALIGN_LATENCY_CALIBRATE=1, D1242) and the lanes'
 * `/checks` and `pnpm verify`, where the build VM itself is often busy with the other lanes (reference p50 132 ms instead
 * of 82 at a load average of 15 on 16 vCPUs, and the raw check failed there for the same code). The budget stays 200 ms
 * in build-VM milliseconds, never looser: an idle build VM has a factor of 1 (the raw 200), and no machine's factor
 * excuses more than a raw 300 ms. ALIGN_LATENCY_CALIBRATE=0 forces the raw check. The G1 gate's measure,
 * `align doctor --bench`, does not use this file and stays raw.
 */
export const CALIBRATED = process.env.ALIGN_LATENCY_CALIBRATE !== "0";

/**
 * A deterministic ~2.4 MB ES module shaped like the bundle's start-up: many top-level function declarations parsed
 * (and cached by Node's compile cache), a small fraction of them run.
 */
export function writeReference(dir: string): { module: string; cache: string } {
  mkdirSync(dir, { recursive: true });
  const n = 20_000;
  const parts: string[] = [];
  for (let i = 0; i < n; i++)
    parts.push(
      `export function f${i}(a, b) { const o = { k${i}: a + ${i}, s: "v${i}-" + b }; return o.k${i} * 2 + o.s.length; }`,
    );
  parts.push(`const fs = [${Array.from({ length: n }, (_, i) => `f${i}`).join(",")}];`);
  parts.push("let acc = 0;\nfor (let i = 0; i < 1500; i++) acc += fs[i](i, 1);\nif (acc === 42) console.log(acc);");
  const module = join(dir, "reference.mjs");
  writeFileSync(module, `${parts.join("\n")}\n`);
  const cache = join(dir, "v8");
  mkdirSync(cache, { recursive: true });
  return { module, cache };
}

/** One run of the reference, in ms (a throw if it fails: a broken reference must never excuse anything). */
export function runReference(ref: { module: string; cache: string }): number {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [ref.module], {
    env: { PATH: process.env.PATH, NODE_COMPILE_CACHE: ref.cache },
    encoding: "utf8",
  });
  const ms = performance.now() - t0;
  if (r.status !== 0) throw new Error(`reference module failed (status ${r.status})`);
  return ms;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? Number.NaN;
};

/** This machine's speed factor from reference runs taken alongside the measurement, clamped to [1, MAX_FACTOR]. */
export function speedFactor(refTimes: number[]): number {
  if (refTimes.length === 0) throw new Error("no reference runs");
  return Math.min(MAX_FACTOR, Math.max(1, median(refTimes) / REFERENCE_MS));
}

/**
 * The number the budget is checked against: the raw p95 off CI; on CI, the p95 in build-VM milliseconds. The raw
 * value, the factor and the verdict are printed either way, so a CI log shows exactly what was compared; a warning
 * says when the factor is at its clamp.
 */
export function budgetScore(label: string, rawP95: number, refTimes: number[]): number {
  const factor = speedFactor(refTimes);
  const measured = median(refTimes) / REFERENCE_MS;
  // At the clamp the check is raw p95 < 200 × MAX_FACTOR = 300 ms on this machine: said in the log, every time.
  if (CALIBRATED && measured > MAX_FACTOR)
    console.warn(
      `${label}: this machine is ${measured.toFixed(2)}× the build VM; the factor is clamped to ${MAX_FACTOR}, so the check here is raw p95 < ${(BUDGET_MS * MAX_FACTOR).toFixed(0)} ms (${((BUDGET_MS * MAX_FACTOR) / measured).toFixed(0)} ms in build-VM terms)`,
    );
  const score = CALIBRATED ? rawP95 / factor : rawP95;
  console.log(
    `${label}: raw p95 ${rawP95.toFixed(1)} ms; reference p50 ${median(refTimes).toFixed(1)} ms (build VM ${REFERENCE_MS}) → factor ${factor.toFixed(2)}; checked ${score.toFixed(1)} ms against ${BUDGET_MS} (${CALIBRATED ? "calibrated" : "raw"})`,
  );
  return score;
}
