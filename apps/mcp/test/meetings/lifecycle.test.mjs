/**
 * The core meeting narrative: opening a session, sending segments, the
 * human's own notes, reading a session back, finalize, audit, the tools,
 * privacy, scope/role, and cross-tenant isolation — sections 1-11 of the
 * original meetings.test.mjs, in one file because each later section reuses
 * local state (the finalized note's path, its audit record, ...) built by an
 * earlier one.
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
  SESSION_FORGED,
  SESSION_BAD_ENGINE,
  SESSION_IN_FLIGHT,
  SESSION_READ_ONLY_DENIED,
  meetingRequest,
  callTool,
  segment,
  keysIn,
  MEETING_PREFIX,
  MEETING_TRANSITIONS,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingLifecycleChecks(check, harness) {
  const { env, recorder, neighbour, s3 } = harness;
  /* ------------------------- 1. opening a session -------------------------- */

  const opened = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_MAIN,
      title: "Roadmap review",
      startedAt: "2026-09-01T09:00:00.000Z",
      source: { kind: "zoom", app: "Zoom" },
      device: { platform: "ios", name: "Test Phone" },
      // A phone on the paid tier: the audio left the device. The note has to
      // say so, and this is where the only party that knows says it.
      transcription: "cloud",
      attendees: [
        { name: "Ada Lovelace", email: "ada@example.test", self: true, via: "manual" },
        { name: "Grace Hopper", email: "grace@example.test", via: "calendar" },
      ],
      events: [{ type: "start", at: "2026-09-01T09:00:00.000Z" }],
    },
  });
  check("a session opens", opened.status === 200 && opened.body?.sessionId === SESSION_MAIN);
  check("and reports the state the client's own log put it in", opened.body?.state === "recording");
  check("with no segments and no note yet", opened.body?.segmentCount === 0 && opened.body?.notePath === null);
  check("and says whether this bucket can do a conflict-safe write", opened.body?.conflictSafe === true);
  check(
    "the in-flight session is in the customer's bucket, under a plumbing prefix",
    keysIn(recorder, MEETING_PREFIX).length === 1
  );

  const rawRecord = () => JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_MAIN}.json`).body);

  const reopened = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, events: [{ type: "start", at: "2026-09-01T09:00:00.000Z" }] },
  });
  check("re-sending the same log is idempotent", reopened.status === 200 && reopened.body?.state === "recording");
  check("and does not erase metadata the body did not carry", rawRecord().title === "Roadmap review");

  /* --------------------------- 2. malformed input -------------------------- */

  const notJson = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { raw: "{not json" });
  check("a malformed body is refused", notJson.status === 400);
  check("with the contract's invalid code", notJson.body?.error === "meeting_invalid");

  const noId = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { body: { title: "no id" } });
  check("a session with no id is refused", noId.status === 400 && noId.body?.error === "meeting_invalid");

  const badArray = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { raw: "[1,2,3]" });
  check("a JSON array is not a session", badArray.status === 400 && badArray.body?.error === "meeting_invalid");

  const badEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_BAD_ENGINE, transcription: "quantum" },
  });
  check(
    "an engine nobody has heard of is refused rather than stored",
    badEngine.status === 400 && badEngine.body?.error === "meeting_invalid"
  );
  check("...and opens no session for it", keysIn(recorder, `${MEETING_PREFIX}${SESSION_BAD_ENGINE}`).length === 0);

  /*
    And it cannot be rewritten on a session that already declared one. Audio
    that has been streamed to a service cannot un-leave the machine, so a client
    talking a note out of saying `cloud` is refused rather than obeyed — which
    is the only direction this field can be wrong in that costs anybody
    anything.
  */
  const rewrittenEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, transcription: "on-device" },
  });
  check(
    "a client may not rewrite the engine a meeting was opened with",
    rewrittenEngine.status === 400 && rewrittenEngine.body?.error === "meeting_invalid"
  );
  check("and the stored session still says where its audio went", rawRecord().transcription === "cloud");
  const sameEngine = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, transcription: "cloud" },
  });
  check("while re-sending the same answer is the no-op a replay needs", sameEngine.status === 200);

  const badId = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions/not-an-id/segments", { body: {} });
  check("a path that is not a meeting id is no route at all", badId.status === 404);

  const wrongMethod = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}`, {
    method: "DELETE",
  });
  check(
    "a known route with the wrong method is a 405 carrying a meeting code",
    wrongMethod.status === 405 && wrongMethod.body?.error === "meeting_invalid"
  );

  const noToken = await meetingRequest(env, null, "/meetings/sessions", { body: { id: SESSION_MAIN } });
  check("and no token is a 401 before any of that", noToken.status === 401);

  /* ------------------------ 3. segments, sent twice ------------------------ */

  const firstBatch = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-1", 0, "Shall we start with the roadmap."),
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
      ],
    },
  });
  check("a batch of segments is accepted", firstBatch.status === 200 && firstBatch.body?.segmentCount === 2);

  const resent = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-1", 0, "Shall we start with the roadmap."),
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
      ],
    },
  });
  check("a phone that lost signal and re-sent duplicates nothing", resent.body?.segmentCount === 2);

  const overlapping = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment("seg-2", 4_000, "Yes — the second half is the risky part.", "Grace Hopper"),
        segment("seg-3", 9_000, "Then we cut the third milestone."),
      ],
    },
  });
  check("an overlapping batch adds only what is new", overlapping.body?.segmentCount === 3);
  check(
    "and the transcript is stored in order, once each",
    rawRecord().transcript.map((row) => row.id).join(",") === "seg-1,seg-2,seg-3"
  );

  const unusable = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        { id: "seg-4", startMs: 20_000, endMs: 1_000, text: "backwards clock", speaker: null, channel: "mic" },
        { id: "", startMs: 21_000, endMs: 22_000, text: "no id", speaker: null, channel: "mic" },
      ],
    },
  });
  check("a row the merge cannot use is counted rather than swallowed", unusable.body?.rejected === 2);
  check("and changes nothing", unusable.body?.segmentCount === 3);

  /*
    An id is a merge key and nothing bounded its length. Text is capped at
    `segmentTextChars` and a request at `requestBytes`, but the size of the
    stored record is never checked — so an oversized id was the one field a
    `context:write` grant could use to inflate a session past what those caps
    imply, in a record `isPlumbing` hides from every note surface at every tier
    including the owner's. Refused at the merge, and counted like any other
    unusable row rather than swallowed.
  */
  const longId = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        { id: "x".repeat(5_000), startMs: 30_000, endMs: 31_000, text: "padded", speaker: null, channel: "mic" },
      ],
    },
  });
  check("a segment whose id is oversized is refused", longId.body?.rejected === 1);
  check("and no such row reaches the record", longId.body?.segmentCount === 3);

  const tooMany = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: Array.from({ length: 1_001 }, (_, n) => segment(`bulk-${n}`, n * 10, "spam")) },
  });
  check("a batch beyond the cap is refused, not truncated", tooMany.status === 400);
  check("and the transcript is untouched", rawRecord().transcript.length === 3);

  const notAnArray = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: "seg-1" },
  });
  check("segments must be an array", notAnArray.status === 400 && notAnArray.body?.error === "meeting_invalid");

  /* --------------- 3b. a batch minted for a different meeting --------------- */

  /*
    THE ONE REFUSAL HERE THAT PROTECTS A NOTE RATHER THAN A BUCKET.

    A recorder's segment id carries, in its own first token, the meeting it was
    minted for. The console app kept an `onSegment` subscription per meeting and
    detached none, so every finished meeting of an evening was handed a batch of
    a *later* meeting's words addressed to it — eight of eight on the owner's
    Mac. Those were refused only because the sessions they named happened to be
    `complete` by then; a session still open — two meetings close together, a
    finalize that had not drained — would have taken them, and the note in
    somebody's bucket would have held a conversation from another room. Nothing
    downstream could tell: by the time it is a turn under `## Transcript` there
    is no id left to check.

    So the check is at the door, on the one fact a wrong envelope cannot
    overwrite, and it is asserted against a session that is very much **open**
    — the whole point is that the refusal must not depend on the coincidence
    that saved the owner's notes.
  */
  const foreignBatch = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: [segment(`${SESSION_TEAM}-mic-0-s000`, 40_000, "spoken in another meeting")] },
  });
  check(
    "a segment minted for another meeting is refused",
    foreignBatch.status === 400 && foreignBatch.body?.error === "meeting_invalid"
  );
  check(
    "and the refusal names the meeting the words belong to",
    (foreignBatch.body?.error_description ?? "").includes(SESSION_TEAM)
  );
  check("and nothing of it reaches the transcript", rawRecord().transcript.length === 3);

  const mixedBatch = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: {
      segments: [
        segment(`${SESSION_MAIN}-mic-9-s000`, 41_000, "mine"),
        segment(`${SESSION_TEAM}-mic-9-s000`, 42_000, "not mine"),
      ],
    },
  });
  /*
    The whole batch, not the offending row. `countUnusable`'s "store
    forty-nine of fifty" is right for a row the merge cannot read and wrong
    here: a batch with somebody else's words in it was addressed by something
    that does not know whose words it is holding, and the rest of it is no more
    trustworthy than the part that gave it away.
  */
  check("a batch mixing two meetings is refused whole", mixedBatch.status === 400);
  check("including the rows that were addressed correctly", rawRecord().transcript.length === 3);

  /*
    The phone's recorders key their chunks on `String(Date.now())`, so their
    segment ids name no meeting at all. Unaddressed is not misaddressed: a guard
    on somebody's transcript may only fail in the direction of accepting what it
    cannot prove wrong, or it silently stops taking words the day a recorder
    changes how it mints ids.
  */
  /*
    Its own session, because this is the one check in the block that must
    *land* something and every count the rest of this file asserts is about
    `SESSION_MAIN`. `idOf` is exhausted — every character of the id alphabet is
    already bound to a fixture — so this id is spelled out rather than drawn
    from that family.
  */
  const SESSION_UNADDRESSED = `mtg_${"a".repeat(19)}b`;
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_UNADDRESSED, title: "Recorded on a phone", startedAt: "2026-09-01T11:00:00.000Z" },
  });
  const unaddressed = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_UNADDRESSED}/segments`,
    { body: { segments: [segment("1757280000000-0-s000", 43_000, "from a phone")] } }
  );
  check(
    "a segment id that names no meeting is still taken",
    unaddressed.status === 200 && unaddressed.body?.segmentCount === 1
  );

  /*
    The replay door, not the append door. A client's own log carries
    `{type: "segments"}` through `POST /meetings/sessions`, so a guard on one of
    the two is not a guard.
  */
  const foreignReplay = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_MAIN,
      events: [
        {
          type: "segments",
          segments: [segment(`${SESSION_TEAM}-mic-1-s000`, 44_000, "replayed from another meeting")],
        },
      ],
    },
  });
  check("a replayed log carrying another meeting's words is refused too", foreignReplay.status === 400);
  check("and that transcript is untouched as well", rawRecord().transcript.length === 3);

  /* ---------------------------- 4. the human's notes ----------------------- */

  const notes = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/notes`, {
    body: { notes: "- ship the first half\n- **decide** on the third milestone" },
  });
  check("the human's notes are stored", notes.status === 200);
  check("verbatim", rawRecord().notes.includes("**decide** on the third milestone"));

  const replaced = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/notes`, {
    body: { notes: "- ship the first half\n- decided: cut milestone three" },
  });
  check("and replaced wholesale, because they are the human's", replaced.status === 200);
  check("with the previous text gone", !rawRecord().notes.includes("**decide**"));

  /* ------------------------- 5. reading a session back --------------------- */

  const read = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}`, { method: "GET" });
  check("a session reads back", read.status === 200 && read.body?.session?.id === SESSION_MAIN);
  check("with its counts", read.body?.session?.segmentCount === 3);
  check(
    "and with the engine its words came from, so a client need not open the note",
    read.body?.session?.transcription === "cloud"
  );
  check("and without the transcript, unless it is asked for", read.body?.transcript === undefined);

  const readFull = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}?transcript=true`, {
    method: "GET",
  });
  check("which it can be", readFull.body?.transcript?.length === 3);

  const listed = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", { method: "GET" });
  check("and the recent list names it", (listed.body?.sessions || []).some((row) => row.id === SESSION_MAIN));

  // The two other doors onto the same routes: a context named in the URL, and
  // the token-in-path fallback for clients that cannot set a header. Both are
  // transports for the same grant and neither is a boundary — the point of
  // checking them is that they reach the same context and no other.
  const bySlug = await meetingRequest(env, TOKEN_OWNER, `/@recorder/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check("naming your own context in the URL reaches it", bySlug.status === 200);
  const byPathToken = await meetingRequest(env, null, `/t/${TOKEN_OWNER}/meetings/sessions/${SESSION_MAIN}`, {
    method: "GET",
  });
  check("and so does the token-in-path fallback", byPathToken.status === 200);

  /*
    The event a client must never be able to send.

    `written` is what moves a session to `complete`, and the gateway is the only
    party that can know a note exists. The interesting shape is not a recording
    session — the transition table refuses `recording -> complete` on its own —
    but one the client has already ended, where `finalizing -> complete` is a
    legal move. A client that could make it would mark its own meeting finished,
    pointing at a note nobody wrote, and the recording would be lost in silence.
  */
  await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_FORGED,
      title: "Forge attempt",
      startedAt: "2026-09-05T14:00:00.000Z",
      events: [
        { type: "start", at: "2026-09-05T14:00:00.000Z" },
        { type: "end", at: "2026-09-05T14:30:00.000Z" },
      ],
    },
  });
  const forgeable = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FORGED}.json`).body);
  check("a client can end its own session", forgeable.state === "finalizing");
  const forged = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: "written", notePath: "1-projects/forged.md" }] },
  });
  check(
    "and cannot send the event that says a note was written",
    forged.status === 400 && forged.body?.error === "meeting_invalid"
  );
  const stillFinalizing = JSON.parse(recorder.get(`${MEETING_PREFIX}${SESSION_FORGED}.json`).body);
  check(
    "so nothing marks a meeting finished that was never written out",
    stillFinalizing.state === "finalizing" && stillFinalizing.notePath === null
  );

  /*
    5a. A REFUSAL IS BUILT FROM CONSTANTS AND IDENTIFIERS, NEVER FROM AN
    UNBOUNDED FIELD A CLIENT SENT.

    `assertEventWithinLimits` only validates the shape a *known* event type
    carries, so an unrecognised `event.type` reaches `foldLog`'s own refusal
    exactly as a client sent it — up to the whole request body, before this
    fix. `apps/desktop`'s queue logs the gateway's own sentence to a file on
    disk, so an unbounded value here was an unbounded write to a customer's
    log, once per retried batch, not merely a long HTTP response.
  */
  const hugeEventType = "x".repeat(50_000);
  const unbounded = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: hugeEventType }] },
  });
  check(
    "an event of a type this contract has never heard of is still refused",
    unbounded.status === 400 && unbounded.body?.error === "meeting_invalid"
  );
  check(
    "and the refusal names it, bounded, rather than echoing the whole thing back",
    typeof unbounded.body?.error_description === "string" &&
      unbounded.body.error_description.length < 200 &&
      !unbounded.body.error_description.includes(hugeEventType)
  );
  const notEvenAString = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: 12345 }] },
  });
  check(
    "a non-string type is described by its typeof, not thrown over",
    notEvenAString.status === 400 && notEvenAString.body?.error_description?.includes("number")
  );

  /*
    AND THE BOUND IS ON THE SHAPE AS WELL AS THE LENGTH.

    The sentence this refusal builds is the tail of one line in a customer's
    log file — `apps/desktop`'s `meeting_write_refused session=… kind=…
    status=… code=…: <sentence>` — so forty characters of a client's own text
    is enough to forge a second line, and four to rewrite the one already
    printed. A length bound alone does not see that: `\n` is one character.
    This is the same rule `assertSafeEtag` applies one folder over, for the
    same reason and against the same trick.
  */
  const forgedLine = "notes\nmeeting_write_refused session=mtg_ok kind=finalize: written";
  const injected = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: forgedLine }] },
  });
  check(
    "an event type carrying a newline is described rather than echoed into a log line",
    injected.status === 400 &&
      typeof injected.body?.error_description === "string" &&
      !/[\u0000-\u001f\u007f]/.test(injected.body.error_description) &&
      !injected.body.error_description.includes("meeting_write_refused")
  );
  const escaped = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: "\u001b[2Kwritten" }] },
  });
  check(
    "...and so is one carrying a terminal escape",
    escaped.status === 400 && !escaped.body?.error_description?.includes("\u001b")
  );
  const ordinary = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_FORGED, events: [{ type: "written" }] },
  });
  check(
    "an identifier-shaped type is still named, because that is what a client author acts on",
    ordinary.status === 400 && ordinary.body?.error_description?.includes("written")
  );

  /* ------------------------------ 6. finalize ------------------------------ */

  /*
    A moment the wearer marked. It arrives on the session route like the rest of
    the session's own fields, on a request that is *not* the one that created the
    session — which is the case that was accepted with a 200 and dropped on the
    floor until `foldMetadata` learned to fold flags.
  */
  const flagged = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_MAIN,
      flags: [
        { at: 4_000, label: "come back to this" },
        { at: 4_000, label: "the same press" },
        // A row the core cannot read. Skipped like an unusable segment, because
        // `meeting_invalid` is the code a client does not retry: refusing the
        // request would park the whole meeting over one bad number.
        { at: "four seconds in" },
      ],
    },
  });
  check("a flag sent after the session was opened is accepted", flagged.status === 200);
  check("and lands in the record, deduped on its offset", rawRecord().flags.length === 1);
  check(
    "...carrying the label the wearer's watch sent",
    rawRecord().flags[0].label === "come back to this"
  );
  check(
    "...and a flag row the core cannot read costs that row, not the request",
    flagged.body?.state === "recording" && rawRecord().flags.length === 1
  );

  const finalized = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/finalize`, {
    body: {
      endedAt: "2026-09-01T09:42:00.000Z",
      enhanced: "Agreed to cut milestone three and ship the first half.",
      templateId: "default",
    },
  });
  check("finalize writes the note", finalized.status === 200 && finalized.body?.state === "complete");
  const notePath = finalized.body?.notePath || "";
  check(
    "at a path derived from the meeting's own UTC date",
    notePath.startsWith("0-inbox/meetings/2026-09-01-") && notePath.endsWith(".md")
  );
  check(
    "...dumped straight into the folder, with no date tree above it",
    notePath.slice("0-inbox/meetings/".length).includes("/") === false
  );
  check("and hands back the note's etag", typeof finalized.body?.etag === "string" && finalized.body.etag !== "");

  const noteBody = recorder.get(notePath)?.body || "";
  check("the note is one file, with the transcript appended to it", noteBody.includes("## Transcript"));
  check("carrying the summary the client generated", noteBody.includes("cut milestone three and ship the first half"));
  check("the human's own notes", noteBody.includes("decided: cut milestone three"));
  check("and what was said", noteBody.includes("Shall we start with the roadmap"));
  check("and the moment the wearer marked, beside the turn they marked it during", noteBody.includes("> [!flag] 00:04 — come back to this"));
  check("with the meeting id in its frontmatter", noteBody.includes(`meeting-id: ${SESSION_MAIN}`));
  check("and a status that says the meeting is over, not mid-write", noteBody.includes("status: complete"));
  /*
    The decision's own check, by its own name: "Every note records how it was
    made ... A person reading a meeting from eight months ago can tell whether
    its audio ever left their laptop, which is not a question they should have
    to reconstruct from their billing history."

    This is the end of that promise rather than the middle of it: not that a
    session field exists, but that the file in the customer's bucket — the only
    artifact left once the receipt drops everything else — says the word.
  */
  check(
    "a finalized note names the engine that produced it",
    noteBody.includes("transcription: cloud")
  );
  check(
    "...and the device that recorded it, beside it",
    noteBody.includes('device: "Test Phone (ios)"')
  );

  const receipt = rawRecord();
  check("the in-flight record becomes a completion receipt", receipt.state === "complete");
  check("naming the note it wrote", receipt.notePath === notePath);
  check("keeping the count", receipt.segmentCount === 3);
  check("and keeping the disclosure, which is one word and is not in the transcript", receipt.transcription === "cloud");
  check("and keeping no second copy of the flags either, because they are in the note", receipt.flags.length === 0);
  check(
    "and keeping no second copy of what was said",
    receipt.transcript.length === 0 &&
      !JSON.stringify(receipt).includes("Shall we start with the roadmap") &&
      receipt.notes === ""
  );

  const finalizedAgain = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/finalize`, {
    body: {},
  });
  check("finalizing twice answers with the note that already exists", finalizedAgain.body?.notePath === notePath);
  check(
    "and never writes a second one",
    keysIn(recorder, "0-inbox/meetings/").length === 1
  );

  const lateSegments = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/segments`, {
    body: { segments: [segment("seg-late", 60_000, "one more thing")] },
  });
  check(
    "a segment arriving after finalize is refused rather than silently dropped",
    lateSegments.status === 400 && lateSegments.body?.error === "meeting_invalid"
  );
  const lateUpsert = await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_MAIN, title: "Renamed after the fact" },
  });
  check("while a metadata re-send is a no-op ack, not an error", lateUpsert.status === 200);
  check("that does not rewrite a finished meeting", rawRecord().title === "Roadmap review");

  /*
    THE STATES THIS MODULE'S REFUSALS NAME BY HAND, HELD AGAINST THE TABLE
    THAT DECIDES THEM.

    `ingest.js` refuses transcript, notes and a re-open to a `complete` or an
    `empty` session, and it names those two states literally rather than
    asking `MEETING_TRANSITIONS` which ones are terminal. **Terminal** is the
    property that actually matters — there is no move left that reaches
    `finalizing`, so words folded in now can never be written out — and the
    hand-written pair agrees with the table today by coincidence rather than
    by construction. That is exactly the residue the phone's
    `acceptsTranscript` closed by deriving itself from the table; this side
    cannot derive as cheaply, because each of the three refusals carries its
    own sentence per state.

    So the coupling is checked instead of assumed. The day the table grows a
    third terminal state this fails, and `appendSegments`, `replaceNotes` and
    `upsertSession` are the three places that have to learn about it before
    that state can ship — rather than silently accepting transcript into a
    meeting nothing will ever write out.
  */
  const terminalStates = Object.keys(MEETING_TRANSITIONS)
    .filter((state) => MEETING_TRANSITIONS[state].length === 0)
    .sort()
    .join(",");
  check(
    "the terminal states ingest.js names by hand are exactly the table's own",
    terminalStates === "complete,empty"
  );

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

}
