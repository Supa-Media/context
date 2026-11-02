/**
 * GROUP TEX'S CHAT HOMES ARE SEALED FROM THE PEOPLE WHO RUN THE PINNED WORKSPACE (decided by the owner, 2026-10-31;
 * `docs/decisions/texting-assistant/chat-homes.md`, `functions/lib/nodes/sealedChats.ts`).
 *
 * A chat's home is `tex/groups/<words>/` in `@context-lc`. The claims, each through the path a real caller takes:
 *
 *  - **An owner of the pinned workspace cannot reach a chat**: not its body, not its name in the listing, not a
 *    search hit, not a write over it or beside it, not its trash, not the audit trail's line about it.
 *  - **An owner cannot change it either**: no access setting at or beneath the homes folder, and no move, rename or
 *    trash of `tex`, the homes folder or a home.
 *  - **The people named on a home read and write it**, through Shared with me as any outsider does, and through the
 *    names a clearance holds.
 *  - **Only a person opens a home**: a `members`, `accounts` or group grant beneath the folder reaches nobody.
 *
 * Every value here is fake. This repository is public.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `canSee` answering `private` scope before the sealed check (`lib/privacy.ts`). → "an owner cannot read" fails.
 *  2. `withSealedChats` returning the rows as they are (`lib/nodes/sealedChats.ts`). → every owner test fails.
 *  3. `withSealedChats` keeping a `members` grant beneath the folder. → "only a person opens a home" fails.
 *  4. `setAccessRow` without the `sealedChange` guard (`lib/nodes/setAccess.ts`). → "no access setting" fails.
 *  5. `applyRowMove` without `chatHomesMoveRefused` (`lib/nodes/rowMove.ts`). → "no move" fails.
 *  6. `listTrash` skipping the rules for an owner (`functions/trash.ts`). → "not its trash" fails.
 *  7. `listEvents` without the chat homes skip (`functions/audit.ts`). → "nor the audit trail's line" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { setAccessRow, type GranteeInput } from "../functions/lib/nodes/setAccess";
import { applyRowMove, chainAt, standFolders } from "../functions/lib/nodes/rowMove";
import { nodeAt } from "../functions/lib/nodes/paths";
import { CHAT_HOMES_CLIENT_ID, chatHomesMoveRefused } from "../functions/lib/nodes/sealedChats";
import { visibleGrantedPaths } from "../functions/lib/grants/outsider";
import { recordAudit } from "../functions/lib/audit";
import { READS_AS_GUEST_NAME } from "../functions/lib/pinnedReaders";
import { asUser, captureError, errorCode } from "./fixtures.helpers";
import { indexBucket } from "./blendedSearch.helpers";
import { WORD, clearanceOf, migrate, pinnedWorld, type PinnedWorld } from "./pinnedReaders.helpers";

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const HOME = "tex/groups/orbit-lamp";
const NOTE = `${HOME}/transcripts/2026-10-30.md`;
const ABOUT = `${HOME}/about-us.md`;

/** The home's folders, and its people named on it, as the chat homes' client makes them. */
async function makeHome(w: PinnedWorld, grantees: GranteeInput[]): Promise<string> {
  await w.t.run(async (ctx) => {
    const m = ctx as unknown as MutationCtx;
    await standFolders(m, w.pinned, await chainAt(ctx.db, w.pinned, `${HOME}/x`), Date.now());
    const answer = await setAccessRow(m, {
      workspaceId: w.pinned,
      path: HOME,
      base: "private",
      grantees,
      actor: { userId: w.staff, role: "owner", clientId: CHAT_HOMES_CLIENT_ID },
    });
    if (!answer.ok) throw new Error(`home refused: ${answer.code}`);
  });
  const row = await w.t.run(async (ctx) => await nodeAt(ctx.db, w.pinned, HOME));
  return row!.noteId!;
}

/** A clearance holding the home's names, as the chat's own turn holds them. */
function chatNames(noteId: string): string[] {
  return [READS_AS_GUEST_NAME, `#${noteId}`, `#${noteId}!edit`];
}

async function op(w: PinnedWorld, scope: "private" | "team", grantedNames: string[], operation: Record<string, unknown>) {
  return await w.t.action(internal.functions.files.runFileOperation, {
    workspaceId: w.pinned,
    scope,
    grantedNames,
    operation: operation as never,
  });
}

/** A world with a home for Sayo, and a transcript and an about note written in it by the chat. */
async function homeWorld(): Promise<PinnedWorld & { home: string }> {
  const w = await pinnedWorld();
  await migrate(w);
  const home = await makeHome(w, [{ kind: "user", userId: w.sayo, role: "edit" }]);
  for (const path of [NOTE, ABOUT]) await op(w, "team", chatNames(home), { kind: "write", path, text: `# Chat\n\n${WORD}\n` });
  return { ...w, home };
}

