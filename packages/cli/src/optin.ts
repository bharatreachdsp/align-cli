/**
 * Turning capture on (`align init` step 5, `align on`; D517 as amended). A terminal cannot opt in by itself: a typed
 * `y` is spoofable (an agent can drive a pseudo-terminal, unset the D404 variables with `env -u`, or push keystrokes
 * with TIOCSTI), so every opt-in the server does not already hold live (a first one, a return after `align off`) and
 * every pilot-terms acceptance is confirmed in the console with the person's own signed-in session, the way device
 * login is approved. When the server already holds a live opt-in (`confirm_in_console: false`), this laptop just
 * starts capturing; nothing is asked.
 */
import { OptinRequestCreated, OptinRequestStatus, type RepoState } from "@align/core/api";
import type { ApiClient } from "./api";
import { agentHarness } from "./confirm/person";
import type { Ctx } from "./context";
import { copy } from "./copy";

export type OptinOutcome = "in" | "declined" | "failed";

/** Waits for the person to confirm in the console; prints the link first. */
async function viaConsole(
  ctx: Ctx,
  api: ApiClient,
  repoPath: string,
  via: "person" | "agent",
  pilot: { url: string } | null,
): Promise<OptinOutcome> {
  const { data: req } = await api.request("POST", `${repoPath}/optin/requests`, OptinRequestCreated, { via });
  ctx.line(copy.optinConsole.open(req.url, pilot !== null));
  const until = Date.parse(req.expires_at);
  for (;;) {
    await ctx.sleep(req.interval * 1000);
    const { data } = await api.request(
      "GET",
      `${repoPath}/optin/requests/${encodeURIComponent(req.id)}`,
      OptinRequestStatus,
    );
    if (data.status === "confirmed") return "in";
    if (data.status === "expired" || ctx.now() > until) {
      ctx.fail(copy.optinConsole.expired);
      return "failed";
    }
  }
}

/**
 * Opts this person in for one repository. `state` is the repository's `GET /repos/:id/state`. The consent text is
 * printed before the console link.
 */
export async function turnOn(
  ctx: Ctx,
  api: ApiClient,
  repoPath: string,
  _remoteNorm: string,
  state: RepoState,
): Promise<OptinOutcome> {
  const pilot = state.pilot_terms && !state.pilot_terms.accepted ? { url: state.pilot_terms.url } : null;
  // What is captured, shown either way (#156 review): as information when the server already holds a live opt-in.
  ctx.line(copy.consent(pilot));
  // Already live on the server (an earlier confirmation, another laptop): nothing to confirm again.
  if (state.confirm_in_console === false && state.opted_in) return "in";
  const agent = agentHarness(ctx.env);
  if (agent) ctx.line(copy.optinConsole.agent(agent));
  return viaConsole(ctx, api, repoPath, agent ? "agent" : "person", pilot);
}
