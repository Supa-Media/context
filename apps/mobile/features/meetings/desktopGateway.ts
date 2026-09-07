import { getDesktopBridge, type DesktopBridge, type MeetingWriteAck } from "@context/desktop-bridge";
import { MeetingGatewayError, type MeetingAddress, type MeetingsGateway } from "./gateway";
import { ERRORS } from "./protocol";
import type {
  IngestAck,
  MeetingSession,
  MeetingSessionSummary,
  TranscriptSegment,
} from "./protocol";

/**
 * Inside the shell, the **shell** writes the meeting.
 *
 * ## What was wrong, and it was two credentials for one meeting
 *
 * `docs/decisions/desktop.md`, *What step 3 did not do*: step 3 replaced the
 * recorder and nothing else, so a meeting captured on a Mac took the shell's
 * machine grant for the audio it recorded and transcribed, and the **page's**
 * control-plane session for the note — `convexGateway.ts`, exactly as a browser
 * does. Two credentials, one meeting.
 *
 * What that cost is what `convexGateway.ts` already lists and costs identically
 * in a browser — no enhancement pass, no session record under `.meetings/`, no
 * `list_meetings` — plus one thing that was only true on the desktop: **the
 * shell's window-less outbox was not on the path**. A meeting was written by
 * the page that happened to be open rather than by the queue that survives it,
 * which is the entire reason the grant lives in the main process
 * (*Sign-in stays in the page, the grant stays in the main process*).
 *
 * So this is a `MeetingsGateway` that hands each of the protocol's four writes
 * to the shell over `window.desktop`. The page still composes — it holds the
 * record, the human's Markdown and the destination somebody picked — and the
 * shell queues, addresses and sends with the credential in `safeStorage`,
 * through the same outbox the tray-only recording uses. **A meeting recorded
 * with the window closed and one recorded from the console take the same path.**
 *
 * ## Which credential, stated once
 *
 * The machine's. Inside the shell there is no branch: if the bridge offers
 * `meetings`, every write goes through it, including a meeting the shell never
 * recorded — a typed one, or one somebody started before the machine was
 * connected. "Sometimes the page and sometimes the shell" would be two writers
 * for one meeting decided by a race, and the failure that produces is not
 * hypothetical: both would collapse onto the same queue entries and the last
 * one in would win.
 *
 * A machine with **no grant** is therefore not a fallback to the page's
 * session, it is a queue. `postEntry` answers *"this machine is not connected
 * to a context yet"* and keeps the write; the shell's Settings card is where
 * somebody connects it; and the next drain sends it. That is the same answer
 * `createHttpGateway` has always given, and `classifySyncFailure` already treats
 * it as transient, so the meeting is kept on the device with a sentence beside
 * it rather than lost.
 *
 * ## Why the finalize is not acknowledged when it is only queued
 *
 * The first three writes are a completed handover: the shell's queue is durable,
 * it drains with no page open, and it sends them in the contract's order. The
 * **finalize** is different, because its answer is the one fact the page does
 * not already have — where the note landed — and until it has that, the note is
 * not in the bucket. `docs/decisions/app-and-console.md` is unambiguous: *the UI
 * must never claim a write it has not seen acknowledged.*
 *
 * So a queued finalize is thrown as `unavailable`, which is transient:
 * `sync.ts` keeps the record, `pendingSteps` will offer the finalize again, and
 * the next attempt either gets the path or is queued again. Re-finalizing is
 * idempotent by the gateway's own rule — *"finalizing twice answers with the
 * note that already exists"* — so the retry costs one request and cannot write
 * a second note.
 *
 * ## What is given up, and it is less than the page's writer gives up
 *
 * `list()` answers empty, exactly as `convexGateway.ts` does and for a
 * different reason: the gateway really does keep a listing, but reading it back
 * over the bridge would be a fifth verb for a call nothing in the app makes.
 * Everything `convexGateway.ts` lists as lost — the enhancement pass, the
 * session record under `.meetings/`, `list_meetings` — is *regained* on this
 * path, because this is the client the gateway was built for.
 */

/** Everything a refused meeting can put in front of a person, and the whole of it. */
export const DESKTOP_WRITE_SENTENCES = {
  /** The shell has it; the bucket does not yet. */
  queued:
    "This meeting is queued on this machine and will be filed as soon as your context can be reached.",
  /** A destination the gateway's own selector would not read as a context. */
  unroutable:
    "This meeting is addressed to a context this app cannot reach, so it is being kept here.",
  /** The shell answered something this build cannot read. */
  unreadable: "The Context app on this machine could not take that meeting.",
} as const;

/**
 * The four protocol codes, so a refusal from the shell is one of them.
 *
 * The shell's queue parks with the contract's own codes, but the value arrives
 * over an IPC boundary from a build that may be older than this bundle — so it
 * is read against the closed set rather than trusted. Anything else is
 * `invalid`, which is the code that does **not** retry: a refusal nobody
 * understands, retried forever against a customer's gateway, is worse than one
 * parked with a sentence beside it. That is `refusal`'s direction in
 * `gateway.ts`, seen from the other end.
 */
const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(ERRORS));

/**
 * A slug the gateway's workspace selector will read as one.
 *
 * The same pattern `createHttpGateway` mirrors, and the shell checks it again
 * before it builds a URL. Checked here as well so the refusal happens where
 * there is a person to tell: a value this pattern rejects would be *ignored* on
 * the far end and the meeting served by whatever context the credential
 * defaults to, which is a note in the wrong bucket wearing somebody else's
 * label.
 */
