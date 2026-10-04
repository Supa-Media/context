/**
 * `/gateway/site` `history` — AN OWNER'S OR EDITOR'S AGENT CAN SEE THE KEPT
 * VERSIONS OF A SITE AND GET AN OLD ONE'S FILES BACK, AND NOTHING THAT IS
 * WITHHELD NOW.
 *
 * Decided by the owner, 2026-10-03 ("Keep last 5"). Rolling back is the agent
 * writing old files into `website/` as a draft, so this only hands them over:
 *
 *  1. A member's, a stranger's and a forged token's call gets the bare `null`.
 *  2. The list names each kept version newest first, and which one is live.
 *  3. A version hands back its files' words as published then, a deleted page
 *     included, and names the pages added since.
 *  4. A page `privacy.md` holds back now is counted and never handed back,
 *     even while its copies are still in the bucket.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { addMember, createUser, gatewayPost } from "../fixtures.helpers";
import { fixture, publish } from "../website.helpers";
import { bodyOf, registerClient, seedConnectedClient, token } from "./fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EDITOR = token("history_editor");
const MEMBER = token("history_member");
const STRANGER = token("history_stranger");
const CLIENT = "mcp_client_history";

async function historyFixture() {
  vi.stubEnv("APP_ORIGIN", "https://context.lc");
  const f = await fixture();
  const editor = await createUser(f.t, "atlas-editor@example.invalid");
  await addMember(f.t, f.workspaceId, editor, "editor", f.owner);
  f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nFirst home\n");
  f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nFirst about\n");
  await publish(f);

  await registerClient(f.t, CLIENT);
  const grant = (userId: typeof f.owner, accessToken: string, scopes: string[], workspaceId = f.workspaceId) =>
    seedConnectedClient(f.t, { workspaceId, userId, clientId: CLIENT, accessToken, scopes });
  await grant(editor, EDITOR, ["context:read", "context:write"]);
  await grant(f.member, MEMBER, ["context:read", "context:write"]);
  const elsewhere = await f.t.run(async (ctx) =>
    (await ctx.db.query("workspaces").collect()).find((w) => w.slug === "atlas-elsewhere")!._id,
  );
  await grant(f.stranger, STRANGER, ["context:read", "context:write", "context:private"], elsewhere);
  return f;
}

type History = {
  versions: Array<{ revision: number; publishedAt: number; pages: number; live: boolean }>;
  version: null | {
    revision: number;
    files: Array<{ path: string; text: string }>;
    more: string[];
    withheld: number;
    addedSince: string[];
  };
  message?: string;
};

async function site(f: Awaited<ReturnType<typeof historyFixture>>, accessToken: string, body: Record<string, unknown>) {
  const response = await gatewayPost(f.t, "/gateway/site", {
    accessToken,
    expectedWorkspaceId: f.workspaceId,
    ...body,
  });
  expect(response.status).toBe(200);
  return (await bodyOf(response)).site as (History & Record<string, unknown>) | null;
}

async function publishAgain(f: Awaited<ReturnType<typeof historyFixture>>) {
  await f.t.action(internal.functions.websites.reconcileWorkspace, { workspaceId: f.workspaceId, publish: true });
}

describe("/gateway/site history", () => {
  test("a member, a stranger and a forged token get the bare null", async () => {
    const f = await historyFixture();
    for (const accessToken of [MEMBER, STRANGER, token("history_forged")]) {
      expect(await site(f, accessToken, { action: "history" })).toBeNull();
      expect(await site(f, accessToken, { action: "history", revision: 1 })).toBeNull();
    }
  });

  test("lists the kept versions newest first, and which is live", async () => {
    const f = await historyFixture();
    f.backend.seed("website/about.md", "---\ntitle: About\nnav: 2\n---\n\nSecond about\n");
    await publishAgain(f);
    const history = await site(f, EDITOR, { action: "history" });
    expect(history!.version).toBeNull();
    expect(history!.versions.length).toBe(2);
    const [newest, older] = history!.versions;
    expect(newest!.revision).toBeGreaterThan(older!.revision);
    expect([newest!.live, older!.live]).toEqual([true, false]);
    expect(newest!.pages).toBe(2);
  });

  test("a version hands back its words, a deleted page included, and names pages added since", async () => {
    const f = await historyFixture();
    const first = (await site(f, EDITOR, { action: "history" }))!.versions[0]!.revision;
    f.backend.seed("website/index.md", "---\ntitle: Home\nnav: 1\n---\n\nSecond home\n");
    f.backend.objects.delete("website/about.md");
    f.backend.seed("website/new.md", "---\ntitle: New\n---\n\nNew page\n");
    await publishAgain(f);

    const old = await site(f, EDITOR, { action: "history", revision: first });
    expect(old!.version!.revision).toBe(first);
    expect(old!.version!.files).toEqual([
      { path: "website/about.md", text: "---\ntitle: About\nnav: 2\n---\n\nFirst about\n" },
      { path: "website/index.md", text: "---\ntitle: Home\nnav: 1\n---\n\nFirst home\n" },
    ]);
    expect(old!.version!.addedSince).toEqual(["website/new.md"]);
    expect(old!.version!.withheld).toBe(0);

    const one = await site(f, EDITOR, { action: "history", revision: first, path: "website/index.md" });
    expect(one!.version!.files.map((file) => file.path)).toEqual(["website/index.md"]);
  });

  test("a page held back now is counted, never handed back, even before its copies are wiped", async () => {
    const f = await historyFixture();
    const first = (await site(f, EDITOR, { action: "history" }))!.versions[0]!.revision;
    // Written straight into the bucket, as another app would: no scan has run,
    // so the copies are still there and only the read-time check stands.
    const manifest = f.backend.snapshot()[PRIVACY_KEY]!;
    const narrowed = manifest.replace(/^(\s*)website: team\s*$/m, "$1website: private");
    expect(narrowed).not.toBe(manifest);
    f.backend.seed(PRIVACY_KEY, narrowed);

    const old = await site(f, EDITOR, { action: "history", revision: first });
    expect(old!.version!.files).toEqual([]);
    expect(old!.version!.withheld).toBe(2);
    expect(JSON.stringify(old)).not.toContain("First about");
  });

  test("an unknown revision is named in a message", async () => {
    const f = await historyFixture();
    const answer = await site(f, EDITOR, { action: "history", revision: 999 });
    expect(answer!.version).toBeNull();
    expect(answer!.message).toMatch(/999 is not one of the kept versions/);
  });
});
