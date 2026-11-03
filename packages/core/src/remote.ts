/**
 * Git remote normalisation (docs/11 `repos.remote_norm`, docs/15 `init` step 1). Shared by the CLI (which
 * sends `remote_norm`) and the server (which matches it), so both sides agree on one spelling.
 *
 * `git@github.com:Acme/Checkout.git`, `ssh://git@github.com:22/acme/checkout`,
 * `https://user:token@GitHub.com/acme/checkout.git/` → `github.com/acme/checkout`.
 * Credentials, ports, the `.git` suffix and trailing slashes are dropped, and the result is lower case
 * (the column is `citext`). Local paths and `file://` remotes have no network identity and give `null`.
 */

export type RemoteProvider = "github" | "gitlab" | "bitbucket" | "other";

const PROVIDERS: Readonly<Record<string, RemoteProvider>> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "bitbucket.org": "bitbucket",
};

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/** One path segment: no space, slash, query, fragment or percent-escape (`%2e%2e` must not hide a `..`). */
const SEGMENT = /^[^\s/\\?#%]+$/;

function finish(host: string, path: string): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!HOST.test(h)) return null;
  const segments = path
    .replace(/[?#].*$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const last = segments.length - 1;
  segments[last] = (segments[last] ?? "").replace(/\.git$/i, "");
  if (segments.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return null;
  return `${h}/${segments.join("/")}`.toLowerCase();
}

/** Normalises a git remote URL; `null` when it is not a network remote we can identify. */
export function normalizeRemote(url: string): string | null {
  const raw = url.trim();
  if (raw.length === 0 || raw.length > 2048) return null;

  // scp-like syntax: [user@]host:path (no scheme, and the part before ':' has no slash).
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
  if (scp?.[1] && scp[2] && !/^[a-z]$/i.test(scp[1]) && !raw.includes("://")) {
    return finish(scp[1], scp[2]);
  }

  const m = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (!m?.[1] || m[2] === undefined) return null;
  const scheme = m[1].toLowerCase();
  if (!["ssh", "git", "http", "https", "git+ssh", "ssh+git"].includes(scheme)) return null;
  const rest = m[2];
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash);
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) return null; // IPv6 literals: not a hosted remote
  const host = hostPort.replace(/:\d*$/, "");
  return finish(host, path);
}

/** The provider for a normalised remote (`github.com/acme/x` → `github`). */
export function remoteProvider(remoteNorm: string): RemoteProvider {
  const host = remoteNorm.split("/", 1)[0] ?? "";
  return PROVIDERS[host] ?? "other";
}
