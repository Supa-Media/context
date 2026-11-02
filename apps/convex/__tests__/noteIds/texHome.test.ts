/**
 * A new note made in a personal workspace's Tex folder is kept in Tex's
 * Durable Object (`lib/noteIds/texHome.ts`): the tree says so on lookup
 * (`texHomes`), and adopts the note only under that owner's Tex key.
 *
 * Sabotage, each confirmed to fail a case here: answer `texHomes` for a shared
 * workspace, or accept a Tex key outside the Tex folder.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { migrate, pinnedWorld, type PinnedWorld } from "../pinnedReaders.helpers";
import { idKeyFor } from "../../functions/lib/nodes/noteIds";
import { ensureCopyRow } from "../../functions/lib/noteIds/state";
import { createUser, createWorkspace, seedTreeRows } from "../fixtures.helpers";
import { tester, type T } from "./noteIds.helpers";

const NOTE = "0190a000-0000-7000-8000-0000000000aa";

async function keyed(t: T, ws: Id<"workspaces">) {
  await t.run(async (ctx) => {
    const layout = await ctx.db.query("noteIdLayout").first();
    if (layout === null) await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1, updatedBy: "test" });
    else await ctx.db.patch(layout._id, { mode: "keys" });
    const copies = await ensureCopyRow(ctx, ws);
    await ctx.db.patch(copies._id, { keyedAt: 1 });
  });
}

async function world(kind: "personal" | "shared") {
  const t = tester();
  const owner = await createUser(t, `tex-home-${kind}@example.com`);
  const ws = await createWorkspace(t, owner, `tex-home-${kind}`, { kind });
  await keyed(t, ws);
  // The Tex folder, made by a note in it.
  await seedTreeRows(t, ws, [{ path: "tex/about-me.md", etag: "e1" }, { path: "projects/plan.md", etag: "e2" }]);
  return { t, ws };
}

const adopt = (t: T, ws: Id<"workspaces">, path: string, key: string) =>
  t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, { workspaceId: ws, path, noteId: NOTE, key, etag: "e", at: 1 });

describe("where a new note is kept", () => {
  test("in a personal workspace, a path in the Tex folder with no note is kept in the person's object", async () => {
    const { t, ws } = await world("personal");
    const found = await t.query(internal.functions.noteIdsKeyed.notesFor, {
      workspaceId: ws,
      paths: ["tex/attention.md", "tex/routines/morning.md", "projects/new.md", "texas.md"],
    });
    expect(found.texHomes).toEqual([
      { path: "tex/attention.md", owner: `person:${ws}` },
      { path: "tex/routines/morning.md", owner: `person:${ws}` },
    ]);
  });

  test("a shared workspace keeps every note in its bucket", async () => {
    const { t, ws } = await world("shared");
    const found = await t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: ws, paths: ["tex/attention.md"] });
    expect(found.texHomes).toEqual([]);
  });

  test("a note in the Tex folder is adopted under its Tex key, and answered with it", async () => {
    const { t, ws } = await world("personal");
    const key = `tex/person:${ws}/${idKeyFor(NOTE, "tex/attention.md")}`;
    expect(await adopt(t, ws, "tex/attention.md", key)).toEqual({ adopted: true });
    const found = await t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: ws, paths: ["tex/attention.md"] });
    expect(found.notes[0]).toMatchObject({ state: "keyed", key, noteId: NOTE });
    expect(found.texHomes).toEqual([]);
  });

  test("a Tex key outside the Tex folder, or naming another owner, is refused", async () => {
    const { t, ws } = await world("personal");
    expect(await adopt(t, ws, "projects/new.md", `tex/person:${ws}/${idKeyFor(NOTE, "projects/new.md")}`)).toEqual({ adopted: false, taken: null });
    expect(await adopt(t, ws, "tex/attention.md", `tex/person:someone/${idKeyFor(NOTE, "tex/attention.md")}`)).toEqual({ adopted: false, taken: null });
    expect(await adopt(t, ws, "tex/attention.md", `tex/chat:c1/${idKeyFor(NOTE, "tex/attention.md")}`)).toEqual({ adopted: false, taken: null });
  });
});

/*
 * A group chat's home in the pinned workspace keeps its notes in that chat's object, under the chat's key. These
 * pin that a home answers only its own chat's key, and that no other workspace, path or name ever gets one.
 *
 * Sabotage, each confirmed to fail a case here: answer `chat:` owners for a shared workspace other than the pin, drop
 * the `take(2)` ambiguity check, or match the home by prefix alone.
 */
