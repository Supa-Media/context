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
 * Who receives is decided here, from the line: the name it is addressed to,
 * or everyone who joined but the sender. The sender never gets its own line.
 * Delivery never fails the send: a job that cannot be reached reads the line
 * in the note as any other agent would.
 */

/** Recipients handed one line at most; a note's mail is a small team, not a broadcast list. */
export const MAX_DELIVERIES = 20;

/**
 * @param {{ TEXTING?: { mailDeliver?: (call: object) => Promise<{ taken?: boolean }> } }} env
 * @param {{ jobMailboxes: (path: string) => Promise<Array<{ mailboxId: string, name: string, jobId: string, own?: boolean }>> }} mail
 * @param {{ path: string, at: string, from: string, app: string | null, to: string, mailKind: "note" | "ask" | "interrupt", text: string }} line
 * @returns {Promise<string[]>} the names of the jobs that took the line
 */
export async function deliverMail(env, mail, line) {
  const texting = env?.TEXTING;
  if (!texting || typeof texting.mailDeliver !== "function" || typeof mail?.jobMailboxes !== "function") return [];
  let boxes;
  try {
    boxes = await mail.jobMailboxes(line.path);
  } catch {
    return [];
  }
  const to = (Array.isArray(boxes) ? boxes : [])
    .filter((box) => typeof box?.jobId === "string" && typeof box?.mailboxId === "string" && box.name !== line.from)
    .filter((box) => line.to === "everyone" || box.name === line.to)
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
  return taken.filter(Boolean);
}
