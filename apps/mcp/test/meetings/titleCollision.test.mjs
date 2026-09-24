/**
 * M1: a moved meeting note is still reachable, and a title collision never
 * lets a stale meeting resolve to the note a different one owns.
 *
 * Split out of meetings.test.mjs; see fixtures.mjs for the shared harness and
 * constants, run against the same `harness` earlier sections left their
 * state in.
 */

import { SESSION_MAIN, TOKEN_EDITOR, TOKEN_OWNER, callTool, idOf, meetingRequest } from "./fixtures.mjs";

/** @param {(label: string, ok: boolean) => void} check */
export async function runMeetingTitleCollisionChecks(check, harness) {
  const { env, recorder, neighbour, opened, rawRecord, finalized, notePath, receipt, written } = harness;
  /* ----------------- M1: a moved meeting note is still reachable ---------- */
  //
  // `notePath` is written once, at finalize, and nothing updates it when the
  // note is moved afterwards — that is `move_note`'s job, and it knows nothing
  // about meetings. `resolveMeetingNotePath` (`src/index.js`) is the fix: it
  // resolves fresh on every `GET /meetings/sessions/:id`, against the note's
  // own `meeting-id` frontmatter, rather than trusting the stored path.
  {
    const SESSION_MOVED = idOf("9");
    await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: {
        id: SESSION_MOVED,
        title: "Filed, then moved",
        startedAt: "2026-09-05T09:00:00.000Z",
        notes: "the meeting itself",
        events: [{ type: "start", at: "2026-09-05T09:00:00.000Z" }],
      },
    });
    const movedFinalize = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MOVED}/finalize`, {
      body: { endedAt: "2026-09-05T09:30:00.000Z" },
    });
    const originalPath = movedFinalize.body?.notePath;
    check(
      "M1 fixture: a session finalizes with a note path",
      movedFinalize.status === 200 && typeof originalPath === "string" && originalPath !== ""
    );

    // What `move_note` does, without going through it: the bytes move to a new
    // key, byte-for-byte, and the old key is gone. Nothing here tells the
    // session record.
    const originalObject = recorder.get(originalPath);
    const movedPath = "0-inbox/archive/filed-and-moved.md";
    recorder.set(movedPath, { body: originalObject.body, etag: originalObject.etag });
    recorder.delete(originalPath);

    const beforeIndexed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MOVED}`, {
      method: "GET",
    });
    check(
      "before the search index has ever run, the (now stale) stored path is reported honestly rather than guessed",
      beforeIndexed.status === 200 && beforeIndexed.body?.session?.notePath === originalPath
    );

    // Behind a response, exactly like an ordinary search — never in front of
    // one. A handful of notes converges in one pass; several are run so this
    // is not timing-fragile against the shard-count/budget arithmetic.
    for (let pass = 0; pass < 12; pass += 1) {
      await callTool(env, TOKEN_OWNER, "search_notes", { query: "filed" });
    }

    const afterIndexed = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MOVED}`, {
      method: "GET",
    });
    check(
      "M1: once the index has caught up, notePath resolves to where the note actually is now",
      afterIndexed.status === 200 && afterIndexed.body?.session?.notePath === movedPath
    );
    check(
      "...and that path is genuinely readable — the note is reachable from its pointer again",
      recorder.get(afterIndexed.body?.session?.notePath ?? "")?.body === originalObject.body
    );

    check(
      "a session whose note never moved is unaffected: it still answers with its original path",
      (await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MAIN}`, { method: "GET" })).body?.session
        ?.notePath === notePath
    );
  }

  /*
   * M1, the adversarial half: resolution is a locator, never a permission.
   * A note finalized team-visible and then moved into a *private* path must
   * not resolve to that path for a team-tier reader, even though the search
   * index itself holds every note regardless of who is asking. The candidate
   * `resolveMeetingNotePath` finds is re-checked with this caller's own
   * `canSee` before it is ever handed back.
   */
  {
    const SESSION_MOVED_PRIVATE = idOf("2");
    await meetingRequest(env, TOKEN_EDITOR, "/meetings/sessions", {
      body: {
        id: SESSION_MOVED_PRIVATE,
        title: "Team meeting, moved somewhere private",
        startedAt: "2026-09-06T09:00:00.000Z",
        notes: "the meeting itself",
        events: [{ type: "start", at: "2026-09-06T09:00:00.000Z" }],
      },
    });
    const teamFinalize = await meetingRequest(
      env,
      TOKEN_EDITOR,
      `/meetings/sessions/${SESSION_MOVED_PRIVATE}/finalize`,
      { body: { folder: "1-projects/shared" } }
    );
    const teamOriginalPath = teamFinalize.body?.notePath;
    check(
      "adversarial fixture: an editor finalizes a team-visible note",
      teamFinalize.status === 200 && typeof teamOriginalPath === "string"
    );

    const teamObject = recorder.get(teamOriginalPath);
    const privatePath = "0-inbox/archive/team-meeting-gone-private.md";
    recorder.set(privatePath, { body: teamObject.body, etag: teamObject.etag });
    recorder.delete(teamOriginalPath);

    for (let pass = 0; pass < 12; pass += 1) {
      await callTool(env, TOKEN_OWNER, "search_notes", { query: "private" });
    }

    const asTeam = await meetingRequest(env, TOKEN_EDITOR, `/meetings/sessions/${SESSION_MOVED_PRIVATE}`, {
      method: "GET",
    });
    check(
      "a team-tier caller never receives the private path the note moved to",
      asTeam.status === 200 && asTeam.body?.session?.notePath !== privatePath
    );
    check(
      "...not anywhere in the answer, the same way a search result never carries a withheld path",
      !JSON.stringify(asTeam.body ?? {}).includes(privatePath)
    );
    // The private tier can see everything, so the same session resolves for
    // the workspace's owner — proving the guard above is the visibility
    // check and not merely "the search missed it".
    const asOwner = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_MOVED_PRIVATE}`, {
      method: "GET",
    });
    check(
      "...while the private tier, which can see everything, resolves it normally",
      asOwner.status === 200 && asOwner.body?.session?.notePath === privatePath
    );
  }

  /*
   * M1, the title-collision half: a title is a weaker anchor than a
   * `meeting-id` — two sessions can share one — so a hit is never trusted
   * from the ranking alone. This is the check the PR's own sabotage record
   * named and left unpinned: dropping the per-candidate frontmatter
   * comparison (trusting the top search hit outright) passed every other
   * check in this file, because none of the fixtures above ever gave two
   * *different* meetings the same title. This one does.
   *
   * Session B finalizes first and is indexed normally — a real, readable
   * note with its own `meeting-id`. Session A shares its exact title, but its
   * own note is deleted the instant it is created, before any index pass
   * ever sees it — so when A's stale stored path later misses, the *only*
   * note a title search can find is B's, and B is not A's meeting. Resolving
   * to B's path would be exactly what "trust the top hit outright" does; the
   * frontmatter check is what stops it and falls back to A's own (now
   * unreadable) stale path instead — "not resolved this time", never someone
   * else's note.
   */
  {
    const COLLIDING_TITLE = "Ambiguous title fixture";

    const SESSION_TITLE_B = idOf("0");
    await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: {
        id: SESSION_TITLE_B,
        title: COLLIDING_TITLE,
        startedAt: "2026-09-05T10:00:00.000Z",
        notes: "the meeting itself",
        events: [{ type: "start", at: "2026-09-05T10:00:00.000Z" }],
      },
    });
    const finalizeB = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_TITLE_B}/finalize`, {
      body: { endedAt: "2026-09-05T10:30:00.000Z" },
    });
    const pathB = finalizeB.body?.notePath;
    check(
      "title-collision fixture: session B finalizes with its own note",
      finalizeB.status === 200 && typeof pathB === "string" && pathB !== ""
    );

    const SESSION_TITLE_A = idOf("1");
    await meetingRequest(env, TOKEN_OWNER, "/meetings/sessions", {
      body: {
        id: SESSION_TITLE_A,
        title: COLLIDING_TITLE,
        startedAt: "2026-09-05T11:00:00.000Z",
        notes: "the meeting itself",
        events: [{ type: "start", at: "2026-09-05T11:00:00.000Z" }],
      },
    });
    const finalizeA = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_TITLE_A}/finalize`, {
      body: { endedAt: "2026-09-05T11:30:00.000Z" },
    });
    const pathA = finalizeA.body?.notePath;
    check(
      "title-collision fixture: session A finalizes with the same title, a different note",
      finalizeA.status === 200 && typeof pathA === "string" && pathA !== "" && pathA !== pathB
    );

    // A's note is gone before anything ever indexes it — not moved anywhere
    // reachable, so it can never be the hit a title search returns. Only B's
    // note is real and findable under this title from here on.
    recorder.delete(pathA);

    for (let pass = 0; pass < 12; pass += 1) {
      await callTool(env, TOKEN_OWNER, "search_notes", { query: "Ambiguous" });
    }

    const resolvedA = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_TITLE_A}`, {
      method: "GET",
    });
    check(
      "a note belonging to a *different* meeting, sharing this one's title, is never returned for it",
      resolvedA.status === 200 && resolvedA.body?.session?.notePath !== pathB
    );
    check(
      "...not anywhere in the answer",
      !JSON.stringify(resolvedA.body ?? {}).includes(pathB)
    );
    check(
      "...it falls back to reporting its own (now stale, unreadable) path honestly instead",
      resolvedA.status === 200 && resolvedA.body?.session?.notePath === pathA
    );

    // And B, which really does own that title, still resolves to itself —
    // the guard rejects an *impostor*, not every hit on a shared title.
    const resolvedB = await meetingRequest(env, TOKEN_OWNER, `/meetings/sessions/${SESSION_TITLE_B}`, {
      method: "GET",
    });
    check(
      "meanwhile the meeting that actually owns the title still resolves to its own note",
      resolvedB.status === 200 && resolvedB.body?.session?.notePath === pathB
    );
  }

  // Cleanup (restoreFailures/restoreControlPlane/restoreS3) moved to
  // harness.restoreAll(), called once by the meetings.test.mjs facade after
  // every section — including this last one — has run.
}
