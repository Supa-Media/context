import { api } from "@context/convex/_generated/api";
import { MEETINGS_FOLDER, meetingNotePath } from "@context/meetings/paths";
import { toFileError } from "../console/files/browser";
import { MeetingGatewayError, type MeetingAddress, type MeetingsGateway } from "./gateway";
import { renderMeetingNote } from "./note";
import { ERRORS } from "./protocol";
import type { IngestAck, MeetingSession, MeetingSessionSummary } from "./protocol";

/**
 * The writer this app uses: a meeting becomes a note the same way a note does.
 *
 * ## What was wrong, in the owner's words
 *
 * *"Doing a meeting should be the exact same thing as creating a new note,
 * except there's dictation involved."*
 *
 * It was not. Meeting capture finalized through the **MCP gateway**, which
 * authenticates MCP clients by per-client OAuth grant (non-negotiable #4), and
 * this app holds no such grant — it signs in to the *control plane* with
 * `@convex-dev/auth`. So `authorization()` answered `null`, `createHttpGateway`
 * correctly refused to send rather than sending a request that would be
 * refused, and **every meeting recorded, transcribed, and stopped.** The
 * screens said so honestly, which is why this looked like a deliberate seam
 * rather than a hole — but it meant a person could record a meeting, watch it
 * finish, and never get a note.
 *
 * Meanwhile the app has been writing notes into the customer's bucket the whole
 * time. `apps/convex/functions/files.ts`'s `writeNote` opens the storage
 * binding server-side through `fileOps.writeFile`; that is the path the editor
 * takes on every save. This gateway is a meeting taking it.
 *
 * ## It is a second writer, not a replacement
 *
 * `createHttpGateway` stays and is still the right answer for a client that
 * *does* hold a grant — the desktop app, which is where the gateway's own
 * enhancement, its session records under `.meetings/`, and `list_meetings` live.
 * Which one an app uses is a property of what credential it has, and this app
 * has a control-plane session. `useMeetingsSetup` chooses; nothing else in the
 * feature knows there are two.
 *
 * What is genuinely given up by taking this path, stated rather than glossed:
 *
 *  - **No enhancement.** The gateway's finalize runs the summary pass;
 *    `writeNote` writes what it is handed. So `## Summary` carries
 *    `note.js`'s own `_No summary yet._` placeholder until somebody wires an
 *    enhancement action, and `MeetingNoteScreen`'s Re-run still asks the
 *    controller rather than this. A meeting is not lost by that — the summary
 *    is the regenerable half, by `docs/decisions/meetings.md`'s own asymmetry,
 *    and the human's notes and the transcript are the half that is not.
 *  - **No session record in the bucket.** `putSession`, `putSegments` and
 *    `putNotes` are acknowledged locally and write nothing. That is not a
 *    silent drop: on this path the *device* is the session store until the note
 *    is written, which it already was, and `.meetings/sessions/<id>.json` is a
 *    gateway implementation detail rather than part of the on-bucket format
 *    (`isPlumbing` hides it from every tool at every tier). What it costs is
 *    that a meeting in progress is not visible from another device.
 *  - **No `list()`.** Same reason — there is nothing on the far end keeping one.
 *    `/meetings` is per-device by design and reads the controller, so nothing
 *    in the app calls it.
 *
 * ## Idempotency, which is the property a second writer is most likely to lose
 *
 * The gateway got this by *claiming* a path into the session record before
 * writing. There is no session record here, so it is bought two other ways:
 *
 *  - **The path carries the meeting's id.** `meetingNotePath` ends the filename
 *    with the tail of the session id, so the same meeting composes the same key
 *    every time and two meetings never collide.
 *  - **`writeNote` with no `expectedEtag` is create-only.** `fileOps.writeFile`
 *    refuses with `CONFLICT` when something is already at the path rather than
 *    overwriting it. So a retry after a write whose *answer* was lost is
 *    refused, and this reads that refusal as what it is — the note is already
 *    there — and answers with the path. It never clobbers, and it never writes
 *    a second note.
 *
 * **How far that goes, and it is less far than it was written.** The gateway's
 * claim record lets it tell two collisions apart — its own retry, or *"a note
 * somebody else's tooling put there"* (`ingest.js`) — and it suffixes rather
 * than answering, because a gateway that overwrites an unrelated note "has
 * destroyed something no version history of ours can give back". This path has
 * no claim record, so it cannot make that distinction: it reads a `CONFLICT` at
 * a key ending in this meeting's id as this meeting's note, and answers with
 * the path. It never overwrites, so the bad case is bounded at *answering with
 * a path that holds somebody else's note* rather than destroying one — but the
 * certainty is the key's shape, not a record, and the key's shape is what the
 * two residuals below are about.
 *
 * **The residuals, both of them.** The key is `(workspaceId, path)` and each
 * half can move between a write whose answer was lost and its retry:
 *
 *  - **The path** carries the title's slug, so a rename in that window composes
 *    a second key. Nothing in the app offers one — and the reason first written
 *    here was wrong, which is worth more than the conclusion: it said the title
 *    is editable on `LiveMeetingScreen`, and that screen renders it as static
 *    text (`:130-131`). `controller.setTitle` exists and has no callers at all.
 *    So the guarantee is stronger than claimed and rests on a surface that does
 *    not exist, which is exactly the shape a future reader would reason from
 *    and get wrong.
 *  - **The workspace.** `resolveWorkspaceId` reads a ref that is re-assigned on
 *    every render, so a retry after the workspace list changed underneath —
 *    a membership landing, a brain claimed between a lost answer and the next
 *    drain — resolves somewhere else. The retry then creates in a *different*
 *    bucket, where there is no conflict to catch it: two notes, one meeting.
 *    Bounded by `meetingWorkspaceId` being `ownPersonalContext`, which changes
 *    at most once per account, and by a meeting addressed to a named context
 *    resolving by slug — but it is a residual and it was not named.
 *
 * Either would need the claim the gateway has.
 *
 * ## The tier rule is not bypassed — it is the same machinery
 *
 * `writeNote` authorizes with `authorizeFileAccess` (`minimum: "editor"`) and
 * `writeFile` then refuses any path the caller's own scope cannot see, through
 * `canSee` over the context's `privacy.md`. A meeting note is a note and the
 * folder's rule decides it, with no meetings visibility model and no bypass,
 * which is exactly what `docs/decisions/meetings.md` requires — and this path
 * holds it *more* directly than the gateway did, because it is the same
 * function every note save goes through rather than a second implementation of
 * the same idea.
 */

