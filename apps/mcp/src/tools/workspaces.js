/**
 * `create_workspace`, `apply_layout` and `connect_google`: setting a workspace
 * up from an agent, so the texting assistant needs a browser only for a third
 * party's own sign-in (decided by Dev2, 2026-10-17;
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

export async function toolCreateWorkspace(store, args) {
  const calls = store?.workspaceSetup;
  if (!calls) return toolError(UNAVAILABLE);
  const slug = typeof args.slug === "string" ? args.slug.trim().replace(/^@/, "") : "";
  if (!slug) return toolError("slug is required: the workspace's @handle.");
  const dryRun = args.dry_run === true;
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!dryRun && !name) return toolError("name is required: what the workspace is called.");

  const answer = await calls.create({ slug, ...(dryRun ? { dryRun: true } : { name }) });
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
  lines.push("Inviting people is done in the app; you cannot invite anyone from here.");
  return toolText(lines.join("\n"));
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
  if (args.kind !== "gmail" && args.kind !== "calendar") return toolError("kind is gmail or calendar.");
  const answer = await calls.connectGoogle(args.kind);
  if (answer === null || answer.ok !== true || typeof answer.url !== "string") return refused(answer);
  const what = args.kind === "gmail" ? "Gmail" : "Google Calendar";
  return toolText(
    `Link to connect ${what}: ${answer.url}\n` +
      `Send it to them: they open it, press Connect Google, and sign in to Google (it connects ${what} with the rest). ` +
      // Someone set up by text has never signed in to the app: the page asks for
      // their phone (a texted code) and, for an account a phone made, their email once.
      "If they aren't signed in to Context in that browser, it first asks for their phone number and texts them a " +
      "code, and the first time it asks for their email too (it emails a code). Say so in one line, so it doesn't " +
      "surprise them. Only they can finish that sign-in; it takes them a couple of minutes. " +
      // Google has not verified the app yet (Dev2, 2026-10-18), so its consent
      // screen warns before it asks for access.
      "Google then warns that it hasn't verified Context: tell them that's expected, and to tap Advanced, then " +
      "Go to Context (or Continue)."
  );
}
