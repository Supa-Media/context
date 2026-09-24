/**
 * Storage failure mid-finalize, and the conflict a lost race must produce
 * when a concurrent write beats a retry to the claim.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants. Section 12 of the original file. Runs against the same
 * `harness` the earlier meeting sections left its notes and audit trail in —
 * see meetings.test.mjs for why the sections share one harness in order.
 */

import {
  MEETING_PREFIX,
  SESSION_CONFLICT,
  SESSION_NEVER_ISSUED,
  SESSION_STORAGE_FAILURE,
  SESSION_TYPED_ONLY,
  TOKEN_NEIGHBOUR,
  TOKEN_OWNER,
  keysIn,
  meetingRequest,
  segment,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingStorageFailureChecks(check, harness) {
  const { env, recorder, neighbour, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* --------------------- 12. storage failure and conflict ------------------ */

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_STORAGE_FAILURE,
      title: "Doomed write",
      startedAt: "2026-09-03T11:00:00.000Z",
      events: [{ type: "start", at: "2026-09-03T11:00:00.000Z" }],
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_STORAGE_FAILURE}/segments`, {
    body: { segments: [segment("fail-1", 0, "this should survive the outage")] },
  });

  // The bucket refuses exactly the note write, which is the interesting moment:
  // the session has been claimed, and the note has not been written.
  harness.failPut = (url) => (url.includes("/meet-recorder/0-inbox/meetings/") ? 500 : null);
  const brokenFinalize = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_STORAGE_FAILURE}/finalize`,
    { body: {} }
  );
  check(
    "a storage failure mid-finalize is reported as retryable",
    brokenFinalize.status === 503 && brokenFinalize.body?.error === "meeting_unavailable"
  );
  check("and no note is left behind", keysIn(recorder, "0-inbox/meetings/").length === 1);

  harness.failPut = null;
  const retried = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_STORAGE_FAILURE}/finalize`,
    { body: {} }
  );
  check("the retry succeeds", retried.status === 200 && retried.body?.state === "complete");
  check("writing exactly one note for that meeting", keysIn(recorder, "0-inbox/meetings/").length === 2);
  check(
    "and the transcript that was in flight survived the outage",
    (recorder.get(retried.body.notePath)?.body || "").includes("this should survive the outage")
  );

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_CONFLICT,
      title: "Contended",
      startedAt: "2026-09-04T12:00:00.000Z",
      events: [{ type: "start", at: "2026-09-04T12:00:00.000Z" }],
    },
  });
  // Every conditional write on that record loses, which is what a session two
  // devices are writing to at once looks like from one of them.
  harness.failPut = (url) => (url.includes(`${MEETING_PREFIX}${SESSION_CONFLICT}.json`) ? 412 : null);
  const contended = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_CONFLICT}/segments`, {
    body: { segments: [segment("contended-1", 0, "who wins")] },
  });
  check(
    "a write that keeps losing its conditional put is a conflict, not a silent overwrite",
    contended.status === 409 && contended.body?.error === "meeting_conflict"
  );
  harness.failPut = null;

  const bounded = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions?limit=2", { method: "GET" });
  check("the recent list honours a limit", (bounded.body?.sessions || []).length === 2);
  check(
    "and answers newest meeting first",
    String(bounded.body.sessions[0].startedAt) > String(bounded.body.sessions[1].startedAt)
  );
  check(
    "reporting what it scanned as a floor rather than a total",
    typeof bounded.body?.scanned === "number" && bounded.body.scanned >= 2
  );

  /*
    A meeting nobody recorded: typed notes, no `start`, no audio. The transition
    table used to refuse `idle -> finalizing`, so this route answered 400 for a
    client that had done nothing wrong — and the only thing that meeting held
    was the half nobody can regenerate.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_TYPED_ONLY,
      title: "Notes only",
      startedAt: "2026-09-01T14:00:00.000Z",
      device: { platform: "ios" },
      notes: "- they said yes",
    },
  });
  const typedOnly = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TYPED_ONLY}/finalize`,
    { body: {} }
  );
  check(
    "a meeting nobody recorded finalizes without a forged start",
    typedOnly.status === 200 && typedOnly.body?.state === "complete"
  );
  const typedNote = recorder.get(typedOnly.body?.notePath || "")?.body || "";
  check("...writing the words the person actually typed", typedNote.includes("- they said yes"));
  check(
    "...and saying plainly that there was no transcript",
    typedNote.includes("_No transcript was captured._")
  );

  /*
    12b. A SESSION THAT CAPTURED NOTHING IS NOT FILED.

    The owner's own bug report: a refused microphone leaves four empty notes in
    the bucket, one per attempt, each "0 min, typed session" with no transcript
    and no typed notes either. `hasNothingCaptured` is the rule and this is the
    gateway wiring around it — no note write, a session marked `empty` with a
    reason, and idempotent the same way a written note is.

    Fixture ids are not run through `idOf` here: every character in
    `MEETING_ID_ALPHABET` is already claimed by a single-repeat id elsewhere in
    this file (see the header on that helper), so these mix two characters
    instead, which cannot collide with any of them.
  */
  const SESSION_EMPTY_MIC_DENIED = `mtg_${"z9".repeat(10)}`;
  const SESSION_EMPTY_NO_REASON = `mtg_${"z8".repeat(10)}`;
  const SESSION_EMPTY_THEN_SEGMENTS = `mtg_${"z7".repeat(10)}`;
  const SESSION_EMPTY_WITH_FLAGS_ONLY = `mtg_${"z6".repeat(10)}`;
  const inboxBeforeEmpty = keysIn(recorder, "0-inbox/meetings/").length;

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_EMPTY_MIC_DENIED, title: "Recording that never started", startedAt: "2026-09-01T15:00:00.000Z" },
  });
  const micDenied = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_MIC_DENIED}/finalize`,
    { body: { emptyReason: "microphone not granted" } }
  );
  check(
    "a session with no transcript and no typed notes finalizes as empty, not complete",
    micDenied.status === 200 && micDenied.body?.state === "empty"
  );
  check("...with no note path", micDenied.body?.notePath === null);
  check("...carrying the reason this device gave", micDenied.body?.emptyReason === "microphone not granted");
  check(
    "...and nothing is written to the bucket for it",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeEmpty
  );

  const emptyAgain = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_MIC_DENIED}/finalize`,
    { body: {} }
  );
  check(
    "re-finalizing an already-empty session answers with the same reason, idempotently",
    emptyAgain.status === 200 &&
      emptyAgain.body?.state === "empty" &&
      emptyAgain.body?.emptyReason === "microphone not granted"
  );
  check(
    "...and still writes nothing",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeEmpty
  );

  const emptySessionRead = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_EMPTY_MIC_DENIED}`, {
    method: "GET",
  });
  check(
    "reading the session back shows the empty state and reason too",
    emptySessionRead.body?.session?.state === "empty" &&
      emptySessionRead.body?.session?.emptyReason === "microphone not granted"
  );

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_EMPTY_NO_REASON, title: "No reason given", startedAt: "2026-09-01T15:10:00.000Z" },
  });
  const noReason = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_NO_REASON}/finalize`,
    { body: {} }
  );
  check(
    "a client that names no reason still gets one, rather than an empty string",
    noReason.status === 200 &&
      noReason.body?.state === "empty" &&
      typeof noReason.body?.emptyReason === "string" &&
      noReason.body.emptyReason.length > 0
  );

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_EMPTY_THEN_SEGMENTS,
      title: "Empty, then a stray write",
      startedAt: "2026-09-01T15:20:00.000Z",
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_EMPTY_THEN_SEGMENTS}/finalize`, {
    body: {},
  });
  const staleSegments = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_THEN_SEGMENTS}/segments`,
    { body: { segments: [segment("late-1", 0, "arrived after the meeting was marked empty")] } }
  );
  check(
    "a segment batch arriving after empty is refused rather than silently dropped",
    staleSegments.status === 400 && staleSegments.body?.error === "meeting_invalid"
  );
  const staleNotes = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_THEN_SEGMENTS}/notes`,
    { body: { notes: "typed after the fact" } }
  );
  check(
    "...and the same for notes typed after the fact",
    staleNotes.status === 400 && staleNotes.body?.error === "meeting_invalid"
  );
  const restaleUpsert = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_EMPTY_THEN_SEGMENTS, title: "Renamed after empty" },
  });
  check(
    "an upsert on an already-empty session is a no-op, not a re-open",
    restaleUpsert.body?.state === "empty"
  );

  /*
    A flag with no transcript and no typed notes is still nothing to file: the
    press happened, but a note with one callout and nothing else is not what
    this feature is for, and the rule is the same content check regardless of
    what put a byte on the session.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_EMPTY_WITH_FLAGS_ONLY,
      title: "Only a flag, nothing else",
      startedAt: "2026-09-01T15:30:00.000Z",
      flags: [{ at: 500 }],
    },
  });
  const flagOnly = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_EMPTY_WITH_FLAGS_ONLY}/finalize`,
    { body: {} }
  );
  check("a flag alone does not save a session from being empty", flagOnly.body?.state === "empty");

  check(
    "...and none of the above left a second note anywhere in the bucket",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeEmpty
  );

  /*
    12c. A CLIENT THAT GAVE UP ON A STUCK FINALIZE SAYS SO, THROUGH THE ROUTE
    THAT ALREADY EXISTS FOR IT.

    `checkFinalizeTimeout` (`packages/meetings/src/recovery.js`) is the pure
    rule a client runs against its own queue; what this pins is that its
    answer — a `fail` event — is one the *contract* already carries end to
    end. No new route, no new wire shape: `fail` has been in
    `CLIENT_EVENT_TYPES` since `failed -> finalizing` was added, and
    `finalizing -> failed` was already legal. What was missing is a client
    ever calling it for this reason, and this is the gateway's half of that
    being true.
  */
  const SESSION_STUCK_FINALIZE = `mtg_${"z5".repeat(10)}`;
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_STUCK_FINALIZE,
      title: "Stuck for two hours",
      startedAt: "2026-09-01T16:00:00.000Z",
      notes: "typed before the crash",
    },
  });
  const stuckFinalize = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_STUCK_FINALIZE}/finalize`,
    { body: {} }
  );
  check(
    "sanity: a session with real notes finalizes normally, and this is the one recovery gives up on",
    stuckFinalize.status === 200 && stuckFinalize.body?.state === "complete"
  );
  // A second finalize on a complete session is the ordinary idempotent replay
  // — nothing about recovery — so instead this drives what recovery actually
  // sends: a `fail` event on the session route, as if a client's own queue had
  // just decided this meeting was never coming back on its own.
  const SESSION_RECOVERED_TO_FAILED = `mtg_${"z4".repeat(10)}`;
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_RECOVERED_TO_FAILED,
      title: "The gateway never answered",
      startedAt: "2026-09-01T16:10:00.000Z",
      notes: "typed before the crash",
      events: [{ type: "end", at: "2026-09-01T16:30:00.000Z" }],
    },
  });
  const beforeFail = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_RECOVERED_TO_FAILED}`,
    { method: "GET" }
  );
  check(
    "the session genuinely sits in finalizing before recovery acts on it",
    beforeFail.body?.session?.state === "finalizing"
  );
  const recoveredFail = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_RECOVERED_TO_FAILED,
      events: [
        {
          type: "fail",
          at: "2026-09-01T18:30:00.000Z",
          reason: "finalize still had not completed 10 minutes after a retry",
        },
      ],
    },
  });
  check(
    "a client's own recovery can move a stuck finalize to failed",
    recoveredFail.status === 200 && recoveredFail.body?.state === "failed"
  );
  const afterFail = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_RECOVERED_TO_FAILED}`,
    { method: "GET" }
  );
  check(
    "...and the reason is readable back, which is what the badge shows",
    afterFail.body?.session?.state === "failed" &&
      afterFail.body?.session?.failureReason === "finalize still had not completed 10 minutes after a retry"
  );
  // `failed -> finalizing` is still legal, so a later retry — the person
  // pressing Retry, or the queued `finalize` entry recovery left in place —
  // can still finish this meeting normally.
  const retryAfterFail = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_RECOVERED_TO_FAILED}/finalize`,
    { body: {} }
  );
  check(
    "a meeting recovery failed can still be finished by a later retry",
    retryAfterFail.status === 200 &&
      retryAfterFail.body?.state === "complete" &&
      typeof retryAfterFail.body?.notePath === "string"
  );
  check(
    "...carrying the notes that were typed before any of this happened",
    (recorder.get(retryAfterFail.body.notePath)?.body || "").includes("typed before the crash")
  );

  /*
    12d. THE TWO WORDS A CLIENT MAY NOT SAY, AND THE ONE WINDOW WHERE SAYING
    ONE OF THEM RACES A NOTE THAT IS ALREADY IN THE BUCKET.

    `empty` joined `written` in `GATEWAY_EVENT_TYPES`, so the first half is the
    same guard `written` has had: a client cannot assert that a meeting
    captured nothing, whatever its own record says. What is new is that this
    release also ships a client which sends `fail` *on a schedule* — see
    `checkFinalizeTimeout` — so "a client gives up on a finalize the gateway is
    still working on" stopped being hypothetical, and the window between the
    claim and the note write is where it lands.
  */
  const SESSION_FORGED_EMPTY = `mtg_${"z3".repeat(10)}`;
  const SESSION_RACED_FAIL = `mtg_${"z2".repeat(10)}`;
  const SESSION_FAILED_THEN_RETRIED = `mtg_${"z1".repeat(10)}`;

  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FORGED_EMPTY,
      title: "A real meeting a client would rather forget",
      startedAt: "2026-09-05T09:00:00.000Z",
      notes: "the words a forged empty would erase",
    },
  });
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FORGED_EMPTY}/segments`, {
    body: { segments: [segment("forged-1", 0, "somebody said this out loud")] },
  });
  const forgedEmpty = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FORGED_EMPTY,
      events: [{ type: "empty", at: "2026-09-05T09:40:00.000Z", reason: "microphone not granted" }],
    },
  });
  check(
    "a client cannot send the event that says a meeting captured nothing",
    forgedEmpty.status === 400 && forgedEmpty.body?.error === "meeting_invalid"
  );
  const afterForged = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FORGED_EMPTY}`, {
    method: "GET",
  });
  check(
    "...changing nothing about the session it was aimed at",
    afterForged.body?.session?.state !== "empty" &&
      afterForged.body?.session?.emptyReason === null &&
      afterForged.body?.session?.segmentCount === 1
  );
  const forgedRecord = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FORGED_EMPTY}.json`).body);
  check(
    "...and the transcript it was aimed at is still on the record",
    (forgedRecord.transcript || []).length === 1 && forgedRecord.notes === "the words a forged empty would erase"
  );
  const SESSION_HONESTLY_EMPTY = `mtg_${"z0".repeat(10)}`;
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_HONESTLY_EMPTY,
      title: "Nothing in it, and still not the client's word",
      startedAt: "2026-09-05T09:41:00.000Z",
    },
  });
  const honestlyEmptyForged = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_HONESTLY_EMPTY,
      events: [{ type: "empty", at: "2026-09-05T09:42:00.000Z", reason: "microphone not granted" }],
    },
  });
  check(
    "a client cannot say it even about a session that really did capture nothing",
    honestlyEmptyForged.status === 400 && honestlyEmptyForged.body?.error === "meeting_invalid"
  );
  const stillOpen = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_HONESTLY_EMPTY}`, {
    method: "GET",
  });
  check(
    "...and the session it was aimed at is still open, for the finalize that decides this",
    stillOpen.body?.session?.state === "idle" && stillOpen.body?.session?.emptyReason === null
  );

  /*
    A client's `fail` landing between the claim and the note write: the note is
    in the customer's bucket by then, so the record has to say so. Folding
    `written` onto a `failed` session refuses the move — which used to leave a
    note nothing pointed at and a 400 the desktop outbox parks forever.

    The interleave is exact rather than concurrent: the hook fires on the note
    write itself, which is the one moment where the claim is stored and the
    note is not, and it writes the record the way a queued `fail` upsert would.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_RACED_FAIL,
      title: "Given up on one request too early",
      startedAt: "2026-09-05T10:00:00.000Z",
      notes: "typed while the gateway was thinking",
      events: [{ type: "end", at: "2026-09-05T10:30:00.000Z" }],
    },
  });
  const racedKey = `${MEETING_PREFIX}${SESSION_RACED_FAIL}.json`;
  let racedOnce = false;
  harness.failPut = (url) => {
    if (racedOnce || !url.includes("/meet-recorder/0-inbox/meetings/")) return null;
    racedOnce = true;
    const record = JSON.parse(recorder.get(racedKey).body);
    recorder.set(racedKey, {
      body: JSON.stringify({
        ...record,
        state: "failed",
        failureReason: "finalize still had not completed 10 minutes after a retry",
        appliedAt: { ...(record.appliedAt || {}), fail: Date.parse("2026-09-05T10:45:00.000Z") },
      }),
      etag: "raced-by-a-clients-own-recovery",
    });
    return null;
  };
  const raced = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_RACED_FAIL}/finalize`,
    { body: {} }
  );
  harness.failPut = null;
  check(
    "a client that gave up mid-finalize does not leave the note it raced orphaned",
    raced.status === 200 && raced.body?.state === "complete" && typeof raced.body?.notePath === "string"
  );
  check(
    "...with the note in the bucket and the record pointing at it",
    (recorder.get(raced.body?.notePath || "")?.body || "").includes("typed while the gateway was thinking")
  );
  const racedRecord = JSON.parse(recorder.get(racedKey).body);
  check(
    "...and the meeting still ended when it ended, rather than when the write finished",
    racedRecord.state === "complete" &&
      racedRecord.endedAt === "2026-09-05T10:30:00.000Z" &&
      racedRecord.failureReason === null
  );

  /*
    The other order, which is the ordinary one: the finalize genuinely does not
    land, recovery fails the session, and a person presses Retry. The claim is
    already held, so the retry must land on the path the first finalize
    reserved rather than composing a second — the same idempotence a crash gets.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FAILED_THEN_RETRIED,
      title: "Failed, then retried by hand",
      startedAt: "2026-09-05T11:00:00.000Z",
      notes: "typed before anybody gave up",
      events: [{ type: "end", at: "2026-09-05T11:30:00.000Z" }],
    },
  });
  const inboxBeforeRetry = keysIn(recorder, "0-inbox/meetings/").length;
  harness.failPut = (url) => (url.includes("/meet-recorder/0-inbox/meetings/") ? 500 : null);
  const doomed = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_FAILED_THEN_RETRIED}/finalize`,
    { body: {} }
  );
  harness.failPut = null;
  check("sanity: the finalize this one gives up on really did fail", doomed.status === 503);
  const claimedPath = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FAILED_THEN_RETRIED}.json`).body).notePath;
  check("...having claimed a path on the way", typeof claimedPath === "string");
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FAILED_THEN_RETRIED,
      events: [
        {
          type: "fail",
          at: "2026-09-05T11:45:00.000Z",
          reason: "finalize still had not completed 10 minutes after a retry",
        },
      ],
    },
  });
  const pressedRetry = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_FAILED_THEN_RETRIED}/finalize`,
    { body: {} }
  );
  check(
    "a person's Retry after a recovery failure finalizes the same session id",
    pressedRetry.status === 200 && pressedRetry.body?.state === "complete"
  );
  check("...on the path the first finalize claimed", pressedRetry.body?.notePath === claimedPath);
  check(
    "...writing exactly one note between them",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeRetry + 1
  );
  const retriedTwice = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_FAILED_THEN_RETRIED}/finalize`,
    { body: {} }
  );
  check(
    "...and a second Retry is the ordinary idempotent replay, not a second note",
    retriedTwice.status === 200 &&
      retriedTwice.body?.notePath === claimedPath &&
      keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeRetry + 1
  );

  /*
    Tenancy, on the two words this release added a client for. A neighbour
    naming somebody else's session id is answered exactly as one naming an id
    nobody ever issued — same status, same bytes — and the record it named is
    untouched either way.
  */
  const neighbourFailsOurs = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_FAILED_THEN_RETRIED}/finalize`,
    { body: { emptyReason: "microphone not granted" } }
  );
  const neighbourFailsAGhost = await meetingRequest(
    env,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_NEVER_ISSUED}/finalize`,
    { body: { emptyReason: "microphone not granted" } }
  );
  check(
    "an empty finalize aimed at another workspace's session is refused as a ghost is",
    neighbourFailsOurs.status === 404 &&
      neighbourFailsOurs.status === neighbourFailsAGhost.status &&
      neighbourFailsOurs.text === neighbourFailsAGhost.text
  );
  const neighbourFailEvent = await meetingRequest(env, TOKEN_NEIGHBOUR, "/meetings/sessions", {
    body: {
      id: SESSION_FAILED_THEN_RETRIED,
      events: [{ type: "fail", at: "2026-09-05T12:00:00.000Z", reason: "not your meeting" }],
    },
  });
  const ourRecordAfter = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FAILED_THEN_RETRIED}.json`).body);
  check(
    "...and a `fail` a neighbour sends for that id never reaches the record that owns it",
    ourRecordAfter.state === "complete" &&
      ourRecordAfter.failureReason === null &&
      neighbourFailEvent.body?.sessionId !== undefined
  );
  check(
    "...it landed in the neighbour's own bucket, which is the whole of what an upsert may do",
    !neighbour.has(`${MEETING_PREFIX}${SESSION_FAILED_THEN_RETRIED}.json`) ||
      JSON.parse(neighbour.get(`${MEETING_PREFIX}${SESSION_FAILED_THEN_RETRIED}.json`).body).title !==
        "Failed, then retried by hand"
  );

}
