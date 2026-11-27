/**
 * Tex in mail, the texting Worker's part (`docs/decisions/note-mail.md`; Dev, 2026-11-27: "Tex in mail should be the
 * same flow as tex in comments I feel, its own mini tex"). A line sent to a person's own Tex on a note's mail wakes
 * their Tex store (`apps/mcp/src/mail/deliver.js`), whose alarm calls `TexRoutines.texMailDue({ owner })`
 * (`texRoutineDue.ts`). Here the runs waiting for that person are claimed from the control plane, each with a texting
 * session of theirs (`apps/convex/functions/texMail.ts`), and each is run by the gateway's `/tex/mail-run`
 * (`packages/tex/gateway/agent/mailRunRoute.js`), which answers in the note's mail. Nobody is texted.
 *
 * The alarm awaits this, so a run lasts as long as the gateway takes. Never a word of the mail here, only ids and a
 * path, and the tokens are never logged.
 */

import { AGENT_TIMEOUT_MS, post, record, ServiceError, type Fetch } from "./clients";

export type TexMailDeps = { fetch: Fetch; controlPlaneOrigin: string | undefined; workerSecret: string | undefined; gatewayOrigin: string | undefined; log: (entry: Record<string, unknown>) => void };

type TexMailRun = { runId: string; accessToken: string; workspaceId: string; path: string; mailboxId: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAILBOX = /^mb_[a-z0-9]{8,32}$/;
/** The most runs one wake takes: the control plane's own cap (`MAX_CLAIMED_TEX_MAIL_RUNS`). */
const MAX_RUNS = 3;

function runsOf(json: unknown): TexMailRun[] {
  const runs = record(json).runs;
  if (!Array.isArray(runs)) return [];
  const out: TexMailRun[] = [];
  for (const value of runs.slice(0, MAX_RUNS)) {
    const run = record(value);
    const { runId, accessToken, workspaceId, path, mailboxId } = run;
    if (typeof runId !== "string" || !ID.test(runId) || typeof accessToken !== "string" || accessToken === "" || typeof workspaceId !== "string" || !ID.test(workspaceId)) continue;
    if (typeof path !== "string" || path === "" || path.length > 512 || typeof mailboxId !== "string" || !MAILBOX.test(mailboxId)) continue;
    out.push({ runId, accessToken, workspaceId, path, mailboxId });
  }
  return out;
}

/** Claims and runs what waits for this personal workspace's person; how many ran. Rejects when the control plane can't be reached, so the alarm tries again. */
export async function runTexMail(deps: TexMailDeps, owner: string): Promise<number> {
  // A Worker without its control plane, secret or gateway can't claim a run: the alarm tries again once it has them.
  if (!deps.controlPlaneOrigin || !deps.workerSecret || !deps.gatewayOrigin) throw new ServiceError("control_plane", 0);
  const claimed = await post(deps.fetch, "control_plane", `${deps.controlPlaneOrigin}/agent-texts/mail-runs/due`, deps.workerSecret, { owner });
  if (claimed.status !== 200) throw new ServiceError("control_plane", claimed.status);
  const runs = runsOf(claimed.json);
  let ran = 0;
  for (const run of runs) {
    const started = Date.now();
    let outcome = "failed";
    try {
      const answered = await post(deps.fetch, "gateway", `${deps.gatewayOrigin}/tex/mail-run`, run.accessToken, { workspaceId: run.workspaceId, path: run.path, mailboxId: run.mailboxId }, AGENT_TIMEOUT_MS);
      const body = record(answered.json);
      outcome = answered.status === 200 && typeof body.outcome === "string" ? body.outcome.slice(0, 40) : `status_${answered.status}`;
      if (answered.status === 200) ran += 1;
    } catch {
      outcome = "unreachable";
    }
    // A run that failed is not tried again: the line is in the note, read by the next run or by Tex's next look.
    deps.log({ event: "tex_mail_run", run: run.runId, outcome, ms: Date.now() - started });
  }
  return ran;
}
