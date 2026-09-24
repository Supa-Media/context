import { check, rpc, call, lacks, succeeded, contextStore, objects, controlPlane, env, worker, storedText } from "./harness.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";

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
  const bigMove = await call("priv-token", "move_folder", {
    source: "1-projects/big-move",
    destination: "1-projects/big-moved",
  });
  const bigMoveId = bigMove.content[0].text.match(/move_id: (\S+)/)?.[1];
  check(
    "owner move_folder creates a logical move for a too-large tree",
    !bigMove.isError &&
      bigMoveId &&
      objects.has(`.context/moves/${bigMoveId}.json`) &&
      objects.has("1-projects/big-move/note-000.md") &&
      !objects.has("1-projects/big-moved/note-000.md")
  );
  check(
    "logical folder move makes destination readable before physical copy",
    succeeded(await call("priv-token", "read_note", { path: "1-projects/big-moved/note-000.md" }))
  );
  /*
    THE SOURCE PREFIX IS GONE, AND A READ OF IT IS FORWARDED RATHER THAN REFUSED.

    This check asserted `isError` until `forwarding.js` landed. The refusal was
    never the point — the point is that the source prefix stops being a live
    location, so a *write* there cannot land (checked below) and a read cannot be
    served the pre-move bytes and written back to a dead path.

    Forwarding keeps both of those and drops the collateral damage: the caller is
    handed the note at its *destination*, with `moved_from` naming the address
    they arrived on, so a client that reads-edits-writes uses the live path. A
    link pasted before the rename now opens, which is the whole reason the ledger
    exists. `canSee` is re-asked at the destination, so nothing widens — the
    private-override check immediately below still passes through the same path.
  */
  {
    const stale = await call("priv-token", "read_note", { path: "1-projects/big-move/note-000.md" });
    check(
      "a read of the moved-away source is forwarded to the destination, and says so",
      succeeded(stale) &&
        stale.content[0].text.includes("path: 1-projects/big-moved/note-000.md") &&
        stale.content[0].text.includes("moved_from: 1-projects/big-move/note-000.md")
    );
  }
  check(
    "logical folder move preserves exact private overrides at the destination",
    (await call("pub-token", "read_note", { path: "1-projects/big-moved/note-501.md" })).isError
  );
  check(
    "logical folder move refuses writes under the moved-away source prefix",
    (await call("priv-token", "write_note", {
      path: "1-projects/big-move/new-private.md",
      content: "post-cutover write",
      visibility: "private",
    })).isError &&
      !objects.has("1-projects/big-move/new-private.md")
  );
  const bigList = (await call("priv-token", "list_notes", { prefix: "1-projects/big-moved" })).content[0].text;
  const oldBigList = (await call("priv-token", "list_notes", { prefix: "1-projects/big-move" })).content[0].text;
  const bigSearchDestination = (await call("priv-token", "search_notes", {
    query: "big 000",
    prefix: "1-projects/big-moved",
  })).content[0].text;
  const bigSearchSource = (await call("priv-token", "search_notes", {
    query: "big 000",
    prefix: "1-projects/big-move",
  })).content[0].text;
  const bigSearchUnprefixed = (await call("priv-token", "search_notes", {
    query: "big 000",
  })).content[0].text;
  check(
    "logical folder move lists destination keys from the source prefix",
    bigList.includes("1-projects/big-moved/note-000.md") &&
      !bigList.includes("1-projects/big-move/note-000.md") &&
      oldBigList === "(no visible notes under that prefix)"
  );
  check(
    "logical folder move makes fallback search destination-aware",
    bigSearchDestination.includes("1-projects/big-moved/note-000.md") &&
      !bigSearchDestination.includes("1-projects/big-move/note-000.md") &&
      !bigSearchSource.includes("1-projects/big-move/note-000.md") &&
      bigSearchUnprefixed.includes("1-projects/big-moved/note-000.md") &&
      !bigSearchUnprefixed.includes("1-projects/big-move/note-000.md")
  );
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
    (await call("pub-token", "materialize_move", { id: bigMoveId })).isError
  );
  await contextStore.delete(`.context/moves/${bigMoveId}.json`);
  await call("priv-token", "materialize_move", { id: bigMoveId });
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/big-missing/note-${suffix}.md`, `missing ${suffix}`);
  }
  const missingMove = await call("priv-token", "move_folder", {
    source: "1-projects/big-missing",
    destination: "1-projects/big-missing-moved",
  });
  const missingMoveId = missingMove.content[0].text.match(/move_id: (\S+)/)?.[1];
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
  for (let i = 0; i < 501; i += 1) {
    const suffix = String(i).padStart(3, "0");
    await contextStore.put(`1-projects/big-complete/note-${suffix}.md`, `complete ${suffix}`);
  }
  await contextStore.put("1-projects/big-complete-link.md", "[[1-projects/big-complete/note-000]]");
  await contextStore.put("1-projects/big-complete/note-001.md", "[[../big-complete-link]]");
  const completeMove = await call("priv-token", "move_folder", {
    source: "1-projects/big-complete",
    destination: "2-areas/deep/big-complete-moved",
  });
  const completeMoveId = completeMove.content[0].text.match(/move_id: (\S+)/)?.[1];
  let completeMaterialize = completeMove;
  for (let i = 0; i < 20 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${completeMoveId}.json`)); i += 1) {
    completeMaterialize = await call("priv-token", "materialize_move", {
      id: completeMoveId,
      batch_size: 100,
    });
  }
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
  const queuedMove = await call("priv-token", "move_folder", {
    source: "1-projects/queued-move",
    destination: "1-projects/queued-moved",
  });
  const queuedMoveId = queuedMove.content[0].text.match(/move_id: (\S+)/)?.[1];
  check(
    "large logical move enqueues a durable gateway job without credentials",
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
      firstProgressReport.body.result.progress.completed > 0 &&
      firstProgressReport?.body?.result?.progress?.total === 501 &&
      !JSON.stringify(firstProgressReport.body.result.progress).includes("queued-move")
  );
  for (let i = 0; i < 20 &&
    !isLogicalDeleteMarker(storedText(`.context/moves/${queuedMoveId}.json`)); i += 1) {
    const message = queuedGatewayMessages.shift();
    if (!message) break;
    await worker.queue({ messages: [{ body: message }] }, env);
  }
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


}
