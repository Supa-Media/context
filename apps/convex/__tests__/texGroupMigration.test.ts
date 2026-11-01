import { describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { carriedNotes } from "../functions/texGroupMigration";
import { createUser, createWorkspace } from "./fixtures.helpers";
import { migrate, pinnedWorld } from "./pinnedReaders.helpers";

/**
 * EVERY GROUP CHAT'S MEMORY LEAVES THE WORKSPACE FOLDERS (the owner, 2026-11-01; `functions/texGroupMigration.ts`).
 *
 *  - `homeEveryChat` makes a home for each chat that has none, in its sponsor's name, and a dry run writes nothing;
 *  - the sweep trashes only an old note a chat's record says it carried, in the workspace it was carried from, and
 *    never a note in the pin, a home's own note, or one no record names.
 *
 * Sabotage record:
 *   `homeEveryChat` making homes on a dry run → "a dry run makes nothing" fails
 *   `carriedNotes` naming every old note in a workspace → "a note no record names is never due" fails
 *   `carriedNotes` reading "default" as the pin → "never a note in the pin" fails
 */

vi.setConfig({ testTimeout: 60_000 });

describe("homes for every chat", () => {
  test("a chat with no home gets one in its sponsor's name; a dry run makes nothing, and only counts leave", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const ada = await createUser(w.t, "ada@example.invalid");
    await createWorkspace(w.t, ada, "ada", { kind: "personal" });
    const chatId = await w.t.run(async (ctx) => await ctx.db.insert("textGroups", { groupKey: "e".repeat(64), lastSeenAt: Date.now(), sponsorId: ada, reachPeople: [ada] }));
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: "f".repeat(64), lastSeenAt: Date.now() });
    });

    const dry = await w.t.mutation(internal.functions.texGroupMigrationRows.homeEveryChat, { dryRun: true });
    expect(dry).toEqual({ chats: 2, homed: 0, wouldHome: 1, made: 0, refused: { no_person: 1 } });
    expect((await w.t.run(async (ctx) => await ctx.db.get(chatId)))?.homeWords).toBeUndefined();

    const real = await w.t.mutation(internal.functions.texGroupMigrationRows.homeEveryChat, { dryRun: false });
    expect(real).toEqual({ chats: 2, homed: 0, wouldHome: 1, made: 1, refused: { no_person: 1 } });
    const chat = await w.t.run(async (ctx) => await ctx.db.get(chatId));
    expect(chat?.homeWords).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
    expect(chat?.homeUsers).toEqual([ada]);
    expect(JSON.stringify(real)).not.toMatch(/eeee|tex\/groups|@/);

    expect(await w.t.mutation(internal.functions.texGroupMigrationRows.homeEveryChat, { dryRun: false })).toEqual({ chats: 2, homed: 1, wouldHome: 0, made: 0, refused: { no_person: 1 } });
  });
});

describe("which old notes the sweep trashes", () => {
  const studio = "ws_studio" as Id<"workspaces">;
  const pin = "ws_pin" as Id<"workspaces">;
  const plan = {
    pin,
    chats: [
      { groupKey: "a".repeat(64), bound: studio, homed: true },
      { groupKey: "b".repeat(64), bound: null, homed: false },
    ],
    workspaces: [{ id: studio, slug: "studio", paths: ["tex/groups/chat-111111111111.md", "tex/groups/voice-111111111111.md", "tex/groups/chat-222222222222.md"] }],
  };

  test("a carried note is due in the workspace it came from, with its voice note when the chat has a home", () => {
    const due = carriedNotes(plan, new Map([["a".repeat(64), [{ where: "default", path: "tex/groups/chat-111111111111.md" }]]]));
    expect([...due].sort()).toEqual([`${studio} tex/groups/chat-111111111111.md`, `${studio} tex/groups/voice-111111111111.md`]);
    // The same, named by slug.
    expect(carriedNotes(plan, new Map([["a".repeat(64), [{ where: "@studio", path: "tex/groups/chat-111111111111.md" }]]])).size).toBe(2);
  });

  test("a note no record names is never due", () => {
    expect(carriedNotes(plan, new Map()).size).toBe(0);
    const due = carriedNotes(plan, new Map([["a".repeat(64), [{ where: "default", path: "tex/groups/chat-111111111111.md" }]]]));
    expect(due.has(`${studio} tex/groups/chat-222222222222.md`)).toBe(false);
  });

  test("never a note in the pin, a home's own note, or a path that is not an old memory note", () => {
    const homeless = new Map([["b".repeat(64), [{ where: "default", path: "tex/groups/chat-222222222222.md" }]]]);
    expect(carriedNotes(plan, homeless).size).toBe(0);
    const odd = new Map([
      ["a".repeat(64), [
        { where: "home", path: "tex/groups/orbit-lamp-river/chat-111111111111.md" },
        { where: "default", path: "1-projects/setlist.md" },
        { where: "@nowhere", path: "tex/groups/chat-111111111111.md" },
        { where: "default", path: "tex/groups/voice-111111111111.md" },
      ]],
    ]);
    expect(carriedNotes(plan, odd).size).toBe(0);
    const pinned = { ...plan, chats: [{ groupKey: "a".repeat(64), bound: pin, homed: true }] };
    expect(carriedNotes(pinned, new Map([["a".repeat(64), [{ where: "default", path: "tex/groups/chat-111111111111.md" }]]])).size).toBe(0);
  });

  test("the sweep with no record carried trashes nothing and counts what it left", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const answer = await w.t.action(internal.functions.texGroupMigration.sweep, { dryRun: false });
    expect(answer).toMatchObject({ trashed: 0, wouldTrash: 0 });
  });
});
