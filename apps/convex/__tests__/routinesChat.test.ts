/**
 * A shared workspace's chat routine (decided by the owner, 2026-10-27;
 * `functions/lib/routines/chats.ts`,
 * `docs/decisions/texting-assistant/chat-routines.md`).
 *
 * A routine in a shared workspace runs only when its `chat:` names a group
 * chat bound to that workspace now, not muted and not in guest mode. Its run
 * names the chat's key and its writer's phone, and carries no grant: the
 * chat's own turn mints one.
 *
 * Sabotage record (2026-10-27), each fails a test here:
 *  - `routineChat` ignoring `workspaceId`: "a chat bound to another workspace
 *    is no chat";
 *  - `routineChat` ignoring `mutedAt` / `guestGroupId`: "a muted chat, or a
 *    guest chat, is no chat";
 *  - `runsRoutine` true for every shared routine: "one with no chat still
 *    never runs".
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { createWorkspace } from "./fixtures.helpers";
import { due, linkPhone, makeDue, routineFixture, rowAt, signal, type RoutineFixture } from "./routines.helpers";

const KEY = "ab".repeat(32);
const ID = KEY.slice(0, 16);
const PATH = "tex/routines/daily/shifts.md";
const PHONE = "+15555550103";
const text = (chat: string | null) => `---\nat: 8:00 am\n${chat ? `chat: ${chat}\n` : ""}---\nPost who is on shift today.\n`;

async function bindChat(f: RoutineFixture, fields: { workspaceId?: Id<"workspaces">; mutedAt?: number; guest?: boolean } = {}) {
  return await f.t.run(async (ctx) => {
    const workspaceId = fields.workspaceId ?? f.workspaceId;
    const guestGroupId = fields.guest
      ? await ctx.db.insert("workspaceGroups", { workspaceId, name: "blue-fox-tide", createdBy: f.owner, createdAt: Date.now() } as never)
      : undefined;
    return await ctx.db.insert("textGroups", {
      groupKey: KEY,
      workspaceId,
      boundBy: f.owner,
      lastSeenAt: Date.now(),
      ...(fields.mutedAt !== undefined ? { mutedAt: fields.mutedAt } : {}),
      ...(guestGroupId !== undefined ? { guestGroupId, guestFolder: "tex/chats/blue-fox-tide" } : {}),
    });
  });
}

async function chatRoutine(f: RoutineFixture, chat: string | null = ID) {
  f.backend.seed(PATH, text(chat));
  await signal(f.t, { workspaceId: f.workspaceId, userId: f.editor, paths: [PATH] });
}

describe("a shared workspace's chat routine", () => {
  test("runs into its chat as its writer, with no grant of its own", async () => {
    const f = await routineFixture({ kind: "shared" });
    await linkPhone(f.t, f.editor, PHONE);
    await bindChat(f);
    await chatRoutine(f);
    expect((await rowAt(f.t, f.workspaceId, PATH))?.chat).toBe(ID);
    await makeDue(f.t, f.workspaceId, PATH);
    const runs = await due(f.t);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ path: PATH, phones: [PHONE], chat: KEY });
    expect(runs[0]!.accessToken).toBeUndefined();
    const grants = await f.t.run((ctx) => ctx.db.query("oauthGrants").collect());
    expect(grants.filter((grant) => grant.clientId === "context_routines")).toEqual([]);
  });

  test("one with no chat still never runs", async () => {
    const f = await routineFixture({ kind: "shared" });
    await linkPhone(f.t, f.editor, PHONE);
    await bindChat(f);
    await chatRoutine(f, null);
    expect(await rowAt(f.t, f.workspaceId, PATH)).toBeNull();
  });

  test("a chat bound to another workspace is no chat", async () => {
    const f = await routineFixture({ kind: "shared" });
    await linkPhone(f.t, f.editor, PHONE);
    const elsewhere = await createWorkspace(f.t, f.owner, "elsewhere", { kind: "shared" });
    await bindChat(f, { workspaceId: elsewhere });
    await chatRoutine(f);
    await makeDue(f.t, f.workspaceId, PATH);
    expect(await due(f.t)).toEqual([]);
    const row = await rowAt(f.t, f.workspaceId, PATH);
    expect(row?.lastOutcome).toBe("no_chat");
    expect(row?.nextRunAt).toBeGreaterThan(Date.now());
  });

  test("a muted chat, or a guest chat, is no chat", async () => {
    for (const fields of [{ mutedAt: Date.now() }, { guest: true }]) {
      const f = await routineFixture({ kind: "shared" });
      await linkPhone(f.t, f.editor, PHONE);
      await bindChat(f, fields);
      await chatRoutine(f);
      await makeDue(f.t, f.workspaceId, PATH);
      expect(await due(f.t)).toEqual([]);
      expect((await rowAt(f.t, f.workspaceId, PATH))?.lastOutcome).toBe("no_chat");
    }
  });

  test("a writer with no phone runs nothing", async () => {
    const f = await routineFixture({ kind: "shared" });
    await bindChat(f);
    await chatRoutine(f);
    await makeDue(f.t, f.workspaceId, PATH);
    expect(await due(f.t)).toEqual([]);
    expect((await rowAt(f.t, f.workspaceId, PATH))?.lastOutcome).toBe("no_chat");
  });

  test("a personal workspace's routine ignores chat: and texts its writer", async () => {
    const f = await routineFixture();
    await linkPhone(f.t, f.editor, PHONE);
    await bindChat(f);
    await chatRoutine(f);
    expect((await rowAt(f.t, f.workspaceId, PATH))?.chat).toBeUndefined();
    await makeDue(f.t, f.workspaceId, PATH);
    const [run] = await due(f.t);
    expect(run).toMatchObject({ phones: [PHONE] });
    expect(run!.accessToken).toMatch(/^cat_/);
    expect((run as Record<string, unknown>).chat).toBeUndefined();
  });
});
