import { describe, expect, test } from "vitest";
import { gatewayPost } from "../fixtures.helpers";
import { ACCESS_A, ACCESS_A_SIBLING, ACCESS_B, bodyOf, token, twoConnectedTenants } from "../controlPlane/fixtures.helpers";

type Mailbox = { mailboxId: string; workspaceId: string; path: string; name: string; readThrough: string | null };
type Joined = { mailbox?: Mailbox; error?: string };

async function join(t: Awaited<ReturnType<typeof twoConnectedTenants>>["t"], accessToken: string, body: Record<string, unknown>) {
  return (await bodyOf(await gatewayPost(t, "/gateway/mail/join", { accessToken, ...body }))) as Joined;
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
});
