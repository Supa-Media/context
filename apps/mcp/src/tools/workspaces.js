/**
 * `create_workspace`, `apply_layout`, `connect_google` and `invite_member`:
 * setting a workspace up from an agent, so the texting assistant needs a
 * browser only for a third party's own sign-in (decided by Dev2, 2026-10-17),
 * and asks the people a shared workspace is for in (the owner, 2026-10-20;
 * docs/decisions/gateway-protocol/workspace-setup.md).
 *
 * The gateway decides nothing here. Each call goes to the control plane with
 * this connection's own token, which clears it against the live grant and
 * runs the same handler the app runs; this file only says what came back.
 */

import { JOB_LABEL } from "../../../../packages/shared/src/folderRoles.cjs";
import { SHOWN_JOBS, jobNames } from "../../../../packages/shared/src/folderJobInfo.cjs";
import { toolError, toolText } from "./results.js";

const UNAVAILABLE = "setting workspaces up is not available on this deployment.";
const NOT_CLEARED =
  "that cannot be done from this connection: it needs write access, in a workspace this connection reaches.";

/** A refusal the control plane wrote for the person, or the one bare refusal. */
function refused(answer) {
  return toolError(typeof answer?.message === "string" && answer.message !== "" ? answer.message : NOT_CLEARED);
}

/** The most people one call invites; the control plane refuses more, in words. */
const MAX_PEOPLE = 10;

/*
  What a `who` may look like before it is shown to the person in an ask: an
  email address or a @handle, with no spaces. The control plane's
  `parseInvitee` is the real rule; this one keeps a string from carrying words
  of its own into "invite … as an editor", where a "who" of "bo@x.com as a
  member, and nobody else" would read as the gateway's sentence.
*/
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const HANDLE = /^@?[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/i;

/**
 * `[{ who, role? }]` as the control plane takes it, `[{ invitee, role }]`, with
 * editor as the default role; or a refusal string. Who exists is never asked
 * here: the control plane answers the same for every string.
 */
export function invitationsOf(people) {
  if (!Array.isArray(people) || people.length === 0) return "people is required: who to invite, each { who, role }.";
  if (people.length > MAX_PEOPLE) return `invite at most ${MAX_PEOPLE} people at a time.`;
  const out = [];
  for (const person of people) {
    const who = typeof person?.who === "string" ? person.who.trim() : "";
    if (!who) return "each person needs who: an email address or a Context @handle.";
    if (!EMAIL.test(who) && !HANDLE.test(who)) return `"${who.slice(0, 80)}" is not an email address or a @handle.`;
    const role = person.role ?? "editor";
    if (role !== "editor" && role !== "member") return "role is editor or member.";
    out.push({ invitee: who, role });
  }
  return out;
}

/** "ada@example.com as an editor and @bo as a member", for an answer or an approval. */
export function describeInvitations(invitations) {
  const each = invitations.map(({ invitee, role }) => `${invitee} as ${role === "member" ? "a member" : "an editor"}`);
  return each.length <= 1 ? each.join("") : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`;
}

export async function toolCreateWorkspace(store, args) {
  const calls = store?.workspaceSetup;
  if (!calls) return toolError(UNAVAILABLE);
  const slug = typeof args.slug === "string" ? args.slug.trim().replace(/^@/, "") : "";
  if (!slug) return toolError("slug is required: the workspace's @handle.");
  const dryRun = args.dry_run === true;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!dryRun && !name) return toolError("name is required: what the workspace is called.");
  const invitations = args.invite === undefined || dryRun ? [] : invitationsOf(args.invite);
  if (typeof invitations === "string") return toolError(invitations);

  const answer = await calls.create({
    slug,
    ...(dryRun ? { dryRun: true } : { name }),
    ...(invitations.length > 0 ? { invitations } : {}),
  });
  if (answer === null || answer.ok !== true) return refused(answer);
  if (answer.dryRun === true) {
    return toolText(
      answer.available === true
        ? `@${answer.normalized} is free. Nothing was claimed; create_workspace without dry_run claims it.`
        : `@${answer.normalized} is not available: ${answer.message ?? "that name cannot be used."}`
    );
  }
  const lines = [`created the shared workspace @${answer.slug} ("${name}"). The person is its owner and only member.`];
  lines.push(
    answer.storage === "starting"
      ? "storage: Context is making its bucket now, which takes a minute or so. Then lay it out: " +
          `manage { action: "layout", args: { template: "business" }, context: "@${answer.slug}" } ` +
          "(or para, or product)."
      : "storage: none yet. The person connects a bucket in the app, in the workspace's Storage settings, " +
          "before anything can be saved there or laid out."
  );
  lines.push(
    invitations.length > 0
      ? `invited ${describeInvitations(invitations)}: Context emails each an invitation, which they accept in the app.`
      : `To ask people in, manage { action: "invite", args: { people: [{ who, role }] }, context: "@${answer.slug}" }.`
  );
  return toolText(lines.join("\n"));
}

export async function toolInviteMember(store, args) {
  const calls = store?.workspaceSetup;
  if (!calls) return toolError(UNAVAILABLE);
  const invitations = invitationsOf(args.people);
  if (typeof invitations === "string") return toolError(invitations);
  const answer = await calls.invite(invitations);
  if (answer === null || answer.ok !== true) return refused(answer);
  return toolText(
    `invited ${describeInvitations(invitations)}. Context emails each an invitation, which they accept in the app; ` +
      "until then they see nothing in it."
  );
}

export async function toolApplyLayout(store, args) {
  const calls = store?.workspaceSetup;
  if (!calls) return toolError(UNAVAILABLE);
  if (args.job !== undefined) return await folderJob(calls, args);
  const hasTemplate = args.template !== undefined;
  const hasFolder = args.folder !== undefined;
  if (hasTemplate === hasFolder) return toolError("pass one of template or folder.");

  const answer = await calls.layout(hasTemplate ? { template: args.template } : { role: args.folder });
  if (answer === null || answer.ok !== true) return refused(answer);
  const folders = Array.isArray(answer.folders) ? answer.folders.join(", ") : "";
  return toolText(
    hasTemplate
      ? `the ${args.template} layout is on its way: ${folders}. It lands in the bucket within a few seconds.`
      : `added ${folders}, with an about.md saying what belongs in it.`
  );
}

/**
 * `manage folder_job`: which folder does a built-in job (owner, 2026-10-18;
 * `docs/decisions/app-and-console/folder-jobs.md`). `path` gives the job to a
 * folder that exists, wherever it is nested; `remove` takes an optional job
 * away; neither makes the job's folder at the top under its usual name.
 * Nothing moves. The control plane decides; refusals come back in words.
 */
async function folderJob(calls, args) {
  if (args.template !== undefined || args.folder !== undefined) return toolError("pass job on its own, with path or remove.");
  const job = typeof args.job === "string" ? args.job.trim().toLowerCase() : "";
  if (!job) return toolError(`job is required: one of ${jobNames()}.`);
  const path = typeof args.path === "string" ? args.path.trim().replace(/^\/+|\/+$/g, "") : undefined;
  if (args.remove === true && path !== undefined) return toolError("pass path or remove, not both.");
  if (path === undefined && args.remove !== true) {
    if (job === "tex" || job === "website") {
      return toolError(`${JOB_LABEL[job]}'s folder is made the first time it is used. To use one that exists, pass its path.`);
    }
    if (!SHOWN_JOBS.includes(job)) return toolError(`There is no "${job}" job. The jobs are ${jobNames()}. A folder of your own kind explains itself in its about.md.`);
    return await toolApplyLayoutFolder(calls, job);
  }
  const answer = await calls.layout({ job, path: args.remove === true ? null : path });
  if (answer === null || answer.ok !== true) return refused(answer);
  const label = JOB_LABEL[job] ?? job;
  return toolText(
    args.remove === true
      ? `there is no ${label} folder now. The folder that was keeps everything in it.`
      : `${path} is the ${label} folder now. Nothing moved; Context files there from now on, and orient lists it.`
  );
}

