import { check, rpc, call, lacks, succeeded, contextStore, objects, controlPlane, env, worker, storedText, WORKSPACE_ID, accessTokenFor } from "./harness.mjs";
import { fullToolList } from "./fullToolList.mjs";

import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";
import { readDocument as readCollaborationDocument } from "@context/collaboration";

export async function runMovesAndBatchChecks() {
  // -- batch move plan and apply
  // Raw legacy notes deliberately have no collaboration head. This case pins
  // resumable copy/delete behavior rather than the CRDT lifecycle, whose
  // destination identity cannot be reconstructed from an identical raw copy.
  await contextStore.put("1-projects/portable/batch-a.md", "batch a");
  await contextStore.put("1-projects/portable/batch-b.md", "batch b");
  const batchPlan = await call("pub-token", "move_notes", {
    dry_run: true,
    moves: [
      { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
      { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
    ],
  });
  const batchPlanText = batchPlan.content[0].text;
  const batchEtags = [...batchPlanText.matchAll(/etag (\S+)\)/g)].map((match) => match[1]);
  check(
    "batch dry-run validates without changing data",
    !batchPlan.isError && batchEtags.length === 2 &&
      objects.has("1-projects/portable/batch-a.md") && !objects.has("1-projects/portable-moved/batch-a.md")
  );
  // An identical raw destination is still a different collaborative identity.
  // Refuse to adopt it, then remove it and prove the batch moves cleanly.
  await contextStore.put("1-projects/portable-moved/batch-a.md", "batch a");
  const batchWithoutEtags = await call("pub-token", "move_notes", {
    moves: [
      { source: "1-projects/portable/batch-a.md", destination: "1-projects/portable-moved/batch-a.md" },
      { source: "1-projects/portable/batch-b.md", destination: "1-projects/portable-moved/batch-b.md" },
    ],
  });
  check("batch apply requires etags", batchWithoutEtags.isError && objects.has("1-projects/portable/batch-a.md"));
  const batchAdoption = await call("pub-token", "move_notes", {
    moves: [
      {
        source: "1-projects/portable/batch-a.md",
        destination: "1-projects/portable-moved/batch-a.md",
        expected_source_etag: batchEtags[0],
      },
      {
        source: "1-projects/portable/batch-b.md",
        destination: "1-projects/portable-moved/batch-b.md",
        expected_source_etag: batchEtags[1],
      },
    ],
  });
  check(
    "batch apply does not adopt identical bytes without the collaborative identity",
    batchAdoption.isError &&
      objects.has("1-projects/portable/batch-a.md") &&
      objects.has("1-projects/portable/batch-b.md") &&
      objects.has("1-projects/portable-moved/batch-a.md"),
  );
  await contextStore.delete("1-projects/portable-moved/batch-a.md");
  const batchApply = await call("pub-token", "move_notes", {
    moves: [
      {
        source: "1-projects/portable/batch-a.md",
        destination: "1-projects/portable-moved/batch-a.md",
        expected_source_etag: batchEtags[0],
      },
      {
        source: "1-projects/portable/batch-b.md",
        destination: "1-projects/portable-moved/batch-b.md",
        expected_source_etag: batchEtags[1],
      },
    ],
  });
  check(
    "batch apply moves every note once every destination is unclaimed",
    !batchApply.isError &&
      isLogicalDeleteMarker(storedText("1-projects/portable/batch-a.md")) &&
      isLogicalDeleteMarker(storedText("1-projects/portable/batch-b.md")) &&
      objects.has("1-projects/portable-moved/batch-a.md") &&
      objects.has("1-projects/portable-moved/batch-b.md")
  );
  const folderDryRun = await call("pub-token", "move_folder", {
    source: "1-projects/portable-moved",
    destination: "1-projects/portable",
    dry_run: true,
  });
  check(
    "folder move dry-run makes no changes",
    !folderDryRun.isError &&
      folderDryRun.content[0].text.includes("preflight ok") &&
      objects.has("1-projects/portable-moved/batch-a.md")
  );
  // The folder playing each built-in role cannot be renamed or moved, by
  // owner or team, under any number (a duplicate of it can: tree/twins.js).
  for (const [token, source] of [["priv-token", "1-projects"], ["pub-token", "1-projects/"]]) {
    const refused = await call(token, "move_folder", { source, destination: "renamed-main-folder", dry_run: true });
    check(
      `move_folder refuses the built-in folder ${source}`,
      refused.isError && /is a built-in folder/.test(refused.content[0].text) && !objects.has("renamed-main-folder/batch-a.md")
    );
  }
  const insideMain = await call("pub-token", "move_folder", {
    source: "1-projects/portable-moved",
    destination: "1-projects/portable-inside",
    dry_run: true,
  });
  check("...while folders inside a built-in folder still move", !insideMain.isError);
  const forgedMoveId = "move-forged-private-leak";
  await contextStore.put(
    `.context/moves/${forgedMoveId}.json`,
    JSON.stringify({
      version: 1,
      id: forgedMoveId,
      status: "logical_active",
      source: "1-projects/secret-thing",
      destination: "1-projects/leak",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      total_objects: 1,
      copied_objects: 0,
      deleted_objects: 0,
      objects: [{
        source: "1-projects/secret-thing/status.md",
        destination: "1-projects/leak/status.md",
        etag: objects.get("1-projects/secret-thing/status.md")?.etag,
        size: objects.get("1-projects/secret-thing/status.md")?.bytes.length,
      }],
    })
  );
  check(
    "a forged logical move marker cannot publish a private source through a team destination",
    (await call("pub-token", "read_note", { path: "1-projects/leak/status.md" })).isError &&
      !(await call("pub-token", "list_notes", { prefix: "1-projects/leak" })).content[0].text.includes(
        "1-projects/leak/status.md"
      )
  );
  await contextStore.delete(`.context/moves/${forgedMoveId}.json`);
  for (let i = 0; i < 502; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/big-move/note-${suffix}.md`, `big ${suffix}`);
  }
  const bigSecretPath = "1-projects/big-move/note-501.md";
  // Keep this large-tree fixture raw: an expected_etag asks set_visibility to
  // resolve the collaborative revision and intentionally promotes the note,
  // which a logical raw folder move must refuse rather than strand.
  await call("priv-token", "set_visibility", {
    path: bigSecretPath,
    visibility: "private",
  });
  const teamBigMove = await call("pub-token", "move_folder", {
    source: "1-projects/big-move",
    destination: "1-projects/big-moved",
  });
  check(
    "team move_folder still refuses too-large trees instead of logically moving hidden content",
    teamBigMove.isError && teamBigMove.content[0].text.includes("large logical folder moves require owner access")
  );
  const bigDryRun = await call("priv-token", "move_folder", {
    source: "1-projects/big-move",
    destination: "1-projects/big-moved",
    dry_run: true,
  });
  check(
    "owner move_folder dry-run reports a large logical move without changing storage",
    !bigDryRun.isError &&
      bigDryRun.content[0].text.includes("large folder") &&
      objects.has("1-projects/big-move/note-000.md") &&
      !objects.has("1-projects/big-moved/note-000.md")
  );
  /*
    Past the one-go threshold a folder moves through the Convex move queue
    (`queuedFolder.js`); this harness's control plane has no queue, which is
    what a workspace still loading looks like. The move is refused and nothing
    changes: no `.context/moves/` job is written any more (2026-10-13), because
    nothing on the way to a note reads one. These checks replace "owner
    move_folder creates a logical move for a too-large tree" and the overlay
    checks after it (destination readable before the copy, the source listed
    and searched at its new name), which tested reading jobs.
  */
  const jobsBefore = [...objects.keys()].filter((key) => key.startsWith(".context/moves/")).length;
  const refusedBigMove = await call("priv-token", "move_folder", {
    source: "1-projects/big-move",
    destination: "1-projects/big-moved",
  });
  check(
    "a folder too large to move in one go is refused when the queue cannot take it",
    refusedBigMove.isError && refusedBigMove.content[0].text.includes("could not queue this move")
  );
  check(
    "...and nothing moved, and no move job was written",
    objects.has("1-projects/big-move/note-000.md") &&
      !objects.has("1-projects/big-moved/note-000.md") &&
      [...objects.keys()].filter((key) => key.startsWith(".context/moves/")).length === jobsBefore
  );
  // Archive-to-archive relocations already retain a recoverable destination, so
  // they avoid creating a redundant history copy when visibility is unchanged.
  await contextStore.put("4-archive/old-layout/a.md", "archived a");
  const archiveRelocationPlan = await call("priv-token", "move_notes", {
    dry_run: true,
    moves: [{ source: "4-archive/old-layout/a.md", destination: "4-archive/new-layout/a.md" }],
  });
  const archiveRelocationEtag = archiveRelocationPlan.content[0].text.match(/etag (\S+)\)/)?.[1];
  const archiveRelocation = await call("priv-token", "move_notes", {
    moves: [{
      source: "4-archive/old-layout/a.md",
      destination: "4-archive/new-layout/a.md",
      expected_source_etag: archiveRelocationEtag,
    }],
  });
  check(
    "archive relocation moves the note",
    !archiveRelocation.isError &&
      isLogicalDeleteMarker(storedText("4-archive/old-layout/a.md")) &&
      objects.has("4-archive/new-layout/a.md")
  );

  // Every write path that used to snapshot has now run in this suite: an
  // overwriting write_note, archive_note, move_note, move_notes and move_folder.
  // The guard is the sweep, not any one of them — a snapshot restored to a single
  // path is the regression this pins, and it is cheap to check the whole bucket.
  check(
    "no gateway write path snapshots to .history/",
    ![...objects.keys()].some((key) => key.startsWith(".history/"))
  );

  // -- immutable, scope-filtered audit log
  // `teamMeetingPath` names the same team-visible fixture note written in
  // privacyAcl.test.mjs's ACL section; restated here as the literal path
  // string rather than importing that module's local, so this file's checks
  // do not depend on another subject file's internal fixture variables.
  const teamMeetingPath = "2-areas/engineering/meetings/team-planning.md";
  await call("priv-token", "write_note", {
    path: "1-projects/secret-thing/private-update.md",
    content: "private audit marker",
  });
  const publicChanges = (await call("pub-token", "list_changes", { limit: 100 }))?.content?.[0]?.text;
  const privateChanges = (await call("priv-token", "list_changes", { limit: 100 }))?.content?.[0]?.text;
  check("team change log shows team move", publicChanges?.includes("move_note"));
  check("team change log hides private paths", lacks(publicChanges, "secret-thing") && lacks(publicChanges, "private-folder"));
  check("private change log includes private paths", privateChanges?.includes("secret-thing") && privateChanges?.includes("private-folder"));
  check(
    "team audit log filters exact-note private ACL events inside team folders",
    lacks(publicChanges, "personnel-check-in") &&
      publicChanges
        .split("\n")
        .filter((line) => line.includes("set_visibility") && line.includes(teamMeetingPath)).length === 0
  );
  check(
    "personal audit log retains private ACL, move, and archive events",
    privateChanges?.includes("personnel-check-in") &&
      privateChanges?.includes("set_visibility") &&
      privateChanges?.includes("inherited-private")
  );
  const listAfterAudit = (await call("priv-token", "list_notes"))?.content?.[0]?.text;
  check("audit plumbing is hidden from note listings", lacks(listAfterAudit, ".context/audit/"));

  // A workspace beyond the synchronous link-scan cap still repairs both
  // inbound and moved-note relative links, including an owner's private note.
  for (let i = 0; i < 4001; i += 1) {
    await contextStore.put(`3-resources/link-fixture/note-${String(i).padStart(4, "0")}.md`, `fixture ${i}`);
  }
  await contextStore.put("1-projects/portable-link-target/note.md", "[outside](../portable-link-ref.md)");
  await contextStore.put("1-projects/portable-link-ref.md", "[[1-projects/portable-link-target/note]]");
  await contextStore.put("1-projects/secret-thing/private-link.md", "[[1-projects/portable-link-target/note]]");
  await contextStore.put("4-archive/1-projects/earlier-thread.md", "archived thread");
  await contextStore.put("1-projects/earlier-ref.md", "[[1-projects/earlier-thread]]");
  // An earlier move, in the ledger the control plane holds (the queued repair reads it with its ticket).
  controlPlane.recordForwarding(WORKSPACE_ID, [{
    from: "1-projects/earlier-thread.md",
    to: "4-archive/1-projects/earlier-thread.md",
    kind: "note",
  }]);
  await contextStore.put("1-projects/other-active/note.md", "[[1-projects/portable-link-target/note]]");
  const otherMoveId = "move-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await contextStore.put(`.context/moves/${otherMoveId}.json`, JSON.stringify({
    version: 1,
    id: otherMoveId,
    status: "copying",
    source: "1-projects/other-active",
    destination: "1-projects/other-moved",
    objects: [{
      source: "1-projects/other-active/note.md",
      destination: "1-projects/other-moved/note.md",
    }],
  }));
  const jobFilesBefore = [...objects.keys()].filter((key) => key.startsWith(".context/moves/")).length;
  const queuedLinks = await call("priv-token", "move_folder", {
    source: "1-projects/portable-link-target",
    destination: "1-projects/deep/portable-link-moved",
  });
  /*
    Beyond the scan cap a move no longer queues a reference-repair job under
    `.context/moves/` (2026-10-13): its rewrite is reported as not done, and
    the forwarding ledger carries the links. This replaces "an owner move
    schedules reference repair beyond the scan cap". A repair job an older
    gateway queued is still finished by the drain, which the checks after
    this hold, from a job seeded as that gateway wrote it.
  */
  check("a move beyond the scan cap leaves its links to forwarding and queues nothing",
    !queuedLinks.isError &&
      queuedLinks.content[0].text.includes("links to the old path forward to the new one") &&
      [...objects.keys()].filter((key) => key.startsWith(".context/moves/")).length === jobFilesBefore);
  // Fixtures of the scan-cap case, so later checks in this run see the bucket they expect.
  for (const key of [...objects.keys()]) {
    if (key.startsWith("3-resources/link-fixture/") ||
        key.startsWith("1-projects/portable-link-") ||
        key.startsWith("1-projects/deep/portable-link-") ||
        key.startsWith("1-projects/other-active/") ||
        key === "1-projects/earlier-ref.md" ||
        key === "4-archive/1-projects/earlier-thread.md" ||
        key === "1-projects/secret-thing/private-link.md") objects.delete(key);
  }
  objects.delete(`.context/moves/${otherMoveId}.json`);
}
