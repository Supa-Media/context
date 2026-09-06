import { api } from "@context/convex/_generated/api";
import { MEETINGS_FOLDER, meetingNotePath } from "@context/meetings/paths";
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
 * **The residual, named.** The key is composed from the title's slug, so a
 * rename between a lost answer and a retry would compose a second key. Nothing
 * in the app offers one: the title is editable on `LiveMeetingScreen`, which
 * renders only while the session `isLive`, and finalize happens after End. If a
 * rename-after-end is ever added, this needs the claim the gateway has.
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
          The context this meeting was addressed to is not one this account can
          reach — a membership that went away, or a list that has not landed
          yet. `unavailable` rather than `invalid`, so it is retried when the
          list arrives instead of being parked forever on a race.

          It does not quote the slug back. A refusal that echoes what it was
          sent is a reflection, which is `normalizeMeetingFolder`'s rule one
          field over.
        */
        throw new MeetingGatewayError(
          ERRORS.unavailable,
          "This device has not opened the context this meeting is going to, so it is being kept here.",
        );
      }

      const path = notePathFor(session, to);
      const text = renderMeetingNote(session, { now: now() });

      try {
        const written = await options.writeNote({ workspaceId, path, text });
        return finalAck(session, written.path);
      } catch (error) {
        const code = codeOf(error);
        if (code === "CONFLICT") {
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
        throw asGatewayError(error, code);
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
 * The answer to a finalize that landed.
 *
 * `state: "complete"` because the note is in the bucket, which is the only
 * thing that makes a meeting complete — and `conflictSafe: true` because
 * `writeFile` really is conditional: it reads, compares and passes `onlyIf`
 * where the bucket supports it, and refuses rather than clobbering where it
 * does not. That is a claim about this write, made where the write happened.
 */
function finalAck(session: MeetingSession, notePath: string): IngestAck {
  return {
    sessionId: session.id,
    state: "complete",
    segmentCount: session.transcript.length,
    conflictSafe: true,
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

/** The control plane's own code, when it sent one. */
function codeOf(error: unknown): string | null {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return null;
}

/**
 * A control-plane refusal, in the protocol's four codes.
 *
 * The mapping is an **allowlist of the transient ones**, which is
 * `classifySyncFailure`'s rule at the other end of the same wire: anything not
 * recognised parks the meeting with its sentence rather than retrying against
 * somebody's storage quota forever. `STORAGE_FAILED` is the one worth retrying
 * — a bucket that was briefly unreachable — and a transport failure with no
 * code at all is the other, because an action that never answered is exactly
 * the offline case the queue exists for.
 */
function asGatewayError(error: unknown, code: string | null): MeetingGatewayError {
  const message = error instanceof Error && error.message !== "" ? error.message : "";
  if (code === null) {
    return new MeetingGatewayError(
      ERRORS.unavailable,
      message === "" ? "Your context could not be reached." : message,
    );
  }
  if (code === "STORAGE_FAILED" || code === "PRIVACY_MANIFEST_BUSY") {
    return new MeetingGatewayError(ERRORS.unavailable, message || "Your context could not be reached.");
  }
  if (code === "STORAGE_NOT_CONNECTED" || code === "STORAGE_UNUSABLE") {
    return new MeetingGatewayError(
      ERRORS.unavailable,
      message || "No bucket is connected to that context yet, so the meeting is being kept here.",
    );
  }
  if (code === "FORBIDDEN" || code === "NOT_FOUND") {
    return new MeetingGatewayError(
      ERRORS.forbidden,
      message || "Your context would not accept this meeting from this device.",
    );
  }
  return new MeetingGatewayError(ERRORS.invalid, message || "Your context could not write that note.");
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
