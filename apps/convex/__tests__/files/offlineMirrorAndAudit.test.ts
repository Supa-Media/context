import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { ACTIVITY_PATH } from "@context/shared/src/activity.cjs";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  SECRET_BODY_MARKER,
  Fixture,
  fixture,
  share,
} from "./fixtures.helpers";

/* -------------------------------------------------------------------------- */
/*                         what the offline mirror is fed                     */
/* -------------------------------------------------------------------------- */

/**
 * `syncManifest` and `readNotes` through the real actions, the real
 * `S3Store` and the real authorization. `offlineSync.test.ts` proves the
 * operations against a bucket; this proves the tier the action hands them is
 * the caller's, and that the answers are the same ones `listFiles` and
 * `readNote` give.
 */
describe("the offline mirror sees exactly what its reader may", () => {
  test("an owner's manifest and a member's differ by exactly the private half", async () => {
    const f = await fixture();
    await share(f);
    const owner = await asUser(f.t, f.owner).action(api.functions.files.syncManifest, {
      workspaceId: f.workspaceId,
    });
    const member = await asUser(f.t, f.reader).action(api.functions.files.syncManifest, {
      workspaceId: f.workspaceId,
    });

    expect(owner.entries.map((entry) => entry.path).sort()).toEqual(
      // `activity.md` is here because the writes above produced one, and it is
      // the owner's: it is a note at the root of their own bucket, so the
      // mirror carries it and the activity page works on a plane. The member's
      // manifest below is the other half of that — it is private, so it is
      // absent there, with no gap where it would have been.
      [
        "1-projects/README.md",
        "1-projects/shared.md",
        "2-areas/README.md",
        "2-areas/private-note.md",
        ACTIVITY_PATH,
        "index.md",
        PRIVACY_KEY,
      ].sort(),
    );
    expect(member.entries.map((entry) => entry.path)).toEqual([
      "1-projects/README.md",
      "1-projects/shared.md",
    ]);
    expect(member).toMatchObject({ kind: "manifest", cursor: null, truncated: false });

    // Not the path, not the etag, not the size — nothing that says it exists.
    const hidden = owner.entries.find((entry) => entry.path === "2-areas/private-note.md")!;
    const rendered = JSON.stringify(member);
    expect(rendered).not.toContain("private-note");
    expect(rendered).not.toContain(`"${hidden.etag}"`);
    expect(rendered).not.toContain(PRIVACY_KEY);
  });

  test("a manifest's etag is the one readNote returns, so a sync can skip what it already has", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);
    const manifest = await as.action(api.functions.files.syncManifest, { workspaceId: f.workspaceId });
    for (const entry of manifest.entries) {
      const read = await as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: entry.path,
      });
      // The manifest carries provider freshness; collaborative reads expose
      // an opaque editing revision. They are separate bases by design.
      expect(entry.etag).toBe((read as { rawEtag?: string }).rawEtag ?? read.etag);
    }
  });

  test("a batch answers each path as readNote would, and a hidden note as a missing one", async () => {
    const f = await fixture();
    await share(f);
    const as = asUser(f.t, f.reader);
    const batch = await as.action(api.functions.files.readNotes, {
      workspaceId: f.workspaceId,
      paths: ["1-projects/shared.md", "2-areas/private-note.md", "2-areas/no-such-note.md"],
    });

    expect(batch.results[0]).toEqual({
      path: "1-projects/shared.md",
      outcome: "read",
      note: await as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
      }),
    });
    const { path: _hiddenPath, ...hidden } = batch.results[1]!;
    const { path: _absentPath, ...absent } = batch.results[2]!;
    expect(hidden).toEqual(absent);
    expect(hidden).toMatchObject({ outcome: "error", code: "FILE_NOT_FOUND" });

    // And word for word what readNote throws for the same path.
    const single = await captureError(() =>
      as.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "2-areas/private-note.md",
      }),
    );
    expect(hidden).toMatchObject({
      code: errorCode(single),
      message: (single as { data: { message: string } }).data.message,
    });
    expect(JSON.stringify(batch)).not.toContain(SECRET_BODY_MARKER);
  });

  test("the owner's batch reads the note the member's was refused", async () => {
    const f = await fixture();
    await share(f);
    const batch = await asUser(f.t, f.owner).action(api.functions.files.readNotes, {
      workspaceId: f.workspaceId,
      paths: ["2-areas/private-note.md"],
    });
    expect(batch.results[0]).toMatchObject({ outcome: "read" });
    expect(JSON.stringify(batch)).toContain(SECRET_BODY_MARKER);
  });

  test("an oversized batch is refused with a code the client can act on, before the bucket is asked", async () => {
    const f = await fixture();
    const before = f.backend.requests.length;
    const error = await captureError(() =>
      asUser(f.t, f.reader).action(api.functions.files.readNotes, {
        workspaceId: f.workspaceId,
        paths: Array.from({ length: 51 }, (_, index) => `1-projects/n${index}.md`),
      }),
    );
    expect(errorCode(error)).toBe("BATCH_TOO_LARGE");
    expect(f.backend.requests.length).toBe(before);
  });
});
/* -------------------------------------------------------------------------- */
/*                    the audit trail is inside that boundary                 */
/* -------------------------------------------------------------------------- */

