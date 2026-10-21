import { beforeEach, describe, expect, test, vi } from "vitest";
import { FAKE_STORAGE } from "../fixtures.helpers";
import { readDocument } from "@context/collaboration";
import { S3Store } from "../../../mcp/src/store/s3.js";
import { withLogicalDelete } from "../../../mcp/src/store/logicalDelete.js";
import { isKeyedWorkspace } from "../../../mcp/src/store/idLayout.js";
import { gmailDayStore } from "../../functions/lib/filesFns/gmailDayStore";
import type { FileStore } from "../../functions/lib/fileOps";
import { enableMailSync, googleAndBucket, endToEnd, runPass } from "./fixtures.helpers";

/**
 * A Gmail day that has been opened is a collaboration document, and every
 * read of it is materialized from that document. A pass that rewrote only the
 * Markdown left the day frozen at whatever it held when it was first opened,
 * however much mail arrived after (production, 2026-10-19).
 *
 * SABOTAGE RECORD
 *   passing the plain store to the Gmail pass (no `gmailDayStore`) -> failed:
 *   the day read back held only "Quarterly numbers"
 *   passing no `reconcileDates` from the forward pass -> "a day that fell
 *   behind" failed: nothing rebuilt the day without new history
 *   returning a plain object of get/put/list/delete from `gmailDayStore` ->
 *   "keeps the store's seams" failed: a keyed workspace read as unkeyed
 */
describe("a Gmail day with a collaboration document", () => {
  beforeEach(() => enableMailSync());

  test("a later pass's mail reaches the day as it is read", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await t.run(async (ctx) => {
      const binding = (await ctx.db.query("storageBindings").first())!;
      await ctx.db.patch(binding._id, {
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      });
    });
    const first = { id: "msg-1", date: "2026-09-08T09:14:00.000Z", subject: "Quarterly numbers", text: "Attached." };
    const second = { id: "msg-2", date: "2026-09-08T15:40:00.000Z", subject: "Board follow-up", text: "Next steps." };
    vi.stubGlobal("fetch", googleAndBucket({ backend, history: { messageIds: ["msg-1"], historyId: "1100" }, messages: [first] }).fetchImpl);
    await runPass(t, workspaceId, connectionId);

    const store = withLogicalDelete(new S3Store({ ...FAKE_STORAGE, forcePathStyle: true, fetchImpl: backend.fetchImpl }));
    const path = "inbox/email/person-at-example-invalid/2026/09/2026-09-08.md";
    expect((await readDocument(store, path)).text).toContain("Quarterly numbers");

    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: ["msg-2"], historyId: "1200" }, messages: [first, second] }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    const day = (await readDocument(store, path)).text;
    expect(day).toContain("Quarterly numbers");
    expect(day).toContain("Board follow-up");
  });

  test("a day that fell behind catches up on a pass with no new history", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    await t.run(async (ctx) => {
      const binding = (await ctx.db.query("storageBindings").first())!;
      await ctx.db.patch(binding._id, {
        capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      });
    });
    // Yesterday, UTC: always inside the days a pass reconciles, whatever the hour.
    const date = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const first = { id: "msg-1", date: `${date}T10:00:00.000Z`, subject: "Quarterly numbers", text: "Attached." };
    const second = { id: "msg-2", date: `${date}T11:00:00.000Z`, subject: "Board follow-up", text: "Next steps." };
    vi.stubGlobal("fetch", googleAndBucket({ backend, history: { messageIds: ["msg-1"], historyId: "1100" }, messages: [first] }).fetchImpl);
    await runPass(t, workspaceId, connectionId);

    const store = withLogicalDelete(new S3Store({ ...FAKE_STORAGE, forcePathStyle: true, fetchImpl: backend.fetchImpl }));
    const path = `inbox/email/person-at-example-invalid/${date.slice(0, 4)}/${date.slice(5, 7)}/${date}.md`;
    expect((await readDocument(store, path)).text).toContain("Quarterly numbers");

    // msg-2's history was spent by a pass whose write was lost (before #1923):
    // the cursor is past it, so no history will ever name it again.
    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: [], historyId: "1200" }, messages: [first, second] }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    expect((await readDocument(store, path)).text).toContain("Board follow-up");
  });

  test("the day store keeps the store's seams", async () => {
    // Contact lookup asks the store it is handed whether the workspace is keyed; the
    // day store must answer as the store does, attached (non-enumerable) seams included.
    const base = {
      get: async () => null,
      put: async () => ({ etag: "e" }),
      list: async () => ({ objects: [], truncated: false }),
      delete: async () => undefined,
      capabilities: { conditionalWrite: true, conditionalCreate: true },
      keyedWorkspace: async () => true,
    } as unknown as FileStore;
    const attached = () => "attached";
    Object.defineProperty(base, "treeListing", { value: attached, enumerable: false });

    const days = gmailDayStore(base, "inbox/email/person");
    expect(await isKeyedWorkspace(days)).toBe(true);
    expect((days as unknown as { treeListing: unknown }).treeListing).toBe(attached);
  });
});
