/**
 * The control plane's note-mail mailboxes, for the stub: `/gateway/mail/join`,
 * `/get`, `/read` and `/jobs` (the mailboxes joined from a Tex job's turn), kept as `apps/convex/functions/noteMail.ts` keeps them.
 * A mailbox belongs to the grant that joined it; another grant gets nothing.
 *
 * Also `/gateway/machines/pair/approve-grant` (`pair_device`), as `.devices`: the asks it got, and the answer a test
 * sets (`{ name, os }`, or a status for a refusal). A mailbox joined with a `machineId` is one of the person's
 * machines, as `apps/convex/functions/noteMail.ts` keeps it; `.devices.machines` names the ones that exist.
 */

const NAME = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** A person's own Tex's mailbox: "tex", joined from their texts by no job or machine (`noteMail.ts` `isTexBox`). */
const texBox = (row) => row.name === "tex" && !row.jobId && !row.machineId && row.clientId === "context_texts";

export function createMailRoutes(grantForAccessToken, coveredContexts, grants = new Map()) {
  // A person's own texting grant, for the Tex seat an agent of theirs with no seat gets (`noteMail.ts` `texSeatMailbox`).
  const textsGrantOf = (userId) => [...grants.values()].find((grant) => grant.userId === userId && grant.clientId === "context_texts" && grant.status === "active") ?? null;
  const mailboxes = new Map();
  // The Tex-in-mail asks the gateway made (`/gateway/mail/tex`), as `apps/convex/functions/noteMail.ts` `askTexMail` takes them.
  const texAsks = [];
  const devices = { asks: [], answer: { name: "Claude Code · repo", os: "linux" }, machines: new Map() };
  let counter = 0;
  const view = ({ mailboxId, workspaceId, path, name, readThrough }) => ({ mailboxId, workspaceId, path, name, readThrough });

  // Answers a test sets for the next joins (`{ error: "refused" }`, `{ error: "own_name", name }`), taken in order.
  const joinAnswers = [];

  async function join(body) {
    if (joinAnswers.length) return joinAnswers.shift();
    const grant = await grantForAccessToken(body.accessToken);
    const reach = grant ? coveredContexts(grant).some((entry) => entry.workspaceId === body.workspaceId) : false;
    if (!grant || !reach || !NAME.test(body.name) || body.name === "everyone") return { error: "refused" };
    const same = [...mailboxes.values()].filter(
      (row) => row.workspaceId === body.workspaceId && row.path === body.path && row.name === body.name
    );
    const mine = same.find((row) => row.grantId === grant.grantId);
    const jobId = typeof body.jobId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.jobId) ? body.jobId : undefined;
    if (body.jobId !== undefined && jobId === undefined) return { error: "refused" };
    // A machine must exist, be live and be the joining grant's own person's (`deviceStillLive` in the real one).
    const machine = body.machineId === undefined ? undefined : devices.machines.get(body.machineId);
    if (body.machineId !== undefined && machine?.ownerId !== grant.userId) return { error: "refused" };
    const machineId = machine ? body.machineId : undefined;
    if (mine) {
      if (jobId) mine.jobId = jobId;
      if (machineId) mine.machineId = machineId;
      return { mailbox: view(mine) };
    }
    if (same.length) return { error: "name_taken" };
    const row = {
      mailboxId: `mb_${(++counter).toString(16).padStart(16, "0")}`,
      grantId: grant.grantId,
      clientId: grant.clientId,
      ownerWorkspaceId: grant.workspaceId,
      workspaceId: body.workspaceId,
      path: body.path,
      name: body.name,
      readThrough: new Date().toISOString(),
      ...(jobId ? { jobId } : {}),
      ...(machineId ? { machineId } : {}),
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
    if (path === "/gateway/machines/pair/approve-grant") {
      devices.asks.push({ accessToken: body.accessToken, workspaceId: body.workspaceId, code: body.code });
      if (typeof devices.answer.status === "number") return new Response(JSON.stringify({ code: "REFUSED" }), { status: devices.answer.status });
      return devices.answer;
    }
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
      const rows = [...mailboxes.values()].filter((row) => row.workspaceId === body.workspaceId && row.path === body.path && (row.jobId || row.machineId || texBox(row)));
      return {
        mailboxes: rows.map(({ mailboxId, name, jobId, machineId, grantId, ...row }) => ({
          mailboxId,
          name,
          ...(jobId ? { jobId } : machineId ? { machineId, machineWorkspaceId: devices.machines.get(machineId)?.workspaceId } : texBox({ name, ...row }) ? { texChat: true } : {}),
          own: grantId === grant.grantId,
        })),
      };
    }
    if (path === "/gateway/mail/tex-seat") {
      // An agent with no seat sent mail here: its person's own Tex gets a "tex" mailbox on the note (`texSeatMailbox`).
      const grant = await grantForAccessToken(body.accessToken);
      const reach = grant ? coveredContexts(grant).some((entry) => entry.workspaceId === body.workspaceId) : false;
      const texts = grant && reach && grant.clientId !== "context_texts" ? textsGrantOf(grant.userId) : null;
      if (!texts) return { mailboxId: null };
      const same = [...mailboxes.values()].filter((row) => row.workspaceId === body.workspaceId && row.path === body.path && row.name === "tex");
      const mine = same.find((row) => row.grantId === texts.grantId);
      if (mine) return { mailboxId: mine.mailboxId };
      if (same.length) return { mailboxId: null };
      const row = { mailboxId: `mb_${(++counter).toString(16).padStart(16, "0")}`, grantId: texts.grantId, clientId: texts.clientId, ownerWorkspaceId: texts.workspaceId, ownerUserId: texts.userId, workspaceId: body.workspaceId, path: body.path, name: "tex", readThrough: new Date().toISOString() };
      mailboxes.set(row.mailboxId, row);
      return { mailboxId: row.mailboxId };
    }
    if (path === "/gateway/mail/tex") {
      const grant = await grantForAccessToken(body.accessToken);
      const row = mailboxes.get(body.mailboxId);
      // `forHandle`: the line is to an agent of that person's; the stub's handle is the texting grant's user id.
      const forOk = body.forHandle === undefined || (row && body.forHandle === String(row.ownerUserId ?? ""));
      const ok = grant && row && texBox(row) && row.grantId !== grant.grantId && row.workspaceId === body.workspaceId && row.path === body.path && forOk;
      texAsks.push({ ...body, accessToken: undefined, answered: ok ? row.ownerWorkspaceId : null });
      return { owner: ok ? row.ownerWorkspaceId : null };
    }
    return undefined;
  }

  return { handle, mailboxes, devices, joinAnswers, texAsks };
}