/** What the app hands this writer to reach the control plane. */
export interface ConvexGatewayOptions {
  /**
   * Run `files.writeNote`. Injected rather than a `ConvexReactClient`, so the
   * whole writer is testable with no client, no socket and no auth — the shape
   * `browser.ts` uses for file operations.
   */
  writeNote: (args: {
    workspaceId: string;
    path: string;
    text: string;
  }) => Promise<{ path: string }>;
  /**
   * The workspace a destination names, or `null` when this app cannot reach it.
   *
   * Read at call time rather than captured, because the workspace list arrives
   * after the controller is configured and a meeting may be finalized at any
   * point after that. `null` in means "wherever this device is pointed", which
   * is the destination-less one-tap record on `/meetings`.
   */
  resolveWorkspaceId: (contextSlug: string | null) => string | null;
  /** What the note says produced it. `renderMeetingNote`'s `now`; injected for tests. */
  now?: () => string;
}

/** Acknowledged and written nowhere. See the header: the device is the store. */
function localAck(session: Pick<MeetingSession, "id" | "state" | "transcript">): IngestAck {
  return {
    sessionId: session.id,
    /*
      The device's own answer, because the device is what holds this session on
      this path. Echoing back what the caller already knows is the honest shape:
      an ack is "here is what I hold now", and what is held is exactly what was
      sent.
    */
    state: session.state,
    segmentCount: session.transcript.length,
    /*
      **False, and it is a claim rather than a default.** `IngestAck.conflictSafe`
      says whether *this* write was conditional. Nothing was written by these
      three calls, and the finalize's own answer says what its write was. A
      `true` here would be this client telling itself a guarantee it did not
      buy — the exact defect `an ack says whether the write was conflict-safe`
      was written about, pointed the other way.
    */
    conflictSafe: false,
    notePath: null,
  };
}

