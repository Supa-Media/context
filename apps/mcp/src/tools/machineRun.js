/**
 * What a job part running on a person's own computer may not do through its
 * run grant (docs/decisions/texting-assistant/machines.md, "Credentials on a
 * device"): the grant is the job's own, minus every call that reaches
 * somebody outside. A coding tool on the machine works in the person's notes
 * as the job would; it never sends an email or a message, posts, changes a
 * calendar or an app, mints a link, invites anyone or opens the vault. Those
 * stay with Tex's own turn, behind the person's yes.
 *
 * Every tool under `send` is refused by name, so a send action added there
 * later is refused here without a change; the rest are named.
 */

import { ACTIONS } from "./v2/actions.js";

export const MACHINE_RUN_CLIENT_ID = "context_tex_machine_run";

export const MACHINE_RUN_REFUSED_TOOLS = new Set([
  "send",
  ...Object.values(ACTIONS.send).map((action) => action.tool),
  "create_link",
  "revoke_link",
  "invite_member",
  "create_workspace",
  "vault_add_link",
  "vault_share_link",
  "vault_view_link",
  "vault_list",
]);

export const MACHINE_RUN_REFUSAL =
  "A job running on your computer can't send, post, share or open the vault. Say what should be sent in your answer, and Tex will ask the person.";

/** True when this session is a machine run's and the call is one it may not make. `name` is the canonical name (`canonicalToolName`). */
export function machineRunRefuses(session, name) {
  return session?.actorClientId === MACHINE_RUN_CLIENT_ID && MACHINE_RUN_REFUSED_TOOLS.has(name);
}
