import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  enableMailSync,
  endToEnd,
  googleAndBucket,
  patchConnection,
  readConnection,
  runPass,
} from "./fixtures.helpers";

/*
  A WRITE QUOTA THAT COUNTS REWRITES STOPS EMAIL FOR GOOD.

  `gmail.quotaBytes` is a lifetime ceiling and today's day note is rewritten
  on every pass that brings it mail, so counting the whole note each time
  spent the quota on the same bytes until a busy mailbox stopped with
  MAIL_QUOTA_EXCEEDED, a failure nothing ever lifted.
  `docs/decisions/communications/sync-recovery.md`, "Recovering without
  the owner".
*/

beforeEach(() => enableMailSync());

describe("the write quota counts what the bucket grew by", () => {
  const day = "inbox/email/person-at-example-invalid/2026/09/2026-09-08.md";
  const messages = [
    { id: "msg-1", date: "2026-09-08T09:14:00.000Z", subject: "Quarterly numbers", text: "The numbers are attached." },
    { id: "msg-2", date: "2026-09-08T11:02:00.000Z", subject: "Follow-up", text: "One more thing." },
  ];

  /*
    Sabotage: report the whole note's size from `writeDayPart` again, and
    the second pass counts the first message's bytes a second time.
  */
  test("rewriting a day counts its growth, not the whole day again", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: ["msg-1"], historyId: "1100" }, messages: messages.slice(0, 1) })
        .fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    const first = (await readConnection(t, connectionId)).syncBytesWritten ?? 0;
    const firstDay = new TextEncoder().encode(backend.snapshot()[day]!).byteLength;

    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: ["msg-2"], historyId: "1200" }, messages }).fetchImpl,
    );
    await runPass(t, workspaceId, connectionId);
    const second = (await readConnection(t, connectionId)).syncBytesWritten ?? 0;
    const secondDay = new TextEncoder().encode(backend.snapshot()[day]!).byteLength;

    expect(backend.snapshot()[day]).toContain("Follow-up");
    expect(second - first).toBe(secondDay - firstDay);
  });

  /*
    A counter from before growth was counted holds every rewrite since the
    account connected, and on a busy mailbox it reached the ceiling and
    stopped Gmail for good. Sabotage: read `syncBytesWritten` as it stands
    in `forwardSyncJob.ts` again and this pass is MAIL_QUOTA_EXCEEDED.
  */
  test("a counter kept the old way starts again rather than stopping the mailbox", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000", quotaBytes: 1_000_000 });
    await patchConnection(t, connectionId, { syncBytesWritten: 2_000_000 });
    vi.stubGlobal(
      "fetch",
      googleAndBucket({ backend, history: { messageIds: ["msg-1"], historyId: "1100" }, messages: messages.slice(0, 1) })
        .fetchImpl,
    );

    expect(await runPass(t, workspaceId, connectionId)).toMatchObject({ status: "synced" });
    const row = await readConnection(t, connectionId);
    expect(row.syncBytesBasis).toBe("growth");
    expect(row.syncBytesWritten).toBeLessThan(1_000_000);
    expect(row.syncBytesWritten).toBeGreaterThan(0);
  });
});