export function createConvexGateway(options: ConvexGatewayOptions): MeetingsGateway {
  const now = options.now ?? (() => new Date().toISOString());

  return {
    putSession: async (_to, session) => localAck(session),
    /*
      The segments and the notes are already on the record this was called from
      — `pendingSteps` derives both from it — so the ack describes the session
      the caller holds. Counting the batch instead would report a number about
      one request rather than about the meeting.
    */
    putSegments: async (_to, sessionId, segments) => ({
      sessionId,
      state: "recording",
      segmentCount: segments.length,
      conflictSafe: false,
      notePath: null,
    }),
    putNotes: async (_to, sessionId) => ({
      sessionId,
      state: "recording",
      segmentCount: 0,
      conflictSafe: false,
      notePath: null,
    }),

    async finalize(to: MeetingAddress, session: MeetingSession): Promise<IngestAck> {
      const workspaceId = options.resolveWorkspaceId(to?.contextSlug ?? null);
      if (workspaceId === null) {
        /*
          `unavailable` rather than `invalid` on both branches, so it is retried
          when the answer changes instead of being parked forever on a race —
          and on both branches the answer really can change: a workspace list
          that has not landed yet, a membership restored, an @name claimed.

          **Two sentences, because they are two situations.** A meeting
          addressed to a context this account cannot reach is a membership
          question. A meeting addressed to nothing that resolves to nothing is
          somebody who has not claimed an @name — there is no context in that
          story, and naming one tells them about a thing they never chose.

          Neither quotes the slug back. A refusal that echoes what it was sent
          is a reflection, which is `normalizeMeetingFolder`'s rule one field
          over.
        */
        throw new MeetingGatewayError(
          ERRORS.unavailable,
          to === null
            ? MEETING_WRITE_SENTENCES.noBrainYet
            : MEETING_WRITE_SENTENCES.unknownContext,
        );
      }

      /*
        Composing the path and rendering the note are **inside** the try, and
        that is not tidiness.

        `meetingNotePath` validates `startedAt` before it looks at the folder,
        so its own `TypeError` — "session.startedAt is not an ISO 8601
        timestamp" — is re-thrown by `notePathFor`'s fallback rather than caught
        by it. Outside the try it escaped `finalize` entirely, `sync.ts`
        classified it `UNKNOWN`, the meeting parked, and that developer sentence
        became the person's whole explanation. This branch added a list section
        for exactly that record; the list could show it and the writer could not
        file it.
      */
      let path: string;
      let text: string;
      try {
        path = notePathFor(session, to);
        /*
          Rendered from the meeting as it will be once this write lands, not as
          it is mid-request. `renderMeetingNote` writes `status:
          <session.state>` and `pendingSteps` guarantees the state here is
          `finalizing`, so handing it the record's own session put
          `status: finalizing` into the frontmatter of every finished meeting in
          the customer's bucket, permanently.

          The gateway's finalize does the same thing and says why: "marked
          complete *before* it is rendered, so the note's own frontmatter says
          what the meeting is rather than what it was in the middle of". The
          path is the one this call is about to claim, which is what makes the
          fold legal here rather than optimistic — a write that fails throws,
          and nothing on the device was changed by composing a string.
        */
        text = renderMeetingNote(written(session, path), { now: now() });
      } catch {
        /*
          `invalid`, so it parks: a `startedAt` this app cannot read will read
          the same way on every retry, and retrying it forever against
          somebody's quota is what the allowlist below exists to stop. The
          sentence points at Copy note, which is the way a meeting gets off the
          device when nothing can file it. Nothing this app writes produces such
          a record — a hand-edited one, or one from another build, does.
        */
        throw new MeetingGatewayError(ERRORS.invalid, MEETING_WRITE_SENTENCES.noReadableDate);
      }

      try {
        const landed = await options.writeNote({ workspaceId, path, text });
        return finalAck(session, landed.path);
      } catch (error) {
        if (toFileError(error).code === "CONFLICT") {
          /*
            Something is already at this key, and the key ends with this
            meeting's own id — so it is this meeting's note, from a write whose
            answer never came back. Answering with the path is the gateway's own
            rule ("finalizing twice answers with the note that already exists"),
            and *not overwriting* is the other half: a note somebody has since
            edited in Obsidian is not ours to replace with our copy of it.
          */
          return finalAck(session, path);
        }
        throw asGatewayError(error);
      }
    },

    /*
      Nothing keeps a server-side list on this path (see the header), and
      nothing in the app calls this. It answers empty rather than throwing,
      because an empty list is the truth about what this writer knows and a
      throw would be a failure somebody has to handle.
    */
    list: async (): Promise<MeetingSessionSummary[]> => [],
  };
}

/**
 * The meeting as the note records it: finished, at the key it was filed under.
 *
 * The `written` fold, applied where the gateway applies it. Spelled out rather
 * than routed through `applyMeetingEvent`, which takes a projection this writer
 * does not hold — and `state` is the only one of these three fields the note
 * actually reads, so what matters is that it says `complete`.
 */
function written(session: MeetingSession, notePath: string): MeetingSession {
  return { ...session, state: "complete", notePath, recordingSince: null };
}

