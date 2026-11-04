import { describe, expect, test } from "vitest";
import { gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_A_SIBLING, ACCESS_B, bodyOf, token, twoConnectedTenants } from "../controlPlane/fixtures.helpers";

type Mailbox = { mailboxId: string; workspaceId: string; path: string; name: string; readThrough: string | null };
type Joined = { mailbox?: Mailbox; error?: string };

async function join(t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"], accessToken: string, body: Record<string, unknown>) {
  return (await bodyOf(await gatewayPost(t, "/gateway/mail/join", { accessToken, ...body }))) as Joined;
}
async function jobs(t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"], accessToken: string, workspaceId: string, path: string) {
  return ((await bodyOf(await gatewayPost(t, "/gateway/mail/jobs", { accessToken, workspaceId, path }))) as {
    mailboxes: Array<{ mailboxId: string; name: string; jobId: string; own: boolean }>;
  }).mailboxes;
}
async function get(t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"], accessToken: string, mailboxId: string) {
  return ((await bodyOf(await gatewayPost(t, "/gateway/mail/get", { accessToken, mailboxId }))) as { mailbox: Mailbox | null }).mailbox;
}

describe("note mail mailboxes", () => {
  test("joining returns a mailbox its own grant can read back, and rejoining returns the same one", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const first = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "1-projects/launch.md", name: "builder" });
    expect(first.mailbox?.mailboxId).toMatch(/^mb_[a-f0-9]{16}$/);
    expect(first.mailbox?.name).toBe("builder");
    expect(first.mailbox?.readThrough).toBeTruthy();
    const again = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "1-projects/launch.md", name: "builder" });
    expect(again.mailbox?.mailboxId).toBe(first.mailbox?.mailboxId);
    expect(await get(t, ACCESS_A, first.mailbox!.mailboxId)).toEqual(first.mailbox);
  });

  test("jobMailboxes says which jobs the presenting grant itself joined as, so only a job's own Tex interrupts it", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "own.md", name: "builder", jobId: "job_0000000009" });
    expect((await jobs(t, ACCESS_A, aliceWs, "own.md")).map((box) => box.own)).toEqual([true]);
    expect((await jobs(t, ACCESS_A_SIBLING, aliceWs, "own.md")).map((box) => box.own)).toEqual([false]);
  });

  test("another connection cannot use a mailbox id, even the same person's", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const { mailbox } = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead" });
    expect(await get(t, ACCESS_A_SIBLING, mailbox!.mailboxId)).toBeNull();
    expect(await get(t, ACCESS_B, mailbox!.mailboxId)).toBeNull();
    expect(await get(t, token("nobody"), mailbox!.mailboxId)).toBeNull();
  });

  test("a name another connection holds on that note is taken; on another note it is free", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead" });
    expect(await join(t, ACCESS_A_SIBLING, { workspaceId: aliceWs, path: "n.md", name: "lead" })).toEqual({ error: "name_taken" });
    expect((await join(t, ACCESS_A_SIBLING, { workspaceId: aliceWs, path: "other.md", name: "lead" })).mailbox).toBeDefined();
  });

  test("a workspace the grant does not reach is refused the same as a bad name", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    expect(await join(t, ACCESS_A, { workspaceId: bobWs, path: "n.md", name: "lead" })).toEqual({ error: "refused" });
    expect(await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "everyone" })).toEqual({ error: "refused" });
    expect(await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "Bad Name" })).toEqual({ error: "refused" });
    expect(await join(t, token("nobody"), { workspaceId: aliceWs, path: "n.md", name: "lead" })).toEqual({ error: "refused" });
  });

  test("the read mark only moves forward, and only for its own grant", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const { mailbox } = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead" });
    const later = new Date(Date.now() + 60_000).toISOString();
    await gatewayPost(t, "/gateway/mail/read", { accessToken: ACCESS_A, mailboxId: mailbox!.mailboxId, readThrough: later });
    expect((await get(t, ACCESS_A, mailbox!.mailboxId))?.readThrough).toBe(later);
    await gatewayPost(t, "/gateway/mail/read", { accessToken: ACCESS_A, mailboxId: mailbox!.mailboxId, readThrough: "2020-01-01T00:00:00.000Z" });
    expect((await get(t, ACCESS_A, mailbox!.mailboxId))?.readThrough).toBe(later);
    const evenLater = new Date(Date.now() + 120_000).toISOString();
    await gatewayPost(t, "/gateway/mail/read", { accessToken: ACCESS_A_SIBLING, mailboxId: mailbox!.mailboxId, readThrough: evenLater });
    expect((await get(t, ACCESS_A, mailbox!.mailboxId))?.readThrough).toBe(later);
  });

  test("a job id is stored on join and is listed by jobMailboxes for its path only", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const bound = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "p.md", name: "builder", jobId: "job_0000000001" });
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "p.md", name: "plain" });
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "q.md", name: "builder", jobId: "job_0000000002" });
    expect(await jobs(t, ACCESS_A_SIBLING, aliceWs, "p.md")).toEqual([
      { mailboxId: bound.mailbox!.mailboxId, name: "builder", jobId: "job_0000000001", own: false },
    ]);
    expect(await jobs(t, ACCESS_A_SIBLING, aliceWs, "q.md")).toEqual([
      expect.objectContaining({ name: "builder", jobId: "job_0000000002" }),
    ]);
    expect(await jobs(t, ACCESS_A_SIBLING, aliceWs, "empty.md")).toEqual([]);
  });

  test("rejoining with a job id re-binds the mailbox; rejoining without one keeps the binding", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const { mailbox } = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead", jobId: "job_aaaaaaaa" });
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead", jobId: "job_bbbbbbbb" });
    expect(await jobs(t, ACCESS_A, aliceWs, "n.md")).toEqual([
      { mailboxId: mailbox!.mailboxId, name: "lead", jobId: "job_bbbbbbbb", own: true },
    ]);
    const kept = await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead" });
    expect(kept.mailbox?.mailboxId).toBe(mailbox!.mailboxId);
    expect(await jobs(t, ACCESS_A, aliceWs, "n.md")).toEqual([
      { mailboxId: mailbox!.mailboxId, name: "lead", jobId: "job_bbbbbbbb", own: true },
    ]);
  });

  test("a malformed job id is refused, whether the join is new or a rejoin", async () => {
    const { t, aliceWs } = await twoConnectedTenants();
    const base = { workspaceId: aliceWs, path: "n.md", name: "lead" };
    expect(await join(t, ACCESS_A, { ...base, jobId: "short" })).toEqual({ error: "refused" });
    expect(await join(t, ACCESS_A, { ...base, jobId: "has space in it" })).toEqual({ error: "refused" });
    expect(await join(t, ACCESS_A, { ...base, jobId: "x".repeat(65) })).toEqual({ error: "refused" });
    expect(await join(t, ACCESS_A, { ...base, jobId: 12345678 })).toEqual({ error: "refused" });
    expect(await jobs(t, ACCESS_A, aliceWs, "n.md")).toEqual([]);
    const { mailbox } = await join(t, ACCESS_A, { ...base, jobId: "job_cccccccc" });
    expect(await join(t, ACCESS_A, { ...base, jobId: "bad/id!!" })).toEqual({ error: "refused" });
    expect(await jobs(t, ACCESS_A, aliceWs, "n.md")).toEqual([
      { mailboxId: mailbox!.mailboxId, name: "lead", jobId: "job_cccccccc", own: true },
    ]);
  });

  test("a grant that does not reach the workspace lists nothing", async () => {
    const { t, aliceWs, bobWs } = await twoConnectedTenants();
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead", jobId: "job_dddddddd" });
    expect(await jobs(t, ACCESS_B, aliceWs, "n.md")).toEqual([]);
    expect(await jobs(t, token("nobody"), aliceWs, "n.md")).toEqual([]);
    expect(await jobs(t, ACCESS_B, bobWs, "n.md")).toEqual([]);
  });

  test("a mailbox whose grant has been revoked is not listed", async () => {
    const { t, aliceWs, grantA } = await twoConnectedTenants();
    await join(t, ACCESS_A, { workspaceId: aliceWs, path: "n.md", name: "lead", jobId: "job_eeeeeeee" });
    expect(await jobs(t, ACCESS_A_SIBLING, aliceWs, "n.md")).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(grantA, { status: "revoked" }));
    expect(await jobs(t, ACCESS_A_SIBLING, aliceWs, "n.md")).toEqual([]);
  });
});
