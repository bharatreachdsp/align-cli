/**
 * The hook de-duplication store (docs/10 §Cross-import guard): key `(harness, harness_session_id, hook_event,
 * sha256(payload), 2-second bucket)`, kept 10 minutes. Each key is an empty file created with O_EXCL, so two
 * concurrent fires of the same hook agree on which one runs. Old keys are pruned opportunistically.
 */
import { createHash } from "node:crypto";
import { closeSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, PRIVATE_MODE } from "../fsx";

export const DEDUPE_BUCKET_MS = 2000;
export const DEDUPE_KEEP_MS = 10 * 60 * 1000;

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export function dedupeKey(
  parts: { harness: string; sessionId: string; hookEvent: string; payload: Buffer | string },
  now: number,
): string {
  const bucket = Math.floor(now / DEDUPE_BUCKET_MS);
  return sha256([parts.harness, parts.sessionId, parts.hookEvent, sha256(parts.payload), String(bucket)].join("\0"));
}

/**
 * True the first time a key is seen (the caller proceeds); false for a duplicate. The key carries its 2-second
 * bucket, so an existing key file is always a duplicate; old files are pruned against the file system's clock.
 */
export function firstSighting(dir: string, key: string, random = Math.random): boolean {
  ensureDir(dir);
  if (random() < 0.05) prune(dir, Date.now());
  try {
    closeSync(openSync(join(dir, key), "wx", PRIVATE_MODE));
    return true;
  } catch (e) {
    // Anything but "already there" (a full disk, permissions) must not swallow a hook: proceed.
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

export function prune(dir: string, now: number): number {
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > DEDUPE_KEEP_MS) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {
        // gone
      }
    }
  } catch {
    // no directory
  }
  return removed;
}
