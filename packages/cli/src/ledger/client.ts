/**
 * Ledger calls for the person's own commands (`confirm`, `decide`, `ask`; docs/25 §Ledger). Every mutation is a
 * person's explicit act with their own token: the server's RPCs record that person as the actor (hard rule 3), and
 * nothing here confirms, rejects or shares on its own. Each mutation carries an `Idempotency-Key`, so a retry after
 * a lost answer never acts twice. Free text the person typed is redacted on this laptop first (`redact.ts`).
 */
import { randomUUID } from "node:crypto";
import type { ApiClient } from "../api";
import { EntriesPage, Entry, KeyResponse, ShareResponse, SupersedeResponse } from "./api";

const key = (k: string) => encodeURIComponent(k);
/** A fresh key per call unless the caller keeps one for a retry of the same act (the TUI does, per card and key). */
const once = (key?: string) => ({ idempotencyKey: key ?? newIdempotencyKey() });
export const newIdempotencyKey = () => `cli-${randomUUID()}`;

export class LedgerClient {
  constructor(
    private readonly api: ApiClient,
    readonly repoId: string,
  ) {}

  async inbox() {
    return (await this.api.request("GET", `/inbox?repo_id=${encodeURIComponent(this.repoId)}`, EntriesPage)).data;
  }

  async entry(k: string) {
    return (await this.api.request("GET", `/entries/${key(k)}`, Entry)).data;
  }

  async confirm(k: string, o: { statement?: string; acceptChecks?: string[]; idem?: string }) {
    const body: Record<string, unknown> = { via: "cli" };
    if (o.statement !== undefined) body.edits = { statement: o.statement };
    if (o.acceptChecks && o.acceptChecks.length > 0) body.accept_checks = o.acceptChecks;
    return (await this.api.request("POST", `/entries/${key(k)}/confirm`, Entry, body, once(o.idem))).data;
  }

  async reject(k: string, reason: string, idem?: string) {
    return (await this.api.request("POST", `/entries/${key(k)}/reject`, Entry, { reason }, once(idem))).data;
  }

  /** `target` is the entry the proposal replaces; the proposal `byKey` becomes its successor. */
  async supersede(target: string, byKey: string, reason: string, idem?: string) {
    return (
      await this.api.request(
        "POST",
        `/entries/${key(target)}/supersede`,
        SupersedeResponse,
        { by_key: byKey, reason },
        once(idem),
      )
    ).data;
  }

  async share(keys: string[], idem?: string) {
    return (await this.api.request("POST", "/entries/share", ShareResponse, { keys }, once(idem))).data;
  }

  async record(body: {
    kind: "decision" | "commitment";
    statement: string;
    rationale?: string;
    alternatives_rejected: string[];
    scope_paths: string[];
    due_date?: string;
    owner_email?: string;
  }) {
    return (
      await this.api.request("POST", "/entries", KeyResponse, { repo_id: this.repoId, ...body, via: "cli" }, once())
    ).data;
  }

  async ask(body: { text: string; owner_email?: string; via?: "person" | "agent" }) {
    return (await this.api.request("POST", "/questions", KeyResponse, { repo_id: this.repoId, ...body }, once())).data;
  }
}
