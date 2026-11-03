/**
 * The one brand file (AGENTS.md rule 10, D52). Every user-visible brand string comes from here; CI fails on
 * strays (`scripts/check-brand.ts`). A rename (L46) changes this file and keeps the aliases working.
 */

/** The product's display name. */
export const PRODUCT_NAME = "ALIGN";

/**
 * The display name on every email the product sends (D428): the product's name, marked "Staging" in staging so a
 * test message is never mistaken for a real one. Infrastructure configures only the address (`ALIGN_EMAIL_FROM`).
 */
export function emailSenderName(env: "local" | "ci" | "staging" | "production"): string {
  return env === "staging" ? `${PRODUCT_NAME} Staging` : PRODUCT_NAME;
}

/** The public CLI package (npm) and its binary. */
export const CLI_PACKAGE = "@align-agent/cli";
export const CLI_BIN = "align";

/**
 * The Claude Code plugin's marketplace (L41, D498): its name in `plugins/claude-code/marketplace.json` and the public
 * repository that holds it (`PLUGIN_REPO` in infra/projects.env). The plugin itself is named `CLI_BIN`.
 */
export const PLUGIN_MARKETPLACE = "align-marketplace";
export const PLUGIN_MARKETPLACE_REPO = "bharatreachdsp/align-marketplace";

/** The per-user home directory under `$HOME` (credentials, queue, config). */
export const HOME_DIR_NAME = ".align";

/** Default human-id prefix for decisions and commitments (`AL-12`); organisations may choose their own. */
export const DEFAULT_ENTRY_PREFIX = "AL";

/** Human-id prefix for questions (`Q-3`). */
export const QUESTION_PREFIX = "Q";

/** The word after `<!--` that opens the pack injected at session start (docs/10, docs/14); readers drop any text with it. */
export const PACK_MARKER_WORD = `${CLI_BIN}-pack`;

/** Matches the pack marker in any case and spacing (`<!-- align-pack`, `<!--ALIGN-PACK`). */
export const PACK_MARKER_RE = new RegExp(`<!--\\s*${PACK_MARKER_WORD}`, "i");

/** The suffix an existing git hook is renamed to when ALIGN's wrapper takes its place (docs/15 §Git hooks). */
export const ORIGINAL_HOOK_SUFFIX = `.pre-${CLI_BIN}`;

/** Commit trailer keys (docs/11 §Identifiers). Keys are matched case-insensitively. */
export const TRAILERS = {
  session: "Align-Session",
  decides: "Decides",
  supersedes: "Supersedes",
  refs: "Refs",
} as const;

export type TrailerKind = keyof typeof TRAILERS;

/**
 * Every key the trailer parser accepts for each kind, the canonical key first. A rename adds the new key
 * here and keeps the old one, so old commits keep parsing.
 */
export const TRAILER_ALIASES: { readonly [K in TrailerKind]: readonly string[] } = {
  session: [TRAILERS.session],
  decides: [TRAILERS.decides],
  supersedes: [TRAILERS.supersedes],
  refs: [TRAILERS.refs],
};

/** Resolves a trailer key (any case, any alias) to its kind, or null. */
export function trailerKind(key: string): TrailerKind | null {
  const wanted = key.trim().toLowerCase();
  for (const [kind, keys] of Object.entries(TRAILER_ALIASES) as [TrailerKind, readonly string[]][]) {
    if (keys.some((k) => k.toLowerCase() === wanted)) return kind;
  }
  return null;
}

/** The client header the CLI sends with its version (docs/25). */
export const CLIENT_HEADER = "X-Align-Client";

/** The response header that tells an outdated CLI to update (`required`; docs/25 §Conventions). */
export const UPGRADE_HEADER = "X-Align-Upgrade";

/** The macOS Keychain service the CLI stores tokens under (account = organisation id; docs/15 §Files). */
export const KEYCHAIN_SERVICE = `${CLI_BIN}-cli`;

/** The User-Agent the CLI and the server's outbound calls send. */
export function userAgent(version: string, component: "cli" | "server" = "cli"): string {
  return `${CLI_BIN}-${component}/${version}`;
}

/**
 * The production domain (`<domain>` in the docs, D428), without a scheme. `scripts/docs/check-placeholders.ts`
 * fails while it is null (absolute URLs on the public site come from it).
 */
export const SITE_DOMAIN: string | null = "align.bharatreachdsp.com";

/**
 * Where the public contact mailboxes live (D428): the company's own domain, whose mail is already received
 * (Google Workspace). The product's domain receives no mail (its zones have no MX records).
 */
export const CONTACT_DOMAIN = "bharatreachdsp.com";

/** The site's absolute origin, or null while the domain is unknown. */
export const SITE_URL: string | null = SITE_DOMAIN ? `https://${SITE_DOMAIN}` : null;

/** A public contact address (`privacy`, `security`, `support`, `legal`) at `CONTACT_DOMAIN`. */
export function contactAddress(mailbox: "privacy" | "security" | "support" | "legal"): string | null {
  return `${mailbox}@${CONTACT_DOMAIN}`;
}

/**
 * The seller of record named in the Terms (Paddle's domain review checks it). Null until the founder's legal
 * name is in the build log (docs/AUTONOMY.md §Founder-only quality steps, replaced); check-placeholders fails
 * while it is null.
 */
export const SELLER_LEGAL_NAME: string | null = "Sakuraj Technologies Private Limited";

/** The open-source client's public repository (the CLI mirror, MIT). */
export const SOURCE_REPO_URL = "https://github.com/bharatreachdsp/align-cli";
