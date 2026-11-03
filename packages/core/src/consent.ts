/**
 * The opt-in consent text (docs/19 §CLI: align init; D517): what is captured, what never is, and who sees what. One
 * copy, shown by `align init` on the terminal and by the console's opt-in page (`/optin/<id>`), where a person
 * confirms a first opt-in with their own session.
 */
import { PRODUCT_NAME } from "./brand";

export type Consent = { title: string; items: string[]; mark: "•" | "×" }[];

export const CONSENT: Consent = [
  {
    title: `What ${PRODUCT_NAME} captures from this repository`,
    mark: "•",
    items: [
      "your prompts and the agent's replies, with secrets removed and code blocks replaced, on this laptop",
      "the file paths the agent touched in this repository, your commits and pull requests",
      "the decisions you confirm",
    ],
  },
  {
    title: "What it never captures",
    mark: "×",
    items: [
      "file contents, tool outputs, the commands your tools run, diffs from this laptop",
      "secrets, .env files, other repositories, hostnames, usernames",
    ],
  },
  {
    title: "Who sees what",
    mark: "•",
    items: [
      "proposals from your sessions: only you, until you confirm or share them, or they appear in a PR you open",
      "confirmed decisions and their short quotes: people with access to this repository",
      "your raw transcripts: only you",
    ],
  },
];

/** Shown under the "never" list: pasted text is not code-fenced, so it is sent after secret redaction. */
export const CONSENT_PASTE_NOTE = "(text you paste without a code fence is sent after secret redaction)";

/** How long a pending opt-in waits for the person's confirmation in the console. */
export const OPTIN_REQUEST_TTL_S = 15 * 60;