describe("an owner of the pinned workspace", () => {
  test("cannot read a chat's note, and is told it does not exist", async () => {
    const w = await homeWorld();
    const staff = await clearanceOf(w, w.staff);
    expect(staff.scope).toBe("private");
    for (const path of [NOTE, ABOUT]) {
      expect(errorCode(await captureError(() => op(w, staff.scope, staff.grantedNames, { kind: "read", path }))), path).toBe("FILE_NOT_FOUND");
    }
    const seen = await op(w, staff.scope, staff.grantedNames, { kind: "visiblePaths", paths: [NOTE, ABOUT, HOME, "tex/groups", "tex"] });
    expect(seen.kind === "visiblePaths" ? seen.paths : null).toEqual(["tex"]);
  });

  test("does not see the homes in the listing", async () => {
    const w = await homeWorld();
    const staff = asUser(w.t, w.staff);
    const tex = await staff.query(api.functions.nodesListing.listFolder, { workspaceId: w.pinned, path: "tex" });
    expect((tex?.entries ?? []).map((entry) => entry.name)).toEqual([]);
    const groups = await staff.query(api.functions.nodesListing.listFolder, { workspaceId: w.pinned, path: "tex/groups" });
    expect((groups?.entries ?? []).map((entry) => entry.name)).toEqual([]);
  });

  test("finds nothing of a chat in search, from the same index that answers the chat", async () => {
    const w = await homeWorld();
    await indexBucket(w.t, w.pinned);
    const staff = await clearanceOf(w, w.staff);
    const search = async (scope: "private" | "team", names: string[]) => {
      const found = await op(w, scope, names, { kind: "search", query: WORD, refreshOnMiss: true });
      return found.kind === "searchResults" ? found.hits.map((hit) => hit.path) : [];
    };
    const theirs = await search(staff.scope, staff.grantedNames);
    expect(theirs.length).toBeGreaterThan(0);
    for (const path of theirs) expect(path.startsWith("tex/")).toBe(false);
    expect(await search("team", chatNames(w.home))).toEqual(expect.arrayContaining([NOTE]));
  });

  test("cannot write over a chat's note, or a new one beside it", async () => {
    const w = await homeWorld();
    const staff = await clearanceOf(w, w.staff);
    for (const path of [NOTE, `${HOME}/planted.md`, "tex/groups/planted.md"]) {
      const refused = await captureError(() => op(w, staff.scope, staff.grantedNames, { kind: "write", path, text: "# mine\n" }));
      expect(errorCode(refused), path).toBe("FILE_NOT_FOUND");
    }
  });

  test("cannot set access at or beneath the homes folder", async () => {
    const w = await homeWorld();
    for (const path of ["tex/groups", HOME, NOTE]) {
      const answer = await w.t.run(async (ctx) =>
        await setAccessRow(ctx as unknown as MutationCtx, {
          workspaceId: w.pinned,
          path,
          base: "team",
          grantees: [{ kind: "user", userId: w.staff, role: "edit" }],
          actor: { userId: w.staff, role: "owner" },
        }),
      );
      expect(answer, path).toEqual({ ok: false, code: "FORBIDDEN" });
    }
  });

  test("cannot move, rename or trash tex, the homes folder or a home", async () => {
    const w = await homeWorld();
    const staff = await clearanceOf(w, w.staff);
    for (const [from, to] of [["tex", "tex2"], ["tex/groups", "areas/groups"], [HOME, "areas/orbit-lamp"]] as const) {
      const moved = await captureError(() => op(w, staff.scope, staff.grantedNames, { kind: "move", from, to }));
      expect(moved, `${from} -> ${to}`).toBeDefined();
      const trashed = await captureError(() => op(w, staff.scope, staff.grantedNames, { kind: "trash", path: from }));
      expect(trashed, `trash ${from}`).toBeDefined();
    }
    // And the row move itself, as a job inside the control plane would make it, refuses the same.
    for (const [from, to, trash] of [["tex", "tex2", false], ["tex/groups", "areas/groups", false], [HOME, ".context/trash/1/orbit-lamp", true]] as const) {
      const answer = await w.t.run(async (ctx) =>
        await applyRowMove(ctx as unknown as MutationCtx, { workspaceId: w.pinned, from, to, privacyEtag: null, privacyChecked: true, now: Date.now(), trash }),
      );
      expect(answer, `${from} -> ${to}`).toEqual({ ok: false, reason: "invalid" });
    }
    // The chat's note is where it was, and still the chat's.
    const read = await op(w, "team", chatNames(w.home), { kind: "read", path: NOTE });
    expect(JSON.stringify(read)).toContain(WORD);
  });

  test("does not see a chat's note in the trash, nor the audit trail's line about it", async () => {
    const w = await homeWorld();
    await op(w, "team", chatNames(w.home), { kind: "trash", path: ABOUT });
    const staff = asUser(w.t, w.staff);
    const trash = await staff.query(api.functions.trash.listTrash, { workspaceId: w.pinned });
    expect(trash.items.map((item) => item.path)).not.toContain(ABOUT);
    // The chat's write, recorded as the gateway records one, under the person who asked.
    await w.t.run(async (ctx) => {
      await recordAudit(ctx as unknown as MutationCtx, { workspaceId: w.pinned, actorUserId: w.sayo, actorClientId: "context_texts_group", action: "file.write", paths: [NOTE] });
      await recordAudit(ctx as unknown as MutationCtx, { workspaceId: w.pinned, actorUserId: w.mel, action: "file.write", paths: ["guides/start.md"] });
    });
    const trail = await staff.query(api.functions.audit.listEvents, { workspaceId: w.pinned, limit: 100 });
    expect(trail.some((row) => row.paths.includes("guides/start.md"))).toBe(true);
    expect(trail.some((row) => row.actorUserId === w.sayo)).toBe(false);
  });
});

