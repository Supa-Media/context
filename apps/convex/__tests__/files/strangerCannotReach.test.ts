import { describe, expect, test } from "vitest";
import * as fileFunctions from "../../functions/files";
import { api } from "../../_generated/api";
import { type Id } from "../../_generated/dataModel";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import {
  SECRET_BODY_MARKER,
  fixture,
  errorShape,
  danglingWorkspaceId,
} from "./fixtures";

/* -------------------------------------------------------------------------- */
/*                              tenant isolation                              */
/* -------------------------------------------------------------------------- */

describe("a stranger cannot reach another workspace's files", () => {
  test("every file endpoint answers exactly as it does for a workspace that never existed", async () => {
    const f = await fixture();
    const dangling = await danglingWorkspaceId(f.t);
    const as = asUser(f.t, f.stranger);
    const importJobId = await f.t.run((ctx) =>
      ctx.db.insert("vaultImportJobs", {
        workspaceId: f.workspaceId,
        actorUserId: f.owner,
        strategy: "merge",
        sourceFingerprint: "vault-isolation",
        totalFiles: 1,
        totalBytes: 3,
        totalBatches: 1,
        completedBatches: [],
        completedFiles: 0,
        createdFiles: 0,
        skippedFiles: 0,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const calls: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) => as.action(api.functions.files.listFiles, { workspaceId, path: "" }),
      // `.obsidian/` is outside the privacy manifest entirely, so the plugin
      // inventory must establish ownership before its fixed read path opens.
      (workspaceId) =>
        as.action(api.functions.files.listObsidianPlugins, { workspaceId }),
      // The cheap half of the same read, and the same reasoning: it opens keys
      // under `.context/plugins/`, which no privacy manifest governs, so
      // ownership is established before the fixed path is built.
      (workspaceId) =>
        as.action(api.functions.files.listManagedPlugins, { workspaceId }),
      (workspaceId) =>
        as.action(api.functions.files.readNote, { workspaceId, path: "1-projects/shared.md" }),
      // The offline mirror's two reads. A manifest that answered an empty list
      // for another tenant's context, instead of this refusal, would be an
      // oracle of a different shape: "empty" for a real context and "not
      // found" for an invented one.
      (workspaceId) => as.action(api.functions.files.syncManifest, { workspaceId }),
      // The activity file's three doors. Reading the list is a bucket read;
      // the other two only touch the membership row, and refuse in the same
      // shape rather than answering `null` for somebody else's context.
      (workspaceId) => as.action(api.functions.files.listActivity, { workspaceId }),
      (workspaceId) => as.query(api.functions.files.activityLastSeen, { workspaceId }),
      (workspaceId) =>
        as.mutation(api.functions.files.markActivitySeen, { workspaceId }),
      (workspaceId) =>
        as.action(api.functions.files.readNotes, {
          workspaceId,
          paths: ["1-projects/shared.md"],
        }),
      (workspaceId) =>
        as.action(api.functions.files.writeNote, {
          workspaceId,
          path: "1-projects/x.md",
          text: "x",
        }),
      // The separate, narrower door that writes plaintext over an encrypted
      // note — see `removeNoteEncryption` in `lib/fileOps.ts`. It reads
      // `privacy.md` and the target note exactly as `writeNote` does, so it
      // carries the same cross-tenant risk and needs the same refusal.
      (workspaceId) =>
        as.action(api.functions.files.removeNoteEncryption, {
          workspaceId,
          path: "1-projects/x.md",
          text: "x",
        }),
      (workspaceId) =>
        as.action(api.functions.files.importVaultBatch, {
          workspaceId,
          files: [{
            path: "imported.md",
            bytes: new TextEncoder().encode("# Imported\n").buffer,
            contentType: "text/markdown; charset=utf-8",
          }],
        }),
      (workspaceId) =>
        as.mutation(api.functions.files.startVaultImport, {
          workspaceId,
          strategy: "merge",
          sourceFingerprint: "vault-isolation",
          totalFiles: 1,
          totalBytes: 3,
          totalBatches: 1,
        }),
      (workspaceId) =>
        as.query(api.functions.files.latestVaultImportJob, { workspaceId }),
      (workspaceId) =>
        as.mutation(api.functions.files.pauseVaultImport, { workspaceId, jobId: importJobId }),
      (workspaceId) =>
        as.action(api.functions.files.importVaultJobBatch, {
          workspaceId,
          jobId: importJobId,
          sourceFingerprint: "vault-isolation",
          batchIndex: 0,
          files: [{
            path: "imported.md",
            bytes: new TextEncoder().encode("# Imported\n").buffer,
            contentType: "text/markdown; charset=utf-8",
          }],
        }),
      (workspaceId) =>
        as.action(api.functions.files.clearVaultImportBatch, {
          workspaceId,
          jobId: importJobId,
          sourceFingerprint: "vault-isolation",
        }),
      (workspaceId) =>
        as.action(api.functions.files.moveEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.copyEntry, { workspaceId, from: "a.md", to: "b.md" }),
      (workspaceId) =>
        as.action(api.functions.files.duplicateEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.archiveEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.trashEntry, { workspaceId, path: "a.md" }),
      (workspaceId) =>
        as.action(api.functions.files.restoreTrashEntry, {
          workspaceId,
          from: ".context/trash/stamp/a.md",
          to: "a.md",
        }),
      (workspaceId) =>
        as.action(api.functions.files.createDirectory, { workspaceId, path: "a" }),
      (workspaceId) =>
        as.action(api.functions.files.deleteEntry, {
          workspaceId,
          path: "a.md",
          confirmation: DELETE_CONFIRMATION,
        }),
      (workspaceId) =>
        as.action(api.functions.files.setNoteVisibility, {
          workspaceId,
          path: "a.md",
          visibility: "team",
        }),
      (workspaceId) =>
        as.action(api.functions.files.setDirectoryVisibility, {
          workspaceId,
          path: "a",
          visibility: "team",
        }),
      // Search reaches the whole context by design, so it is the endpoint that
      // returns the most from one call: paths, titles and body snippets across
      // every folder. Stripping its `callerId` + `authorizeFileAccess` and
      // hardcoding `scope: "private"` left all 1,403 checks green before this
      // line existed — a stranger reading another tenant's bucket at OWNER
      // scope, invisible to the suite.
      (workspaceId) =>
        as.action(api.functions.files.searchContext, { workspaceId, query: "shared" }),
      // Reads the same index `searchContext` does, so it carries the same
      // cross-tenant risk: a stranger asking for another workspace's note
      // paths must get `WORKSPACE_NOT_FOUND`, never a real (even empty) list.
      (workspaceId) => as.action(api.functions.files.notePaths, { workspaceId }),
      // The same shape one level up: every FOLDER this caller can see, for the
      // "move into another context" picker. A folder name is itself private —
      // `1-projects/acme-acquisition` names a deal — so handing a stranger an
      // empty list rather than a refusal would still be an existence oracle
      // they could walk one guess at a time.
      (workspaceId) => as.action(api.functions.files.folderPaths, { workspaceId }),
      // Counts and phase reveal less than a path, but the existence of a long
      // move is still activity in another tenant and therefore owner-only.
      (workspaceId) => as.query(api.functions.files.listDurableMoves, { workspaceId }),
      // Owner-only, and absent here since it was written. The one exit from a
      // broken `privacy.md`, so reaching it across tenants would rewrite
      // somebody else's access map to all-private.
      (workspaceId) => as.action(api.functions.files.resetPrivacy, { workspaceId }),
      (workspaceId) => as.action(api.functions.files.updateStorageLayout, { workspaceId }),
      // Owner-only, and a writer of `privacy.md` like the two visibility
      // setters beside it. The group name resolves against the workspace the
      // caller names, so reaching this across tenants would point somebody
      // else's note at a group — and the refusal has to come from the
      // workspace check ahead of that resolution, not from the group lookup,
      // or a stranger learns which names exist by the shape of the error.
      (workspaceId) =>
        as.action(api.functions.files.setNoteGroup, {
          workspaceId,
          path: "1-projects/shared.md",
          group: "@supa-leads",
        }),
      // The folder-shaped sibling, on the same terms. It resolves a name
      // against this workspace too — and now resolves a PERSON's handle as
      // well as a group, so the refusal ahead of that resolution is also what
      // stops a stranger asking whether a given handle is a member here.
      (workspaceId) =>
        as.action(api.functions.files.setFolderGroup, {
          workspaceId,
          path: "1-projects",
          group: "@supa-leads",
        }),
      /*
        Pasting an image into somebody else's bucket. Editor-level, so what a
        stranger meets is the membership refusal — and the key is derived from
        the bytes rather than supplied, so there is no path to guess either.
      */
      (workspaceId) =>
        as.action(api.functions.files.storeNoteImage, {
          workspaceId,
          bytes: new Uint8Array([137, 80, 78, 71]).buffer,
          contentType: "image/png",
        }),
      /*
        And reading one back out. There is a second gate behind this one — the
        note that references the image has to be one the caller can see — and
        what belongs here is the first: a stranger never reaches the gate at all.
      */
      (workspaceId) =>
        as.action(api.functions.files.readNoteImage, {
          workspaceId,
          notePath: "1-projects/a.md",
          leaf: "paste-abcd1234.png",
        }),
      /*
        Setting somebody else's workspace's icon photo. Owner-level — stricter
        than the paste above, because it writes bytes *and* changes what every
        member of that workspace sees — so a stranger meets the membership
        refusal before any of that.
      */
      (workspaceId) =>
        as.action(api.functions.files.setWorkspaceIconPhoto, {
          workspaceId,
          bytes: new Uint8Array([137, 80, 78, 71]).buffer,
          contentType: "image/png",
        }),
      /*
        And reading one back. **This is the endpoint with no object argument**
        — the leaf comes off the workspace row, which is what stops it being a
        general reader of the opaque image store (`workspaceIcon.test.ts` makes
        that case in full). Here it is the plainer question: a stranger naming
        a real workspace must not be able to tell it from one that never
        existed, and an icon is a picture every *member* is shown, which is
        exactly the kind of endpoint that gets a looser gate by accident.
      */
      (workspaceId) => as.action(api.functions.files.workspaceIconPhoto, { workspaceId }),
    ];

    /**
     * The endpoints whose refusal is an ANSWER rather than an error.
     *
     * `searchContexts` takes a *list* of workspace ids and searches the ones
     * the caller may reach, so a workspace id it cannot use is dropped rather
     * than refused — `resolveScope` argues that out at length, and the short
     * version is that refusing would make the endpoint an oracle a hundred
     * guesses wide per request.
     *
     * Dropping is only safe if it is **indistinguishable**, which is a stronger
     * claim than "it does not throw" and needs its own assertion rather than a
     * line in the table above. So these are called the same two ways — with
     * another tenant's real id, and with an id that never existed — and the two
     * answers must be byte-identical. An endpoint that returned, say, a source
     * row for a real-but-forbidden context and none for a dangling one would
     * pass a test that only checked for an absence of results.
     *
     * They are held in their own list rather than excused from the coverage
     * check, because the check is what makes this file notice a new endpoint at
     * all: `searchContext` had no isolation test for a whole release because
     * nobody added a line, and an escape hatch spelled "skip these names" is
     * how that happens again.
     */
    const dropping: Array<(workspaceId: Id<"workspaces">) => Promise<unknown>> = [
      (workspaceId) =>
        as.action(api.functions.files.searchContexts, {
          query: "shared",
          contexts: [workspaceId],
        }),
    ];

    // **The list above is checked against what Convex says is public, not
    // against what a regex can find in the source.**
    //
    // It was hand-maintained and went stale the way a hand-maintained list of
    // security-critical endpoints always does: `searchContext` arrived with
    // #154 and nobody added it here, so the endpoint that reaches furthest into
    // a bucket had no isolation check at all. `resetPrivacy` had been missing
    // since it was written.
    //
    // The first version of this guard grepped `^export const (\w+) = action\(`
    // out of the file, and `structure.test.ts` had already written down why
    // that is wrong — "a guard a rename defeats is not a guard". Measured, it
    // was defeated twice: a public `query` in this module was invisible to it
    // (a public existence oracle over any `workspaceId` sat in `files.ts` with
    // all 1,403 checks green), and so was an ordinary line break, since
    // `export const x =\n  action({` does not match. Nothing in CI reformats
    // `apps/convex`, so that is a live hole rather than a stylistic one.
    //
    // `isPublic` is Convex's own flag on the registered function. It does not
    // care about the builder, the line breaks, the name, or a type annotation.
    //
    // **`isHttp` is read too, and leaving it out was this guard's third hole.**
    // `httpActionGeneric` sets `isHttp` and neither `isPublic` nor `isInternal`
    // (convex/dist/esm/server/impl/registration_impl.js:245, against 124/172/210
    // for mutation/query/action), so an `httpAction` exported from this module
    // is invisible to an `isPublic` test. Measured: an unauthenticated
    // `GET /files/raw` listing any workspace's bucket at OWNER scope, routed for
    // real in `http.ts`, left all 1,403 checks green.
    //
    // `structure.test.ts` had already written this down — its `classify()`
    // returns `isPublic: true` for an `isHttp` function and calls it "the hole
    // this whole file exists to close, hiding in plain sight". An earlier
    // version of this comment claimed parity with that function while omitting
    // the one case it exists for.
    //
    // An `httpAction` can never appear in `covered`, because it is not reachable
    // through `api.`. So this makes the equality fail permanently the moment one
    // lands in `files.ts`, which is the intended outcome rather than a gap:
    // an HTTP route into file operations needs its own argument, in
    // `UNAUTHENTICATED_HTTP_ROUTES` or beside it, not a line in this table.
    //
    // **What it still does not cover, stated rather than implied:** a file
    // endpoint that lands in a different module. This reads `functions/files.ts`
    // alone, because the neighbouring modules have their own isolation stories
    // and sweeping them here would assert something this test has not thought
    // about. A new module of file endpoints needs its own entry, and no check
    // here will say so.
    const covered = new Set(
      [...calls, ...dropping].flatMap((call) =>
        [...call.toString().matchAll(/api\.functions\.files\.(\w+)/g)].map((m) => m[1]),
      ),
    );
    const publicEndpoints = Object.entries(fileFunctions)
      .filter(([, value]) => {
        const fn = value as { isPublic?: boolean; isHttp?: boolean } | null;
        return fn?.isPublic === true || fn?.isHttp === true;
      })
      .map(([name]) => name);
    expect(publicEndpoints.length).toBeGreaterThan(10);
    expect([...covered].sort()).toEqual([...publicEndpoints].sort());

    for (const call of calls) {
      const theirs = await captureError(() => call(f.workspaceId));
      const nowhere = await captureError(() => call(dangling));
      expect(errorCode(theirs)).toBe("WORKSPACE_NOT_FOUND");
      expect(errorShape(theirs)).toBe(errorShape(nowhere));
    }

    for (const call of dropping) {
      const theirs = await call(f.workspaceId);
      const nowhere = await call(dangling);
      // Byte-identical, and not merely both empty: the whole answer is
      // compared, so a source row, a count or a cursor that appeared for a real
      // context and not for an invented one would fail here.
      expect(JSON.stringify(theirs)).toBe(JSON.stringify(nowhere));
      // And nothing from the other tenant's bucket rode along. `shared` is a
      // word in it; `SECRET_BODY_MARKER` is in its private half.
      const rendered = JSON.stringify(theirs);
      expect(rendered).not.toContain("1-projects/shared.md");
      expect(rendered).not.toContain(SECRET_BODY_MARKER);
    }
  });

  test("and nothing in the other tenant's bucket was touched", async () => {
    const f = await fixture();
    const before = f.backend.snapshot();
    await captureError(() =>
      asUser(f.t, f.stranger).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/shared.md",
        text: "# Vandalised\n",
      }),
    );
    expect(f.backend.snapshot()).toEqual(before);
  });

  test("a signed-out caller is turned away before anything else happens", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      f.t.action(api.functions.files.listFiles, { workspaceId: f.workspaceId, path: "" }),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });
});

