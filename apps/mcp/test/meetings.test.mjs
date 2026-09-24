/**
 * Meeting ingestion, end to end: the routes three devices send a meeting to,
 * the note it becomes in the customer's own bucket, and the ways all of that is
 * supposed to fail.
 *
 * The arrangement is the one where a mistake actually leaks: two workspaces on
 * the same S3 endpoint with adjacent bucket names, a session id issued in the
 * first, and a connection to the second that knows that id. Everything in the
 * isolation section is that neighbour trying to read it, write to it, finalize
 * it, and merely find out whether it exists — which is the one an existence
 * oracle gives away for free if the refusals are not identical.
 *
 * Offline and framework-free like the rest of the suite: a real control plane
 * stub over HTTP, a real S3 backend in memory, the real `S3Store` signing real
 * requests to it, and one `fetch` layer of our own on top that can fail a write
 * on demand — because "storage broke halfway through finalize" is not a
 * hypothetical for a product whose entire job is not to lose a meeting.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted, with the counts as measured
 * rather than as expected:
 *
 * 1. **The control plane hands the neighbour *our* binding**
 *    (`flags.bindingWorkspaceId = "ws_recorder"`, a control plane that resolved
 *    the wrong tenant) — 4 checks failed. This is the sabotage that matters
 *    here, because it is the only way a meeting route can reach another
 *    workspace's bucket at all: tenancy in this module is the *store* it is
 *    handed, never a key it builds, so there is no path prefix to get wrong.
 *    The gateway's own two-party check refuses and the isolation checks see it.
 * 2. **`notFound()` answers 403 instead of 404** — 3 checks failed. Worth
 *    recording precisely: the byte-identical-refusal check still *passed*,
 *    because both answers still come out of one code path. It is the status
 *    that carries the existence signal, and it is the status that caught it.
 * 3. **The meeting scope gate asks for `context:read` on every method** —
 *    4 checks failed: a read-only grant and a `member` role both wrote.
 * 4. **`finalizeSession` loses its "already complete" branch** — 5 checks
 *    failed, and not the ones expected. No second file appeared (the retry
 *    reuses the claimed path) — instead the second finalize re-rendered the
 *    note from the completion receipt, which by design holds no transcript and
 *    no notes, and *emptied a finished meeting*. Idempotency here is not a
 *    tidiness property; it is what stops a client's retry destroying the note.
 * 5. **`writeSession` drops `onlyIf` on a store that honours it** — 2 checks
 *    failed: the conflict a lost race must produce stopped being produced, and
 *    the second write stopped guarding the read it came from.
 * 6. **A meeting note is written at `team` whatever the connection's tier** —
 *    4 checks failed, all of them a private meeting reaching a team connection.
 * 7. **The team-connection destination check is removed from
 *    `publishMeetingNote`** — 5 checks failed: a team connection filed a
 *    meeting into a folder whose default is private, and the extra note it left
 *    behind failed three unrelated counts, which is what a stray write looks
 *    like from the rest of the suite.
 * 8. **`matchMeetingRoute` accepts any id shape** — 1 check failed.
 * 9. **`read_meeting` returns the whole file regardless of the argument** —
 *     3 checks failed: the transcript came back uninvited, with nothing said
 *     about it.
 * 10. **The client-event allow-list is removed, so a client may send
 *     `written`** — 2 checks failed. The first version of this check proved
 *     nothing and is worth recording: it forged the event against a *recording*
 *     session, which the transition table refuses on its own, so the guard
 *     could be deleted with the suite still green. Ending the session first
 *     makes `finalizing -> complete` a legal move and the allow-list the only
 *     thing standing between a client and a meeting marked finished that was
 *     never written.
 * 11. **`listSessions` ignores its limit** — 1 check failed.
 * 12. **`normalizeTranscription` coerces an unknown engine to `null` instead of
 *     refusing** — 2 checks failed: the refusal, and the session it then opened
 *     for an engine nobody has heard of. The note that meeting would become
 *     says `transcription: none` about audio that may well have left the
 *     device, which is the one direction this field is not allowed to be wrong
 *     in.
 * 13. **`withTranscription` lets a client rewrite the engine a session was
 *     opened with** — 2 checks failed. Deleting the call to it altogether fails
 *     1 instead: an unknown engine is still refused at `createSession`, so what
 *     the later-body path adds is exactly the refusal of a *rewrite*.
 * 14. **`completionReceipt` drops `transcription` with the transcript** —
 *     1 check failed. Cheap to get wrong, because the receipt is deliberately
 *     the place where almost everything is dropped; the note has the answer,
 *     but the receipt is what a client lists without opening one.
 * 21. **Transcription** — the route that carries audio, sabotaged six ways:
 *     the per-session budget removed (2), a chunk accepted for a session that
 *     does not exist (8), the body forwarded unvalidated (6), the session
 *     offset dropped from the times (1), segment ids renumbered around the
 *     blanks that were dropped (1), and an unconfigured gateway answering 503
 *     rather than 501 (2). Three more in `index.js`: an `http` transcription
 *     endpoint accepted (1), the workspace id forwarded instead of an HMAC of
 *     it (2), and a session id added to the body the service receives (1). The
 *     checks that matter most are the ones asserting a refusal bought **no**
 *     inference, because a guard that refuses after paying is not a guard.
 *
 * 15. **`finalizeSession` ignores `body.folder` and builds the inbox path from
 *     the module constant** — the defect §16 exists to close, put back — 9
 *     checks failed.
 * 16. **The folder is honoured on every finalize rather than only on the one
 *     that claims the path** (`if (!next.notePath)` relaxed to always
 *     recompute) — 3 checks failed, and they are the ones worth having: a
 *     retry after a failed note write, naming a second folder, wrote a
 *     **second note** and left the meeting in two places. The
 *     already-complete finalize did not fork, because that path returns before
 *     the claim — which is why the interesting test is the storage-failure
 *     retry and not the easy double-finalize.
 * 17. **A refused folder fails the finalize instead of falling back** —
 *     5 checks failed. `meeting_invalid` is the code a client does not retry,
 *     so this is somebody's forty minutes parked over one bad string.
 * 18. **The fallback happens and the ack never says so** — 2 checks failed.
 *     This is the sabotage that reads as harmless and is not: it is the
 *     original defect exactly, a destination control that appears to work and
 *     does nothing.
 * 19. **The ack reads the refused folder back to whoever sent it** — 1 check
 *     failed.
 * 20. **`folderRejected` means only "the string was malformed" again**, rather
 *     than "the folder you named is not where this note is" — 2 checks failed,
 *     both of them a client that asked for one folder, got another, and was
 *     answered 200 with nothing said. That is §18's defect surviving in the one
 *     shape §18 did not cover.
 * 21. **A claim is never released** (`releaseClaim` returns immediately) — 3
 *     checks failed: a team connection that named a folder its tier may not
 *     write stayed parked on that path, so even `finalize {}` was refused
 *     forever. That is the wedge `body.folder` introduced.
 * 22. **A claim is released on every failure, transient included** (both guards
 *     in `releaseClaim` removed) — 4 checks failed, and they are the crash-retry
 *     property: the retry after a failed note write stopped landing on the path
 *     the first finalize claimed and wrote a second note. Removing *only* the
 *     status check fails 1 — `a 503 refusal keeps the claim` — and removing
 *     *only* the `instanceof` check fails 0, because a thrown storage error
 *     carries no status either way. That last row is why the release table
 *     drives `handleMeetings` directly: the two failure shapes that decide this
 *     were both unreachable from the worker-level fixtures, and a first draft
 *     of the fix that released on a `MeetingRefusal(503)` went green.
 * 23. **`finalizeSession` stops checking `hasNothingCaptured`** (the fold into
 *     `empty` deleted, so an empty session falls straight through to the note
 *     write) — 11 checks failed. This is the owner's own bug report, closed at
 *     the one place that can close it for every client: a session with no
 *     transcript and no typed notes wrote a real, empty note to the bucket
 *     again, once per fixture — "0 min, typed session" with nothing in it.
 */