const ROUTABLE_SLUG = /^[a-z0-9-]{2,32}$/;

/** The shell's half of the surface this file needs. */
export type DesktopMeetings = NonNullable<DesktopBridge["meetings"]>;

export function createDesktopGateway(meetings: DesktopMeetings): MeetingsGateway {
  /** Send one write, and turn the shell's three answers into the app's. */
  async function write(
    to: MeetingAddress,
    sessionId: string,
    kind: "session" | "segments" | "notes" | "finalize",
    body: Record<string, unknown>,
  ): Promise<MeetingWriteAck> {
    if (to !== null && !ROUTABLE_SLUG.test(to.contextSlug)) {
      throw new MeetingGatewayError(ERRORS.invalid, DESKTOP_WRITE_SENTENCES.unroutable);
    }
    let ack: MeetingWriteAck;
    try {
      ack = await meetings.write({ sessionId, kind, context: to?.contextSlug ?? null, body });
    } catch (error) {
      /*
        A channel the shell would not answer. Transient rather than parked: a
        window mid-teardown, a shell being replaced by an update, a main process
        that has not finished starting. All of those are gone on the next drain,
        and parking a meeting over one of them is what `classifySyncFailure`'s
        allowlist exists to avoid.
      */
      throw new MeetingGatewayError(ERRORS.unavailable, messageOf(error));
    }
    if (ack.rejected !== null) {
      const code = KNOWN_CODES.has(ack.rejected.code) ? ack.rejected.code : ERRORS.invalid;
      throw new MeetingGatewayError(code, ack.rejected.message || DESKTOP_WRITE_SENTENCES.unreadable);
    }
    return ack;
  }

  /** The device is not the store on this path, so an ack describes the handover. */
  const handover = (sessionId: string, state: MeetingSession["state"], segmentCount: number): IngestAck => ({
    sessionId,
    state,
    segmentCount,
    /*
      **False, and it is a claim rather than a default.** `IngestAck.conflictSafe`
      says whether *this* write was conditional, and a write that is sitting in
      a queue has not been made yet. The gateway's own ack for the eventual
      request is what knows; this one must not borrow it.
    */
    conflictSafe: false,
    notePath: null,
  });

  return {
    async putSession(to, session) {
      await write(to, session.id, "session", session as unknown as Record<string, unknown>);
      return handover(session.id, session.state, session.transcript.length);
    },

    async putSegments(to, sessionId, segments: readonly TranscriptSegment[]) {
      await write(to, sessionId, "segments", { segments: [...segments] });
      return handover(sessionId, "recording", segments.length);
    },

    async putNotes(to, sessionId, markdown) {
      await write(to, sessionId, "notes", { markdown });
      return handover(sessionId, "recording", 0);
    },

    async finalize(to, session) {
      const ack = await write(to, session.id, "finalize", finalizeBody(to));
      if (ack.notePath === null) {
        /*
          Queued, which is not the same as written. See the header: the note is
          not in the bucket, the page may not say it is, and `unavailable` is
          the code that has the record ask again rather than parking it. The
          shell's queue is still holding it either way — this is about what the
          *page* is allowed to draw.
        */
        throw new MeetingGatewayError(ERRORS.unavailable, DESKTOP_WRITE_SENTENCES.queued);
      }
      return {
        sessionId: session.id,
        state: "complete",
        segmentCount: session.transcript.length,
        conflictSafe: false,
        notePath: ack.notePath,
      };
    },

    /*
      Nothing in the app calls this, and reading the gateway's real listing back
      over the bridge would be a fifth verb for a question `/meetings` answers
      from the device. Empty rather than a throw, for `convexGateway.ts`'s
      reason: an empty list is a truth about what this writer knows, and a throw
      would be a failure somebody has to handle.
    */
    list: async (): Promise<MeetingSessionSummary[]> => [],
  };
}

/**
 * What a finalize says, which is nothing at all when nobody chose a folder.
 *
 * `createHttpGateway`'s body, unchanged, because this is the same request made
 * with the same credential — the shell is the transport rather than a second
 * protocol. `{}` lets the gateway's own default stand, which is what the
 * meetings list's one-tap record wants.
 */
function finalizeBody(to: MeetingAddress): Record<string, string> {
  return to === null ? {} : { folder: to.folder };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return DESKTOP_WRITE_SENTENCES.unreadable;
}

/**
 * The writer this app should use, given whether it is inside a shell.
 *
 * The one line in the feature that knows there are now three
 * (`useMeetingsSetup` calls it, and nothing else does): a browser and a phone
 * keep the writer they had, and a page inside a shell that offers `meetings`
 * hands the meeting to the machine.
 *
 * **Asked for the member rather than the version.** `MIN_BRIDGE_VERSION` is
 * still 1, so a shell somebody installed before this shipped is accepted and
 * simply has no `meetings` — and `getDesktopBridge()` answers `null` in a
 * browser, on a phone, in a subframe and on a shell this bundle does not
 * understand. All four are the same answer here: use the fallback, which is a
 * real product rather than a degraded one.
 */
export function meetingsWriterFor(
  fallback: MeetingsGateway,
  bridge: DesktopBridge | null = getDesktopBridge(),
): MeetingsGateway {
  const meetings = bridge?.meetings;
  if (meetings === undefined || typeof meetings.write !== "function") return fallback;
  return createDesktopGateway(meetings);
}
