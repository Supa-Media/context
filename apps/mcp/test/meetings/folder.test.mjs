/**
 * The folder the person picked, end to end: filed where they pointed it
 * rather than into the inbox, refused folders, idempotent retries that claim
 * a path and release it.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants. Section 16 of the original file, run against the same
 * `harness` earlier sections left their state in.
 */

import {
  MeetingRefusal,
  SESSION_DOTTED,
  SESSION_ENCODED,
  SESSION_ESCAPING,
  SESSION_FILED,
  SESSION_PLUMBING,
  SESSION_RECLAIMED,
  SESSION_RETITLED,
  SESSION_SPACED,
  SESSION_TEAM_ALLOWED,
  SESSION_TEAM_DEFAULT,
  SESSION_TEAM_FOLDER,
  SESSION_WEDGED,
  TOKEN_EDITOR,
  TOKEN_MEMBER,
  TOKEN_OWNER,
  TOKEN_SHARED,
  callTool,
  fakeStore,
  handleMeetings,
  keysIn,
  meetingRequest,
  segment,
  toolDefinition,
} from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingFolderChecks(check, harness) {
  const { env, recorder, neighbour, s3, controlPlane, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* ------------ 16. the folder the person picked, end to end --------------- */

  /*
    A phone can ask where a meeting's notes should go, and until now the gateway
    built the inbox path from a module constant and consulted nothing: a person
    who picked a folder got the inbox anyway, silently. Everything below is that
    control actually reaching the bucket, and the four ways it must not misfire.
  */

  check(
    "a finalize that names no folder says nothing about one",
    finalized.body?.folderRejected === undefined && notePath.startsWith("0-inbox/meetings/")
  );

  // `notes` here is a placeholder these fixtures are not testing — they are
  // testing folders, claims and idempotency — and it exists only so the
  // sessions below are not `hasNothingCaptured`: without it every one of them
  // finalizes as `empty` and none of the folder logic below it ever runs.
  const openFor = (id, title, startedAt) =>
    meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: {
        id,
        title,
        startedAt,
        notes: "typed while it was happening",
        events: [{ type: "start", at: startedAt }],
      },
    });

  await openFor(SESSION_FILED, "Filed by hand", "2026-09-06T10:00:00.000Z");
  await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/notes`, {
    body: { notes: "- filed where the person pointed it" },
  });
  const filed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/finalize`, {
    body: { folder: "2-areas/team" },
  });
  const filedPath = filed.body?.notePath || "";
  check("a finalize can name the folder the person picked", filed.status === 200 && filed.body?.state === "complete");
  check(
    "...and the note lands in it, dumped straight in rather than under a date tree",
    filedPath === `2-areas/team/2026-09-06-filed-by-hand-${SESSION_FILED.slice(-8)}.md`
  );
  check("...carrying what the person typed", (recorder.get(filedPath)?.body || "").includes("filed where the person pointed it"));
  check("...and the ack claims nothing was refused", filed.body?.folderRejected === undefined);
  check(
    "...and nothing was filed into the inbox on the way",
    !keysIn(recorder, "0-inbox/meetings/").includes(filedPath)
  );

  /*
    THE IDEMPOTENCY CHECK. The note path is claimed into the session record
    under a conditional write and reused by every retry, so the folder is an
    input to the *claim* and the claim happens once. A second finalize naming
    somewhere else is a client retrying, not a person moving a note.
  */
  const filedAgain = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_FILED}/finalize`, {
    body: { folder: "1-projects/somewhere-else" },
  });
  check(
    "finalizing again with a different folder answers with the note that already exists",
    filedAgain.status === 200 && filedAgain.body?.notePath === filedPath
  );
  check("...writing nothing at the folder the retry named", keysIn(recorder, "1-projects/somewhere-else/").length === 0);
  check("...so the meeting is still exactly one note", keysIn(recorder, "2-areas/team/").length === 1);
  /*
    And it SAYS so. Answering 200 with the first note's path and no flag is
    correct about the meeting and silent about the request: the client asked for
    `1-projects/somewhere-else` and got `2-areas/team`, which is the same
    "appears to work and does nothing" the destination control was built to end,
    one layer down. `folderRejected` is the field for exactly that sentence, so
    it means "the folder you named is not where this note is" rather than the
    narrower "the string you sent was malformed".
  */
  check("...and the client is told the folder it named is not where the note is", filedAgain.body?.folderRejected === true);
  check("...without reading its value back", !filedAgain.text.includes("somewhere-else"));

  /*
    And the same property through the path that is not a no-op: a first finalize
    whose note write fails has *claimed* a path without writing it, which is the
    one window where a second folder could fork a meeting into two notes.
  */
  await openFor(SESSION_RECLAIMED, "Half written", "2026-09-06T11:00:00.000Z");
  harness.failPut = (url) => (url.includes("/meet-recorder/2-areas/archive/") ? 500 : null);
  const claimed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RECLAIMED}/finalize`, {
    body: { folder: "2-areas/archive" },
  });
  check(
    "a note write that fails under a chosen folder is retryable, like any other",
    claimed.status === 503 && claimed.body?.error === "meeting_unavailable"
  );
  harness.failPut = null;
  const reclaimed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RECLAIMED}/finalize`, {
    body: { folder: "3-resources/inbox" },
  });
  check(
    "the retry lands on the path the first finalize claimed, not the folder it just named",
    reclaimed.status === 200 && reclaimed.body?.notePath?.startsWith("2-areas/archive/")
  );
  check("...leaving nothing behind at the second folder", keysIn(recorder, "3-resources/").length === 0);
  check("...and exactly one note at the first", keysIn(recorder, "2-areas/archive/").length === 1);
  /*
    A *transient* failure keeps the claim, which is the property the claim
    exists for — and the client is still told that the folder it named on the
    retry is not where the note went. The two are not in tension: the claim
    decides where the note goes, the flag says whether the request got what it
    asked for.
  */
  check("...and the retry is told its folder was not the one used", reclaimed.body?.folderRejected === true);

  /*
    THE TRAP THE IDEMPOTENCY SECTION NAMES, WHICH NOTHING WAS CHECKING.

    `docs/decisions/meetings.md` states it in so many words: "if the bucket path
    is derived from the title, and the human renames the meeting between a
    failed finalize and its retry, a title-derived path produces a *second* note
    and both look correct" — and it then cited a check called `a re-finalize
    with a changed title rewrites one note rather than adding a second` that had
    never been written. The folder cases above are the same window entered by a
    different door and do not cover it: `slugifyTitle` is what puts the title
    into the key, so a rename is the one input that changes the *filename*
    rather than the folder, and a claim read out of the record is the only thing
    stopping it. Both notes would look correct, which is what makes it the trap.
  */
  await openFor(SESSION_RETITLED, "Standup", "2026-09-06T13:00:00.000Z");
  harness.failPut = (url) => (url.includes("/meet-recorder/0-inbox/meetings/") ? 500 : null);
  const halfNamed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RETITLED}/finalize`, {});
  check(
    "a finalize whose note write fails has claimed a path under the first title",
    halfNamed.status === 503 && halfNamed.body?.error === "meeting_unavailable"
  );
  harness.failPut = null;
  const inboxBeforeRetitle = keysIn(recorder, "0-inbox/meetings/").length;
  const renamed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_RETITLED}/finalize`, {
    body: { title: "Quarterly planning with the whole team" },
  });
  check(
    "a re-finalize with a changed title rewrites one note rather than adding a second",
    renamed.status === 200 &&
      renamed.body?.notePath === `0-inbox/meetings/2026-09-06-standup-${SESSION_RETITLED.slice(-8)}.md`
  );
  check(
    "...so the rename adds no second key to the bucket",
    keysIn(recorder, "0-inbox/meetings/").length === inboxBeforeRetitle + 1
  );
  check(
    "...and nothing is filed under the new title's slug",
    !keysIn(recorder, "0-inbox/meetings/").some((key) => key.includes("quarterly-planning"))
  );

  /*
    A refused folder must not lose the meeting. `meeting_invalid` is the code a
    client does not retry, so failing the request over one bad string would park
    forty minutes of somebody's meeting for good — the same argument that makes
    an unusable flag row cost that row rather than the request. It falls back,
    and the ack says so, because a fallback nobody is told about is the silent
    wrong destination this whole change exists to close.
  */
  const inboxBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_ESCAPING, "Aimed outside", "2026-09-06T12:00:00.000Z");
  const escaping = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_ESCAPING}/finalize`, {
    body: { folder: "../../shhh-2026" },
  });
  check(
    "a folder that tries to leave the bucket does not lose the meeting",
    escaping.status === 200 && escaping.body?.state === "complete"
  );
  check("...it is filed at the default instead", escaping.body?.notePath?.startsWith("0-inbox/meetings/") === true);
  check("...and exactly one note appears there", keysIn(recorder, "0-inbox/meetings/").length === inboxBefore + 1);
  check("...the client is told its folder was not used", escaping.body?.folderRejected === true);
  check(
    "...and is not read its own value back",
    !escaping.text.includes("shhh-2026")
  );
  check(
    "...and no key anywhere in the bucket took the folder it asked for",
    ![...recorder.keys()].some((key) => key.includes("shhh-2026") || key.includes(".."))
  );

  await openFor(SESSION_PLUMBING, "Aimed at the plumbing", "2026-09-06T13:00:00.000Z");
  const plumbing = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_PLUMBING}/finalize`, {
    body: { folder: ".meetings" },
  });
  check(
    "a folder naming a dot-prefixed path is refused the same way",
    plumbing.body?.folderRejected === true && plumbing.body?.notePath?.startsWith("0-inbox/meetings/") === true
  );
  check(
    "...so no meeting is filed where `isPlumbing` would hide it from its own owner",
    keysIn(recorder, ".meetings/2026/").length === 0
  );

  /*
    `..` INSIDE a segment, which is a different thing from traversal and used to
    behave like nothing else in this list.

    `normalizeMeetingFolder` delegated to `normalizeRoot`, which refuses a
    segment that *equals* `.` or `..`. `normalizePath` — the gateway's own rule
    for a key — refuses `..` anywhere in the string. So `1-projects/foo..bar`
    passed validation, the claim wrote `1-projects/foo..bar/2026/09/….md` into
    the session record under a conditional write, and every finalize from then
    on answered 400 `meeting_invalid`: the code a client does not retry, on a
    path nothing clears. Only a `null` from the folder validator reaches the
    fallback above, so this class bypassed it completely — a meeting parked for
    good over a folder name a real vault could have.
  */
  const dottedBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_DOTTED, "Aimed at a dotted name", "2026-09-06T16:00:00.000Z");
  const dotted = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_DOTTED}/finalize`, {
    body: { folder: "1-projects/foo..bar" },
  });
  check(
    "a folder with `..` inside a segment does not wedge the meeting",
    dotted.status === 200 && dotted.body?.state === "complete"
  );
  check(
    "...it falls back like every other folder this gateway will not file into",
    dotted.body?.notePath?.startsWith("0-inbox/meetings/") === true &&
      keysIn(recorder, "0-inbox/meetings/").length === dottedBefore + 1
  );
  check("...and the client is told", dotted.body?.folderRejected === true);
  check(
    "...with nothing left anywhere at the name it asked for",
    ![...recorder.keys()].some((key) => key.includes("foo..bar"))
  );

  /*
    AND THE SAME THING PERCENT-ENCODED, WHICH THE RULE ABOVE DOES NOT COVER.

    The `..` check is `segment.includes("..")` on the raw string, and the
    gateway's `normalizePath` is `clean.includes("..")` — so the two agree, and
    the comment above is right that they do. **The layer that refuses the key
    is neither of them.** `describeKeyProblem`, at the adapter boundary,
    percent-DECODES each segment before comparing: a segment of `%2e%2e` is a
    `".." path segment` there and nowhere earlier.

    WHAT IT COSTS, MEASURED RATHER THAN INHERITED FROM THE CASE ABOVE. A first
    draft of this block reused that case's story and every load-bearing clause
    of it was wrong. The refusal happens in `store.get` inside
    `unclaimedNotePath`, which runs INSIDE the claim mutator — so:

      - the session record is never written (`state: "recording"`,
        `notePath: null`, `version: 1` after the failure),
      - nothing is claimed, so `releaseClaim` is never reached and its
        400/403 gate is beside the point,
      - `publishMeetingNote` is never entered, so `normalizePath`,
        `isPlumbing` and `persistExactVisibility` are all downstream of a call
        that did not happen — which is why `privacy.md` is untouched,
      - and a later finalize returns **200** at the default folder. Nothing is
        lost and the meeting is not stuck.

    The defect is the ANSWER. A deterministic failure comes back
    `503 meeting_unavailable`, "retry with backoff" — so a client repeating the
    same body retries forever, instead of the 200 with `folderRejected` that
    this whole fallback exists to give it.

    Four shapes measured, all accepted by the folder validator and all refused
    by `assertSafeKey`: `%2e%2e`, `%2E%2E`, `ok/%2e%2e`, `%2e`.
  */
  const encodedBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_ENCODED, "Aimed at an encoded name", "2026-09-06T17:00:00.000Z");
  const encoded = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_ENCODED}/finalize`,
    { body: { folder: "1-projects/%2e%2e" } }
  );
  check(
    "a folder whose segment decodes to `..` is answered, not retried forever",
    encoded.status === 200 && encoded.body?.state === "complete"
  );
  check(
    "...it falls back like every other folder this gateway will not file into",
    encoded.body?.notePath?.startsWith("0-inbox/meetings/") === true &&
      keysIn(recorder, "0-inbox/meetings/").length === encodedBefore + 1
  );
  check("...and the client is told", encoded.body?.folderRejected === true);
  check(
    "...with nothing written at the encoded name, and privacy.md untouched",
    ![...recorder.keys()].some((key) => key.includes("%2e")) &&
      !(recorder.get("privacy.md")?.body ?? "").includes("%2e")
  );

  /*
    AND A FOLDER THE VALIDATOR ACCEPTED THAT THE BUILDER THEN REFUSED.

    `normalizeMeetingFolder` was not idempotent: `normalizeRoot` trims the whole
    string but not a segment, so `"/ /"` came back as `" "` and normalizing that
    again gave `null`. `meetingNotePath` re-normalizes what it is handed, and
    the gateway hands it this function's own output — inside the claim mutator,
    so the throw surfaced as **400 `meeting_invalid`, "this session's start time
    is not a timestamp"**, on a session whose `startedAt` is fine. The `catch`
    producing that message says "The folder cannot reach here: it was resolved
    before any of this"; it could, and now it cannot.

    Fixed in `packages/meetings/src/paths.js`, whose suite holds the property
    (4,680 shapes, 132 non-idempotent and 20 throwing before, 0 and 0 after).
    This check is the end the person sees: a fallback and a flag, not a refusal
    that blames the clock.
  */
  const spacedBefore = keysIn(recorder, "0-inbox/meetings/").length;
  await openFor(SESSION_SPACED, "Aimed at a spaced name", "2026-09-06T18:00:00.000Z");
  const spaced = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_SPACED}/finalize`,
    { body: { folder: "/ /" } }
  );
  check(
    "a folder that normalizes to a whitespace segment falls back, and does not blame the clock",
    spaced.status === 200 &&
      spaced.body?.folderRejected === true &&
      keysIn(recorder, "0-inbox/meetings/").length === spacedBefore + 1
  );

  /*
    THE TIER IS THE PATH'S, AND A CLIENT-NAMED FOLDER DOES NOT BUY A WIDER ONE.
    `1-projects` defaults to `team` in this context's manifest, so a folder
    argument is now a way to ask for a destination whose folder rule differs
    from the inbox's. A personal connection's meeting is still private, with the
    exact override written before the content — the note's tier is decided by
    `privacy.md` and the connection's scope, exactly as `write_note`'s is.
  */
  await openFor(SESSION_TEAM_DEFAULT, "Filed in a team folder", "2026-09-06T14:00:00.000Z");
  const inTeamFolder = await meetingRequest(
    env,
    TOKEN_OWNER,
    `/meetings/sessions/${SESSION_TEAM_DEFAULT}/finalize`,
    { body: { folder: "1-projects/notes" } }
  );
  const teamFolderPath = inTeamFolder.body?.notePath || "";
  check("a personal connection can file into a team-default folder", inTeamFolder.status === 200);
  check(
    "...and the note is still private, because the tier is the connection's and not the folder's",
    (await callTool(env, TOKEN_OWNER, "read_meeting", { path: teamFolderPath })).includes("visibility: private")
  );
  check(
    "...so a team connection cannot read a meeting filed into its own folder",
    (await callTool(env, TOKEN_MEMBER, "read_meeting", { path: teamFolderPath })) === "not found"
  );

  /*
    And the other direction: a team connection may only create team content, in
    a folder whose default is already team. That refusal is unchanged, and the
    folder argument is now the way such a connection reaches a destination it
    *can* write — which is the same rule `toolWriteNote` obeys, not a new one.
  */
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM_FOLDER,
      title: "An editor files properly",
      startedAt: "2026-09-06T15:00:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-06T15:00:00.000Z" }],
    },
  });
  const editorPrivateFolder = await meetingRequest(
    env,
    TOKEN_EDITOR,
    `/meetings/sessions/${SESSION_TEAM_FOLDER}/finalize`,
    { body: { folder: "2-areas/private-by-default" } }
  );
  check(
    "a team connection still cannot name a folder whose default is private",
    editorPrivateFolder.status === 403 && editorPrivateFolder.body?.error === "meeting_forbidden"
  );
  check("...and no note is written when it tries", keysIn(recorder, "2-areas/private-by-default/").length === 0);
  /*
    A second session rather than a retry of that one, because in *this* context
    the default meetings folder is private as well — so a retry could only be
    refused again, for a reason that has nothing to do with the folder it named.

    **The claim that refusal leaves behind is released now, and the sentence
    that used to stand here is corrected rather than dropped.** It said a team
    connection naming a destination its tier may not write "parks that session
    on that path", and called that "the pre-existing behaviour of this route
    ... not something the folder argument introduces". That was false. Before
    `body.folder` existed a team connection could only ever aim at
    `MEETINGS_FOLDER`, so in a context whose default folder is team-visible
    there was no way to wedge at all, and in one whose default is private the
    very first finalize failed — nothing was lost that the person could
    otherwise have had. The folder argument is what made a deterministic
    post-claim refusal reachable in a context that would otherwise work, and a
    sticky claim is what made it permanent. `SESSION_WEDGED` below is that
    case, run in the one context in this file whose default folder a team
    connection *can* write.
  */
  await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
    body: {
      id: SESSION_TEAM_ALLOWED,
      title: "An editor files properly",
      startedAt: "2026-09-06T15:30:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-06T15:30:00.000Z" }],
    },
  });
  const editorTeamFolder = await meetingRequest(
    env,
    TOKEN_EDITOR,
    `/meetings/sessions/${SESSION_TEAM_ALLOWED}/finalize`,
    { body: { folder: "1-projects/shared" } }
  );
  check(
    "...while a folder its tier may write is accepted",
    editorTeamFolder.status === 200 && editorTeamFolder.body?.notePath?.startsWith("1-projects/shared/") === true
  );
  check(
    "...and lands at the tier that path earns",
    (await callTool(env, TOKEN_EDITOR, "read_meeting", { path: editorTeamFolder.body.notePath })).includes(
      "visibility: team"
    )
  );

  /*
    A REFUSAL THAT WILL NEVER SUCCEED DOES NOT KEEP THE PATH IT CLAIMED.

    `TOKEN_SHARED` is a team connection in a context whose `0-inbox` default is
    team-visible, so it can finish a meeting — the mainline shared-workspace
    flow. Point it at a folder its tier may not write and the finalize is
    refused at the note write, by which time the claim has already reserved
    that path in the session record. The claim is deliberately sticky across a
    retry, so the sequence was: `finalize {folder}` → 403, `finalize {folder}`
    → 403, **`finalize {}` → 403** — a meeting that could be recorded, could be
    typed into, and could never be written out, over one string the person
    picked in a sheet.

    The claim exists so that a *retryable* failure lands on the same note. A
    refusal that will never succeed has written nothing, so holding the path
    buys nothing and costs the meeting. So a deterministic refusal from the
    note write releases the claim, and only a deterministic one: the storage
    failure two blocks up still keeps it, which is what `the retry lands on the
    path the first finalize claimed` asserts.
  */
  await meetingRequest(env, TOKEN_SHARED, "/meetings/sessions", {
    body: {
      id: SESSION_WEDGED,
      title: "Aimed somewhere its tier cannot reach",
      startedAt: "2026-09-06T17:00:00.000Z",
      notes: "the meeting itself",
      events: [{ type: "start", at: "2026-09-06T17:00:00.000Z" }],
    },
  });
  const shared = s3.bucketFor("meet-shared");
  const wedge = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_WEDGED}/finalize`, {
    body: { folder: "2-areas/private-here" },
  });
  check(
    "a team connection naming a folder its tier may not write is still refused",
    wedge.status === 403 && wedge.body?.error === "meeting_forbidden"
  );
  check("...and writes nothing there", keysIn(shared, "2-areas/private-here/").length === 0);
  const unwedged = await meetingRequest(env, TOKEN_SHARED, `/meetings/sessions/${SESSION_WEDGED}/finalize`, {
    body: {},
  });
  check(
    "...but the meeting is not parked on the path that refusal claimed",
    unwedged.status === 200 && unwedged.body?.state === "complete"
  );
  check(
    "...it finalizes into the default folder its tier can write",
    unwedged.body?.notePath?.startsWith("0-inbox/meetings/") === true
  );
  check(
    "...and the note is really there, with exactly one written for it",
    typeof shared.get(unwedged.body.notePath)?.body === "string" &&
      keysIn(shared, "0-inbox/meetings/").filter((key) => key.includes(SESSION_WEDGED.slice(-8))).length === 1
  );

  /*
    WHICH FAILURES GIVE THE PATH BACK, as a table rather than as one example.

    The refusal above is a 403 and the storage failure further up is a thrown
    `Error`, so between them the suite covers two of the four shapes a note
    write can fail in — and the two it missed are the two that decide whether
    the crash-retry property survives. Measured: a `releaseClaim` with its
    status check deleted, which releases on a `MeetingRefusal(503)` too, went
    green against the whole suite.

    So this drives `handleMeetings` directly with a programmable `publishNote`.
    The rule being pinned: a refusal that will never succeed (400, 403) gives
    the claimed path back, and anything that might work next time (503, a
    thrown storage error) keeps it.
  */
  const releaseCases = [
    { name: "a 400 refusal", error: () => new MeetingRefusal(400, "invalid", "not a note path"), released: true },
    { name: "a 403 refusal", error: () => new MeetingRefusal(403, "forbidden", "not at this tier"), released: true },
    { name: "a 503 refusal", error: () => new MeetingRefusal(503, "unavailable", "the manifest could not be read"), released: false },
    { name: "a storage error", error: () => new Error("the bucket said no"), released: false },
  ];
  for (const [index, releaseCase] of releaseCases.entries()) {
    const store = fakeStore({ conditionalWrite: true });
    const id = `mtg_${"c".repeat(19)}${index}`;
    let refuse = true;
    const publish = async (_store, _scope, { path }) => {
      if (refuse) throw releaseCase.error();
      return { path, etag: "e1", visibility: "private" };
    };
    const call = (path, body) =>
      handleMeetings(
        new Request(`https://mcp.context.test${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        path,
        store,
        { scope: "private", workspaceId: "ws_release" },
        { publishNote: publish }
      );

    await call("/meetings/sessions", {
      id,
      title: "Claimed once",
      startedAt: "2026-09-06T18:00:00.000Z",
      notes: "the meeting itself",
    });
    await call(`/meetings/sessions/${id}/finalize`, { folder: "2-areas/first" });
    refuse = false;
    const second = await (await call(`/meetings/sessions/${id}/finalize`, {})).json();
    const landed = String(second.notePath || "");
    check(
      releaseCase.released
        ? `${releaseCase.name} gives the claimed path back, so a bare finalize still lands`
        : `${releaseCase.name} keeps the claim, because it might work next time`,
      releaseCase.released
        ? landed.startsWith("0-inbox/meetings/")
        : landed.startsWith("2-areas/first/")
    );
  }

  /*
    The one consequence worth stating rather than discovering. `list_meetings`
    reads the default folder off the bucket, because there is no meetings index
    to consult and nothing records where a meeting was filed — so a meeting the
    person pointed elsewhere is not listed, which is exactly what already
    happens to a meeting its owner *moves*. It is still a note, and every other
    tool reaches it.
  */
  const listAfterFiling = await callTool(env, TOKEN_OWNER, "list_meetings", { limit: 25 });
  check("list_meetings still lists what is in the default folder", listAfterFiling.includes(notePath));
  check(
    "and does not claim a meeting filed elsewhere, the same as one its owner moved",
    !listAfterFiling.includes(filedPath)
  );
  check(
    "...which is still a note, and read_meeting reads it at its own path",
    (await callTool(env, TOKEN_OWNER, "read_meeting", { path: filedPath })).includes(
      "filed where the person pointed it"
    )
  );

  /*
    **And the model is told, because the model is the only one who can act on
    it.** The three checks above prove the behaviour; none of them reads the
    sentence a connected client is actually handed, and for a while that
    sentence said `list_meetings` lists "the meetings the user recorded" — full
    stop, no qualification. An assistant reading that has no reason to look
    further when a meeting is missing, so a meeting somebody deliberately filed
    elsewhere silently did not exist to any client. A tool description is not
    prose about the tool; it is the whole of what the model knows, and a wrong
    one is a defect of the same kind as a wrong return value.

    Asserted on the shape of the claim rather than on the exact wording — the
    folder it names, that it is not everything, and where to go instead — so
    the sentence may be rewritten but not quietly re-broadened.
  */
  const listDefinition = await toolDefinition(env, TOKEN_OWNER, "list_meetings");
  const listedDescription = listDefinition?.description || "";
  check("the tool's own description names the folder it reads", listedDescription.includes("0-inbox/meetings"));
  check(
    "...says it is not every meeting",
    /not necessarily every meeting|does not appear here|not every meeting/i.test(listedDescription)
  );
  check("...and points somewhere for the ones it does not list", listedDescription.includes("search_notes"));

}
