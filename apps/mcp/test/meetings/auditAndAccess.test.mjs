/**
 * Audit, the tools, privacy, scope/role, and cross-tenant isolation:
 * sections 7-11 of the original meetings.test.mjs, all exercising the
 * meeting finalized by openingAndFinalize.test.mjs against the same
 * harness.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants.
 */

import {
  TOKEN_OWNER,
  TOKEN_NEIGHBOUR,
  TOKEN_READ_ONLY,
  TOKEN_MEMBER,
  TOKEN_EDITOR,
  SESSION_MAIN,
  SESSION_NEVER_ISSUED,
  SESSION_TEAM,
  SESSION_IN_FLIGHT,
  SESSION_READ_ONLY_DENIED,
  meetingRequest,
  callTool,
  segment,
  keysIn,
  MEETING_PREFIX,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingAuditAndAccessChecks(check, harness) {
  const { env, recorder, neighbour, s3, opened, rawRecord, finalized, notePath, receipt } = harness;
  /* -------------------------------- 7. audit ------------------------------- */

  const auditKeys = keysIn(recorder, ".context/audit/");
  const auditEntries = auditKeys.map((key) => JSON.parse(recorder.get(key).body));
  const written = auditEntries.find((entry) => entry.action === "meeting_note");
  check("writing a meeting is an audited event", Boolean(written));
  check("naming the acting identity, not just the tier", written?.actor_user_id === "user_meet_owner");
  check("and the client that acted", written?.actor_client_id === "mcp_client_meet_phone");
  check("and the context it happened in", written?.workspace_id === "ws_recorder");
  check("it records the path it wrote", written?.paths?.[0] === notePath);
  /*
    The audit entry minus the path it names. The path is what an audit record is
    *for* and it is checked above — and it carries a slug of the title, exactly
    as every note path in this gateway does, so it is taken out before asking
    the question this check actually asks: does anything else in the record
    carry what was said, who said it, or what the meeting was called.
  */
  const auditRest = JSON.stringify({ ...written, paths: undefined });
  check(
    "and no note content: not the transcript, not the title, not the attendees",
    !auditRest.includes("roadmap") &&
      !auditRest.includes("Roadmap review") &&
      !auditRest.includes("Lovelace")
  );

  /* ------------------------------- 8. the tools ---------------------------- */

  const list = await callTool(env, TOKEN_OWNER, "list_meetings");
  check("list_meetings finds the meeting", list.includes(notePath));
  check("with its title", list.includes("Roadmap review"));
  check("and who was there", list.includes("Ada Lovelace"));

  const summaryOnly = await callTool(env, TOKEN_OWNER, "read_meeting", { path: notePath });
  check("read_meeting returns the note", summaryOnly.includes("decided: cut milestone three"));
  check(
    "without the transcript by default",
    !summaryOnly.includes("Shall we start with the roadmap") && !summaryOnly.includes("## Transcript")
  );
  check("saying that there is one, and how to ask for it", summaryOnly.includes("transcript: true"));
  check("and how much was left behind", /transcript omitted: \d+ characters/.test(summaryOnly));

  const withTranscript = await callTool(env, TOKEN_OWNER, "read_meeting", { path: notePath, transcript: true });
  check("and returns it when asked", withTranscript.includes("Shall we start with the roadmap"));
  check("with the section heading it is filed under", withTranscript.includes("## Transcript"));

  const missing = await callTool(env, TOKEN_OWNER, "read_meeting", { path: "0-inbox/meetings/nope.md" });
  check("a meeting note that does not exist is 'not found'", missing === "not found");

  /* ------------------------------ 9. privacy ------------------------------- */

  check("a personal connection's meeting is private", summaryOnly.includes("visibility: private"));
  const memberRead = await callTool(env, TOKEN_MEMBER, "read_meeting", { path: notePath });
  check("so a team-tier connection cannot read it", memberRead === "not found");
  const memberList = await callTool(env, TOKEN_MEMBER, "list_meetings");
  check("and cannot learn it exists by listing", !memberList.includes(notePath));
  check("being told only that there is nothing it may see", memberList.includes("no meetings recorded yet"));

  /*
    The same two refusals, asked of the HTTP surface instead of the tool surface.

    `read_meeting` and `list_meetings` above filter with `canSee`, so a team-tier
    connection is told "not found" about a private meeting. The ingestion routes
    read `.context/meetings/sessions/<id>.json` straight out of the store, and that
    record is the same meeting: its title, who was in the room, the path of the
    private note it became, and — while it is still recording — every word of
    the transcript. A boundary that holds on one of the two surfaces exposing a
    thing is not a boundary.

    The finalized meeting first. Its receipt keeps the summary for good, so this
    half of the disclosure is permanent rather than a window during the call.
  */
  const memberSessionRead = await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check(
    "a team-tier connection cannot read a private meeting's session record either",
    memberSessionRead.status === 404 && memberSessionRead.body?.error === "meeting_forbidden"
  );
  /*
    AND IT IS TOLD WHAT AN ID NOBODY EVER ISSUED IS TOLD, TO THE BYTE.

    The cross-tenant block further down already compares these two answers —
    for `TOKEN_NEIGHBOUR`, whose refusal the *store* makes by construction,
    since another workspace's id is unreachable from this one's bucket. This
    is the harder half and had only a description: a caller who **can** reach
    this context, refused by a decision in code (`canSeeSession`), against the
    same caller asking for an id that was never minted. Their being the same
    bytes is the whole of the guard, and describing each one separately is
    what let the same gap sit on the transcribe route until it was measured —
    diverging the sentence there failed nothing in 4,072 checks.
  */
  const memberGhostRead = await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${SESSION_NEVER_ISSUED}`, {
    method: "GET",
  });
  check(
    "...byte-identical to what it is told about an id nobody ever issued",
    memberSessionRead.text === memberGhostRead.text && memberSessionRead.status === memberGhostRead.status
  );
  /*
    AND THEY MUST COST THE SAME, NOT ONLY READ THE SAME.

    The check above closes the channel a caller READS. This closes the one a
    caller MEASURES. Two answers that are byte-identical and a different number
    of storage round trips apart are still two answers; the second is just
    measured with a clock rather than read.

    Counted rather than timed, so this is deterministic. The number is not the
    invariant; the equality is.
  */
  const sessionTripsFor = async (id) => {
    const before = s3.trips();
    await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${id}`, { method: "GET" });
    return s3.trips() - before;
  };
  const forbiddenTrips = await sessionTripsFor(SESSION_MAIN);
  const ghostTrips = await sessionTripsFor(SESSION_NEVER_ISSUED);
  check(
    `a refused session and an id nobody issued cost the same to refuse `
      + `(forbidden ${forbiddenTrips}, never issued ${ghostTrips})`,
    forbiddenTrips === ghostTrips
  );

  const memberSessionList = await meetingRequest(env, TOKEN_MEMBER, "/meetings/sessions", { method: "GET" });
  const listedForMember = JSON.stringify(memberSessionList.body ?? {});
  check("and cannot learn the private note's path by listing sessions", !listedForMember.includes(notePath));
  check("nor its title and who was in the room", !listedForMember.includes("Ada Lovelace"));
  // The count is part of the listing: reporting the raw scan width would hand a
  // team connection an exact number of the private meetings it was filtered out
  // of, which is the same disclosure arriving as an integer.
  check(
    "nor a count of the meetings it was filtered out of",
    memberSessionList.body?.scanned === (memberSessionList.body?.sessions || []).length
  );

  /*
    Now a meeting that is still recording, which is where the transcript lives:
    a receipt has already dropped it, so the finalized session above understates
    what an in-flight one discloses.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_IN_FLIGHT,
      title: "Compensation review",
      startedAt: "2026-09-03T11:00:00.000Z",
      events: [{ type: "start", at: "2026-09-03T11:00:00.000Z" }],
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_IN_FLIGHT}/segments`, {
    body: { segments: [segment("seg-live", 0, "we are raising her band to four")] },
  });

  const memberLiveRead = await meetingRequest(
    env,
    TOKEN_MEMBER,
    `/meetings/sessions/${SESSION_IN_FLIGHT}?transcript=true`,
    { method: "GET" }
  );
  check(
    "a meeting still recording is not readable by a team-tier connection",
    memberLiveRead.status === 404 && memberLiveRead.body?.error === "meeting_forbidden"
  );
  /*
    The same comparison for the live read, because it takes a different query
    (`?transcript=true`) down a different branch, and a branch that answers
    its own way is exactly how one of a pair of refusals drifts.
  */
  const memberGhostLiveRead = await meetingRequest(
    env,
    TOKEN_MEMBER,
    `/meetings/sessions/${SESSION_NEVER_ISSUED}?transcript=true`,
    { method: "GET" }
  );
  check(
    "...and it too is told exactly what an id nobody ever issued is told",
    memberLiveRead.text === memberGhostLiveRead.text && memberLiveRead.status === memberGhostLiveRead.status
  );
  check(
    "so what was said in the room does not leave it",
    !JSON.stringify(memberLiveRead.body ?? {}).includes("raising her band")
  );

  /*
    And the integrity half, which is worse than the disclosure. An editor holds
    `context:write` at the team tier, so the scope gate lets it through, and the
    notes route replaces the human's Markdown — the body of the private note
    this meeting is about to become. Finding the id is the listing above; this
    is what the id is worth.
  */
  const editorTampers = await meetingRequest(env, TOKEN_EDITOR, `/meetings/sessions/${SESSION_IN_FLIGHT}/notes`, {
    body: { notes: "TAMPERED BY AN EDITOR" },
  });
  check(
    "a team-tier editor cannot rewrite a private meeting's notes",
    editorTampers.status === 404 && editorTampers.body?.error === "meeting_forbidden"
  );
  // Read the record out of the bucket rather than off the ack: `sessionSummary`
  // does not carry `notes`, so a response that looks clean is not evidence the
  // stored meeting is.
  const tamperedRecord = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_IN_FLIGHT}.json`).body);
  check("and the stored meeting is untouched by the attempt", tamperedRecord.notes !== "TAMPERED BY AN EDITOR");

  /*
    And an upsert of the same id, which is the dangerous shape of the same move.

    A session the caller may not see reads as absent, so an upsert would take
    `null` for "no such session", open a fresh one and write it with no etag —
    an unconditional put over the owner's in-flight meeting. Withholding a
    record and then letting somebody create over it is worse than showing it:
    the transcript would be gone rather than read.
  */
  const editorUpserts = await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_IN_FLIGHT,
      title: "Hijacked",
      startedAt: "2026-09-03T11:00:00.000Z",
    },
  });
  check(
    "a team-tier connection cannot create over a private meeting it cannot see",
    editorUpserts.status === 404 && editorUpserts.body?.error === "meeting_forbidden"
  );
  const survivingRecord = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_IN_FLIGHT}.json`).body);
  check(
    "so the meeting it could not read is still the meeting that was recorded",
    survivingRecord.title === "Compensation review" && survivingRecord.transcript.length === 1
  );
  const ownerChecksBack = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_IN_FLIGHT}`, {
    method: "GET",
  });
  check(
    "while the owner still reads their own meeting in full",
    ownerChecksBack.status === 200 && JSON.stringify(ownerChecksBack.body ?? {}).includes("Compensation review")
  );

  // A team connection that *can* write is still refused this destination: the
  // meetings folder inherits `private`, and a team connection may not create
  // private content. Its session is opened first, so the refusal is the write
  // and not the ingestion.
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM,
      title: "Editor's meeting",
      startedAt: "2026-09-02T10:00:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-02T10:00:00.000Z" }],
    },
  });
  const editorFinalize = await meetingRequest(env, TOKEN_EDITOR, `/meetings/sessions/${SESSION_TEAM}/finalize`, {
    body: {},
  });
  check(
    "a team connection cannot file a meeting into a private folder",
    editorFinalize.status === 403 && editorFinalize.body?.error === "meeting_forbidden"
  );
  check("and no note is written when it tries", keysIn(recorder, "0-inbox/meetings/").length === 1);

  /* --------------------------- 10. scope and role -------------------------- */

  const readOnlyWrite = await meetingRequest(env, TOKEN_READ_ONLY, "/meetings/sessions", {
    body: { id: SESSION_READ_ONLY_DENIED, startedAt: "2026-09-01T09:00:00.000Z" },
  });
  check(
    "a read-only grant cannot open a session",
    readOnlyWrite.status === 403 && readOnlyWrite.body?.error === "meeting_forbidden"
  );
  check("and is told which scope it is missing", readOnlyWrite.body?.scope?.[0] === "context:write");
  const readOnlyRead = await meetingRequest(env, TOKEN_READ_ONLY, "/meetings/sessions", { method: "GET" });
  check("while reading is still allowed", readOnlyRead.status === 200);

  const memberWrite = await meetingRequest(env, TOKEN_MEMBER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: [segment("seg-member", 0, "let me in")] },
  });
  check(
    "a full-scope grant whose role is `member` cannot write either",
    memberWrite.status === 403 && memberWrite.body?.error === "meeting_forbidden"
  );
  check("and the refusal happens before anything is read", memberWrite.body?.scope?.[0] === "context:write");

  /* ------------------------ 11. cross-tenant isolation --------------------- */

  const neighbourReads = await meetingRequest(env, TOKEN_NEIGHBOUR, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  const neighbourReadsGhost = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_NEVER_ISSUED}`,
    { method: "GET" }
  );
  check("another workspace cannot read a session id issued in this one", neighbourReads.status === 404);
  check("and it carries the contract's forbidden code", neighbourReads.body?.error === "meeting_forbidden");
  check(
    "byte-identical to an id nobody has ever issued, so nothing leaks by existence",
    neighbourReads.text === neighbourReadsGhost.text && neighbourReads.status === neighbourReadsGhost.status
  );

  const neighbourWrites = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_MAIN}/segments`,
    { body: { segments: [segment("seg-intruder", 0, "INTRUDER-MARKER")] } }
  );
  check("nor write to it", neighbourWrites.status === 404);
  check(
    "and the attempt reaches nothing: not the record, not the note",
    !JSON.stringify(rawRecord()).includes("INTRUDER-MARKER") &&
      !(recorder.get(notePath)?.body || "").includes("INTRUDER-MARKER")
  );
  check(
    "and does not create the session in the attacker's own bucket either",
    keysIn(neighbour, MEETING_PREFIX).length === 0
  );

  const neighbourFinalizes = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_MAIN}/finalize`,
    { body: {} }
  );
  check("nor finalize it", neighbourFinalizes.status === 404);
  check("writing no note anywhere", keysIn(neighbour, "0-inbox/meetings/").length === 0);
  check("and leaving the original alone", keysIn(recorder, "0-inbox/meetings/").length === 1);

  const neighbourList = await meetingRequest(env, TOKEN_NEIGHBOUR, "/meetings/sessions", { method: "GET" });
  check(
    "and the neighbour's own listing enumerates nothing of ours",
    (neighbourList.body?.sessions || []).length === 0
  );

  const neighbourBySlug = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/@recorder/meetings/sessions/${SESSION_MAIN}`,
    { method: "GET" }
  );
  check("naming the context in the URL does not help", neighbourBySlug.status === 403);
  const neighbourByGhostSlug = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    "/@no-such-context/meetings/sessions/" + SESSION_MAIN,
    { method: "GET" }
  );
  check(
    "and a context that exists refuses exactly as one that does not",
    neighbourBySlug.status === neighbourByGhostSlug.status
  );

  // Later sections (storage failure/conflict, the route name, the folder,
  // transcribing, title collision) reuse some of this section's local state
  // — the finalized SESSION_MAIN record, its note path, its audit entry, its
  // completion receipt — the way the rest of this file already does, so it
  // is handed to them here on the shared harness rather than recomputed.
  Object.assign(harness, { opened, rawRecord, finalized, notePath, receipt, written });
}
