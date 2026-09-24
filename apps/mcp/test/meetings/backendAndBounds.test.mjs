/**
 * A backend that cannot do any conditional write at all, and every size
 * bound the meeting protocol enforces, driven to its edge.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants. Section 15 and the "every size bound" section of the original
 * file, run against the same `harness` earlier sections left their state in.
 */

import {
  LIMITS,
  MEETING_PREFIX,
  SESSION_CROWDED,
  SESSION_MAIN,
  assertSessionWithinLimits,
  conflictSafeWrites,
  fakeStore,
  handleMeetings,
  idOf,
  segment,
  writeSession,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingBackendAndBoundsChecks(check, harness) {
  const { env, recorder, neighbour, s3, controlPlane, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* -------------------- 15. a backend that cannot do any of that ----------- */

  const safe = fakeStore({ conditionalWrite: true });
  const unsafe = fakeStore({ conditionalWrite: false });
  check("a store that honours a conditional write says so", conflictSafeWrites(safe) === true);
  check("and one that does not, does not", conflictSafeWrites(unsafe) === false);

  /*
    A bucket that honours `If-Match` but has not been probed yet.

    `withProbedCapabilities` lowers a store's declared capability to the one the
    binding was *probed* for, and the control plane "starts a binding at `false`,
    and only a real probe may turn it on" — so unproven is every bucket's
    opening state, not a legacy edge. That answer is the right one to *report*
    on the ack and the wrong one to gate the write on: the header costs nothing
    to send, a backend that ignores it ignores it either way, and the existing
    sabotage for this ("`writeSession` drops `onlyIf`") only ever ran against
    stores that declare `true`. The population the guard covers was the thing
    left unchecked.
  */
  const unprobed = fakeStore({ conditionalWrite: false });
  // Carries a tier: `writeSession` refuses a record without one, which is the
  // guard that stops a fresh object literal silently downgrading a meeting.
  const bare = { id: SESSION_MAIN, scope: "private", transcript: [], attendees: [], appliedAt: {} };
  const firstEtag = await writeSession(unprobed, { ...bare, notes: "first" }, null);
  await writeSession(unprobed, { ...bare, notes: "somebody else" }, firstEtag);
  const staleWrite = await writeSession(unprobed, { ...bare, notes: "mine, from a stale read" }, firstEtag);
  check("a write guards the read it came from even before the bucket is probed", staleWrite === false);
  check(
    "so a meeting is not overwritten by a writer holding a stale etag",
    JSON.parse(unprobed.objects.get(`${MEETING_PREFIX}${SESSION_MAIN}.json`).body).notes === "somebody else"
  );

  /* ------------------- every size bound, driven to its edge ------------------ */

  /*
    NINE OF THE TEN BOUNDS ON THIS PATH WERE PROVED BY NOTHING.

    `LIMITS` is what stops a `context:write` grant growing an unbounded hidden
    object in somebody else's bucket — the record is refused by `isPlumbing` at
    every tier including the owner's, so nothing in the product ever shows it.
    Measured by replacing each check's condition with `false` in turn and
    running the suite. Against the tree before this block, only
    `segmentsPerRequest` reddened; the other nine were live in production and
    exercised by nothing. With this block all ten redden, and re-running that
    measurement is how you check the block still earns its place.

    Each case reads its number out of `LIMITS` rather than copying it: a suite
    written relative to its own constant cannot catch a bad value, but it can
    catch a deleted check, which is what these are for.

    ONE CHECK PER BOUND, NAMED. An earlier draft rolled six of them into a
    single `admitted.length === 0`, which would have gone green with a case
    refused for the wrong reason — and one of them was, because the segment
    shape was wrong and `normalizeSegment` dropped it before any bound saw it.
  */
  const boundStore = fakeStore({ conditionalWrite: true });
  const boundSession = { scope: "private", workspaceId: "ws_bounds" };
  // Nothing in this block finalizes, so this is never invoked; it is here to
  // fail loudly rather than write a note if that ever stops being true.
  const refuseToPublish = async () => {
    throw new Error("the bounds fixture never finalizes");
  };
  const BOUND_SESSION = idOf("z");

  const sendTo = async (path, body, headers = {}) =>
    handleMeetings(
      new Request(`https://mcp.context.test${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      path,
      boundStore,
      boundSession,
      { publishNote: refuseToPublish }
    );

  await sendTo("/meetings/sessions", {
    id: BOUND_SESSION,
    startedAt: "2026-09-05T13:00:00.000Z",
  });

  const segmentsPath = `/meetings/sessions/${BOUND_SESSION}/segments`;
  const notesPath = `/meetings/sessions/${BOUND_SESSION}/notes`;
  // The shape `normalizeSegment` accepts. Getting this wrong is how a bound
  // test passes on a row that was discarded before the bound was consulted.
  const seg = (i, text = "a") => ({ id: `s${i}`, startMs: i * 10, endMs: i * 10 + 5, text });
  // Distinct `at`, because `withFlag` dedupes on it: a batch of identical
  // flags folds to ONE, and a comment claiming otherwise is arithmetic nobody
  // checked. It was, for one round of review.
  const flags = (n) => Array.from({ length: n }, (_, i) => ({ type: "flag", at: i }));

  /*
    EACH BOUND IS A PAIR: the payload exactly at the limit is accepted and the
    payload one past it is refused. The refusal alone is not evidence — an
    earlier draft posted the three event bounds to `/meetings/sessions/:id/events`,
    a route that does not exist, and all three went green on the 404. A pair
    cannot do that: no wrong reason refuses one and admits the other.
  */
  const atBatch = await sendTo(segmentsPath, {
    segments: Array.from({ length: LIMITS.segmentsPerRequest }, (_, i) => seg(i)),
  });
  check("a full per-request batch of segments is accepted", atBatch.status === 200);
  const tooManySegments = await sendTo(segmentsPath, {
    segments: Array.from({ length: LIMITS.segmentsPerRequest + 1 }, (_, i) => seg(i)),
  });
  check("one segment over the per-request batch is refused", tooManySegments.status >= 400);

  const atSegmentText = await sendTo(segmentsPath, {
    segments: [seg(0, "a".repeat(LIMITS.segmentTextChars))],
  });
  check("a segment exactly at the text bound is accepted", atSegmentText.status === 200);
  const tooLongSegment = await sendTo(segmentsPath, {
    segments: [seg(0, "a".repeat(LIMITS.segmentTextChars + 1))],
  });
  check("one character over the per-segment text bound is refused", tooLongSegment.status >= 400);

  /*
    The three event bounds. A client's replay log arrives as `events` on the
    upsert body and on finalize — `foldLog(next, body.events)` at both — so the
    upsert is the surface that reaches `eventsPerRequest` and, through it,
    `assertEventWithinLimits` on every event in the batch. There is no separate
    events route to post to; `SUB_ROUTES` has segments, notes and finalize.
  */
  const replay = async (events) => sendTo("/meetings/sessions", { id: BOUND_SESSION, events });

  const atEvents = await replay(flags(LIMITS.eventsPerRequest));
  check("a full replay batch of events is accepted", atEvents.status === 200);
  // Folded, not discarded, and *asserted* rather than assumed: a fixture that
  // quietly folded to one flag would leave the `flags` ceiling unreachable and
  // this pair proving nothing about the record it claims to have grown.
  const afterReplay = JSON.parse(
    boundStore.objects.get(`${MEETING_PREFIX}${BOUND_SESSION}.json`).body
  );
  check(
    "and every event in it lands on the record",
    afterReplay.flags.length === LIMITS.eventsPerRequest
  );
  const tooManyEvents = await replay(flags(LIMITS.eventsPerRequest + 1));
  check("one event over the per-replay bound is refused", tooManyEvents.status >= 400);

  const atNotes = await sendTo(notesPath, { notes: "a".repeat(LIMITS.notesChars) });
  check("notes exactly at the bound are accepted", atNotes.status === 200);
  const tooLongNotes = await sendTo(notesPath, { notes: "a".repeat(LIMITS.notesChars + 1) });
  check("notes one character over the bound are refused", tooLongNotes.status >= 400);

  const atEnhanced = await replay([
    { type: "enhanced", at: 1, markdown: "a".repeat(LIMITS.enhancedChars) },
  ]);
  check("an enhanced note exactly at the bound is accepted", atEnhanced.status === 200);
  const tooLongEnhanced = await replay([
    { type: "enhanced", at: 1, markdown: "a".repeat(LIMITS.enhancedChars + 1) },
  ]);
  check("an enhanced note one character over the bound is refused", tooLongEnhanced.status >= 400);

  /*
    `requestBytes`, both halves, and they are NOT the same guard. `Content-Length`
    is a header the caller controls and a chunked request carries none at all,
    so `Number(null || 0)` is `0` and sails past the declared check — the
    byteLength check is the only real bound and the declared one is the
    courtesy that stops us buffering first.

    Which is why the declared half is driven by a body that LIES: a truthfully
    oversized body is refused by the byte check whether the declared one exists
    or not, so deleting the declared check reddens nothing and the pair proves
    one guard twice. A small body under a huge `Content-Length` is the only
    payload that isolates it — and it is the case the guard is for, since the
    header is the only thing we know before we buffer. The oversized body below is one
    long string field rather than a segments array, and both cases assert `413`
    exactly: `readJsonBody` is the only thing in the meetings path that returns
    that status, so neither can be satisfied by a refusal from anywhere else.
  */
  const declaredTooBig = await sendTo(segmentsPath, JSON.stringify({ notes: "small" }), {
    "Content-Length": String(LIMITS.requestBytes + 1),
  });
  check("a body that only claims to be too large is refused unread", declaredTooBig.status === 413);
  const huge = JSON.stringify({ notes: "a".repeat(LIMITS.requestBytes + 1) });
  const chunkedTooBig = await sendTo(segmentsPath, huge);
  check(
    "and one that declares nothing is refused on what it actually weighs",
    chunkedTooBig.status === 413
  );

  /*
    THE WHOLE-RECORD CEILINGS, asserted on the function that enforces them.

    `segmentsPerSession` is 20,000 and `flags` is 2,000, reached over many
    requests rather than in one; driving 20,000 segments through the handler
    would re-serialise the record on every batch and cost more than the check is
    worth.

    `attendees` is asymmetric between the two upsert paths, which is worth
    saying out loud: `foldMetadata` *truncates* with `slice(0, LIMITS.attendees)`
    when the session already exists, but `createSession` only dedupes, so a
    session OPENED over the ceiling reaches `assertSessionWithinLimits` and is
    refused. Both bound it; only one is a refusal, and that half is driven
    through the handler below. An earlier draft of this comment claimed the
    ceiling was unreachable through the handler at all, and skipped that check
    on the strength of it.

    So the ceilings are driven directly at `assertSessionWithinLimits`, which is
    the function all three live in and which `ingest.js` calls on every write
    that can grow one of them — the upsert, the segment append and the finalize
    claim. `replaceNotes` does not call it, and does not need to: it folds a
    `notes` event and touches none of these three lists. ("At every write" is
    what this said until review; it is one word wider than the code.)
  */
  const atCeiling = {
    transcript: Array.from({ length: LIMITS.segmentsPerSession }, (_, i) => seg(i)),
    attendees: Array.from({ length: LIMITS.attendees }, (_, i) => ({ name: `a${i}` })),
    flags: Array.from({ length: LIMITS.flags }, (_, i) => ({ at: i })),
  };
  let ceilingHeld = true;
  try {
    assertSessionWithinLimits(atCeiling);
  } catch {
    ceilingHeld = false;
  }
  check("a session exactly at every ceiling is allowed", ceilingHeld);

  const overBy = (field, extra) => {
    try {
      assertSessionWithinLimits({ ...atCeiling, [field]: [...atCeiling[field], extra] });
      return false;
    } catch {
      return true;
    }
  };
  check(
    "one segment past the session ceiling is refused",
    overBy("transcript", seg(LIMITS.segmentsPerSession))
  );
  check("one attendee past the ceiling is refused", overBy("attendees", { name: "one more" }));
  check("one flag past the ceiling is refused", overBy("flags", { at: 1 }));

  const crowded = await sendTo("/meetings/sessions", {
    id: SESSION_CROWDED,
    startedAt: "2026-09-05T13:00:00.000Z",
    attendees: Array.from({ length: LIMITS.attendees + 1 }, (_, i) => ({ name: `a${i}` })),
  });
  check("and a session opened one attendee over it is refused too", crowded.status >= 400);

  const fakeSession = { scope: "private", workspaceId: "ws_fake" };
  const publishNever = async () => {
    throw new Error("this fixture never finalizes");
  };
  const openOn = async (store, id) =>
    handleMeetings(
      new Request("https://mcp.context.test/meetings/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, startedAt: "2026-09-05T13:00:00.000Z" }),
      }),
      "/meetings/sessions",
      store,
      fakeSession,
      { publishNote: publishNever }
    );

  const ackSafe = await (await openOn(safe, SESSION_MAIN)).json();
  const ackUnsafe = await (await openOn(unsafe, SESSION_MAIN)).json();
  check("the ack tells a client its bucket is conflict-safe", ackSafe.conflictSafe === true);
  check(
    "and tells it plainly when it is not, rather than dropping the guarantee quietly",
    ackUnsafe.conflictSafe === false
  );

  await openOn(safe, SESSION_MAIN);
  await openOn(unsafe, SESSION_MAIN);
  check(
    "a second write to a conflict-safe store guards the read it came from",
    safe.puts.length === 2 && safe.puts[0].onlyIf === null && safe.puts[1].onlyIf !== null
  );
  /*
    This assertion used to read "a store that cannot guard one is never asked to
    pretend", and required `onlyIf` to be absent from every write to a store
    declaring `conditionalWrite: false`. It was correct while that flag meant
    "this adapter does not send `If-Match`". It stopped being correct when
    `withProbedCapabilities` made the flag mean "no probe has confirmed this
    backend honours `If-Match`" — a set that includes every freshly bound
    bucket, because the control plane starts each one at `false`.

    Under the old rule those buckets got no guard at all: a lost race was not
    reported, the retry never fired, and a stale writer overwrote a live meeting
    in silence. Nothing was "pretending" — a backend that ignores the header
    ignores it and the write succeeds either way — so the header was free and
    the rule was costing exactly the guarantee it was written to protect.

    What the author was defending is real and is still asserted, two checks
    above: the *ack* tells the client `conflictSafe: false`. That is where
    honesty about the backend belongs. Whether the guard is attempted is a
    different question from what the client is promised.
  */
  check(
    "a bucket that has not been probed is still guarded, not silently unguarded",
    unsafe.puts.length === 2 && unsafe.puts[0].onlyIf === null && unsafe.puts[1].onlyIf !== null
  );
  check(
    "while the ack still refuses to promise a guarantee the backend may not keep",
    ackUnsafe.conflictSafe === false
  );

  /*
    And the stamp is enforced where it can be checked rather than asserted where
    it cannot. `completionReceipt` builds a fresh object literal and once
    dropped the tier, which read back as `private` and locked a team connection
    out of the meeting it had just finished. A comment saying "every write goes
    through `updateSession`" is what failed; this is the version that cannot.
  */
  let refusedUnstamped = false;
  try {
    await writeSession(unprobed, { id: SESSION_MAIN, transcript: [], attendees: [], appliedAt: {} }, null);
  } catch {
    refusedUnstamped = true;
  }
  check("a record carrying no tier is refused rather than written at a downgraded one", refusedUnstamped);

}
