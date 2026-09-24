/**
 * Transcribing a chunk: the route a client uploads recorded audio to, the
 * shared secret forwarded to the transcription service, and every way that
 * is supposed to fail or refuse.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants. The "transcribing a chunk" section of the original file (its
 * own header there numbers it 12 again — a pre-existing mislabelling, not
 * changed here), run against the same `harness` earlier sections left their
 * state in.
 */

import {
  LIMITS,
  MEETING_PREFIX,
  SESSION_MAIN,
  SESSION_NEVER_ISSUED,
  SESSION_TRANSCRIBE,
  TOKEN_EDITOR,
  TOKEN_NEIGHBOUR,
  TOKEN_OWNER,
  TOKEN_READ_ONLY,
  TRANSCRIBE_ORIGIN,
  TRANSCRIBE_SECRET,
  meetingRequest,
  segment,
  worker,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingTranscribingChecks(check, harness) {
  const { env, recorder, neighbour, s3, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* ----------------------- 12. transcribing a chunk ------------------------ */
  //
  // The one route that carries audio. What is checked here is not "does it
  // transcribe" — the engine is a stub — but the three things that decide
  // whether it is safe to have at all: an unconfigured deployment says so
  // permanently, a refusal costs zero inference, and the audio goes to the
  // service without anything that would let the service reconstruct a meeting.

  const chunk = (overrides = {}) => ({
    audioBase64: "QUJDRA==",
    mimeType: "audio/webm;codecs=opus",
    chunkId: `${SESSION_TRANSCRIBE}-mic-0`,
    offsetMs: 40_000,
    durationMs: 20_000,
    ...overrides,
  });

  const unconfigured = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}/transcribe`, {
    body: chunk(),
  });
  check(
    "a gateway with no transcription configured refuses, permanently",
    unconfigured.status === 501 && unconfigured.body?.error === "meeting_unavailable"
  );
  check("...and forwards nothing", harness.transcribeCalls.length === 0);

  const transcribing = {
    ...env,
    TRANSCRIBE_WORKER_URL: TRANSCRIBE_ORIGIN,
    TRANSCRIBE_WORKER_SECRET: TRANSCRIBE_SECRET,
  };

  const insecure = await meetingRequest(
    { ...transcribing, TRANSCRIBE_WORKER_URL: "http://transcribe.example-meetings.test" },
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_MAIN}/transcribe`,
    { body: chunk() }
  );
  check(
    "an http transcription endpoint is no configuration at all — audio does not go in the clear",
    insecure.status === 501 && harness.transcribeCalls.length === 0
  );

  const openedForAudio = await meetingRequest(transcribing, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_TRANSCRIBE, title: "Transcribed meeting", transcription: "cloud" },
  });
  check("a meeting to transcribe is opened", openedForAudio.status === 200);

  harness.transcribeAnswer = () =>
    new Response(
      JSON.stringify({
        segments: [
          { startMs: 0, endMs: 1_000, text: "first" },
          { startMs: 1_000, endMs: 1_200, text: "   " },
          { startMs: 1_200, endMs: 2_000, text: "third", confidence: 0.5 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  const transcribed = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check("a chunk is transcribed", transcribed.status === 200);
  const words = transcribed.body?.segments ?? [];
  check("the blank segment is dropped", words.length === 2);
  check(
    "...and nothing is renumbered, so an id names a position in the engine's own answer",
    words[1]?.id === `${SESSION_TRANSCRIBE}-mic-0-s002`
  );
  check("every id is derived from the chunk id the client sent", words.every((word) => word.id.startsWith(chunk().chunkId)));
  check("times are offset into session time", words[0]?.startMs === 40_000 && words[0]?.endMs === 41_000);
  check("a speaker is never invented", words.every((word) => word.speaker === null));
  check("a confidence the engine did not give is null, not a number we chose", words[0]?.confidence === null);
  check("...and one it did give is passed through", words[1]?.confidence === 0.5);
  check(
    "a service that refused nothing says so, rather than saying nothing",
    transcribed.body?.refusedSegments === 0
  );

  const forwarded = harness.transcribeCalls.at(-1);
  check("the audio went to the configured service", forwarded?.url === `${TRANSCRIBE_ORIGIN}/transcribe`);
  check("...with the shared secret as a bearer", forwarded?.headers.Authorization === `Bearer ${TRANSCRIBE_SECRET}`);
  check("...carrying the audio and what it is", forwarded?.body.audioBase64 === "QUJDRA==" && forwarded?.body.mimeType.startsWith("audio/webm"));
  check(
    "THE SERVICE IS NOT TOLD WHERE THE CHUNK SITS, so it cannot hold a fragment of a meeting",
    forwarded?.body.chunkId === undefined &&
      forwarded?.body.offsetMs === undefined &&
      forwarded?.body.sessionId === undefined
  );
  const callerHeader = forwarded?.headers["X-Caller-Hash"];
  check("who is spending is named opaquely", typeof callerHeader === "string" && /^[0-9a-f]{64}$/.test(callerHeader));
  check("...and it is not the workspace id", callerHeader !== "ws_recorder" && !callerHeader.includes("recorder"));

  const audioKey = `${MEETING_PREFIX}${SESSION_TRANSCRIBE}.json`;
  const audioRecord = JSON.parse(recorder.get(audioKey)?.body ?? "{}");
  check("the chunk was charged against the meeting's own budget", audioRecord.transcribedChunks === 1);

  /*
    The counter has to survive the *other* writes to a session, and that is not
    obvious: it is a field the shared core does not know about, riding on a
    record every event fold rebuilds. If a fold dropped it, the budget would
    silently reset on the next segment batch — a ceiling that resets is not a
    ceiling, and nothing else in the suite would have noticed.
  */
  await meetingRequest(transcribing, TOKEN_OWNER, `/meetings/sessions/${SESSION_TRANSCRIBE}/segments`, {
    body: { segments: [{ id: "seg-after-audio", startMs: 0, endMs: 1_000, text: "still here", channel: "mic" }] },
  });
  const afterFold = JSON.parse(recorder.get(audioKey)?.body ?? "{}");
  check("THE BUDGET SURVIVES AN EVENT FOLD, so a ceiling cannot be reset by recording", afterFold.transcribedChunks === 1);
  check("...and the fold still did its own job", (afterFold.transcript ?? []).length === 1);

  /*
    And the same attack through the other door, which is the obvious one to
    reach for: re-open the session you already hold, over the collection route,
    and see whether the record comes back rebuilt with the count gone.
    `foldMetadata` starts from the stored session rather than from the body, so
    it does not — but that is a property of `applyEvent` spreading a record it
    does not fully know, and nothing else here would notice it changing.
  */
  await meetingRequest(transcribing, TOKEN_OWNER, "/meetings/sessions", {
    body: { id: SESSION_TRANSCRIBE, title: "Re-opened to reset the meter" },
  });
  const afterUpsert = JSON.parse(recorder.get(audioKey)?.body ?? "{}");
  check(
    "...AND AN UPSERT OF A SESSION YOU HOLD DOES NOT RESET IT EITHER",
    afterUpsert.transcribedChunks === 1 && afterUpsert.title === "Re-opened to reset the meter"
  );

  /*
    SILENCE IS A REAL ANSWER, AND IT ARRIVES WITH ITS REASON.

    The transcription service now refuses the segments the engine's own evidence
    says are not speech (`infra/transcribe-worker/src/transcribe.ts`, after
    ninety seconds of a quiet room produced 166 words on the owner's Mac). So a
    quiet room reaches this gateway as an empty `segments` array beside a
    non-zero `refused`, and three things have to be true of that here.

    It must not read as a broken service. An empty array falls through
    `intoSegments` silently — but a payload with no readable `segments` at all
    is still a 503, because those are different answers and collapsing them is
    how "every meeting transcribed to nothing" ships with a green health check.

    The count must reach the recorder, because the recorder is what puts a
    sentence on somebody's screen. `segments: []` with `refused: 3` is "the room
    was quiet"; with `refused: 0` it is "nothing is transcribing this". A client
    that cannot tell them apart shows the wrong one, which is the shorter answer
    with no explanation this repository keeps finding.

    And a service one deploy behind must go on working: it is deployed by its
    own workflow and answers with a bare array.

    SABOTAGE, each one edit to `src/meetings/transcribe.js`:
      drop `refusedSegments` from the answer                    3 FAIL
      read `raw.segments` only, with no bare-array fallback     2 FAIL
      treat an unreadable payload as an empty transcript        1 FAIL

    What is deliberately NOT checked here is a judgement, because this gateway
    makes none: it holds a base64 string it must not decode and a list of
    sentences no filter can tell apart, so it carries the decision and does not
    take one.
  */
  const quietBefore = harness.transcribeCalls.length;
  harness.transcribeAnswer = () =>
    new Response(JSON.stringify({ text: "", segments: [], refused: 3 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const quiet = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBE}-mic-1` }) }
  );
  check("a chunk of silence is a 200, not a failure", quiet.status === 200);
  check("...with no words in it", (quiet.body?.segments ?? []).length === 0);
  check("...and the count that says why it is empty", quiet.body?.refusedSegments === 3);
  check("...having really been forwarded", harness.transcribeCalls.length === quietBefore + 1);

  harness.transcribeAnswer = () =>
    new Response(JSON.stringify([{ startMs: 0, endMs: 500, text: "older" }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const legacy = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBE}-mic-2` }) }
  );
  check("a service that predates the refusal count still transcribes", legacy.status === 200);
  check("...and reports nothing refused", legacy.body?.refusedSegments === 0);

  harness.transcribeAnswer = () =>
    new Response(JSON.stringify({ result: { text: "reshaped" } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const unreadable = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBE}-mic-3` }) }
  );
  check(
    "an answer with no readable segments is a failure, not a quiet room",
    unreadable.status === 503
  );

  /*
    THE EVIDENCE THE REFUSAL WAS MADE ON, CARRIED TO THE ONE WHO CAN READ IT.

    The refusal above cut invented words about threefold on the owner's Mac and
    did not stop them, and the question that decides what to do next — is the
    threshold wrong, or is the signal wrong — turns on `no_speech_prob`,
    `avg_logprob` and `duration_after_vad`, which were read in the transcription
    service and dropped there. Nothing downstream could see them: this gateway's
    logs are in an account the person diagnosing a recording does not have, and
    the transcript's own `confidence` is `null` on every segment the deployed
    model has ever produced, because it does not emit that field.

    So the summary rides the answer, and this gateway does to it exactly what it
    does to `refusedSegments`: reads the shape, carries it, judges nothing. Two
    properties, and the second is the one worth the check.

    SABOTAGE, each one edit to `src/meetings/transcribe.js`:
      drop `speechEvidence` from the answer                     3 FAIL
      forward `raw.evidence` instead of rebuilding it           1 FAIL
      default an absent reading to 0 rather than null           1 FAIL
  */
  harness.transcribeAnswer = () =>
    new Response(
      JSON.stringify({
        text: "hello",
        segments: [{ startMs: 0, endMs: 500, text: "hello" }],
        refused: 2,
        evidence: {
          segments: 3,
          statedNoSpeech: 3,
          statedLogprob: 3,
          keptNoSpeechMax: 0.58,
          keptLogprobMin: -0.99,
          refusedNoSpeechMin: 0.94,
          refusedLogprobMax: -1.6,
          duration: 20,
          durationAfterVad: null,
          // A field this gateway does not know, and a place somebody's words
          // could hide. It must not be forwarded.
          transcript: "words nobody asked this gateway to carry",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  const withEvidence = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBE}-mic-4` }) }
  );
  check(
    "the engine's own evidence reaches the recorder",
    withEvidence.body?.speechEvidence?.keptNoSpeechMax === 0.58 &&
      withEvidence.body?.speechEvidence?.keptLogprobMin === -0.99 &&
      withEvidence.body?.speechEvidence?.refusedNoSpeechMin === 0.94 &&
      withEvidence.body?.speechEvidence?.segments === 3
  );
  check(
    "...with a field the engine did not state carried as null, not as a number",
    withEvidence.body?.speechEvidence?.durationAfterVad === null
  );
  check(
    "...AND NOTHING THE GATEWAY DOES NOT KNOW, WHICH IS WHERE TEXT WOULD RIDE",
    Object.values(withEvidence.body?.speechEvidence ?? {}).every(
      (value) => value === null || typeof value === "number"
    ) && !("transcript" in (withEvidence.body?.speechEvidence ?? {}))
  );

  harness.transcribeAnswer = () =>
    new Response(JSON.stringify({ text: "hi", segments: [], refused: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const noEvidence = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBE}-mic-5` }) }
  );
  check(
    "a service too old to state any evidence says so with null, not with zeros",
    noEvidence.status === 200 && noEvidence.body?.speechEvidence === null
  );

  const before = harness.transcribeCalls.length;
  const neighbourTranscribe = await meetingRequest(
    transcribing,
    TOKEN_NEIGHBOUR,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check(
    "a neighbour holding the id cannot transcribe into it",
    neighbourTranscribe.status === 404 && neighbourTranscribe.body?.error === "meeting_forbidden"
  );
  check("...AND BUYS NO INFERENCE DOING SO", harness.transcribeCalls.length === before);

  const readOnlyTranscribe = await meetingRequest(
    transcribing,
    TOKEN_READ_ONLY,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check(
    "a read-only grant may not transcribe",
    readOnlyTranscribe.status === 403 && readOnlyTranscribe.body?.error === "meeting_forbidden"
  );
  check("...and buys no inference either", harness.transcribeCalls.length === before);

  const unknownSession = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_NEVER_ISSUED}/transcribe`,
    { body: chunk() }
  );
  check(
    "a chunk must belong to a meeting that exists",
    unknownSession.status === 404 && unknownSession.body?.error === "meeting_forbidden"
  );
  check("...so inference cannot be bought without recording anything", harness.transcribeCalls.length === before);

  /*
    AND THE TWO ANSWERS ARE ONE ANSWER, WHICH IS THE WHOLE OF THE GUARD.

    `canSeeSession`'s own header says a session a team connection may not see
    is "answered as absent, which is the same 404 another workspace's id
    gets", and `sessionNotFound`'s says it is "spelled once here because
    `ingest.js` and `updateSession` both have to give it and two spellings
    would be two answers." The checks above assert each refusal is *a* 404
    carrying `meeting_forbidden` — separately, and never against each other —
    so both would go on passing while the sentence a client actually reads
    drifted apart, and a team-tier caller holding an id would learn from the
    prose that a private meeting exists at it. That is the inference
    `SECURITY.md` counts as a bug, and the identity of these two strings is
    the only thing standing in front of it.

    So they are compared, rather than described. A team-tier grant is the
    caller because that is the boundary being tested: `TOKEN_NEIGHBOUR` above
    is another workspace, which the store refuses by construction, and this
    one is a caller who *can* reach this context and may not see this session
    in it.
  */
  const hiddenTranscribe = await meetingRequest(
    transcribing,
    TOKEN_EDITOR,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check(
    "a team-tier caller cannot transcribe into a private meeting it may not see",
    hiddenTranscribe.status === 404 && hiddenTranscribe.body?.error === "meeting_forbidden"
  );
  check("...buying no inference on the way", harness.transcribeCalls.length === before);
  check(
    "...AND IS TOLD WHAT AN ID THAT NEVER EXISTED IS TOLD, TO THE CHARACTER",
    typeof unknownSession.body?.error_description === "string" &&
      hiddenTranscribe.body?.error_description === unknownSession.body.error_description &&
      hiddenTranscribe.status === unknownSession.status &&
      hiddenTranscribe.body?.error === unknownSession.body?.error
  );

  const badMime = await meetingRequest(transcribing, TOKEN_OWNER, `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`, {
    body: chunk({ mimeType: "application/octet-stream" }),
  });
  check("a container this gateway does not accept is refused", badMime.status === 400 && badMime.body?.error === "meeting_invalid");
  check("...before anything is forwarded", harness.transcribeCalls.length === before);

  const oversizedChunk = await meetingRequest(transcribing, TOKEN_OWNER, `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`, {
    body: chunk({ audioBase64: "A".repeat(LIMITS.transcribeAudioChars + 1) }),
  });
  check("an oversized chunk is refused", oversizedChunk.status === 413);
  check("...before anything is forwarded", harness.transcribeCalls.length === before);

  const badChunkId = await meetingRequest(transcribing, TOKEN_OWNER, `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`, {
    body: chunk({ chunkId: "a chunk id with spaces and a \n newline" }),
  });
  check("a chunk id that is not a short key is refused", badChunkId.status === 400);

  // The budget, from the far side: a record already at the ceiling refuses
  // without forwarding, which is the only bound this stateless Worker can have.
  const spent = JSON.parse(recorder.get(audioKey)?.body ?? "{}");
  recorder.set(audioKey, {
    body: JSON.stringify({ ...spent, transcribedChunks: LIMITS.transcribeChunksPerSession }),
    etag: "t-spent",
  });
  const overBudget = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check(
    "a meeting that has spent its budget is refused, and not with a retry code",
    overBudget.status === 400 && overBudget.body?.error === "meeting_invalid"
  );
  check("...COSTING ZERO INFERENCE", harness.transcribeCalls.length === before);

  // A service that is down is temporary: the meeting is still recording, and
  // the next chunk is worth trying.
  recorder.set(audioKey, {
    body: JSON.stringify({ ...spent, transcribedChunks: 1 }),
    etag: "t-reset",
  });
  harness.transcribeAnswer = () => new Response("upstream is having a day", { status: 502 });
  const upstreamDown = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBE}/transcribe`,
    { body: chunk() }
  );
  check(
    "a transcription service that is down is a retryable refusal",
    upstreamDown.status === 503 && upstreamDown.body?.error === "meeting_unavailable"
  );
  check(
    "...and its own words are not relayed to the client",
    !JSON.stringify(upstreamDown.body ?? {}).includes("having a day")
  );
  harness.transcribeAnswer = null;

  /*
    THE ONE SHAPE `empty` MUST NOT DESCRIBE AS "NOTHING WAS CAPTURED".

    A meeting whose audio this gateway really did take, and whose transcription
    produced nothing — every chunk answered with no words, or dropped by a
    client after a refusal. That session reaches finalize with no transcript
    and no typed notes, so it is `empty` by the rule and nothing is filed,
    which is right: there is no audio anywhere to file, because audio is never
    persisted by us. What would be wrong is the sentence: "the microphone was
    never granted" sends somebody to their permissions over a recording that
    happened. `transcribedChunks` is spent before a byte is forwarded, so the
    gateway knows better than the device's guess here.
  */
  const SESSION_TRANSCRIBED_TO_NOTHING = `mtg_${"y9".repeat(10)}`;
  await meetingRequest(transcribing, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_TRANSCRIBED_TO_NOTHING,
      title: "Forty minutes nobody could transcribe",
      startedAt: "2026-09-06T09:00:00.000Z",
      transcription: "cloud",
    },
  });
  harness.transcribeAnswer = () =>
    new Response(JSON.stringify({ segments: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const silentChunk = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBED_TO_NOTHING}/transcribe`,
    { body: chunk({ chunkId: `${SESSION_TRANSCRIBED_TO_NOTHING}-mic-0` }) }
  );
  harness.transcribeAnswer = null;
  check("sanity: the audio went out and came back with no words", silentChunk.status === 200);
  const emptyAfterAudio = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TRANSCRIBED_TO_NOTHING}/finalize`,
    { body: { emptyReason: "microphone not granted" } }
  );
  check(
    "a meeting whose audio transcribed to nothing is still not filed",
    emptyAfterAudio.status === 200 && emptyAfterAudio.body?.state === "empty"
  );
  check(
    "...but it is not told the microphone was the problem, because this gateway took the audio",
    emptyAfterAudio.body?.emptyReason === "Audio was recorded, but no words came back from it."
  );
  check(
    "...and the sentence names no fault, because there may not be one",
    !/could not|failed|error/i.test(emptyAfterAudio.body?.emptyReason ?? "")
  );
  check(
    "...and nothing about the session was deleted on the way: the record is still there to read",
    JSON.parse(
      s3.bucketFor("meet-recorder").get(`${MEETING_PREFIX}${SESSION_TRANSCRIBED_TO_NOTHING}.json`)?.body ?? "{}"
    ).transcribedChunks === 1
  );

  /*
    THE SHAPE THAT COULD NOT REACH `empty` AT ALL UNTIL TONIGHT.

    A recording of a quiet room. `hasNothingCaptured` — no transcript, no typed
    notes — is the one rule behind `finalizing -> empty`, and its transcript
    half was unreachable for any session that opened a microphone: an engine
    handed ninety seconds of silence answered with 166 words, so the transcript
    was never empty and the guard merged as `2a120f5` was dead code in practice.
    The implementation was right; the assumption under it was false.

    Nothing here changed to fix that. What changed is upstream: the
    transcription service refuses the segments the engine's own evidence says
    are not speech, so a quiet chunk really does produce no words, and the
    existing rule reaches the existing state on its own. This is the check that
    says so end to end — chunks forwarded, no words back, and no note in the
    bucket.

    SABOTAGE: make the transcription answer carry one invented segment —
    `{ segments: [{ startMs: 0, endMs: 900, text: "Thank you." }], refused: 3 }`,
    which is what the engine really did — and 2 checks go RED, including "no
    note is written for a room nobody spoke in". That is exactly the defect: one
    hallucinated line is the whole difference between an empty session and a
    meeting note full of sentences nobody said.
  */
  const SESSION_QUIET_ROOM = `mtg_${"z8".repeat(10)}`;
  await meetingRequest(transcribing, TOKEN_OWNER, "/meetings/sessions", {
    body: {
      id: SESSION_QUIET_ROOM,
      title: "Ninety seconds of nobody talking",
      startedAt: "2026-09-06T11:00:00.000Z",
      transcription: "cloud",
    },
  });
  harness.transcribeAnswer = () =>
    new Response(JSON.stringify({ text: "", segments: [], refused: 4 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const quietChunks = [];
  for (let index = 0; index < 3; index += 1) {
    quietChunks.push(
      await meetingRequest(
        transcribing,
        TOKEN_OWNER,
        `/meetings/sessions/${SESSION_QUIET_ROOM}/transcribe`,
        { body: chunk({ chunkId: `${SESSION_QUIET_ROOM}-mic-${index}`, offsetMs: index * 20_000 }) }
      )
    );
  }
  harness.transcribeAnswer = null;
  check(
    "ninety seconds of a quiet room transcribes to nothing, three chunks running",
    quietChunks.every((answer) => answer.status === 200 && (answer.body?.segments ?? []).length === 0)
  );
  check(
    "...and every one of them says why it is empty",
    quietChunks.every((answer) => answer.body?.refusedSegments === 4)
  );
  const notesBefore = [...s3.bucketFor("meet-recorder").keys()].length;
  const quietFinal = await meetingRequest(
    transcribing,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_QUIET_ROOM}/finalize`,
    { body: {} }
  );
  check(
    "A SESSION THAT CAPTURED ONLY SILENCE REACHES `empty`",
    quietFinal.status === 200 && quietFinal.body?.state === "empty"
  );
  check(
    "no note is written for a room nobody spoke in",
    [...s3.bucketFor("meet-recorder").keys()].length === notesBefore && !quietFinal.body?.path
  );
  check(
    "...and the session record is still there, with its reason",
    typeof quietFinal.body?.emptyReason === "string" && quietFinal.body.emptyReason.length > 0
  );

}