import { createMeetingHarness } from "./meetings/fixtures.mjs";
import { runMeetingOpeningAndFinalizeChecks } from "./meetings/openingAndFinalize.test.mjs";
import { runMeetingAuditAndAccessChecks } from "./meetings/auditAndAccess.test.mjs";
import { runMeetingStorageFailureChecks } from "./meetings/storageFailureAndConflict.test.mjs";
import { runMeetingRouteAndCapabilityChecks } from "./meetings/routeAndCapabilities.test.mjs";
import { runMeetingBackendAndBoundsChecks } from "./meetings/backendAndBounds.test.mjs";
import { runMeetingFolderChecks } from "./meetings/folder.test.mjs";
import { runMeetingTranscribingChecks } from "./meetings/transcribing.test.mjs";
import { runMeetingTitleCollisionChecks } from "./meetings/titleCollision.test.mjs";

/**
 * This file used to hold every one of these checks directly, in one
 * 3,906-line function that built a single shared harness (a real S3 backend,
 * a real control-plane stub, and one `fetch` layer able to fail a write or
 * answer the transcription service) and ran every section against it in
 * order — several sections read state (a note's path, its audit record, the
 * bucket's own accumulated key count) left behind by an earlier one, so they
 * cannot be reordered or given independent fixtures.
 *
 * It is now a thin facade over `test/meetings/*.test.mjs`, split by
 * responsibility, that builds that same harness once and threads it through
 * every section in its original order, so `import { runMeetingChecks } from
 * "./meetings.test.mjs"` keeps working unchanged and the checks run exactly
 * as they did before.
 */
export async function runMeetingChecks(check) {
  const harness = await createMeetingHarness();
  await runMeetingOpeningAndFinalizeChecks(check, harness);
  await runMeetingAuditAndAccessChecks(check, harness);
  await runMeetingStorageFailureChecks(check, harness);
  await runMeetingRouteAndCapabilityChecks(check, harness);
  await runMeetingBackendAndBoundsChecks(check, harness);
  await runMeetingFolderChecks(check, harness);
  await runMeetingTranscribingChecks(check, harness);
  await runMeetingTitleCollisionChecks(check, harness);
  harness.restoreAll();
}
