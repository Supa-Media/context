/**
 * The control plane's note-mail mailboxes, for the stub: `/gateway/mail/join`,
 * `/get`, `/read` and `/jobs` (the mailboxes joined from a Tex job's turn), kept as `apps/convex/functions/noteMail.ts` keeps them.
 * A mailbox belongs to the grant that joined it; another grant gets nothing.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function createMailRoutes(grantForAccessToken, coveredContexts) {
  const mailboxes = new Map();
  let counter = 0;
  const view = ({ mailboxId, workspaceId, path, name, readThrough }) => ({ mailboxId, workspaceId, path, name, readThrough });

  async function join(body) {
    const grant = await grantForAccessToken(body.accessToken);
    const reach = grant ? coveredContexts(grant).some((entry) => entry.workspaceId === body.workspaceId) : false;
    if (!grant || !reach || !NAME.test(body.name) || body.name === "everyone") return { error: "refused" };
    const same = [...mailboxes.values()].filter(
      (row) => row.workspaceId === body.workspaceId && row.path === body.path && row.name === body.name
    );
    const mine = same.find((row) => row.grantId === grant.grantId);
    const jobId = typeof body.jobId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.jobId) ? body.jobId : undefined;
    if (body.jobId !== undefined && jobId === undefined) return { error: "refused" };
    if (mine) {
      if (jobId) mine.jobId = jobId;
      return { mailbox: view(mine) };
    }
    if (same.length) return { error: "name_taken" };
    const row = {
      mailboxId: `mb_${(++counter).toString(16).padStart(16, "0")}`,
      grantId: grant.grantId,
      workspaceId: body.workspaceId,
      path: body.path,
      name: body.name,
      readThrough: new Date().toISOString(),
      ...(jobId ? { jobId } : {}),
    };
    mailboxes.set(row.mailboxId, row);
    return { mailbox: view(row) };
  }

  async function own(body) {
    const grant = await grantForAccessToken(body.accessToken);
    const row = mailboxes.get(body.mailboxId);
    return grant && row && row.grantId === grant.grantId ? row : null;
  }

  /** The answer for `path`, or undefined when it is not a mail route. */
  async function handle(path, body) {
    if (path === "/gateway/mail/join") return join(body);
    if (path === "/gateway/mail/get") {
      const row = await own(body);
      return { mailbox: row ? view(row) : null };
    }
    if (path === "/gateway/mail/read") {
      const row = await own(body);
      if (row && Date.parse(body.readThrough) > Date.parse(row.readThrough)) row.readThrough = body.readThrough;
      return { ok: true };
    }
    if (path === "/gateway/mail/jobs") {
      const grant = await grantForAccessToken(body.accessToken);
      const reach = grant ? coveredContexts(grant).some((entry) => entry.workspaceId === body.workspaceId) : false;
      if (!reach) return { mailboxes: [] };
      const rows = [...mailboxes.values()].filter((row) => row.workspaceId === body.workspaceId && row.path === body.path && row.jobId);
      return { mailboxes: rows.map(({ mailboxId, name, jobId, grantId }) => ({ mailboxId, name, jobId, own: grantId === grant.grantId })) };
    }
    return undefined;
  }

  return { handle, mailboxes };
}