/**
 * The answer to a finalize that landed.
 *
 * `state: "complete"` because the note is in the bucket, which is the only
 * thing that makes a meeting complete.
 *
 * **`conflictSafe: false`, and it said `true`.** The reasoning behind the
 * `true` was about `writeFile` in general — it reads, compares and passes
 * `onlyIf` where the bucket supports it — and it is not true of *this* write.
 * `writeFile` computes `conditional = capabilities?.conditionalWrite === true
 * && existing !== null`, and a create has no `existing`: that is what makes it
 * a create. So every meeting write in this app is a `read-compare`, on every
 * backend, including the ones that honour `If-Match`.
 *
 * The field exists so a client can tell a guarantee it bought from one it did
 * not (`an ack says whether the write was conflict-safe`), and `localAck` above
 * answers `false` for exactly that reason. Claiming it here was that defect
 * pointed the other way, one function down.
 *
 * The write is still safe against clobbering — create-only means `CONFLICT`
 * rather than an overwrite — which is a different property, bought a different
 * way, and stated where it is bought rather than borrowed as this flag.
 */
function finalAck(session: MeetingSession, notePath: string): IngestAck {
  return {
    sessionId: session.id,
    state: "complete",
    segmentCount: session.transcript.length,
    conflictSafe: false,
    notePath,
  };
}

/**
 * Where the note goes, with the same fallback the gateway has.
 *
 * `meetingNotePath` throws on a folder it will not file into, and losing a
 * meeting over one bad string is what `a refused folder does not lose the
 * meeting` refuses. So a refusal falls back to `MEETINGS_FOLDER` — and the ack
 * would say `folderRejected`, except that this path cannot get there: the sheet
 * only ever offers folders `normalizeMeetingFolder` accepts, so the fallback is
 * a backstop rather than a route. It is here so that a destination restored from
 * an older build cannot throw a meeting away.
 */
function notePathFor(session: MeetingSession, to: MeetingAddress): string {
  const folder = to?.folder ?? MEETINGS_FOLDER;
  try {
    return meetingNotePath(session, { folder });
  } catch {
    return meetingNotePath(session, { folder: MEETINGS_FOLDER });
  }
}

/**
 * Every sentence a refused meeting can put in front of a person.
 *
 * Exported so the suite can assert that the set is closed — see
 * `and neither does the server's own prose, vetted or not`. One readable place
 * for "what can this screen say" is worth more than reusing the server's
 * wording, and the server's wording is written for a file editor: `canSee`
 * refusing a write answers *"That file does not exist."*, which is exactly
 * right in a console and a lie on a meeting card.
 */
export const MEETING_WRITE_SENTENCES = {
  unreachable: "Your context could not be reached, so the meeting is being kept here.",
  /** The destination named a context this account cannot reach. */
  unknownContext:
    "This device has not opened the context this meeting is going to, so it is being kept here.",
  /** There was no destination, and no brain to fall back to. */
  noBrainYet:
    "You have not claimed your @name yet, so there is nowhere for this meeting to go. It is being kept here — claim one and it will be filed.",
  noBucket: "No bucket is connected to that context yet, so the meeting is being kept here.",
  signedOut: "This device is signing back in to your context, so the meeting is being kept here.",
  unreadableFolder:
    "Your context will not take a meeting in that folder at this account's access level. Choose another folder and try again.",
  readOnly: "You can read that context but not write to it, so a meeting cannot land there.",
  notAMember: "You are not a member of the context this meeting is addressed to any more.",
  unwritable: "Your context could not write that note.",
  noReadableDate:
    "This meeting's start time is not a date this app can read, so it has no note to be filed under. Copy the note out from this screen.",
} as const;

