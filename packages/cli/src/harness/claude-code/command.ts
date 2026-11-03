/**
 * Claude Code's `/align` command (docs/14 §Delivery, docs/15 §Files): the user-level file
 * `~/.claude/commands/align.md`, whose body runs `align pack --format md` through the shim and whose `allowed-tools`
 * lets exactly that command run without a prompt. `init` writes it for Claude Code; a file there that is not ALIGN's
 * (different front matter) is left alone. `uninstall` removes it only when it is still ALIGN's and no other registered
 * repository captures Claude Code (`--purge`: whenever it is ALIGN's).
 */
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLI_BIN } from "@align/core/brand";
import { copy } from "../../copy";
import { writeUserFileAtomic } from "../../fsx";
import { shellWord } from "../hooks-file";

export const COMMAND_DESCRIPTION = copy.pack.commandDescription;

export const commandFile = (home: string) => join(home, ".claude", "commands", `${CLI_BIN}.md`);

const HEADER = `---\ndescription: ${COMMAND_DESCRIPTION}\n`;

export function commandText(shim: string): string {
  const run = `${shellWord(shim)} pack --format md`;
  return `${HEADER}allowed-tools: Bash(${run})\n---\n\n!\`${run}\`\n`;
}

/** ALIGN's own file: a regular file starting with ALIGN's description (any shim path). */
export function commandIsOurs(home: string): boolean {
  const p = commandFile(home);
  try {
    if (!lstatSync(p).isFile()) return false;
    return readFileSync(p, "utf8").startsWith(HEADER);
  } catch {
    return false;
  }
}

export function commandInstalled(home: string, shim: string): boolean {
  try {
    return readFileSync(commandFile(home), "utf8") === commandText(shim);
  } catch {
    return false;
  }
}

/** Writes the command; "foreign" when a file that is not ALIGN's is in the way. */
export function installCommand(home: string, shim: string): "written" | "unchanged" | "foreign" {
  const p = commandFile(home);
  if (commandInstalled(home, shim)) return "unchanged";
  let present = true;
  try {
    lstatSync(p);
  } catch {
    present = false;
  }
  if (present && !commandIsOurs(home)) return "foreign";
  writeUserFileAtomic(p, commandText(shim), 0o600);
  return "written";
}

export function uninstallCommand(home: string): void {
  if (commandIsOurs(home)) rmSync(commandFile(home), { force: true });
}