describe("the people named on a home", () => {
  test("read it through Shared with me, and nobody else does", async () => {
    const w = await homeWorld();
    const paths = [NOTE, ABOUT, HOME];
    const sayo = await w.t.run(async (ctx) => await visibleGrantedPaths(ctx, { userId: w.sayo, workspaceId: w.pinned, paths }));
    expect(sayo.sort()).toEqual([...paths].sort());
    // A real member who is not in the chat.
    const mel = await clearanceOf(w, w.mel);
    const seen = await op(w, mel.scope, mel.grantedNames, { kind: "visiblePaths", paths });
    expect(seen.kind === "visiblePaths" ? seen.paths : null).toEqual([]);
  });

  test("an owner who is in the chat reads it like anyone in it", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    const home = await makeHome(w, [{ kind: "user", userId: w.staff, role: "edit" }]);
    await op(w, "team", chatNames(home), { kind: "write", path: NOTE, text: `# Chat\n\n${WORD}\n` });
    const staff = await clearanceOf(w, w.staff);
    expect(JSON.stringify(await op(w, staff.scope, staff.grantedNames, { kind: "read", path: NOTE }))).toContain(WORD);
  });
});

describe("only a person opens a home", () => {
  test("a members, accounts or group grant beneath the folder reaches nobody", async () => {
    const w = await pinnedWorld();
    await migrate(w);
    await makeHome(w, [
      { kind: "members", role: "edit" },
      { kind: "accounts", role: "view" },
    ]);
    const mel = await clearanceOf(w, w.mel);
    const sayo = await clearanceOf(w, w.sayo);
    for (const who of [mel, sayo]) {
      const seen = await op(w, who.scope, who.grantedNames, { kind: "visiblePaths", paths: [HOME, NOTE] });
      expect(seen.kind === "visiblePaths" ? seen.paths : null).toEqual([]);
    }
  });
});

describe("chatHomesMoveRefused", () => {
  test("keeps what is inside one home moving, and refuses everything that crosses the seal", () => {
    expect(chatHomesMoveRefused(`${HOME}/a.md`, `${HOME}/b/a.md`, false)).toBe(false);
    expect(chatHomesMoveRefused(`${HOME}/a.md`, ".context/trash/1/a.md", true)).toBe(false);
    expect(chatHomesMoveRefused(".context/trash/1/a.md", `${HOME}/a.md`, true)).toBe(false);
    expect(chatHomesMoveRefused(`${HOME}/a.md`, "areas/a.md", false)).toBe(true);
    expect(chatHomesMoveRefused("areas/a.md", `${HOME}/a.md`, false)).toBe(true);
    expect(chatHomesMoveRefused(`${HOME}/a.md`, "tex/groups/other-home/a.md", false)).toBe(true);
    expect(chatHomesMoveRefused(HOME, "tex/groups/renamed", false)).toBe(true);
    expect(chatHomesMoveRefused("tex", "tex2", false)).toBe(true);
    expect(chatHomesMoveRefused("Tex/Groups", "x", false)).toBe(true);
    expect(chatHomesMoveRefused("tex", ".context/trash/1/tex", true)).toBe(true);
    expect(chatHomesMoveRefused("areas/a.md", "areas/b.md", false)).toBe(false);
  });
});