/**
 * A control-plane refusal, in the protocol's four codes.
 *
 * ## The unwrapping is `browser.ts`'s funnel, not a second one
 *
 * `toFileError` is the single place in this app that decides what a thrown
 * thing may say, and the two checks it makes are the ones that matter here:
 * `instanceof ConvexError` **and** a shaped payload. Reading `.data` off
 * anything — which this file did — surfaces the code of any object that happens
 * to have one, and then classifies a meeting on it. And `error.message` is not
 * the server's message at all: on the real wire Convex builds it as
 * `` `[CONVEX A(functions/files:writeNote)] ${message}\n  Called by client` ``,
 * so forwarding it puts a stack-trace-shaped string carrying whatever the
 * storage adapter said — a bucket name, a host, a signed URL, a provider's raw
 * XML — on a meeting card.
 *
 * A throw that is not a `ConvexError` unwraps to `UNKNOWN`, which is what
 * `features/offline/sync.ts` already treats a dropped socket as. That is the
 * honest reading: nobody on the far end evaluated this request.
 *
 * ## The codes are the ones `files.writeNote` actually sends
 *
 * This mapping used to name `FORBIDDEN` and `NOT_FOUND`, and that action
 * produces neither, so the branch was dead and **every real refusal parked the
 * meeting permanently.** What it does send: `NOT_AUTHENTICATED` from
 * `callerId`; `WORKSPACE_NOT_FOUND` / `INSUFFICIENT_ROLE` from
 * `authorizeFileAccess`; `STORAGE_NOT_CONNECTED` / `STORAGE_UNUSABLE` /
 * `STORAGE_FAILED` from `runFileOperation`; and `fileOps`' own codes, of which
 * a write reaches `FILE_NOT_FOUND` (the `canSee` refusal), `PATH_INVALID`,
 * `CONTENT_TOO_LARGE`, `CONFLICT` (handled above, as this meeting's own note)
 * and the `PRIVACY_MANIFEST_*` family.
 *
 * ## The split is transient versus parked, because parked waits for a person
 *
 * Transient is still an allowlist, for `classifySyncFailure`'s reason: a code
 * this build has not heard of, retried on every reconnection, spends the
 * customer's quota on a write that was never going to succeed. What is on it:
 *
 *  - **`NOT_AUTHENTICATED`** — a token refresh is a second in which
 *    `getAuthUserId` answers `null`. Parking a meeting on that is losing it to
 *    a coincidence.
 *  - **`STORAGE_FAILED`, `PRIVACY_MANIFEST_BUSY`** — a bucket that was briefly
 *    unreachable, and somebody else mid-CAS on `privacy.md`.
 *  - **`STORAGE_NOT_CONNECTED`, `STORAGE_UNUSABLE`** — retried, then parked by
 *    `MAX_SYNC_ATTEMPTS` with a sentence, which is the right shape for
 *    something a person fixes elsewhere in the app and comes back from.
 *  - **`UNKNOWN`** — see above.
 *
 * `FILE_NOT_FOUND`, `INSUFFICIENT_ROLE` and `WORKSPACE_NOT_FOUND` park as
 * `forbidden` rather than `invalid`. Both park; the difference is the sentence,
 * and these three are the ones where a person can actually do something —
 * change the folder, ask for a role, pick another context — which is what a
 * parked meeting is waiting for them to do.
 */
function asGatewayError(error: unknown): MeetingGatewayError {
  const { code } = toFileError(error);

  if (code === "UNKNOWN") {
    return new MeetingGatewayError(ERRORS.unavailable, MEETING_WRITE_SENTENCES.unreachable);
  }
  if (code === "NOT_AUTHENTICATED") {
    return new MeetingGatewayError(ERRORS.unavailable, MEETING_WRITE_SENTENCES.signedOut);
  }
  if (code === "STORAGE_FAILED" || code === "PRIVACY_MANIFEST_BUSY") {
    return new MeetingGatewayError(ERRORS.unavailable, MEETING_WRITE_SENTENCES.unreachable);
  }
  if (code === "STORAGE_NOT_CONNECTED" || code === "STORAGE_UNUSABLE") {
    return new MeetingGatewayError(ERRORS.unavailable, MEETING_WRITE_SENTENCES.noBucket);
  }
  if (code === "FILE_NOT_FOUND") {
    return new MeetingGatewayError(ERRORS.forbidden, MEETING_WRITE_SENTENCES.unreadableFolder);
  }
  if (code === "INSUFFICIENT_ROLE") {
    return new MeetingGatewayError(ERRORS.forbidden, MEETING_WRITE_SENTENCES.readOnly);
  }
  if (code === "WORKSPACE_NOT_FOUND") {
    return new MeetingGatewayError(ERRORS.forbidden, MEETING_WRITE_SENTENCES.notAMember);
  }
  return new MeetingGatewayError(ERRORS.invalid, MEETING_WRITE_SENTENCES.unwritable);
}

/**
 * The `writeNote` call, bound to a Convex client.
 *
 * Separated from the writer above so the writer takes a function and the app
 * takes a client: `createConvexGateway` is then testable with no Convex at all,
 * and this is the only line that knows the action's name.
 */
export function writeNoteThrough(client: {
  action: (reference: unknown, args: unknown) => Promise<unknown>;
}): ConvexGatewayOptions["writeNote"] {
  return async (args) => {
    const result = (await client.action(api.functions.files.writeNote, {
      workspaceId: args.workspaceId,
      path: args.path,
      text: args.text,
    })) as { path: string };
    return result;
  };
}