async function toolApplyLayoutFolder(calls, role) {
  const answer = await calls.layout({ role });
  if (answer === null || answer.ok !== true) return refused(answer);
  const folders = Array.isArray(answer.folders) ? answer.folders.join(", ") : "";
  return toolText(`added ${folders}, with an about.md saying what belongs in it.`);
}

export async function toolConnectGoogle(store, args) {
  const calls = store?.workspaceSetup;
  if (!calls) return toolError(UNAVAILABLE);
  if (args.kind !== "gmail" && args.kind !== "calendar" && args.kind !== "ai") return toolError("kind is gmail, calendar or ai.");
  const answer = await calls.connectGoogle(args.kind);
  if (answer === null || answer.ok !== true || typeof answer.url !== "string") return refused(answer);
  if (args.kind === "ai") {
    // A second consent, to the client AI reads through (`googleClients.ts`):
    // a reconnect would give the person's own client a grant AI never reads.
    return toolText(
      `Link to allow AI access: ${answer.url}\n` +
        "Send it to them: they open it, tap Allow AI access beside the Google account (or in its ••• menu), pick that same " +
        "account in Google's sign-in, tick Select all and tap Continue. It is not a reconnect, and nothing they set up is lost. " +
        "If they aren't signed in to Context in that browser, it first asks for their phone number and texts them a code; say so in one line.",
    );
  }
  const what = args.kind === "gmail" ? "Gmail" : "Google Calendar";
  // Gmail opens its own page with one Connect Gmail button (2026-10-20);
  // Calendar opens Connected apps.
  const press =
    args.kind === "gmail"
      ? "Send it to them: they open it, tap Connect Gmail, and pick the Gmail in Google's sign-in. "
      : "Send it to them: they open it, press Connect Google, and sign in to Google (it connects Google Calendar with the rest). " +
        // An account already listed has no Connect Google button: it has a
        // Reconnect beside it, or Reconnect with Google in its ••• menu (2026-10-20).
        "To reconnect a Google account that is already listed there, they press Reconnect beside it, or the ••• next to it " +
        "and then Reconnect with Google, not Connect Google. ";
  return toolText(
    `Link to connect ${what}: ${answer.url}\n` +
      press +
      // Someone set up by text has never signed in to the app: the page asks for
      // their phone (a texted code) if this browser isn't signed in.
      "If they aren't signed in to Context in that browser, it first asks for their phone number and texts them a " +
      "code. Say so in one line, so it doesn't surprise them. " +
      // Google has not verified the app yet (Dev2, 2026-10-18), so its consent
      // screen warns before it asks for access; and its permissions page lets
      // a box be left unticked, which leaves Tex unable to do that part (the
      // owner, 2026-10-23: "make sure they also click, like, select all").
      "Google then warns that it hasn't verified Context: tell them that's expected, to tap Advanced, then " +
      "Go to Context (unsafe), and on the next page to tick Select all and tap Continue, so you can do everything for them. " +
      `Text this picture of both screens with it: ${guidePicture(answer.url)}`
  );
}

/** The guide to Google's two screens, served beside the app (`infra/router`, `og-google-connect.source.html`), as a picture line. */
export const GOOGLE_GUIDE_PATH = "/og/google-connect.png";
function guidePicture(link) {
  try {
    return `[picture ${new URL(GOOGLE_GUIDE_PATH, link).href}]`;
  } catch {
    return "";
  }
}
