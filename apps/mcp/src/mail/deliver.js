/**
 * Mail delivered at once to the background jobs that joined a note's mail
 * (owner, 2026-11-04: "agents Tex started message each other instantly";
 * `docs/decisions/note-mail.md`).
 *
 * The line is written into the note first, through the ordinary write path,
 * and stays there: the note is the record, and delivery is only a nudge. Then
 * the gateway asks the control plane which mailboxes on that note were
 * joined from a job's turn (`noteMailboxes.jobId`), and hands each recipient
 * job the line through the texting Worker's named entrypoint
 * (`TexRoutines.mailDeliver`, `apps/agent/src/jobMail.ts`), which steers it
 * into the part running now or keeps it for the next one.
 *
 * A mailbox joined from a session on one of the person's machines (a cloud
 * VM's Claude Code, `device` on join) gets the line through that machine's
 * workspace object instead: it goes down the runner's socket, and the runner
 * holds it until the session has been shown it (`ws.machine.mail`).
 *
 * Who receives is decided here, from the line: the name it is addressed to,
 * or everyone who joined but the sender. The sender never gets its own line.
 * Delivery never fails the send: a job that cannot be reached reads the line
 * in the note as any other agent would.
 */

import { callTexStore } from "../texStore/wire.js";
import { workspaceStub } from "../workspaceStore/api.js";

/**
 * The agents on every job note besides its jobs (`agent/jobNote.js`): a line addressed to one is handed to the job
 * that sent it, whose own object tells the chat (Tex) or asks the advisor (`apps/agent/src/jobNote.ts`). Only a
 * sender's own job mailbox counts, so a line from anybody else reaches neither.
 */
const ROSTER_AGENTS = new Set(["tex", "advisor"]);

/** Recipients handed one line at most; a note's mail is a small team, not a broadcast list. */
export const MAX_DELIVERIES = 20;

/** A mail id for the runner's inbox: one per line and machine, never a credential. */
function messageIdOf(line, mailboxId) {
  return `ml_${mailboxId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32)}_${Date.parse(line.at) || Date.now()}`;
}

/**
 * Hands one line to a machine whose session joined the note's mail (`device` on join): its workspace object sends
 * it on the runner's socket, and the runner keeps it until that session has been shown it (`ws.machine.mail`).
 */
async function toMachine(env, workspaceId, box, line) {
  const stub = workspaceStub(env, workspaceId);
  if (stub === null) return false;
  // Every call to a workspace object names its workspace, and the object refuses one that does not (`rows.pinWorkspace`).
  const mail = {
    messageId: messageIdOf(line, box.mailboxId),
    // An interrupt is Tex's to its own job; to a machine it is an ask that needs reading now.
    kind: line.mailKind === "ask" || line.mailKind === "interrupt" ? "ask" : "note",
    from: String(line.from).slice(0, 100),
    to: String(line.to).slice(0, 40),
    text: String(line.text).slice(0, 4000),
    ...(line.app ? { app: String(line.app).slice(0, 40) } : {}),
    path: line.path,
    at: Date.parse(line.at) || Date.now(),
  };
  const response = await callTexStore(stub, "ws.machine.mail", {}, new TextEncoder().encode(JSON.stringify({ workspaceId, id: box.machineId, mail })));
  return (await response.json())?.sent === true;
}

/**
 * @param {{ TEXTING?: { mailDeliver?: (call: object) => Promise<{ taken?: boolean }> }, WORKSPACE_STORE?: object }} env
 * @param {{ jobMailboxes: (path: string) => Promise<Array<{ mailboxId: string, name: string, jobId?: string, machineId?: string, machineWorkspaceId?: string, own?: boolean }>> }} mail
 * @param {{ path: string, at: string, from: string, app: string | null, to: string, mailKind: "note" | "ask" | "interrupt", text: string }} line
 * @returns {Promise<string[]>} the names of the jobs and machines that took the line
 */
export async function deliverMail(env, mail, line) {
  if (typeof mail?.jobMailboxes !== "function") return [];
  let boxes;
  try {
    boxes = await mail.jobMailboxes(line.path);
  } catch {
    return [];
  }
  const texting = env?.TEXTING;
  if (ROSTER_AGENTS.has(line.to)) {
    const sender = (Array.isArray(boxes) ? boxes : []).find((box) => box?.name === line.from && typeof box.jobId === "string" && typeof box.mailboxId === "string" && box.own === true);
    if (!sender || typeof texting?.mailDeliver !== "function") return [];
    try {
      const answer = await texting.mailDeliver({
        jobId: sender.jobId,
        mailboxId: sender.mailboxId,
        to: line.to,
        mail: { path: line.path, at: line.at, from: line.from, app: line.app, kind: line.mailKind, text: line.text },
      });
      return answer?.taken === true ? [line.to] : [];
    } catch {
      return [];
    }
  }
  const addressed = (Array.isArray(boxes) ? boxes : [])
    .filter((box) => typeof box?.mailboxId === "string" && box.name !== line.from && !ROSTER_AGENTS.has(box.name))
    .filter((box) => line.to === "everyone" || box.name === line.to)
    .slice(0, MAX_DELIVERIES);
  // A session on a machine (a cloud VM's Claude Code): through its workspace object, never an interrupt from another agent.
  // The machine lives in its own workspace's object, which need not be the note's (`machineWorkspaceId`).
  const machines = addressed.filter((box) => typeof box.machineId === "string" && typeof box.machineWorkspaceId === "string" && (line.mailKind !== "interrupt" || box.own === true));
  const toMachines = machines.map(async (box) => ((await toMachine(env, box.machineWorkspaceId, box, line).catch(() => false)) ? box.name : null));
  const jobs = typeof texting?.mailDeliver === "function" ? addressed.filter((box) => typeof box.jobId === "string") : [];
  const to = jobs
    // An interrupt reaches only a job its sender's own grant joined as: one person's Tex never stops another person's job.
    .filter((box) => line.mailKind !== "interrupt" || box.own === true)
    .slice(0, MAX_DELIVERIES);
  const taken = await Promise.all(
    to.map(async (box) => {
      try {
        const answer = await texting.mailDeliver({
          jobId: box.jobId,
          mailboxId: box.mailboxId,
          to: box.name,
          mail: { path: line.path, at: line.at, from: line.from, app: line.app, kind: line.mailKind, text: line.text },
        });
        return answer?.taken === true ? box.name : null;
      } catch {
        return null;
      }
    }),
  );
  return [...taken, ...(await Promise.all(toMachines))].filter(Boolean);
}
