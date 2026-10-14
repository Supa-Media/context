/**
 * Where the open note went when it was moved to the trash
 * (`functions/trashedNotes.ts`): what the console needs to keep it on screen
 * as a trashed note with Restore, and who moved it.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `canSee` check and a member learns a private note was trashed;
 *  - drop the restore check and a restored note still reads as trashed;
 *  - compare `byYou` against nothing and the owner's own trash reads as someone else's.
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
