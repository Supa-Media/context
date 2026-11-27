import { describe, expect, test } from "vitest";
import { createUser, createWorkspace, gatewayPost, setupTest } from "../fixtures.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "../controlPlane/fixtures.helpers";
import { TEXTS_CLIENT_ID } from "../../functions/textLinks";
import { TEXTS_GROUP_CLIENT_ID } from "../../functions/textGroups";
import { MAX_TEX_MAIL_RUNS_PER_HOUR } from "../../functions/noteMail";

/**
 * TEX IN MAIL (`functions/noteMail.ts` `askTexMail`, `functions/texMail.ts`): a line sent to a person's own Tex on a
 * note wakes their Tex, which answers with a texting session of theirs.
 *
 * ## Sabotage record
 * - `isTexBox` accepting any client: the group chat's "tex" box is woken, and "a group chat's Tex is never woken" fails.
 * - `askTexMail` without `mayUse`: Tex's own line wakes itself, and "Tex never wakes itself" fails.
 * - `askTexMail` without the reach check: a stranger's token wakes Dev's Tex, and "a stranger" fails.
 */

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const FULL = ["context:read", "context:write", "context:private"];
const TEX = token("dev_texts");
const BOT = token("dev_bot");
const GROUP = token("dev_group");
const STRANGER = token("stranger");
const PATH = "areas/growth/mail/tex.md";

type T = ReturnType<typeof setupTest>;
type Box = { mailboxId: string; name: string; texChat?: true; jobId?: string; own: boolean };

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function world() {
  const t = setupTest();
  const dev = await createUser(t, "dev@example.invalid");
  const devWs = await createWorkspace(t, dev, "devon", { kind: "personal" });
  const stranger = await createUser(t, "stranger@example.invalid");
  const strangerWs = await createWorkspace(t, stranger, "strangeling", { kind: "personal" });
  for (const clientId of [TEXTS_CLIENT_ID, TEXTS_GROUP_CLIENT_ID, "mcp_bot", "mcp_stranger"]) await registerClient(t, clientId);
  await seedConnectedClient(t, { workspaceId: devWs, userId: dev, clientId: TEXTS_CLIENT_ID, accessToken: TEX, scopes: FULL });
  const groupGrant = await seedConnectedClient(t, { workspaceId: devWs, userId: dev, clientId: TEXTS_GROUP_CLIENT_ID, accessToken: GROUP, scopes: FULL });
  await seedConnectedClient(t, { workspaceId: devWs, userId: dev, clientId: "mcp_bot", accessToken: BOT, scopes: FULL });
  await seedConnectedClient(t, { workspaceId: strangerWs, userId: stranger, clientId: "mcp_stranger", accessToken: STRANGER, scopes: FULL });
  const joined = (await bodyOf(await gatewayPost(t, "/gateway/mail/join", { accessToken: TEX, workspaceId: devWs, path: PATH, name: "tex" }))) as { mailbox: { mailboxId: string } };
  return { t, dev, devWs, groupGrant, mailboxId: joined.mailbox.mailboxId };
}

async function boxes(t: T, accessToken: string, workspaceId: string, path = PATH) {
  return ((await bodyOf(await gatewayPost(t, "/gateway/mail/jobs", { accessToken, workspaceId, path }))) as { mailboxes: Box[] }).mailboxes;
}

async function ask(t: T, accessToken: string, workspaceId: string, mailboxId: string, path = PATH) {
  return ((await bodyOf(await gatewayPost(t, "/gateway/mail/tex", { accessToken, workspaceId, path, mailboxId }))) as { owner: string | null }).owner;
}

async function claim(t: T, owner: string) {
  return (await agentPost(t, "/agent-texts/mail-runs/due", { owner })).runs as Array<{ runId: string; accessToken: string; workspaceId: string; path: string; mailboxId: string }>;
}

describe("Tex in mail", () => {
  test("a person's own Tex's mailbox is listed as theirs, to everyone who reaches the note", async () => {
    const { t, devWs, mailboxId } = await world();
    expect(await boxes(t, BOT, devWs)).toEqual([{ mailboxId, name: "tex", texChat: true, own: false }]);
    expect(await boxes(t, TEX, devWs)).toEqual([{ mailboxId, name: "tex", texChat: true, own: true }]);
  });

  test("a line to it wakes the owner's Tex once, and the run claims a texting session of theirs", async () => {
    const { t, dev, devWs, mailboxId } = await world();
    expect(await ask(t, BOT, devWs, mailboxId)).toBe(devWs);
    expect(await ask(t, BOT, devWs, mailboxId)).toBe(devWs);
    const runs = await claim(t, devWs);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ workspaceId: devWs, path: PATH, mailboxId });
    const session = (await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: runs[0]!.accessToken }))) as { session: { clientId: string; actorUserId: string } | null };
    expect(session.session).toMatchObject({ clientId: TEXTS_CLIENT_ID, actorUserId: dev });
    // The texting token it replaced still works for the turn that holds it.
    expect(((await bodyOf(await gatewayPost(t, "/gateway/session", { accessToken: TEX }))) as { session: unknown }).session).not.toBeNull();
    expect(await claim(t, devWs)).toEqual([]);
  });

  test("Tex never wakes itself", async () => {
    const { t, devWs, mailboxId } = await world();
    expect(await ask(t, TEX, devWs, mailboxId)).toBeNull();
    expect(await claim(t, devWs)).toEqual([]);
  });

  test("a stranger, another note's path, or an unknown mailbox wakes nothing", async () => {
    const { t, devWs, mailboxId } = await world();
    expect(await ask(t, STRANGER, devWs, mailboxId)).toBeNull();
    expect(await ask(t, BOT, devWs, mailboxId, "other.md")).toBeNull();
    expect(await ask(t, BOT, devWs, "mb_0000000000000000")).toBeNull();
    expect(await claim(t, devWs)).toEqual([]);
  });

  test("a group chat's Tex and a job's mailbox are never woken", async () => {
    const { t, devWs, groupGrant } = await world();
    // A group chat's Tex reaches only its home, so its box is put in place here rather than joined.
    await t.run((ctx) => ctx.db.insert("noteMailboxes", { mailboxId: "mb_group000000000", grantId: groupGrant, workspaceId: devWs, path: "g.md", name: "tex", createdAt: Date.now() }));
    expect((await boxes(t, BOT, devWs, "g.md")).some((box) => box.texChat)).toBe(false);
    expect(await ask(t, BOT, devWs, "mb_group000000000", "g.md")).toBeNull();
    const job = (await bodyOf(await gatewayPost(t, "/gateway/mail/join", { accessToken: TEX, workspaceId: devWs, path: "j.md", name: "builder", jobId: "job_0000000001" }))) as { mailbox: { mailboxId: string } };
    expect(await ask(t, BOT, devWs, job.mailbox.mailboxId, "j.md")).toBeNull();
  });

  test("at most a handful of runs an hour for one mailbox", async () => {
    const { t, devWs, mailboxId } = await world();
    for (let i = 0; i < MAX_TEX_MAIL_RUNS_PER_HOUR; i += 1) {
      expect(await ask(t, BOT, devWs, mailboxId)).toBe(devWs);
      expect(await claim(t, devWs)).toHaveLength(1);
    }
    expect(await ask(t, BOT, devWs, mailboxId)).toBeNull();
  });

  test("a claim names a real owner or gets nothing", async () => {
    const { t } = await world();
    expect(await claim(t, "not-an-id")).toEqual([]);
  });
});
