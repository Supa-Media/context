import {
  check,
  call,
  lacks,
  succeeded,
  objects,
  storedText,
  setConcurrentCreateOnAbsent,
  setEnforceOneUseBodies,
} from "./harness.mjs";
import { isLogicalDeleteMarker } from "../src/store/logicalDelete.js";

export async function runProposalsAndArchiveChecks() {
  // -- archive
  const arch = await call("priv-token", "archive_note", { path: "1-projects/togather/notes.md" });
  const privateArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/notes.md"));
  check(
    "archive preserves private ACL without a privacy-named folder",
    !arch.isError &&
      privateArchiveKey?.startsWith("4-archive/") &&
      !privateArchiveKey.startsWith("4-archive/private/") &&
      (await call("team-token", "read_note", { path: privateArchiveKey }))?.isError &&
      isLogicalDeleteMarker(storedText("1-projects/togather/notes.md"))
  );
  await call("pub-token", "write_note", { path: "1-projects/togather/probe.md", content: "temporary probe" });
  const probeRead = (await call("pub-token", "read_note", { path: "1-projects/togather/probe.md" }))?.content?.[0]?.text;
  const probeEtag = probeRead?.match(/etag: (\S+)/)?.[1];
  const publicArchiveWithoutEtag = await call("pub-token", "archive_note", {
    path: "1-projects/togather/probe.md",
  });
  check("team archive requires etag", publicArchiveWithoutEtag.isError && objects.has("1-projects/togather/probe.md"));
  const publicArchive = await call("pub-token", "archive_note", {
    path: "1-projects/togather/probe.md",
    expected_etag: probeEtag,
  });
  const publicArchiveKey = [...objects.keys()].find((key) => key.endsWith("/1-projects/togather/probe.md"));
  check(
    "team archive retracts into team-visible recoverable archive",
    !publicArchive.isError &&
      publicArchiveKey?.startsWith("4-archive/") &&
      !publicArchiveKey.startsWith("4-archive/team/") &&
      isLogicalDeleteMarker(storedText("1-projects/togather/probe.md"))
  );

  // -- private-approval proposal queue
  const proposal = await call("pub-token", "propose_note", {
    path: "2-areas/private/apps/example.md",
    content: "# Proposed app note",
    reason: "Apps belong in the apps area",
    agent: "Claude Code",
  });
  const proposalText = proposal.content[0].text;
  const proposalId = proposalText.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
  check(
    "team connection can queue a private-destination proposal without filing it",
    !proposal.isError && proposalId && !objects.has("2-areas/private/apps/example.md")
  );
  const publicProposalList = await call("pub-token", "list_proposals");
  check("team connection cannot inspect proposal queue", publicProposalList.isError);
  const privateProposalList = (await call("priv-token", "list_proposals"))?.content?.[0]?.text;
  check(
    "private connection lists proposal metadata",
    privateProposalList?.includes(proposalId) &&
      privateProposalList?.includes("2-areas/private/apps/example.md") &&
      lacks(privateProposalList, "# Proposed app note")
  );
  const privateProposalRead = (await call("priv-token", "read_proposal", { id: proposalId }))?.content?.[0]?.text;
  check("private connection reads proposal content", privateProposalRead?.includes("# Proposed app note"));
  const approveProposal = await call("priv-token", "review_proposal", {
    id: proposalId,
    action: "approve",
  });
  check(
    "private approval files proposal and clears pending queue",
    !approveProposal.isError && objects.has("2-areas/private/apps/example.md") &&
      (await call("priv-token", "list_proposals"))?.content?.[0]?.text.includes("no pending")
  );
  const racedProposal = await call("pub-token", "propose_note", {
    path: "2-areas/private/apps/raced-approval.md",
    content: "# Proposed content that must not overwrite",
    reason: "Exercise the approval destination create race",
    agent: "Claude Code",
  });
  const racedProposalId = racedProposal.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
  setConcurrentCreateOnAbsent({
    key: "2-areas/private/apps/raced-approval.md",
    text: "# Human-created winner",
  });
  const racedApproval = await call("priv-token", "review_proposal", {
    id: racedProposalId,
    action: "approve",
  });
  check(
    "proposal approval never overwrites a note created after its preflight",
    racedApproval.isError &&
      storedText("2-areas/private/apps/raced-approval.md") === "# Human-created winner",
  );
  check(
    "a proposal whose destination raced remains pending for another review",
    (await call("priv-token", "list_proposals"))?.content?.[0]?.text.includes(racedProposalId),
  );
  await call("priv-token", "review_proposal", { id: racedProposalId, action: "reject" });
  const rejectedProposal = await call("pub-token", "propose_note", {
    path: "2-areas/private/apps/rejected.md",
    content: "reject me",
    reason: "testing rejection",
    agent: "Claude Code",
  });
  const rejectedId = rejectedProposal.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
  const rejectReview = await call("priv-token", "review_proposal", { id: rejectedId, action: "reject" });
  check("private rejection preserves no destination note", !rejectReview.isError && !objects.has("2-areas/private/apps/rejected.md"));

  // -- privacy-aware chat history archives
  const privateChatArchive = await call("priv-token", "save_context", {
    platform: "codex",
    history: "## User\nBuild the Workspace.\n\n## Assistant\nDone.",
    completeness: "full-visible-transcript",
    title: "Private Codex transcript",
    session_id: "thread-private-1",
  });
  const privateChatPath = privateChatArchive.content[0].text.match(/saved: (\S+)/)?.[1];
  check(
    "private connection defaults chat history to private",
    !privateChatArchive.isError &&
      privateChatPath?.startsWith("4-archive/chat-history/codex/") &&
      storedText(privateChatPath).includes('visibility: "private"') &&
      storedText(privateChatPath).includes('completeness: "full-visible-transcript"')
  );
  const publicReadPrivateChat = await call("pub-token", "read_note", { path: privateChatPath });
  check("team connection cannot discover private chat history", publicReadPrivateChat.isError && publicReadPrivateChat.content[0].text === "not found");

  const privatePublishedChat = await call("priv-token", "save_context", {
    platform: "chatgpt",
    history: "## User\nPublish this chat.\n\n## Assistant\nPublished.",
    visibility: "team",
    confirm_team_publish: true,
    completeness: "available-context",
  });
  const privatePublishedPath = privatePublishedChat.content[0].text.match(/saved: (\S+)/)?.[1];
  check(
    "personal connection can explicitly publish a chat archive to team visibility",
    !privatePublishedChat.isError &&
      privatePublishedPath?.startsWith("4-archive/chat-history/chatgpt/") &&
      succeeded(await call("pub-token", "read_note", { path: privatePublishedPath }))
  );

  const publicChatArchive = await call("pub-token", "save_context", {
    platform: "claude",
    history: "## User\nTeam by default?\n\n## Assistant\nYes.",
  });
  const publicChatPath = publicChatArchive.content[0].text.match(/saved: (\S+)/)?.[1];
  check(
    "team connection defaults chat history to team and labels partial context",
    !publicChatArchive.isError &&
      publicChatPath?.startsWith("4-archive/chat-history/claude/") &&
      storedText(publicChatPath).includes('visibility: "team"') &&
      storedText(publicChatPath).includes('completeness: "available-context"')
  );

  const publicPrivateChat = await call("pub-token", "save_context", {
    platform: "claude",
    history: "## User\nMake this one private.\n\n## Assistant\nQueued privately.",
    visibility: "private",
    completeness: "full-visible-transcript",
  });
  const privateChatProposalId = publicPrivateChat.content[0].text.match(/proposal queued: ([0-9a-f-]+)/i)?.[1];
  const privateChatIntendedPath = publicPrivateChat.content[0].text.match(/intended path: (\S+)/)?.[1];
  check(
    "team connection explicitly requesting private chat history creates a hidden proposal",
    !publicPrivateChat.isError &&
      privateChatProposalId &&
      privateChatIntendedPath?.startsWith("4-archive/chat-history/claude/") &&
      !objects.has(privateChatIntendedPath)
  );
  const approvePrivateChat = await call("priv-token", "review_proposal", {
    id: privateChatProposalId,
    action: "approve",
  });
  check(
    "personal reviewer can approve a team client's private chat archive",
    !approvePrivateChat.isError &&
      objects.has(privateChatIntendedPath) &&
      (await call("pub-token", "read_note", { path: privateChatIntendedPath }))?.isError
  );

  // archive_chat must respect the folder default the way write_note does. Make
  // one platform's archive folder private and check that a team connection can no
  // longer plant a team-visible note in it — while the sanctioned route into a
  // private destination, a proposal for the owner to review, still works.
  const notionFolderDry = await call("priv-token", "set_folder_visibility", {
    path: "4-archive/chat-history/notion",
    visibility: "private",
    dry_run: true,
  });
  const notionPrivacyEtag = notionFolderDry.content[0].text.match(/privacy_etag: (\S+)/)?.[1];
  const notionFolderApply = await call("priv-token", "set_folder_visibility", {
    path: "4-archive/chat-history/notion",
    visibility: "private",
    expected_privacy_etag: notionPrivacyEtag,
  });
  check(
    "a folder default can be tightened to private for the archive_chat check",
    !notionFolderApply.isError
  );
  const teamArchiveIntoPrivateFolder = await call("pub-token", "save_context", {
    platform: "notion",
    history: "## User\nLand this in a private-default folder.\n\n## Assistant\nShould not.",
  });
  check(
    "archive_chat refuses a team connection writing into a private-default folder",
    teamArchiveIntoPrivateFolder.isError &&
      ![...objects.keys()].some(
        (key) => key.startsWith("4-archive/chat-history/notion/") && !key.startsWith(".")
      )
  );
  check(
    "and refuses it with the same permission error write_note uses, naming no path",
    teamArchiveIntoPrivateFolder.content[0].text.startsWith("permission denied:") &&
      !teamArchiveIntoPrivateFolder.content[0].text.includes("4-archive/chat-history") &&
      !teamArchiveIntoPrivateFolder.content[0].text.includes("notion")
  );
  const teamProposalIntoPrivateFolder = await call("pub-token", "save_context", {
    platform: "notion",
    history: "## User\nQueue it instead.\n\n## Assistant\nQueued.",
    visibility: "private",
  });
  check(
    "a team connection can still queue a private archive there for owner review",
    !teamProposalIntoPrivateFolder.isError &&
      /proposal queued: [0-9a-f-]+/i.test(teamProposalIntoPrivateFolder.content[0].text)
  );
  const personalArchiveIntoPrivateFolder = await call("priv-token", "save_context", {
    platform: "notion",
    history: "## User\nOwner archives here.\n\n## Assistant\nFine.",
  });
  check(
    "a personal connection still archives into its own private folder",
    !personalArchiveIntoPrivateFolder.isError &&
      /saved: 4-archive\/chat-history\/notion\//.test(
        personalArchiveIntoPrivateFolder.content[0].text
      )
  );

  // -- move note / folder
  const portableRead = (await call("pub-token", "read_note", { path: "1-projects/portable/a.md" }))?.content?.[0]?.text;
  const portableEtag = portableRead?.match(/etag: (\S+)/)?.[1];
  setEnforceOneUseBodies(true);
  const moveNote = await call("pub-token", "move_note", {
    source: "1-projects/portable/a.md",
    destination: "1-projects/portable/renamed.md",
    expected_source_etag: portableEtag,
  });
  setEnforceOneUseBodies(false);
  check(
    "team move_note moves within team scope with a production one-use body",
    !moveNote.isError && objects.has("1-projects/portable/renamed.md") &&
      isLogicalDeleteMarker(storedText("1-projects/portable/a.md"))
  );
  const staleFetchAfterRename = await call("pub-token", "fetch", {
    id: "1-projects/portable/a.md",
  });
  check(
    "fetch forwards an old path after its source becomes a logical-delete marker",
    succeeded(staleFetchAfterRename) &&
      JSON.parse(staleFetchAfterRename.content[0].text).text === "portable a"
  );
  const moveConflict = await call("pub-token", "move_note", {
    source: "1-projects/portable/renamed.md",
    destination: "1-projects/portable/existing.md",
  });
  check("move_note refuses destination overwrite", moveConflict.isError && objects.has("1-projects/portable/renamed.md"));
  // A team move_folder over a tree with a private island moves what the caller
  // can see and leaves the island alone. It must NOT refuse: refusing reports
  // that unreadable content is in there, which is a private-note existence
  // oracle a team connection can walk the whole tree with (see the dry-run
  // indistinguishability check below).
  const mixedMove = await call("pub-token", "move_folder", {
    source: "1-projects/mixed",
    destination: "1-projects/mixed-dest",
  });
  check(
    "team move_folder moves the visible half of a tree with a private island",
    !mixedMove.isError &&
      objects.has("1-projects/mixed-dest/public.md") &&
      isLogicalDeleteMarker(storedText("1-projects/mixed/public.md"))
  );
  check(
    "team move_folder leaves the private island where it was",
    objects.has("1-projects/mixed/private/secret.md") &&
      !objects.has("1-projects/mixed-dest/private/secret.md")
  );
  check(
    "the moved half stays team-readable and the island stays unreadable",
    succeeded(await call("pub-token", "read_note", { path: "1-projects/mixed-dest/public.md" })) &&
      (await call("pub-token", "read_note", { path: "1-projects/mixed/private/secret.md" }))?.isError
  );

  // The oracle itself. `1-projects/mixed/private` is private by folder default
  // and, after the move above, is all that is left under `1-projects/mixed`. A
  // team caller must not be able to tell that folder apart from one that was
  // never created: both are "not found", byte for byte. dry_run makes the
  // question free to ask, so any difference is walkable across the whole tree.
  const onlyPrivateProbe = await call("pub-token", "move_folder", {
    source: "1-projects/mixed/private",
    destination: "1-projects/probe-dest",
    dry_run: true,
  });
  const neverExistedProbe = await call("pub-token", "move_folder", {
    source: "1-projects/no-such-folder-at-all",
    destination: "1-projects/probe-dest",
    dry_run: true,
  });
  check(
    "team move_folder dry_run cannot distinguish an all-private folder from a missing one",
    onlyPrivateProbe.isError &&
      neverExistedProbe.isError &&
      onlyPrivateProbe.content[0].text === neverExistedProbe.content[0].text
  );
  check(
    "the private-only probe changed nothing",
    objects.has("1-projects/mixed/private/secret.md")
  );
  // A personal connection still sees and moves the whole tree, islands included.
  const personalIslandMove = await call("priv-token", "move_folder", {
    source: "1-projects/mixed",
    destination: "1-projects/mixed-personal",
  });
  check(
    "personal move_folder still moves a tree a team connection could only half-see",
    !personalIslandMove.isError &&
      objects.has("1-projects/mixed-personal/private/secret.md") &&
      isLogicalDeleteMarker(storedText("1-projects/mixed/private/secret.md"))
  );
  const privateFolderMove = await call("priv-token", "move_folder", {
    source: "1-projects/private-folder",
    destination: "1-projects/private-folder-renamed",
  });
  check(
    "personal move_folder moves a private tree without reducing privacy",
    !privateFolderMove.isError &&
      objects.has("1-projects/private-folder-renamed/a.md") &&
      isLogicalDeleteMarker(storedText("1-projects/private-folder/a.md")) &&
      (await call("team-token", "read_note", { path: "1-projects/private-folder-renamed/a.md" }))?.isError
  );
  check(
    "a folder move writes no history snapshot",
    ![...objects.keys()].some((key) => key.startsWith(".history/"))
  );


}
