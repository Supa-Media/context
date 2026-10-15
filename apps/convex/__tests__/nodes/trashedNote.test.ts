/**
 * Where the open note went when it was moved to the trash
 * (`functions/trashedNotes.ts`): what the console needs to keep it on screen
 * as a trashed note with Restore, and who moved it.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `canSee` check and a member learns a private note was trashed;
 *  - drop the restore check and a restored note still reads as trashed;
 *  - compare `byYou` against nothing and the owner's own trash reads as someone else's;
 *  - match only the exact path (the old `paths[0] === path`) and a note inside a trashed folder answers nothing;
 *  - drop the `/` from the folder match and `launch-old/` reads as inside a trashed `launch`;
 *  - match a restore only by its exact path and a note whose folder came back still reads as trashed;
 *  - drop the `normalizePath` check and `secret/../keep.md` reads as inside a trashed private folder.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { fixture, type Fixture } from "./moveFixture.helpers";

const TRASH = ".context/trash/2026-10-14T05-00-00-000Z/1-projects/launch/brief.md";
const SECRET_TRASH = ".context/trash/2026-10-14T05-00-00-000Z/1-projects/secret/codes.md";

async function trashed(f: Fixture, actorUserId: Fixture["ownerId"], note: string, trash: string) {
  await f.t.mutation(internal.functions.audit.recordEvent, {
    workspaceId: f.ws,
    actorUserId,
    action: "file.archive",
    paths: [note, trash],
    details: { files: 1, recoverable: true, trash: true },
  });
}

describe("asking where the open note went", () => {
  test("answers the trash key and that the caller moved it", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch/brief.md", TRASH);
    const answer = await f.owner.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/launch/brief.md" });
    expect(answer).toMatchObject({ trash: TRASH, byYou: true });
  });

  test("tells another member it was not them", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch/brief.md", TRASH);
    const answer = await f.member.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/launch/brief.md" });
    expect(answer).toMatchObject({ trash: TRASH, byYou: false });
  });

  test("answers nothing once the note was restored", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch/brief.md", TRASH);
    await f.t.mutation(internal.functions.audit.recordEvent, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      action: "file.move",
      paths: [TRASH, "1-projects/launch/brief.md"],
      details: { files: 1, restoredFromTrash: true },
    });
    expect(await f.owner.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/launch/brief.md" })).toBeNull();
  });

  test("answers nothing about a note the caller may not see", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/secret/codes.md", SECRET_TRASH);
    expect(await f.member.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/secret/codes.md" })).toBeNull();
    expect(await f.owner.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/secret/codes.md" })).toMatchObject({ trash: SECRET_TRASH });
  });

  test("answers nothing for a note that was never trashed", async () => {
    const f = await fixture("s3");
    expect(await f.owner.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/launch/plan.md" })).toBeNull();
  });
});

const FOLDER_TRASH = ".context/trash/2026-10-14T06-00-00-000Z/1-projects/launch";

async function restored(f: Fixture, trash: string, to: string) {
  await f.t.mutation(internal.functions.audit.recordEvent, {
    workspaceId: f.ws,
    actorUserId: f.ownerId,
    action: "file.move",
    paths: [trash, to],
    details: { files: 1, restoredFromTrash: true },
  });
}

const ask = (who: Fixture["owner"], f: Fixture, path: string) =>
  who.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path });

describe("asking about a note inside a folder that went to the trash", () => {
  test("answers where the note sits inside the folder's trash", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch", FOLDER_TRASH);
    expect(await ask(f.member, f, "1-projects/launch/brief.md")).toMatchObject({ trash: `${FOLDER_TRASH}/brief.md`, byYou: false });
    expect(await ask(f.owner, f, "1-projects/launch/sub/deep.md")).toMatchObject({ trash: `${FOLDER_TRASH}/sub/deep.md`, byYou: true });
  });

  test("a folder whose name only begins the same is not that folder", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch", FOLDER_TRASH);
    expect(await ask(f.owner, f, "1-projects/launch-old/brief.md")).toBeNull();
  });

  test("answers nothing once the folder came back, or the note on its own", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/launch", FOLDER_TRASH);
    await restored(f, `${FOLDER_TRASH}/brief.md`, "1-projects/launch/brief.md");
    expect(await ask(f.owner, f, "1-projects/launch/brief.md")).toBeNull();
    // Its neighbour is still in the trash.
    expect(await ask(f.owner, f, "1-projects/launch/plan.md")).toMatchObject({ trash: `${FOLDER_TRASH}/plan.md` });
    await restored(f, FOLDER_TRASH, "1-projects/launch");
    expect(await ask(f.owner, f, "1-projects/launch/plan.md")).toBeNull();
  });

  test("a hidden note under a shared folder answers nothing to a member", async () => {
    const f = await fixture("s3");
    const trash = ".context/trash/2026-10-14T06-00-00-000Z/1-projects";
    await trashed(f, f.ownerId, "1-projects", trash);
    expect(await ask(f.member, f, "1-projects/secret/codes.md")).toBeNull();
    expect(await ask(f.member, f, "1-projects/keep.md")).toMatchObject({ trash: `${trash}/keep.md` });
    expect(await ask(f.owner, f, "1-projects/secret/codes.md")).toMatchObject({ trash: `${trash}/secret/codes.md` });
  });

  test("a path that is not stored as written answers nothing, so a hidden folder's trash cannot be reached through it", async () => {
    const f = await fixture("s3");
    await trashed(f, f.ownerId, "1-projects/secret", ".context/trash/2026-10-14T06-00-00-000Z/1-projects/secret");
    expect(await ask(f.member, f, "1-projects/secret/../keep.md")).toBeNull();
    expect(await ask(f.owner, f, "1-projects/secret/../keep.md")).toBeNull();
  });
});