describe("a group chat's home in the pinned workspace", () => {
  const CHAT = "c".repeat(64);
  const OTHER = "d".repeat(64);
  const WORDS = "orbit-lamp-river";
  const HOME_NOTE = `tex/groups/${WORDS}/attention.md`;

  async function chatWorld(): Promise<PinnedWorld> {
    const w = await pinnedWorld();
    await migrate(w);
    await keyed(w.t, w.pinned);
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: CHAT, lastSeenAt: 1, homeWords: WORDS });
      await ctx.db.insert("textGroups", { groupKey: OTHER, lastSeenAt: 1, homeWords: "marsh-quiet-stone" });
    });
    return w;
  }

  const adoptIn = (w: PinnedWorld, path: string, key: string) =>
    w.t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, { workspaceId: w.pinned, path, noteId: NOTE, key, etag: "e", at: 1 });

  test("a note under a chat's home is kept in that chat's object, and the tree says so on lookup", async () => {
    const w = await chatWorld();
    const found = await w.t.query(internal.functions.noteIdsKeyed.notesFor, {
      workspaceId: w.pinned,
      paths: [HOME_NOTE, `tex/groups/${WORDS}`, "tex/groups/no-such-chat-here/x.md"],
    });
    expect(found.texHomes).toEqual([{ path: HOME_NOTE, owner: `chat:${CHAT}` }]);
  });

  test("it is adopted under its chat's key, and under no other key", async () => {
    const w = await chatWorld();
    const key = `tex/chat:${CHAT}/${idKeyFor(NOTE, HOME_NOTE)}`;
    expect(await adoptIn(w, HOME_NOTE, `tex/chat:${OTHER}/${idKeyFor(NOTE, HOME_NOTE)}`)).toEqual({ adopted: false, taken: null });
    expect(await adoptIn(w, HOME_NOTE, `tex/person:${w.pinned}/${idKeyFor(NOTE, HOME_NOTE)}`)).toEqual({ adopted: false, taken: null });
    expect(await adoptIn(w, HOME_NOTE, key)).toEqual({ adopted: true });
    const found = await w.t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: w.pinned, paths: [HOME_NOTE] });
    expect(found.notes[0]).toMatchObject({ state: "keyed", key, noteId: NOTE });
  });

  test("a home whose words name no chat, or two chats, keeps nothing in a chat's object", async () => {
    const w = await chatWorld();
    await w.t.run(async (ctx) => {
      await ctx.db.insert("textGroups", { groupKey: "e".repeat(64), lastSeenAt: 1, homeWords: WORDS });
    });
    const found = await w.t.query(internal.functions.noteIdsKeyed.notesFor, {
      workspaceId: w.pinned,
      paths: [HOME_NOTE, "tex/groups/no-such-chat-here/x.md"],
    });
    expect(found.texHomes).toEqual([]);
    expect(await adoptIn(w, HOME_NOTE, `tex/chat:${CHAT}/${idKeyFor(NOTE, HOME_NOTE)}`)).toEqual({ adopted: false, taken: null });
  });

  test("a folder of the same name in any other workspace never takes a chat's key", async () => {
    const w = await chatWorld();
    const owner = await createUser(w.t, "studio-owner@example.invalid");
    const studio = await createWorkspace(w.t, owner, "studio", { kind: "shared" });
    await keyed(w.t, studio);
    const found = await w.t.query(internal.functions.noteIdsKeyed.notesFor, { workspaceId: studio, paths: [HOME_NOTE] });
    expect(found.texHomes).toEqual([]);
    const refused = await w.t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, {
      workspaceId: studio,
      path: HOME_NOTE,
      noteId: NOTE,
      key: `tex/chat:${CHAT}/${idKeyFor(NOTE, HOME_NOTE)}`,
      etag: "e",
      at: 1,
    });
    expect(refused).toEqual({ adopted: false, taken: null });
  });
});
