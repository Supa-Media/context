/**
 * An outsider given edit can save that note's body, and nothing else.
 *
 * Drives the real actions (`shares.readGrantedNote`, `shares.writeGrantedNote`)
 * against the real credential barrier and a bucket stub, so a passing write
 * means the bytes really landed and a refused one means they really did not.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - make `guestCanEdit` answer `guestCanSee` (view counts as edit): "a view
 *    grant reads and cannot save" fails;
 *    (also "a note's own view list beats the folder's edit" and "an edit grant
 *    in another workspace does not open this one");
 *  - strip comments for an editor too: "an editor reads the comments" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import {
  HELD,
  noteIdOf,
  PLAN,
  PLAN_MARKER,
  readByNoteId,
  readByPath,
  revokeAll,
  SALARIES,
  SALARIES_MARKER,
  SECRET,
  setBase,
  setListFor,
  TEAM_NOTE,
  world,
  type World,
} from "./outsider.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

function edit(userId: Id<"users">) {
  return [{ kind: "user" as const, userId, role: "edit" as const }];
}

function view(userId: Id<"users">) {
  return [{ kind: "user" as const, userId, role: "view" as const }];
}

function save(w: World, who: Id<"users">, locator: { noteId?: string; path?: string }, text: string, expectedEtag: string) {
  return asUser(w.t, who).action(api.functions.shares.writeGrantedNote, {
    workspaceId: w.ws,
    ...locator,
    text,
    expectedEtag,
  });
}

/** The bucket's own bytes at a key, never through any product read. */
function bucketText(w: World, key: string): string | null {
  return w.backend.snapshot()[key] ?? null;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  expect(errorCode(await captureError(() => promise))).toBe(code);
}

describe("an outsider with edit saves the note", () => {
  test("an edit grant on a note reads with a version and saves over it", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola));

    const note = await readByNoteId(w, w.kola, await noteIdOf(w, PLAN));
    expect(note.canEdit).toBe(true);
    expect(note.etag).not.toBeNull();

    const written = await save(w, w.kola, { noteId: await noteIdOf(w, PLAN) }, "# Plan\n\nkola-edited-7c02\n", note.etag as string);
    expect(written.path).toBe(PLAN);

    const again = await readByPath(w, w.kola, PLAN);
    expect(again.text).toContain("kola-edited-7c02");
    expect(again.text).not.toContain(PLAN_MARKER);
  });

  test("the save is in the workspace's audit trail under the outsider's account", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    await save(w, w.kola, { path: PLAN }, "# Plan\n\nchanged\n", note.etag as string);

    const rows = await w.t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", w.ws))
        .collect(),
    );
    const write = rows.find((row) => row.action === "file.write" && row.actorUserId === w.kola);
    expect(write?.paths).toEqual([PLAN]);
    expect(JSON.stringify(write)).not.toContain("changed");
  });

  test("an edit grant on a folder lets them save a note inside it", async () => {
    const w = await world();
    await setListFor(w, "1-projects", edit(w.kola));
    const note = await readByPath(w, w.kola, HELD);
    expect(note.canEdit).toBe(true);
    await save(w, w.kola, { path: HELD }, "# Held\n\nfolder-edit\n", note.etag as string);
    expect((await readByPath(w, w.kola, HELD)).text).toContain("folder-edit");
  });

  test("an editor reads the comments, and a reader does not", async () => {
    const w = await world();
    const withThread = "# Plan\n\nWords <!--c:k7f2-->here<!--/c:k7f2-->.\n\n```comments\n- k7f2 @owner: zzq-thread-marker-7c02\n```\n";
    // Written by the owner through the product: the workspace is keyed, so a path seeded into the bucket is never read.
    for (const path of [PLAN, HELD]) {
      const current = await asUser(w.t, w.owner).action(api.functions.files.readNote, { workspaceId: w.ws, path });
      await asUser(w.t, w.owner).action(api.functions.files.writeNote, {
        workspaceId: w.ws,
        path,
        text: withThread,
        expectedEtag: current.etag,
      });
    }
    await setListFor(w, PLAN, edit(w.kola));
    await setListFor(w, HELD, view(w.kola));

    expect((await readByPath(w, w.kola, PLAN)).text).toContain("zzq-thread-marker-7c02");
    expect((await readByPath(w, w.kola, HELD)).text).not.toContain("zzq-thread-marker-7c02");
  });
});