/**
 * THE ATTACK: RECOVER A HIDDEN NOTE'S PATH FROM THE AUDIT TRAIL.
 *
 * Everything above proves the file APIs hold the line — a `team`-scoped member
 * cannot read, list, or infer a private note. `listEvents` is readable by every
 * member of the same workspace and used to hand them the path anyway, three
 * different ways, for a note whose folder listing correctly comes back empty.
 *
 * Attacker and victim share ONE database and ONE workspace on purpose. A
 * fixture that puts them in separate ones proves nothing: the refusal would
 * then come from the row not existing rather than from the gate.
 */
describe("a member cannot recover a hidden path out of the audit trail", () => {
  const HIDDEN = "2-areas/acquisition-of-acme.md";
  const SIBLING = "2-areas/acquisition-of-acme-terms.md";

  /**
   * A private folder holding two notes, touched by the owner in the ways that
   * write a path onto the trail: created, and re-classified.
   */
  async function attackFixture() {
    const f = await fixture();
    await share(f);
    const owner = asUser(f.t, f.owner);

    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: HIDDEN,
      text: "# Acme\n",
    });
    await owner.action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: SIBLING,
      text: "# Terms\n",
    });
    await owner.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: HIDDEN,
      visibility: "private",
    });
    return f;
  }

  async function memberSees(f: Fixture): Promise<string> {
    const rows = await asUser(f.t, f.reader).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    return JSON.stringify(rows);
  }

  /**
   * The premise. If the member could list the folder, nothing below is a leak.
   */
  test("the member's own listing of that folder is empty", async () => {
    const f = await attackFixture();
    const listing = await asUser(f.t, f.reader).action(
      api.functions.files.listFiles,
      { workspaceId: f.workspaceId, path: "2-areas" },
    );
    expect(listing.entries).toEqual([]);
  });

  /**
   * `file.create` and `visibility.note` both name the note, and the second one
   * labels it `visibility: "private"` -- so before the gate the member did not
   * merely learn a path, they learned it was a path kept from them.
   */
  test("the trail does not hand over the path it was created under", async () => {
    const f = await attackFixture();
    expect(await memberSees(f)).not.toContain(HIDDEN);
  });

  /**
   * The worst of the three. `deleteEntry` on a folder records
   * `keysUnder(...)` expanded at the *actor's* clearance, so an owner deleting
   * a private folder used to write every private note in it onto a row the
   * member reads.
   */
  test("nor every private sibling out of a folder delete", async () => {
    const f = await attackFixture();
    await asUser(f.t, f.owner).action(api.functions.files.deleteEntry, {
      workspaceId: f.workspaceId,
      path: "2-areas",
      confirmation: DELETE_CONFIRMATION,
    });
    const dump = await memberSees(f);
    expect(dump).not.toContain(HIDDEN);
    expect(dump).not.toContain(SIBLING);
  });

  /**
   * The owner is the reason this is a gate and not a schema change: the record
   * itself is unchanged, and the person with `private` clearance still reads
   * all of it.
   */
  test("the owner's own view of the same trail is complete", async () => {
    const f = await attackFixture();
    const rows = await asUser(f.t, f.owner).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    expect(JSON.stringify(rows)).toContain(HIDDEN);
    expect(rows.every((row) => row.pathsWithheld === false)).toBe(true);
  });

  /**
   * THE HALF OF THE TRAIL A MEMBER KEEPS.
   *
   * Withholding every path from a non-owner would have been simpler and would
   * have taken this with it — "what did my own client just do in my name" is
   * a member's main reason to open the trail, and those paths are ones the
   * member supplied, expanded at the member's own clearance.
   */
  test("a member still reads the paths of what they did themselves", async () => {
    const f = await attackFixture();
    await asUser(f.t, f.editor).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/editor-wrote-this.md",
      text: "# Mine\n",
    });
    const rows = await asUser(f.t, f.editor).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    const mine = rows.find((row) => row.actorUserId === f.editor);
    expect(mine?.pathsWithheld).toBe(false);
    expect(mine?.paths).toEqual(["1-projects/editor-wrote-this.md"]);
    // And the owner's rows in the very same response are still closed.
    expect(
      rows.filter((row) => row.actorUserId === f.owner).every((row) => row.pathsWithheld),
    ).toBe(true);
  });

  /**
   * THE SECOND-ORDER LEAK: A REDACTION THAT VARIES IS ITSELF A SIGNAL.
   *
   * `pathsWithheld` is computed from the reader alone, never from the row, so
   * a withheld row that named two private notes and a withheld row that named
   * nothing at all come back byte-identical. Had the flag been raised only
   * when `paths` was non-empty, a member could have subtracted "rows that
   * touched something" from "notes I can list" — the same census the note
   * count is owner-only to prevent, rebuilt out of booleans.
   *
   * The two rows are inserted directly, with equal `at` and equal action, so
   * the only thing that could differ between them is the thing under test.
   */
  test("a withheld row is indistinguishable from a row that named nothing", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        action: "file.delete",
        paths: ["2-areas/one.md", "2-areas/two.md"],
        at: 5_000,
      });
      await ctx.db.insert("auditEvents", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        action: "file.delete",
        paths: [],
        at: 5_000,
      });
    });
    const rows = await asUser(f.t, f.reader).query(
      api.functions.audit.listEvents,
      { workspaceId: f.workspaceId, limit: 100 },
    );
    const pair = rows.filter((row) => row.at === 5_000);
    expect(pair).toHaveLength(2);
    // `eventId` is the row's own id and is not derived from its contents.
    const shape = (row: (typeof pair)[number]) =>
      JSON.stringify({ ...row, eventId: null });
    expect(shape(pair[0]!)).toBe(shape(pair[1]!));
  });
});

