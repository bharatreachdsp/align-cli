/** `~/.align/config.json`: server URL, the cached update check, per-organisation cache (docs/15 §Files). */
import { isNumber, isRecord, isString, isStringArray, recordOf, versionOk } from "./check";
import { CorruptFileError, moveAside, readJsonFile, withLock, writeJsonAtomic } from "./fsx";
import type { Paths } from "./paths";

export type Config = {
  version: 1;
  server?: string;
  update?: {
    checked_at: number;
    latest: string;
    min_supported: string;
    /** UTC date (YYYY-MM-DD) the update line was last shown, so it shows once per day (docs/19). */
    notice_shown_on?: string;
  };
  /** Per organisation: the email domains redaction keeps (docs/17), cached at sign-in and opt-in. */
  orgs: Record<string, { slug: string; name: string; email_domains: string[]; updated_at: number }>;
};

const emptyConfig = (): Config => ({ version: 1, orgs: {} });

const parseConfig = (v: unknown): Config | null => {
  if (!isRecord(v) || !versionOk(v)) return null;
  const c: Config = emptyConfig();
  if (v.server !== undefined) {
    if (!isString(v.server)) return null;
    c.server = v.server;
  }
  if (v.update !== undefined) {
    const u = v.update;
    if (!isRecord(u) || !isNumber(u.checked_at) || !isString(u.latest) || !isString(u.min_supported)) return null;
    if (u.notice_shown_on !== undefined && !isString(u.notice_shown_on)) return null;
    c.update = { checked_at: u.checked_at, latest: u.latest, min_supported: u.min_supported };
    if (u.notice_shown_on !== undefined) c.update.notice_shown_on = u.notice_shown_on;
  }
  const orgs = recordOf(v.orgs, (o) =>
    isRecord(o) && isString(o.slug) && isString(o.name) && isStringArray(o.email_domains) && isNumber(o.updated_at)
      ? { slug: o.slug, name: o.name, email_domains: o.email_domains, updated_at: o.updated_at }
      : null,
  );
  if (!orgs) return null;
  c.orgs = orgs;
  return c;
};

/** The config; a corrupt file reads as empty (it holds only preferences and caches). */
export function readConfig(paths: Paths): Config {
  try {
    return readJsonFile(paths.config, parseConfig, emptyConfig);
  } catch {
    return emptyConfig();
  }
}

/** Read-modify-write under the config lock; a corrupt file is moved aside first. */
export function updateConfig(paths: Paths, change: (c: Config) => void): Config {
  return withLock(paths.configLock, () => {
    let c: Config;
    try {
      c = readJsonFile(paths.config, parseConfig, emptyConfig);
    } catch (e) {
      if (!(e instanceof CorruptFileError)) throw e;
      moveAside(paths.config);
      c = emptyConfig();
    }
    change(c);
    writeJsonAtomic(paths.config, c);
    return c;
  });
}