describe("what edit never reaches", () => {
  test("a view grant reads and cannot save", async () => {
    const w = await world();
    await setListFor(w, PLAN, view(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    expect(note.canEdit).toBe(false);
    expect(note.etag).toBeNull();

    expect(note.text).toContain(PLAN_MARKER);
    // Even with a version in hand, read some other way, the write is refused.
    const etag = await w.t.run(async (ctx) => {
      const row = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", w.ws).eq("path", PLAN))
        .unique();
      return row?.etag as string;
    });
    await expectCode(save(w, w.kola, { path: PLAN }, "# Plan\n\nnope\n", etag), "SHARE_UNAVAILABLE");
    expect((await readByPath(w, w.kola, PLAN)).text).toContain(PLAN_MARKER);
  });

  test("a note's own view list beats the folder's edit", async () => {
    const w = await world();
    await setListFor(w, "1-projects", edit(w.kola));
    await setListFor(w, PLAN, view(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    expect(note.canEdit).toBe(false);
    const held = await readByPath(w, w.kola, HELD);
    await expectCode(save(w, w.kola, { path: PLAN }, "# Plan\n\nnope\n", held.etag as string), "SHARE_UNAVAILABLE");
  });

  test("a private subfolder and a note the members can see stay closed under a folder edit grant", async () => {
    const w = await world();
    await setListFor(w, "1-projects", edit(w.kola));
    await setBase(w, "1-projects/private", "private");
    await setBase(w, TEAM_NOTE, "team");
    const held = await readByPath(w, w.kola, HELD);
    await expectCode(save(w, w.kola, { path: SECRET }, "x", held.etag as string), "SHARE_UNAVAILABLE");
    await expectCode(save(w, w.kola, { path: TEAM_NOTE }, "x", held.etag as string), "SHARE_UNAVAILABLE");
  });

  test("a climbing path writes nothing outside the grant", async () => {
    const w = await world();
    await setListFor(w, "1-projects", edit(w.kola));
    const held = await readByPath(w, w.kola, HELD);
    await expectCode(
      save(w, w.kola, { path: "1-projects/../2-areas/salaries.md" }, "# Salaries\n\nleaked\n", held.etag as string),
      "SHARE_UNAVAILABLE",
    );
    expect(bucketText(w, SALARIES)).toContain(SALARIES_MARKER);
  });

  test("a note that is not there is not created", async () => {
    const w = await world();
    await setListFor(w, "1-projects", edit(w.kola));
    const held = await readByPath(w, w.kola, HELD);
    await expectCode(save(w, w.kola, { path: "1-projects/new.md" }, "# New\n", held.etag as string), "SHARE_UNAVAILABLE");
    expect(bucketText(w, "1-projects/new.md")).toBeNull();
  });

  test("a form block is refused with its own reason", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    const form = "# Plan\n\n```form\ntitle: RSVP\nfields:\n  - name: Coming?\n    type: text\n```\n";
    await expectCode(save(w, w.kola, { path: PLAN }, form, note.etag as string), "GRANT_FORM_REFUSED");
  });

  test("a save over a version that moved on is a conflict, and keeps the newer text", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    await save(w, w.kola, { path: PLAN }, "# Plan\n\nfirst\n", note.etag as string);
    await expectCode(save(w, w.kola, { path: PLAN }, "# Plan\n\nsecond\n", note.etag as string), "CONFLICT");
    expect((await readByPath(w, w.kola, PLAN)).text).toContain("first");
  });

  test("taking the grant back ends the save", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    await revokeAll(w, PLAN);
    await expectCode(save(w, w.kola, { path: PLAN }, "# Plan\n\nlate\n", note.etag as string), "SHARE_UNAVAILABLE");
  });

  test("a member and a stranger cannot use the outsider's door", async () => {
    const w = await world();
    await setListFor(w, PLAN, [...edit(w.kola), ...edit(w.bob)]);
    const note = await readByPath(w, w.kola, PLAN);
    await expectCode(save(w, w.bob, { path: PLAN }, "# Plan\n\nbob\n", note.etag as string), "SHARE_UNAVAILABLE");
    await expectCode(save(w, w.carol, { path: PLAN }, "# Plan\n\ncarol\n", note.etag as string), "SHARE_UNAVAILABLE");
    await expectCode(
      w.t.action(api.functions.shares.writeGrantedNote, { workspaceId: w.ws, path: PLAN, text: "x", expectedEtag: note.etag as string }),
      "NOT_AUTHENTICATED",
    );
  });

  test("an edit grant in another workspace does not open this one", async () => {
    const w = await world();
    await setListFor(w, PLAN, edit(w.kola), w.beta);
    await setListFor(w, PLAN, view(w.kola));
    const note = await readByPath(w, w.kola, PLAN);
    expect(note.canEdit).toBe(false);
  });
});
