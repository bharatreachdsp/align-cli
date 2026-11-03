/** Repositories: resolve, claim, opt-in, state (docs/25 §Repositories). Routes arrive in L20. */
import { z } from "zod";
import { Id, Timestamp } from "./common";

export const Provider = z.enum(["github", "gitlab", "bitbucket", "other"]);

/** What the CLI knows about a clone (docs/15 `init` step 1). The root commit is the clone proof. */
export const RepoIdentity = z.object({
  remote_norm: z.string().min(3).max(512),
  root_commit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
  default_branch: z.string().min(1).max(255),
  provider: Provider,
});
export type RepoIdentity = z.infer<typeof RepoIdentity>;

export const Repo = z.object({
  id: Id,
  remote_norm: z.string(),
  verified: z.boolean(),
  default_branch: z.string(),
  project_id: Id.nullable(),
});
export type Repo = z.infer<typeof Repo>;

export const ResolveResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("connected"),
    repo: Repo,
    /** `repo_access.source` (docs/11); null when the caller has no access yet. */
    access: z.enum(["owner", "admin", "github", "clone", "grant"]).nullable(),
    opted_in: z.boolean(),
  }),
  z.object({ status: z.literal("unclaimed") }),
  z.object({
    status: z.literal("other_org"),
    org_name: z.string(),
    /** Present when the person collaborates on the verified repository on GitHub (auto-join). */
    auto_join_url: z.url().optional(),
    /** Where to ask that organisation's admins for access (docs/19), D81. */
    request_access_url: z.url().optional(),
  }),
]);
export type ResolveResponse = z.infer<typeof ResolveResponse>;

export const ClaimResponse = z.object({ repo: Repo });

/**
 * `PUT /repos/:id/optin`. Turning capture on here is only a return to a repository the person has opted into before,
 * from their own terminal (`via: "person"`, its pilot terms already accepted); a first opt-in, an agent's request
 * (`via: "agent"`) and accepting the pilot terms all go through `POST /repos/:id/optin/requests` and the console
 * (D517). `accept_pilot_terms_version` is no longer honoured: the server answers `confirmation_required`.
 */
export const OptinRequest = z.object({
  opted_in: z.boolean(),
  via: z.enum(["person", "agent"]).optional(),
  accept_pilot_terms_version: z.string().min(1).max(32).optional(),
});
export type OptinRequest = z.infer<typeof OptinRequest>;

export const OptinResponse = z.object({ opted_in: z.boolean(), at: Timestamp });

/** `POST /repos/:id/optin/requests` (D517): a pending opt-in the person confirms in the console. */
export const OptinRequestCreate = z.object({ via: z.enum(["person", "agent"]) });
export const OptinRequestCreated = z.object({
  id: z.uuid(),
  /** The console page that shows the consent (and the pilot terms) and confirms with the person's own session. */
  url: z.url(),
  expires_at: Timestamp,
  /** Seconds between status polls. */
  interval: z.number().int().positive(),
});
export const OptinRequestStatus = z.object({ status: z.enum(["pending", "confirmed", "expired"]) });

export const Plan = z.enum(["free", "beta", "team", "business"]);

export const RepoState = z.object({
  opted_in: z.boolean(),
  plan: Plan,
  limits: z.record(z.string(), z.number().nullable()),
  email_domains: z.array(z.string()),
  client: z.object({ latest: z.string(), min_supported: z.string() }),
  counts: z.object({ proposed_for_me: z.number().int(), open_conflicts: z.number().int() }),
  /** The pilot data terms a `beta` organisation's members accept at opt-in; null otherwise (D81). */
  pilot_terms: z.object({ version: z.string(), url: z.url(), accepted: z.boolean() }).nullable(),
  /**
   * D517: turning capture on needs the console (a first opt-in here, or pilot terms not yet accepted); when false a
   * person's own terminal may turn it back on with `PUT /repos/:id/optin`. Optional for older servers.
   */
  confirm_in_console: z.boolean().optional(),
});
export type RepoState = z.infer<typeof RepoState>;
