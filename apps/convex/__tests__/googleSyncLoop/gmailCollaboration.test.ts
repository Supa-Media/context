import { beforeEach, describe, expect, test, vi } from "vitest";
import { FAKE_STORAGE } from "../fixtures.helpers";
import { readDocument } from "@context/collaboration";
import { S3Store } from "../../../mcp/src/store/s3.js";
import { withLogicalDelete } from "../../../mcp/src/store/logicalDelete.js";
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
    const path = "0-inbox/email/person-at-example-invalid/2026/09/2026-09-08.md";
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
});
