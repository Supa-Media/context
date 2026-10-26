/**
 * The Messages backup's log read back for its owner's Download as folders
 * (`functions/messagesExport.ts`, `lib/messagesBackup/exportLog.ts`), through
 * `runFileOperation` against a bound bucket, as production runs it.
 *
 * Sabotage, each confirmed to fail a case here (2026-10-26):
 *  - drop the owner check in `readLogForExport`: a member reads the texts;
 *  - drop the prefix check on `after`: a page reads notes after a chosen key;
 *  - answer `next: null` after the first page: the second page is never read.
 */

import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { LOG_PAGE_OBJECTS, MESSAGES_LOG_PREFIX } from "../../functions/lib/messagesBackup/exportLog";
import { FAKE_STORAGE, addMember, asUser, createUser, createWorkspace, seedStorageBinding, setupTest, type TestConvex } from "../fixtures.helpers";
import { memoryS3 } from "../storeStub.helpers";
import { renderPrivacyManifest } from "../seededRules.helpers";

const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  vi.unstubAllGlobals();
});

const line = (id: string) => JSON.stringify({ v: 1, kind: "message", id, chat: "chat-ada", at: "2026-10-21T09:00:00.000Z", me: false, from: "+15550100", text: `words of ${id}`, service: "iMessage" });

async function backedUp(objects: number) {
  const t = setupTest();
  deployments.push(t);
  const ownerId = await createUser(t, "owner@example.invalid");
  const memberId = await createUser(t, "member@example.invalid");
  const workspaceId = await createWorkspace(t, ownerId, "texts-owner");
  await addMember(t, workspaceId, memberId, "member");
  const bucket = memoryS3(FAKE_STORAGE.bucket);
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  bucket.seed("notes/zz-after-the-log.md", "# Not a text\n");
  const keys: string[] = [];
  for (let n = 0; n < objects; n += 1) {
    const key = `${MESSAGES_LOG_PREFIX}2026/10/${String(1_760_000_000_000 + n).padStart(13, "0")}-aa.jsonl`;
    bucket.seed(key, `${line(`m-${n}`)}\n`);
    keys.push(key);
  }
  vi.stubGlobal("fetch", bucket.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: ownerId });
  return { workspaceId, keys, owner: asUser(t, ownerId), member: asUser(t, memberId) };
}

test("the owner reads the whole log, page after page, in arrival order", async () => {
  const f = await backedUp(LOG_PAGE_OBJECTS + 3);
  const first = await f.owner.action(api.functions.messagesExport.readLogForExport, { workspaceId: f.workspaceId });
  expect(first.objects.map((object) => object.key)).toEqual(f.keys.slice(0, LOG_PAGE_OBJECTS));
  expect(first.next).toBe(f.keys[LOG_PAGE_OBJECTS - 1]);
  const second = await f.owner.action(api.functions.messagesExport.readLogForExport, { workspaceId: f.workspaceId, after: first.next ?? undefined });
  expect(second.objects.map((object) => object.key)).toEqual(f.keys.slice(LOG_PAGE_OBJECTS));
  expect(second.objects[2].text).toContain("words of m-52");
  expect(second.next).toBeNull();
});

test("anyone but the owner is answered nothing", async () => {
  const f = await backedUp(2);
  expect(await f.member.action(api.functions.messagesExport.readLogForExport, { workspaceId: f.workspaceId })).toEqual({ objects: [], next: null });
});

test("a page never starts outside the log, wherever it is asked to", async () => {
  const f = await backedUp(2);
  for (const after of ["notes/", "", ".context/messages/imessage/files/"]) {
    const page = await f.owner.action(api.functions.messagesExport.readLogForExport, { workspaceId: f.workspaceId, after });
    expect(page.objects.every((object) => object.key.startsWith(MESSAGES_LOG_PREFIX))).toBe(true);
    expect(page.objects.some((object) => object.text.includes("Not a text"))).toBe(false);
  }
});
