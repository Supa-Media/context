import { check, call, lacks, succeeded, objects, storedText, setConcurrentCreateOnAbsent } from "./harness.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";

export async function runPrivacyAclChecks() {
  // -- list/read scoping
  const lPub = (await call("pub-token", "list_notes"))?.content?.[0]?.text;
  check("team list hides privacy.md", lacks(lPub, "privacy.md"));
  check("team list hides private", lacks(lPub, "secret-thing") && lacks(lPub, "one-on-ones"));
  const rPub = await call("pub-token", "read_note", { path: "1-projects/secret-thing/status.md" });
  check("team read of private → not found", rPub.isError && rPub.content[0].text === "not found");
  const rPub2 = await call("pub-token", "read_note", { path: "2-areas/engineering/one-on-ones/alex.md" });
  check("deeper private rule beats team parent", rPub2.isError);
  const rPub3 = await call("pub-token", "read_note", { path: "2-areas/engineering/practices.md" });
  check("team reads team area", rPub3.content[0].text.includes("eng practices"));

  // -- writes
  const wPub = await call("pub-token", "write_note", { path: "2-areas/health/gym.md", content: "x" });
  check(
    "team write to private path returns non-leaking permission error",
    wPub.isError && wPub.content[0].text.includes("permission denied") && !wPub.content[0].text.includes("exists")
  );
  const wPub2 = await call("pub-token", "write_note", { path: "1-projects/togather/notes.md", content: "ok" });
  check("legacy public token writes to a team path", !wPub2.isError);
  setConcurrentCreateOnAbsent({
    key: "1-projects/concurrent-create.md",
    text: "human won the create race",
  });
  const racedCreate = await call("pub-token", "write_note", {
    path: "1-projects/concurrent-create.md",
    content: "agent must not overwrite",
  });
  check(
    "two concurrent creates have one winner and the later conditional create is refused",
    racedCreate?.isError === true &&
      racedCreate.content[0].text.includes("created while this write was in progress") &&
      storedText("1-projects/concurrent-create.md") === "human won the create race",
  );
  const wPubNewFolder = await call("pub-token", "write_note", {
    path: "2-areas/apps/new-folder-created-by-note.md",
    content: "public app-area note",
  });
  check(
    "team connection creates a new folder under a broad team PARA root",
    !wPubNewFolder.isError && objects.has("2-areas/apps/new-folder-created-by-note.md")
  );
  const wPubDeepFolder = await call("team-token", "write_note", {
    path: "2-areas/apps/created-entirely-through-mcp/deep/nested/status.md",
    content: "deep team path",
  });
  check(
    "team connection creates arbitrarily nested implicit folders under a team default",
    !wPubDeepFolder.isError &&
      objects.has("2-areas/apps/created-entirely-through-mcp/deep/nested/status.md")
  );

  // -- folder defaults can be managed entirely through the personal MCP
  const managedFolder = "2-areas/apps/mcp-managed-visibility";
  const managedTeamPath = `${managedFolder}/team-before-change.md`;
  const managedPrivatePath = `${managedFolder}/private-before-change.md`;
  await call("priv-token", "write_note", {
    path: managedTeamPath,
    content: "team before folder change",
    visibility: "team",
    confirm_team_publish: true,
  });
  await call("priv-token", "write_note", {
    path: managedPrivatePath,
    content: "private before folder change",
    visibility: "private",
  });
  const folderPrivacyDryRun = await call("priv-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "private",
    dry_run: true,
  });
  const folderPrivacyDryRunText = folderPrivacyDryRun.content[0].text;
  const folderPrivacyEtag = folderPrivacyDryRunText.match(/privacy_etag: (\S+)/)?.[1];
  check(
    "folder visibility dry-run reports impact and makes no change",
    !folderPrivacyDryRun.isError &&
      folderPrivacyDryRunText.includes("dry run: no changes made") &&
      folderPrivacyDryRunText.includes("resulting_default: private") &&
      succeeded(await call("team-token", "read_note", { path: managedTeamPath }))
  );
  const folderPrivacyMissingEtag = await call("priv-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "private",
  });
  check(
    "folder visibility apply requires the privacy manifest etag",
    folderPrivacyMissingEtag.isError && folderPrivacyMissingEtag.content[0].text.includes("dry_run=true")
  );
  const makeFolderPrivate = await call("priv-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "private",
    expected_privacy_etag: folderPrivacyEtag,
  });
  const makeFolderPrivateText = makeFolderPrivate.content[0].text;
  const privateFolderPrivacyEtag = makeFolderPrivateText.match(/new_privacy_etag: (\S+)/)?.[1];
  const privacyAfterFolderPrivate = storedText("privacy.md");
  check(
    "personal MCP atomically makes a folder private and hides every inherited note from team",
    !makeFolderPrivate.isError &&
      (await call("team-token", "read_note", { path: managedTeamPath }))?.isError &&
      (await call("team-token", "read_note", { path: managedPrivatePath }))?.isError &&
      privacyAfterFolderPrivate.includes(`  ${managedFolder}: private`)
  );
  /**
   * This check used to assert the opposite — that making a folder private removed
   * the now-redundant `private` override inside it. Since the fold, that line is
   * not only about its own path: it is the only thing narrowing every note that
   * folds onto it, including one in a differently-cased sibling folder that
   * `set_folder_visibility` never scans. Compacting it away published a private
   * note and reported `newly_team_visible_notes: 0`.
   *
   * The note's visibility is identical either way — it is private under the
   * folder rule and private under the override — so what was traded is a tidier
   * manifest for a fail-open publish, which is not a close call. A `team`
   * override that has become redundant is still compacted; only narrowings stay.
   */
  check(
    "a redundant exact-note narrowing is kept, because a twin may be relying on it",
    privacyAfterFolderPrivate.includes(`  ${managedPrivatePath}: private`) &&
      (await call("team-token", "read_note", { path: managedPrivatePath }))?.isError === true
  );
  const teamBlockedUnderManagedPrivate = await call("team-token", "write_note", {
    path: `${managedFolder}/team-must-not-create.md`,
    content: "blocked",
  });
  check(
    "team nested creation is blocked only when the inherited folder default is private",
    teamBlockedUnderManagedPrivate.isError && !objects.has(`${managedFolder}/team-must-not-create.md`)
  );
  const publishFolderWithoutConfirmation = await call("priv-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "inherit",
    expected_privacy_etag: privateFolderPrivacyEtag,
  });
  check(
    "private folder to inherited-team transition requires explicit confirmation",
    publishFolderWithoutConfirmation.isError &&
      (await call("team-token", "read_note", { path: managedTeamPath }))?.isError
  );
  const publishFolderWithConfirmation = await call("priv-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "inherit",
    expected_privacy_etag: privateFolderPrivacyEtag,
    confirm_team_publish: true,
  });
  check(
    "confirmed inheritance change republishes the folder and removes its direct rule",
    !publishFolderWithConfirmation.isError &&
      succeeded(await call("team-token", "read_note", { path: managedTeamPath })) &&
      !storedText("privacy.md").includes(`  ${managedFolder}: private`)
  );
  const teamCannotChangeFolderVisibility = await call("team-token", "set_folder_visibility", {
    path: managedFolder,
    visibility: "private",
    dry_run: true,
  });
  check("team connections cannot mutate folder defaults", teamCannotChangeFolderVisibility.isError);

  // -- per-note private/team visibility inside one logical folder
  const teamMeetingPath = "2-areas/engineering/meetings/team-planning.md";
  const privateMeetingPath = "2-areas/engineering/meetings/personnel-check-in.md";
  const teamMeeting = await call("priv-token", "write_note", {
    path: teamMeetingPath,
    content: "# Team planning\n\nTEAM-SIDE-BY-SIDE-MARKER",
    visibility: "team",
    confirm_team_publish: true,
  });
  const privateMeeting = await call("priv-token", "write_note", {
    path: privateMeetingPath,
    content: "# Personnel check-in\n\nPRIVATE-SIDE-BY-SIDE-MARKER",
    visibility: "private",
  });
  check(
    "personal connection creates private and team notes side-by-side in one team folder",
    !teamMeeting.isError &&
      !privateMeeting.isError &&
      objects.has(teamMeetingPath) &&
      objects.has(privateMeetingPath)
  );
  check(
    "write_note reports the effective visibility explicitly",
    /visibility:\s*team/i.test(teamMeeting.content[0].text) &&
      /visibility:\s*private/i.test(privateMeeting.content[0].text)
  );
  const teamReadsTeamMeeting = await call("team-token", "read_note", { path: teamMeetingPath });
  const teamReadsPrivateMeeting = await call("team-token", "read_note", { path: privateMeetingPath });
  check("team connection reads the adjacent team note", !teamReadsTeamMeeting.isError);
  check(
    "exact private note is indistinguishable from missing to a team connection",
    teamReadsPrivateMeeting.isError && teamReadsPrivateMeeting.content[0].text === "not found"
  );
  const teamMeetingList = (await call("team-token", "list_notes", {
    prefix: "2-areas/engineering/meetings",
  })).content[0].text;
  const teamPrivateSearch = (await call("team-token", "search_notes", {
    query: "PRIVATE-SIDE-BY-SIDE-MARKER",
  })).content[0].text;
  const teamOrientAfterPrivateNote = (await call("team-token", "orient"))?.content?.[0]?.text;
  check(
    "private note is absent from team listings",
    teamMeetingList.includes(teamMeetingPath) && !teamMeetingList.includes(privateMeetingPath)
  );
  check("private note content is absent from team search", !teamPrivateSearch.includes(privateMeetingPath));
  check(
    "private note name is absent from team orientation",
    lacks(teamOrientAfterPrivateNote, "personnel-check-in")
  );

  const privateScopeByPath = await call("priv-token", "scope_info", { path: privateMeetingPath });
  const teamScopeByPath = await call("priv-token", "scope_info", { path: teamMeetingPath });
  const hiddenScopeByPath = await call("team-token", "scope_info", { path: privateMeetingPath });
  const absentMeetingPath = "2-areas/engineering/meetings/absent-note.md";
  const absentScopeByPath = await call("team-token", "scope_info", { path: absentMeetingPath });
  check(
    "scope_info(path) tells a personal connection the exact effective visibility",
    privateScopeByPath.content[0].text.includes(privateMeetingPath) &&
      /visibility:\s*private/i.test(privateScopeByPath.content[0].text) &&
      teamScopeByPath.content[0].text.includes(teamMeetingPath) &&
      /visibility:\s*team/i.test(teamScopeByPath.content[0].text)
  );
  check(
    "scope_info(path) does not disclose a private override to a team connection",
    !/effective visibility:\s*private/i.test(hiddenScopeByPath.content[0].text) &&
      !/(?:note|path) exists:\s*(?:yes|true)/i.test(hiddenScopeByPath.content[0].text) &&
      hiddenScopeByPath.content[0].text.replaceAll(privateMeetingPath, "<path>") ===
        absentScopeByPath.content[0].text.replaceAll(absentMeetingPath, "<path>")
  );

  const personalPrivateRead = (await call("priv-token", "read_note", {
    path: privateMeetingPath,
  })).content[0].text;
  const privateMeetingEtag = personalPrivateRead.match(/etag: (\S+)/)?.[1];
  const privateUpdate = await call("priv-token", "write_note", {
    path: privateMeetingPath,
    content: "# Personnel check-in\n\nPRIVATE-UPDATED-MARKER",
    expected_etag: privateMeetingEtag,
  });
  check("updating a note without visibility preserves its private ACL", !privateUpdate.isError);
  check(
    "updated private note stays unreadable and unsearchable to team",
    (await call("team-token", "read_note", { path: privateMeetingPath }))?.isError &&
      lacks(
        (await call("team-token", "search_notes", { query: "PRIVATE-UPDATED-MARKER" }))?.content?.[0]?.text,
        privateMeetingPath
      )
  );

  const teamCannotCreatePrivatePath = "2-areas/engineering/meetings/team-cannot-hide.md";
  const teamPrivateWrite = await call("team-token", "write_note", {
    path: teamCannotCreatePrivatePath,
    content: "must not be filed",
    visibility: "private",
  });
  check(
    "team connection cannot directly create a private note",
    teamPrivateWrite.isError && !objects.has(teamCannotCreatePrivatePath)
  );
  const internetPublicWrite = await call("priv-token", "write_note", {
    path: "2-areas/engineering/meetings/internet-public.md",
    content: "must not become anonymous",
    visibility: "public",
  });
  check(
    "write_note exposes no internet-public visibility tier",
    internetPublicWrite.isError && !objects.has("2-areas/engineering/meetings/internet-public.md")
  );
  const misleadingFrontmatterPath = "2-areas/engineering/meetings/frontmatter-mismatch.md";
  const misleadingFrontmatter = await call("priv-token", "write_note", {
    path: misleadingFrontmatterPath,
    content: "---\nscope: private\n---\n# Sensitive",
    visibility: "team",
    confirm_team_publish: true,
  });
  check(
    "server rejects private frontmatter paired with team visibility",
    misleadingFrontmatter.isError && !objects.has(misleadingFrontmatterPath)
  );

  const teamMeetingRead = (await call("priv-token", "read_note", { path: teamMeetingPath }))?.content?.[0]?.text;
  const teamMeetingEtag = teamMeetingRead?.match(/etag: (\S+)/)?.[1];
  const makeMeetingPrivate = await call("priv-token", "set_visibility", {
    path: teamMeetingPath,
    visibility: "private",
    expected_etag: teamMeetingEtag,
  });
  check(
    "personal connection can narrow a team note to private in place",
    !makeMeetingPrivate.isError &&
      objects.has(teamMeetingPath) &&
      (await call("team-token", "read_note", { path: teamMeetingPath }))?.isError
  );
  const nowPrivateMeetingRead = (await call("priv-token", "read_note", {
    path: teamMeetingPath,
  })).content[0].text;
  const nowPrivateMeetingEtag = nowPrivateMeetingRead.match(/etag: (\S+)/)?.[1];
  const publishWithoutConfirmation = await call("priv-token", "set_visibility", {
    path: teamMeetingPath,
    visibility: "team",
    expected_etag: nowPrivateMeetingEtag,
  });
  check(
    "private to team transition requires explicit publication confirmation",
    publishWithoutConfirmation.isError &&
      (await call("team-token", "read_note", { path: teamMeetingPath }))?.isError
  );
  const publishWithConfirmation = await call("priv-token", "set_visibility", {
    path: teamMeetingPath,
    visibility: "team",
    expected_etag: nowPrivateMeetingEtag,
    confirm_team_publish: true,
  });
  check(
    "confirmed private to team transition publishes the same logical note",
    !publishWithConfirmation.isError &&
      objects.has(teamMeetingPath) &&
      succeeded(await call("team-token", "read_note", { path: teamMeetingPath }))
  );
  const teamCannotChangeVisibility = await call("team-token", "set_visibility", {
    path: teamMeetingPath,
    visibility: "private",
  });
  check("team connections cannot mutate note ACLs", teamCannotChangeVisibility.isError);

  const inheritedPrivatePath = "2-areas/private/meetings/inherited-private.md";
  const inheritedPrivateWrite = await call("priv-token", "write_note", {
    path: inheritedPrivatePath,
    content: "inherited private content",
    visibility: "private",
  });
  const inheritedPrivateEtag = (await call("priv-token", "read_note", {
    path: inheritedPrivatePath,
  }))?.content?.[0]?.text?.match(/etag: (\S+)/)?.[1];
  const publishInsidePrivateFolder = await call("priv-token", "set_visibility", {
    path: inheritedPrivatePath,
    visibility: "team",
    expected_etag: inheritedPrivateEtag,
    confirm_team_publish: true,
  });
  const createTeamInsidePrivateFolder = await call("priv-token", "write_note", {
    path: "2-areas/private/meetings/invalid-team-child.md",
    content: "must stay absent",
    visibility: "team",
  });
  check("private note can be created under an inherited-private folder", !inheritedPrivateWrite.isError);
  check(
    "explicitly confirmed exact team override works inside an inherited-private folder",
    !publishInsidePrivateFolder.isError &&
      createTeamInsidePrivateFolder.isError &&
      !objects.has("2-areas/private/meetings/invalid-team-child.md") &&
      succeeded(await call("team-token", "read_note", { path: inheritedPrivatePath }))
  );
  const teamUpdatesPublishedPrivateFolderNote = await call("team-token", "write_note", {
    path: inheritedPrivatePath,
    content: "team-updated exact exception",
    expected_etag: inheritedPrivateEtag,
  });
  check(
    "team connection can update a known exact-team note inside a private-default folder",
    !teamUpdatesPublishedPrivateFolderNote.isError
  );

  const teamToPrivateSource = "2-areas/engineering/meetings/team-to-private-move.md";
  await call("priv-token", "write_note", {
    path: teamToPrivateSource,
    content: "team note that will move into a private tree",
    visibility: "team",
    confirm_team_publish: true,
  });
  const teamToPrivateMove = await call("priv-token", "move_note", {
    source: teamToPrivateSource,
    destination: "2-areas/private/meetings/team-to-private-move.md",
  });
  check(
    "moving a team note into an inherited-private folder safely tightens access",
    !teamToPrivateMove.isError &&
      (await call("team-token", "read_note", {
        path: "2-areas/private/meetings/team-to-private-move.md",
      })).isError
  );

  const movePrivateMeeting = await call("priv-token", "move_note", {
    source: privateMeetingPath,
    destination: "2-areas/engineering/meetings/personnel-check-in-renamed.md",
  });
  const movedPrivateMeetingPath = "2-areas/engineering/meetings/personnel-check-in-renamed.md";
  check(
    "moving a private note within a team folder preserves its ACL",
    !movePrivateMeeting.isError &&
      objects.has(movedPrivateMeetingPath) &&
      isLogicalDeleteMarker(storedText(privateMeetingPath)) &&
      (await call("team-token", "read_note", { path: movedPrivateMeetingPath }))?.isError
  );
  const archivePrivateMeeting = await call("priv-token", "archive_note", {
    path: movedPrivateMeetingPath,
  });
  const archivedPrivateMeetingPath = archivePrivateMeeting.content[0].text.match(/→ (\S+)/)?.[1];
  check(
    "archiving a private note preserves private visibility and logical history",
    !archivePrivateMeeting.isError &&
      archivedPrivateMeetingPath &&
      objects.has(archivedPrivateMeetingPath) &&
      isLogicalDeleteMarker(storedText(movedPrivateMeetingPath)) &&
      (await call("team-token", "read_note", { path: archivedPrivateMeetingPath }))?.isError
  );

  // -- etag CAS + history
  const read1 = (await call("priv-token", "read_note", { path: "index.md" }))?.content?.[0]?.text;
  const etag = read1?.match(/etag: (\S+)/)?.[1];
  const beforeVersionlessWrite = storedText("index.md");
  const versionlessWrite = await call("priv-token", "write_note", {
    path: "index.md",
    content: "an agent replacement with no version",
  });
  check(
    "an existing collaborative note requires the exact version the agent read",
    versionlessWrite.isError &&
      versionlessWrite.content[0].text.includes("expected_etag") &&
      storedText("index.md") === beforeVersionlessWrite,
  );
  const wOk = await call("priv-token", "write_note", { path: "index.md", content: "v2", expected_etag: etag });
  check("CAS write with fresh etag ok", !wOk.isError);
  const wStale = await call("priv-token", "write_note", { path: "index.md", content: "v3", expected_etag: etag });
  const afterStaleMerge = (await call("priv-token", "read_note", { path: "index.md" })).content[0].text;
  check(
    "a retained stale collaboration base is merged instead of rejected",
    !wStale.isError && afterStaleMerge.includes("v2") && afterStaleMerge.includes("v3"),
  );
  check(
    "an overwrite writes no history snapshot",
    ![...objects.keys()].some((k) => k.startsWith(".history/"))
  );

  // -- search scoping
  const sPub = (await call("pub-token", "search_notes", { query: "status" }))?.content?.[0]?.text;
  check("team search hides private hits", lacks(sPub, "secret-thing"));
  const sPriv = (await call("priv-token", "search_notes", { query: "PRIVATEWORD" }))?.content?.[0]?.text;
  check("private search finds private", sPriv?.includes("secret-thing"));
  const sPrefixed = (await call("priv-token", "search_notes", {
    query: "portable",
    prefix: "1-projects/portable",
  })).content[0].text;
  check(
    "prefixed search stays inside the requested visible subtree",
    sPrefixed.includes("1-projects/portable/") && !sPrefixed.includes("2-areas/")
  );


}
