/**
 * The calls that wait for the person's yes because nothing undoes them, apart
 * from an email and a calendar change (`heldGates.js`, which hold their exact
 * copy): claiming a workspace's @handle, which is never freed (Dev2,
 * 2026-10-17), and inviting people, because the invitation email cannot be
 * unsent (the owner, 2026-10-20;
 * docs/decisions/gateway-protocol/workspace-setup.md).
 *
 * `irreversibleOf` answers what the approval says and why it is asked, or null
 * for every other call. A dry run claims nothing and is never held. Every
 * person a call would invite is named in the summary, so a yes is to them.
 */

import { oneLine } from "../privacy/egress.js";
import { describeInvitations, invitationsOf } from "./workspaces.js";
import { slackHeldSummary } from "./connectors.js";
import { appHeldSummary } from "./apps.js";

const HANDLE_IS_PERMANENT = "a @handle, once claimed, is never given back";
const EMAIL_IS_SENT = "an invitation is emailed and cannot be unsent";
const SLACK_IS_READ = "people in Slack read a message the moment it lands";
const APP_CHANGES = "a change in another app happens there, where Context cannot undo it";

function slugOf(args) {
  return typeof args.slug === "string" ? args.slug.trim().replace(/^@/, "").toLowerCase() : "";
}

/** `invite` as it would be sent, described; "" for none; null when the tool will refuse it anyway. */
function invitedClause(people) {
  if (people === undefined) return "";
  const invitations = invitationsOf(people);
  return typeof invitations === "string" ? null : describeInvitations(invitations);
}

/**
 * `{ audience, permanent, summary, because }` for a call that waits, or null.
 * `into` is the addressed workspace's @name, for an invite into one that exists;
 * `slack` is where a Slack post goes, by name (`slackPlace`).
 */
export function irreversibleOf(name, args, { into = null, slack = null } = {}) {
  const a = args && typeof args === "object" ? args : {};
  if (name === "create_workspace") {
    if (a.dry_run === true) return null;
    const invited = invitedClause(a.invite);
    // The tool refuses a list it cannot send, in words, before any handle is claimed.
    if (invited === null) return null;
    return {
      audience: invited ? "outside" : "private",
      permanent: true,
      summary: oneLine(
        `claim the handle @${slugOf(a)} for a new shared workspace (handles are permanent)` +
          (invited ? `, and invite ${invited} (Context emails them)` : "")
      ),
      because: invited ? `${HANDLE_IS_PERMANENT}, and ${EMAIL_IS_SENT}` : HANDLE_IS_PERMANENT,
    };
  }
  if (name === "invite_member") {
    const invited = invitedClause(a.people);
    // A call the tool will refuse anyway runs, and is refused in words.
    if (!invited) return null;
    const where = typeof into === "string" && into !== "" ? ` to ${into}` : "";
    return {
      audience: "outside",
      permanent: true,
      summary: oneLine(`invite ${invited}${where} (Context emails them)`),
      because: EMAIL_IS_SENT,
    };
  }
  if (name === "slack_api") {
    // A post is read the moment it lands; a reaction or a read is not held.
    const summary = slackHeldSummary(a, slack);
    if (summary === null) return null;
    return { audience: "outside", permanent: true, summary, because: SLACK_IS_READ };
  }
  if (name === "app_change") {
    // Every change through a connected app waits: Context can't know what a tool does.
    const summary = appHeldSummary(a);
    if (summary === null) return null;
    return { audience: "outside", permanent: true, summary, because: APP_CHANGES };
  }
  return null;
}
