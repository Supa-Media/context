import { check, rpc, call, lacks, succeeded, contextStore, objects, controlPlane, env, worker, storedText, WORKSPACE_ID } from "./harness.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";
import { readDocument as readCollaborationDocument } from "@context/collaboration";
import { checkSettledConcurrentFailure, finishMoveWithBoundedCleanup } from "./moveCleanupChecks.mjs";
import { seedLegacyFolderMove, seedLegacyReferenceJob } from "./legacyMoveJob.mjs";

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
  // A job an older gateway left behind still finishes (below); until the
  // drain copies a note, the note is where the bucket holds it.
  const bigMoveId = await seedLegacyFolderMove(contextStore, "1-projects/big-move", "1-projects/big-moved");
  check(
    "a legacy move job is not read on the way to a note: its destination is absent until copied",
    (await call("priv-token", "read_note", { path: "1-projects/big-moved/note-000.md" })).isError &&
      succeeded(await call("priv-token", "read_note", { path: "1-projects/big-move/note-000.md" }))
  );
  check(
    "a draining legacy move still refuses writes under its source prefix",
    (await call("priv-token", "write_note", {
      path: "1-projects/big-move/new-private.md",
      content: "post-cutover write",
      visibility: "private",
    })).isError &&
      !objects.has("1-projects/big-move/new-private.md")
  );
  const bigList = (await call("priv-token", "list_notes", { prefix: "1-projects/big-move" })).content[0].text;
  check(
    "a listing draws the tree, not the job",
    bigList.includes("1-projects/big-move/note-000.md") && !bigList.includes("1-projects/big-moved/")
  );
  const markerBeforeInspection = storedText(`.context/moves/${bigMoveId}.json`);
  const inspection = await call("priv-token", "materialize_move", { id: bigMoveId, batch_size: 0 });
  check("zero batch inspects without moving", !inspection.isError && inspection.content[0].text.includes("references_scanned: 0/0") && inspection.content[0].text.includes("next_source: 1-projects/big-move/note-000.md") && storedText(`.context/moves/${bigMoveId}.json`) === markerBeforeInspection && !objects.has("1-projects/big-moved/note-000.md"));
  const legacyInspection = await call("priv-token", "materialize_move", { id: `${bigMoveId}:inspect`, batch_size: 1 });
  check("cached connector inspection does not move", legacyInspection.content[0].text === inspection.content[0].text && storedText(`.context/moves/${bigMoveId}.json`) === markerBeforeInspection);
  await contextStore.put("1-projects/big-moved/note-000.md", "user edit during pending move");
  let materialized = await call("priv-token", "materialize_move", { id: bigMoveId, batch_size: 100 });
  check(
    "materialize_move pauses rather than clobbering a destination edit",
    materialized.isError &&
      storedText("1-projects/big-moved/note-000.md") === "user edit during pending move" &&
      objects.has(`.context/moves/${bigMoveId}.json`)
  );
  await contextStore.delete("1-projects/big-moved/note-000.md");
  materialized = await call("priv-token", "materialize_move", { id: bigMoveId, batch_size: 100 });
  check(
    "materialize_move copies a bounded batch without deleting sources early",
    !materialized.isError &&
      materialized.content[0].text.includes("copying") &&
      objects.has("1-projects/big-moved/note-000.md") &&
      objects.has("1-projects/big-move/note-000.md")
  );
  await contextStore.put("1-projects/big-move/note-000.md", "post cutover source edit");
  for (let i = 0; i < 20 && objects.has(`.context/moves/${bigMoveId}.json`); i += 1) {
    materialized = await call("priv-token", "materialize_move", { id: bigMoveId, batch_size: 100 });
  }
  check(
    "materialize_move preserves post-cutover source edits instead of deleting them",
    materialized.isError &&
      objects.has(`.context/moves/${bigMoveId}.json`) &&
      objects.has("1-projects/big-moved/note-501.md") &&
      storedText("1-projects/big-move/note-000.md") === "post cutover source edit"
  );
  const teamMaterializeTools =
    (await rpc("pub-token", "tools/list"))?.result?.tools?.map((tool) => tool.name) ?? [];
  check(
    "materialize_move is not advertised outside owner scope",
    !teamMaterializeTools.includes("materialize_move")
  );
  check(
    "materialize_move direct calls are masked outside owner scope",
    (await call("pub-token", "materialize_move", { id: bigMoveId, batch_size: 0 })).isError
  );
  await contextStore.delete(`.context/moves/${bigMoveId}.json`);
  await call("priv-token", "materialize_move", { id: bigMoveId });
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/big-missing/note-${suffix}.md`, `missing ${suffix}`);
  }
  const missingMoveId = await seedLegacyFolderMove(contextStore, "1-projects/big-missing", "1-projects/big-missing-moved");
  await contextStore.delete("1-projects/big-missing/note-000.md");
  const missingMaterialize = await call("priv-token", "materialize_move", {
    id: missingMoveId,
    batch_size: 100,
  });
  check(
    "materialize_move pauses honestly when a captured source disappears before copy",
      missingMaterialize.isError &&
      objects.has(`.context/moves/${missingMoveId}.json`) &&
      !objects.has("1-projects/big-missing-moved/note-000.md")
  );
  await contextStore.delete(`.context/moves/${missingMoveId}.json`);
  for (let i = 0; i < 101; i += 1) {
    await contextStore.put(`1-projects/retargeted/note-${i}.md`,
      i === 0 ? "Contact [site](https://old.example)" : `record ${i}`);
  }
  const retargetedId = await seedLegacyFolderMove(contextStore, "1-projects/retargeted", "4-archive/1-projects/retargeted");
  await contextStore.put("4-archive/1-projects/retargeted/note-0.md",
    "Contact [site](https://new.example)");
  let retargetedResult = await call("priv-token", "materialize_move", {
    id: retargetedId, batch_size: 1,
  });
  await contextStore.delete("4-archive/1-projects/retargeted/note-1.md");
  for (let i = 0; i < 10 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${retargetedId}.json`)); i += 1) {
    retargetedResult = await call("priv-token", "materialize_move", {
      id: retargetedId, batch_size: 100,
    });
    if (retargetedResult.isError) break;
  }
  check("materialization preserves a destination whose link targets alone changed",
    !retargetedResult?.isError &&
      storedText("4-archive/1-projects/retargeted/note-0.md") ===
        "Contact [site](https://new.example)" &&
      isLogicalDeleteMarker(storedText("1-projects/retargeted/note-0.md")) &&
      storedText("4-archive/1-projects/retargeted/note-1.md") === "record 1" &&
      isLogicalDeleteMarker(storedText("1-projects/retargeted/note-1.md")));
  await contextStore.delete(`.context/moves/${retargetedId}.json`);
  for (let i = 0; i < 101; i += 1) {
    await contextStore.put(`2-areas/communications/generated-conflict/note-${i}.md`,
      `---\nsource: imessage\ngenerated: 2026-08-31\n---\n\nOriginal message ${i}`);
  }
  const conflictId = await seedLegacyFolderMove(contextStore, "2-areas/communications/generated-conflict", "4-archive/2-areas/communications/generated-conflict");
  await contextStore.put("4-archive/2-areas/communications/generated-conflict/note-0.md",
    "---\nsource: imessage\ngenerated: 2026-08-31\n---\n\nUpdated message 0");
  let conflictResult;
  for (let i = 0; i < 10 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${conflictId}.json`)); i += 1) {
    conflictResult = await call("priv-token", "materialize_move", {
      id: conflictId, batch_size: 100,
    });
    if (conflictResult.isError) break;
  }
  const conflictBackup =
    `4-archive/2-areas/communications/generated-conflict/note-0.move-conflict-${conflictId}.md`;
  check("generated communication conflicts preserve both versions",
    !conflictResult?.isError &&
      storedText(conflictBackup)?.includes("Original message 0") &&
      storedText("4-archive/2-areas/communications/generated-conflict/note-0.md")?.includes("Updated message 0") &&
      isLogicalDeleteMarker(storedText("2-areas/communications/generated-conflict/note-0.md")));
  await contextStore.delete(`.context/moves/${conflictId}.json`);
  for (let i = 0; i < 101; i += 1) {
    await contextStore.put(`2-areas/communications/headed-conflict/note-${i}.md`,
      `---\nsource: imessage\ngenerated: 2026-08-31\n---\n\nOriginal message ${i}`);
  }
  await call("priv-token", "read_note", {
    path: "2-areas/communications/headed-conflict/note-0.md",
  });
  const headedConflictId = await seedLegacyFolderMove(contextStore, "2-areas/communications/headed-conflict", "4-archive/2-areas/communications/headed-conflict");
  await call("priv-token", "materialize_move", { id: headedConflictId, batch_size: 1 });
  await readCollaborationDocument(contextStore,
    "4-archive/2-areas/communications/headed-conflict/note-0.md");
  let headedConflictResult;
  for (let i = 0; i < 10 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${headedConflictId}.json`)); i += 1) {
    headedConflictResult = await call("priv-token", "materialize_move", {
      id: headedConflictId, batch_size: 100,
    });
    if (headedConflictResult.isError) break;
  }
  const headedBackup =
    `4-archive/2-areas/communications/headed-conflict/note-0.move-collaboration-conflict-${headedConflictId}.md`;
  check("a generated note with distinct collaboration identities keeps both histories",
    !headedConflictResult?.isError &&
      storedText(headedBackup)?.includes("Original message 0") &&
      storedText("4-archive/2-areas/communications/headed-conflict/note-0.md")?.includes("Original message 0") &&
      isLogicalDeleteMarker(storedText("2-areas/communications/headed-conflict/note-0.md")));
  await contextStore.delete(`.context/moves/${headedConflictId}.json`);
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/big-complete/note-${suffix}.md`, `complete ${suffix}`);
  }
  await contextStore.put("1-projects/big-complete-link.md", "[[1-projects/big-complete/note-000]]");
  await contextStore.put("1-projects/big-complete/note-001.md", "[[../big-complete-link]]");
  const completeMoveId = await seedLegacyFolderMove(contextStore, "1-projects/big-complete", "2-areas/deep/big-complete-moved");
  const completeMaterialize = await finishMoveWithBoundedCleanup(completeMoveId, null);
  check(
    "materialize_move completes a logical move and removes the source objects",
    !completeMaterialize.isError &&
      completeMaterialize.content[0].text.includes("complete") &&
      isLogicalDeleteMarker(storedText(`.context/moves/${completeMoveId}.json`)) &&
      isLogicalDeleteMarker(storedText("1-projects/big-complete/note-000.md")) &&
      objects.has("2-areas/deep/big-complete-moved/note-000.md")
  );
  check(
    "logical folder move rewrites references when the move is activated",
    storedText("1-projects/big-complete-link.md") === "[[2-areas/deep/big-complete-moved/note-000]]" &&
      storedText("2-areas/deep/big-complete-moved/note-001.md") ===
        "[[../../../1-projects/big-complete-link]]"
  );
  await checkSettledConcurrentFailure();
  const queuedGatewayMessages = [];
  env.GATEWAY_JOBS = {
    async send(message) {
      queuedGatewayMessages.push(message);
    },
  };
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/queued-move/note-${suffix}.md`, `queued ${suffix}`);
  }
  const queuedMoveId = await seedLegacyFolderMove(contextStore, "1-projects/queued-move", "1-projects/queued-moved");
  // A legacy job is handed to the durable queue by the owner's resume (an
  // older gateway enqueued it at cutover); the resume itself copies one.
  await call("priv-token", "materialize_move", { id: queuedMoveId, batch_size: 1, resume_background: true });
  check(
    "a resumed legacy move enqueues a durable gateway job without credentials",
    queuedGatewayMessages.length === 1 &&
      queuedGatewayMessages[0]?.ticket === "job-ticket-1" &&
      queuedGatewayMessages[0]?.kind === "materialize_move" &&
      queuedGatewayMessages[0]?.moveId === queuedMoveId &&
      !JSON.stringify(queuedGatewayMessages[0]).includes("cat_test_owner")
  );
  const firstQueuedMessage = queuedGatewayMessages.shift();
  await worker.queue({ messages: [{ body: firstQueuedMessage }] }, env);
  const firstProgressReport = [...controlPlane.calls]
    .reverse()
    .find((entry) => entry.path === "/gateway/jobs/report");
  check(
    "queue consumer reports bounded move progress without note paths",
    firstProgressReport?.body?.result?.status === "queued" &&
      firstProgressReport?.body?.result?.progress?.phase === "copying" &&
      Number.isInteger(firstProgressReport?.body?.result?.progress?.completed) &&
      firstProgressReport.body.result.progress.completed === 21 &&
      firstProgressReport?.body?.result?.progress?.total === 501 &&
      !JSON.stringify(firstProgressReport.body.result.progress).includes("queued-move")
  );
  let observedReferenceBatch = false;
  for (let i = 0; i < 1200 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${queuedMoveId}.json`)); i += 1) {
    const message = queuedGatewayMessages.shift();
    if (!message) break;
    const beforeText = storedText(`.context/moves/${queuedMoveId}.json`);
    await worker.queue({ messages: [{ body: message }] }, env);
    const afterText = storedText(`.context/moves/${queuedMoveId}.json`);
    if (!isLogicalDeleteMarker(beforeText) && !isLogicalDeleteMarker(afterText)) {
      const before = JSON.parse(beforeText);
      const after = JSON.parse(afterText);
      if (before.status === "rewriting" && after.reference_scanned > (before.reference_scanned || 0)) {
        observedReferenceBatch = after.reference_scanned - (before.reference_scanned || 0) <= 5;
      }
    }
  }
  check("queue link sweeps use a smaller bounded batch while copies still use twenty",
    observedReferenceBatch);
  check(
    "queue consumer materializes a large logical move across bounded passes",
    isLogicalDeleteMarker(storedText(`.context/moves/${queuedMoveId}.json`)) &&
      isLogicalDeleteMarker(storedText("1-projects/queued-move/note-000.md")) &&
      objects.has("1-projects/queued-moved/note-000.md")
  );
  delete env.GATEWAY_JOBS;
  for (let i = 0; i < 502; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.delete(`1-projects/big-move/note-${suffix}.md`);
    await contextStore.delete(`1-projects/big-moved/note-${suffix}.md`);
  }
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.delete(`1-projects/big-missing/note-${suffix}.md`);
    await contextStore.delete(`1-projects/big-missing-moved/note-${suffix}.md`);
    await contextStore.delete(`1-projects/big-complete/note-${suffix}.md`);
    await contextStore.delete(`2-areas/deep/big-complete-moved/note-${suffix}.md`);
    await contextStore.delete(`1-projects/queued-move/note-${suffix}.md`);
    await contextStore.delete(`1-projects/queued-moved/note-${suffix}.md`);
  }
  await contextStore.delete("1-projects/big-complete-link.md");

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
  const referenceMessages = [];
  env.GATEWAY_JOBS = { async send(message) { referenceMessages.push(message); } };
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
      referenceMessages.length === 0 &&
      [...objects.keys()].filter((key) => key.startsWith(".context/moves/")).length === jobFilesBefore);
  const linkJobId = await seedLegacyReferenceJob(contextStore, [
    ["1-projects/portable-link-target/note.md", "1-projects/deep/portable-link-moved/note.md"],
  ]);
  const profileMarker = storedText(`.context/moves/${linkJobId}.json`);
  const profile = await call("priv-token", "materialize_move", { id: `${linkJobId}:profile`, batch_size: 1 });
  check("owner can profile without changing the marker; other scopes are masked",
    !profile.isError && profile.content[0].text.includes("note inventory:") &&
    profile.content[0].text.includes("active move markers:") &&
    storedText(`.context/moves/${linkJobId}.json`) === profileMarker &&
    (await call("pub-token", "materialize_move", { id: `${linkJobId}:profile`, batch_size: 1 })).isError);
  const restarted = await call("priv-token", "materialize_move", {
    id: linkJobId,
    batch_size: 1,
    resume_background: true,
  });
  check("an owner can restart a stalled reference worker",
    !restarted.isError && restarted.content[0].text.includes("background worker queued") &&
      referenceMessages.length === 1);
  const inventoryAfterFirstPass = JSON.parse(storedText(`.context/moves/${linkJobId}.json`));
  /*
    Asked from the owner's connection, the pass takes the whole reference
    inventory from the Convex tree in one step (`references.js`) rather than
    a bucket page per pass; the background worker, which has no grant to ask
    the tree with, still pages the bucket (the queued move above). This
    replaces "reference inventory saves its first storage page" and
    "...resumes from the saved cursor", which held the request's bucket pages.
  */
  check("an owner's pass takes the reference inventory from the tree in one step",
    inventoryAfterFirstPass.reference_inventory_complete === true &&
      inventoryAfterFirstPass.reference_inventory_pages === undefined &&
      inventoryAfterFirstPass.reference_inventory_keys.includes("1-projects/deep/portable-link-moved/note.md"));
  const queuedBeforeFreshPass = referenceMessages.length;
  const freshPass = await call("priv-token", "materialize_move", {
    id: linkJobId, batch_size: 1,
  });
  check("a fresh move pass does not queue a duplicate worker",
    !freshPass.isError && referenceMessages.length === queuedBeforeFreshPass);
  const staleKey = `.context/moves/${linkJobId}.json`;
  const staleJob = JSON.parse(storedText(staleKey));
  staleJob.updated_at = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await contextStore.put(staleKey, JSON.stringify(staleJob));
  const stalePass = await call("priv-token", "materialize_move", {
    id: linkJobId, batch_size: 1,
  });
  check("an ordinary materialize call revives a stalled background worker",
    !stalePass.isError && stalePass.content[0].text.includes("background worker queued") &&
      referenceMessages.length === queuedBeforeFreshPass + 1);
  delete env.GATEWAY_JOBS;
  let profiledCheckpoint = false;
  for (let i = 0; i < 100 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${linkJobId}.json`)); i += 1) {
    const progress = await call("priv-token", "materialize_move", { id: linkJobId, batch_size: 100 });
    if (progress?.isError) break;
    const markerText = storedText(`.context/moves/${linkJobId}.json`);
    if (!profiledCheckpoint && !isLogicalDeleteMarker(markerText) &&
        JSON.parse(markerText).reference_inventory_complete === true) {
      const checkpointProfile = await call("priv-token", "materialize_move", {
        id: `${linkJobId}:profile`, batch_size: 1,
      });
      profiledCheckpoint = !checkpointProfile.isError &&
        checkpointProfile.content[0].text.includes("checkpointed inventory:") &&
        !checkpointProfile.content[0].text.includes("note inventory:");
    }
  }
  check("owner profiles the checkpointed reference inventory without a fresh bucket walk",
    profiledCheckpoint);
  check("queued reference repair updates inbound and moved-note relative links",
    isLogicalDeleteMarker(storedText(`.context/moves/${linkJobId}.json`)) &&
      storedText("1-projects/portable-link-ref.md") === "[[1-projects/deep/portable-link-moved/note]]" &&
      storedText("1-projects/deep/portable-link-moved/note.md") === "[outside](../../portable-link-ref.md)");
  check("owner reference repair also updates private notes",
    storedText("1-projects/secret-thing/private-link.md") === "[[1-projects/deep/portable-link-moved/note]]");
  check("reference repair follows an earlier move in the forwarding ledger",
    storedText("1-projects/earlier-ref.md") === "[[4-archive/1-projects/earlier-thread]]");
  check("reference repair leaves another active move's source untouched",
    storedText("1-projects/other-active/note.md") === "[[1-projects/portable-link-target/note]]");
  for (const key of [...objects.keys()]) {
    if (key.startsWith("3-resources/link-fixture/") ||
        key.startsWith("1-projects/portable-link-") ||
        key.startsWith("1-projects/deep/portable-link-") ||
        key.startsWith("1-projects/other-active/") ||
        key === "1-projects/earlier-ref.md" ||
        key === "4-archive/1-projects/earlier-thread.md" ||
        key === "1-projects/secret-thing/private-link.md") objects.delete(key);
  }
  objects.delete(`.context/moves/${linkJobId}.json`);
  objects.delete(`.context/moves/${otherMoveId}.json`);


}
