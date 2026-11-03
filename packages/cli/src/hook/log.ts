/**
 * `~/.align/logs/align.log`: counts and codes only, never content (AGENTS.md rule 9). One line per call:
 * `<iso time> <component> <code>[ <n>]`. Rotated at 1 MB, three files kept. Never throws.
 */
import { appendFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, PRIVATE_MODE } from "../fsx";

const MAX_BYTES = 1024 * 1024;
const KEEP = 3;
const CODE = /^[a-z0-9_.-]{1,64}$/;

export function logCount(logsDir: string, component: string, code: string, n = 1): void {
  try {
    if (!CODE.test(component) || !CODE.test(code) || !Number.isSafeInteger(n)) return;
    ensureDir(logsDir);
    const file = join(logsDir, "align.log");
    try {
      if (statSync(file).size > MAX_BYTES) {
        rmSync(`${file}.${KEEP - 1}`, { force: true });
        for (let i = KEEP - 2; i >= 1; i--) {
          try {
            renameSync(`${file}.${i}`, `${file}.${i + 1}`);
          } catch {
            // missing
          }
        }
        renameSync(file, `${file}.1`);
      }
    } catch {
      // no file yet
    }
    appendFileSync(file, `${new Date().toISOString()} ${component} ${code}${n === 1 ? "" : ` ${n}`}\n`, {
      mode: PRIVATE_MODE,
    });
  } catch {
    // logging never breaks a hook
  }
}
