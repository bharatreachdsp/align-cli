/**
 * The paths hint of a pack request (docs/14 §Request): the working directory relative to the root, the files
 * `git status` reports and the files changed on the branch (`git diff --name-only origin/<default>...HEAD`), in that
 * order of priority, de-duplicated, deny-listed paths removed, at most 200. Both git calls run at once with the 300 ms
 * budget (sanitised environment, hook/home.ts); a call that fails or runs out of time contributes nothing, so on
 * timeout the hint is just the working directory.
 */
import { effectiveDenyGlobs, isDenied } from "@align/core/redact";
import { GIT_TIMEOUT_MS } from "../git";
import { hookGit } from "../hook/home";
import { isHintPath, PACK_MAX_PATHS } from "./check";

/** A branch name git would accept as a ref (and never an option). */
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;

/** `git status --porcelain -z` records: `XY path`, with a second record (the original path) after renames and copies. */
export function parseStatusZ(out: string): string[] {
  const recs = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i] ?? "";
    if (r.length < 4) continue;
    const xy = r.slice(0, 2);
    paths.push(r.slice(3));
    if (xy.includes("R") || xy.includes("C")) i++;
  }
  return paths;
}

export type HintInput = {
  root: string;
  /** The working directory relative to the root (`""` at the root, null outside). */
  cwdRel: string | null;
  defaultBranch: string;
  denyGlobs: readonly string[];
  timeoutMs?: number;
};

export async function pathsHint(input: HintInput): Promise<string[]> {
  const t = input.timeoutMs ?? GIT_TIMEOUT_MS;
  const base = BRANCH.test(input.defaultBranch) && !input.defaultBranch.startsWith("-") ? input.defaultBranch : null;
  const [status, diff] = await Promise.all([
    hookGit(["status", "--porcelain", "-z", "--untracked-files=normal"], input.root, t),
    base ? hookGit(["diff", "--name-only", "-z", `origin/${base}...HEAD`], input.root, t) : Promise.resolve(null),
  ]);
  const candidates = [
    ...(input.cwdRel ? [input.cwdRel] : []),
    ...(status ? parseStatusZ(status) : []),
    ...(diff ? diff.split("\0") : []),
  ];
  return cleanHint(candidates, input.denyGlobs);
}

/** De-duplicates, drops what the server would refuse and what the deny globs cover, and caps at 200. */
export function cleanHint(candidates: readonly string[], denyGlobs: readonly string[]): string[] {
  const globs = effectiveDenyGlobs(denyGlobs);
  const budget = { steps: 2_000_000 };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const p = raw.replace(/\/+$/, "");
    if (seen.has(p) || !isHintPath(p)) continue;
    seen.add(p);
    if (isDenied(p, globs, budget)) continue;
    out.push(p);
    if (out.length >= PACK_MAX_PATHS) break;
  }
  return out;
}
