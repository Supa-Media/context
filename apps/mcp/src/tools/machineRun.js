/**
 * What a job part running on a person's own computer may not do through its
 * run grant (docs/decisions/texting-assistant/machines.md, "Credentials on a
 * device"): the grant is the job's own, minus every call that reaches
 * somebody outside. A coding tool on the machine works in the person's notes
 * as the job would; it never sends an email or a message, posts, changes a
 * calendar or an app, mints a link, invites anyone or opens a vault page. Those
 * stay with Tex's own turn, behind the person's yes. It may call an API with a
 * saved key through `vault_list`'s `fetch`, never seeing the key, under the
 * same first-use yes as any AI (the owner, 2026-11-05: "while it doesn't have
 * logins it can use api keys to send requests using context as a proxy"); a
 * run started from a group uses only the group's keys (`vault/access.js`).
 *
 * Every tool under `send` but its `api` action (`vault_list` with `fetch`) is
 * refused by name, so a send action added there later is refused here without
 * a change; the rest are named. The `send` tool itself is offered for that one
 * action, and every other action of it is refused by the tool it translates
 * to (`tools/session.js` checks both names).
 */

import { ACTIONS } from "./v2/actions.js";

export const MACHINE_RUN_CLIENT_ID = "context_tex_machine_run";

/** The one tool under `send` a run may reach: an API called with a saved key it never sees. */
const KEYED_API = "vault_list";

export const MACHINE_RUN_REFUSED_TOOLS = new Set([
  ...Object.values(ACTIONS.send).map((action) => action.tool).filter((tool) => tool !== KEYED_API),
  "create_link",
  "revoke_link",
  "invite_member",
  "create_workspace",
  "vault_add_link",
  "vault_share_link",
  "vault_view_link",
]);

export const MACHINE_RUN_REFUSAL =
  "A job running on your computer can't send, post, share or open a vault page. Mail Tex on your job's note what should be sent or opened, and why, and keep working: Tex asks the person and their answer comes back to you.";

/** True when this session is a machine run's and the call is one it may not make. `name` is the canonical name (`canonicalToolName`). */
export function machineRunRefuses(session, name) {
  return session?.actorClientId === MACHINE_RUN_CLIENT_ID && MACHINE_RUN_REFUSED_TOOLS.has(name);
}
