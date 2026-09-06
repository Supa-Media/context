import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ConvexError } from "convex/values";

import {
  MEETING_WRITE_SENTENCES,
  createConvexGateway,
} from "../features/meetings/convexGateway";
import { drainMeetings } from "../features/meetings/sync";
import { emptyAck, type MeetingRecord } from "../features/meetings/record";
import { seedSession } from "../features/meetings/session";
import { ERRORS, PROTOCOL_VERSION, type MeetingSession } from "../features/meetings/protocol";
import { parseMeetingNote, renderMeetingNote } from "@context/meetings/note";

/**
 * A meeting becomes a note the same way a note does.
 *
 * ## The defect
 *
 * *"Doing a meeting should be the exact same thing as creating a new note,
 * except there's dictation involved."* It was not. Meeting capture finalized
 * through the MCP gateway, which authenticates MCP clients by OAuth grant; this
 * app holds no grant, so `authorization()` answered `null`, the gateway refused
 * to send rather than sending a request that would be refused, and **every
 * meeting recorded, transcribed, and stopped on the device.** Every screen said
 * so honestly, which is why it read as a deliberate seam rather than a hole.
 *
 * Meanwhile `files.writeNote` has been putting notes in the same customer's
 * bucket on every save the editor makes. `createConvexGateway` is a meeting
 * taking that path.
 *
 * ## What is checked here and what is checked next door
 *
 * This file drives the writer with `writeNote` as a function, so there is no
 * Convex, no socket and no auth in it — the shape `browser.ts` uses. What that
 * cannot see is the server's own rules, and they are not restated here: the
 * tier gate is `fileOps.writeFile`'s `canSee` call, which every note save
 * already goes through, and `apps/convex/__tests__` owns it. The last test
 * below pins the *premise* — that the meeting path really is that function —
 * the way `storageCodePosition.test.ts` pins a fact about the server from
 * another app.
 *
 * ## Sabotage record
 *
 * Each applied, whole suite run, reverted:
 *
 *  1. `finalize` composed the path from the title alone, with no id suffix.
 *     → 3 failed, led by `the same meeting composes the same key every time`.
 *  2. `finalize` treated a `CONFLICT` as a failure instead of as the note it
 *     already wrote.
 *     → `a retry after a lost answer finds its note rather than writing a
 *     second` failed, and the record was left `finalizing` forever.
 *  3. `writeNote` called with an `expectedEtag`, making the write an overwrite.
 *     → `the write is create-only, so it can never clobber a note` failed.
 *  4. `finalize` ignored the destination and always used the default folder.
 *     → `the folder the sheet chose is where the note goes` failed.
 *  5. `resolveWorkspaceId` answering `null` classified as `invalid` rather than
 *     `unavailable`.
 *     → `a context this device cannot reach yet is retried, not parked` failed.
 */

const STARTED = "2026-09-06T18:00:00.000Z";

function session(over: Partial<MeetingSession> = {}): MeetingSession {
  return {
    ...seedSession({
      id: "mtg_abcdefghjkmnpqrstv",
      version: PROTOCOL_VERSION,
      title: "Design review",
      startedAt: STARTED,
      source: { kind: "in-person" },
      device: { platform: "ios", name: "Seyi's phone" },
      transcription: "on-device",
    }),
    state: "finalizing",
    notes: "curiosity is the prerequisite",
    ...over,
  };
}

function record(over: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    version: 1,
    workspaceId: "ws-1",
    session: session(),
    destination: null,
    acked: emptyAck(),
    runningSince: null,
    updatedAt: 0,
    attempts: 0,
    ...over,
  };
}

/**
 * A `writeNote` that records what it was asked to write, and can refuse.
 *
 * **The refusal is a real `ConvexError` carrying the message Convex really
 * builds**, and that is the whole of why this double exists in this shape. The
 * first version threw `new Error("refused")` with a `.data` hand-attached, so
 * `error.message` was already a clean word and the writer forwarding it looked
 * correct. On the wire it is
 * `` `[CONVEX A(functions/files:writeNote)] ${message}\n  Called by client` `` —
 * a stack-trace-shaped string that was being rendered on a meeting card.
 *
 * `throwAs: "plain"` is the other half: a bare `Error` with a `.data` bolted on
 * is not a server answer, and reading a code off it is the widening
 * `browser.ts` names and refuses.
 */
function spyWriteNote(
  options: { refuseWith?: string; serverSays?: string; throwAs?: "convex" | "plain" } = {},
) {
  const calls: Array<{ workspaceId: string; path: string; text: string }> = [];
  const write = async (args: { workspaceId: string; path: string; text: string }) => {
    calls.push(args);
    if (options.refuseWith !== undefined) {
      const data = { code: options.refuseWith, message: options.serverSays ?? "server prose" };
      if (options.throwAs === "plain") {
        const error = new Error(WIRE_MESSAGE) as Error & { data: typeof data };
        error.data = data;
        throw error;
      }
      const error = new ConvexError(data);
      /*
        Convex assembles this on the client before the caller ever sees it — the
        deployment's own function reference and a caller frame, around whatever
        the server said. It is not something a person may be shown.
      */
      error.message = WIRE_MESSAGE;
      throw error;
    }
    return { path: args.path };
  };
  return { calls, write };
}

/** What `ConvexError`'s `.message` really looks like once it has crossed the wire. */
const WIRE_MESSAGE =
  "[CONVEX A(functions/files:writeNote)] Uncaught Error: s3.eu-central-003.example.net refused\n  Called by client";

function writer(options: Parameters<typeof spyWriteNote>[0] = {}, resolves = "ws-1") {
  const spy = spyWriteNote(options);
  const gateway = createConvexGateway({
    writeNote: spy.write,
    resolveWorkspaceId: () => (resolves === "" ? null : resolves),
    now: () => "2026-09-06T18:41:00.000Z",
  });
  return { gateway, calls: spy.calls };
}

/* -------------------------------------------------------------------------- */

describe("a meeting reaches the bucket through the path a note takes", () => {
  test("finalizing writes one note, through `files.writeNote`", async () => {
    const { gateway, calls } = writer();
    const ack = await gateway.finalize(null, session());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.workspaceId).toBe("ws-1");
    expect(ack.notePath).toBe(calls[0]!.path);
    // The state the ack claims is the one the bucket now supports. A note is in
    // it, so the meeting is complete — that is what `complete` means here.
    expect(ack.state).toBe("complete");
  });

  test("the note says the meeting is complete, not that it is mid-finalize", async () => {
    /*
      `renderMeetingNote` writes `status: <session.state>`, and this path handed
      it `record.session` — which `pendingSteps` guarantees is `finalizing`,
      because that is the only state a finalize is derived from. So **every
      meeting note in the customer's bucket said `status: finalizing`, for
      ever**, over a meeting that was finished.

      The MCP gateway does not: it folds `written` *before* it renders, and says
      why — "marked complete before it is rendered, so the note's own
      frontmatter says what the meeting is rather than what it was in the middle
      of". Same fold here, over the path this write is about to claim.
    */
    const { gateway, calls } = writer();
    await gateway.finalize(null, session());
    expect(parseMeetingNote(calls[0]!.text).frontmatter.status).toBe("complete");
  });

  test("an ack never claims a conditional write, because a create is not one", async () => {
    /*
      `conflictSafe: true` was a claim about a write that cannot be conditional.
      `writeFile` computes `conditional = capabilities?.conditionalWrite &&
      existing !== null`, and a create has no `existing` by definition — that is
      what makes it a create — so every meeting write in this app is a
      `read-compare`, on every backend, including the ones that support
      `If-Match`.

      The claim is not free: `an ack says whether the write was conflict-safe`
      exists so a client can tell a guarantee it bought from one it did not, and
      `localAck` a few lines up answers `false` for exactly that reason.
    */
    const { gateway } = writer();
    const ack = await gateway.finalize(null, session());
    expect(ack.conflictSafe).toBe(false);

    // Including the retry that finds its own note: nothing was written at all
    // on that path, so there is even less to claim.
    const retried = writer({ refuseWith: "CONFLICT" });
    expect((await retried.gateway.finalize(null, session())).conflictSafe).toBe(false);
  });

  test("what it writes is the note the gateway would have written", async () => {
    /*
      `renderMeetingNote` is the gateway's own renderer, imported rather than
      reimplemented (`features/meetings/note.ts`). What proves it is not a
      screen-shaped summary is that the gateway's own *parser* reads it back:
      frontmatter, title, the three headings, and the human's words verbatim.
    */
    const { gateway, calls } = writer();
    await gateway.finalize(null, session());

    const parsed = parseMeetingNote(calls[0]!.text);
    expect(parsed.title).toBe("Design review");
    expect(parsed.notes).toBe("curiosity is the prerequisite");
    expect(parsed.frontmatter["meeting-id"]).toBe("mtg_abcdefghjkmnpqrstv");
    // The seam this product discloses: a reader can tell whether the audio left
    // the machine, from the note, eight months later.
    expect(parsed.frontmatter.transcription).toBe("on-device");
    expect(parsed.frontmatter.device).toBe("Seyi's phone (ios)");
  });

  test("the folder the sheet chose is where the note goes", async () => {
    const { gateway, calls } = writer();
    await gateway.finalize(
      { kind: "currentPage", contextSlug: "acme", folder: "2-areas/team", label: "2-areas/team" },
      session(),
    );
    expect(calls[0]!.path).toBe(
      "2-areas/team/2026/09/2026-09-06-design-review-mnpqrstv.md",
    );
  });

  test("and the default is the default when nobody was asked", async () => {
    const { gateway, calls } = writer();
    await gateway.finalize(null, session());
    expect(calls[0]!.path.startsWith("0-inbox/meetings/2026/09/")).toBe(true);
  });

  test("a folder that would not file at all falls back rather than losing the meeting", async () => {
    /*
      `a refused folder does not lose the meeting`, one writer over. The sheet
      only offers folders `normalizeMeetingFolder` accepts, so this is a backstop
      for a destination restored from an older build — but "the meeting is lost
      because one string was bad" is the outcome that must not be reachable.
    */
    const { gateway, calls } = writer();
    const ack = await gateway.finalize(
      { kind: "currentPage", contextSlug: "acme", folder: "../escape", label: "../escape" },
      session(),
    );
    expect(ack.notePath).not.toBeNull();
    expect(calls[0]!.path.startsWith("0-inbox/meetings/")).toBe(true);
  });
});

describe("one meeting is one note, however many times it is sent", () => {
  test("the same meeting composes the same key every time", async () => {
    const first = writer();
    const second = writer();
    await first.gateway.finalize(null, session());
    await second.gateway.finalize(null, session());
    expect(first.calls[0]!.path).toBe(second.calls[0]!.path);
    // And the key carries the meeting's own id, which is what makes two
    // meetings on one day with one title two notes rather than a collision.
    expect(first.calls[0]!.path).toContain("mnpqrstv");
  });

  test("a retry after a lost answer finds its note rather than writing a second", async () => {
    /*
      The gateway bought this with a claimed path in the session record. There
      is none here, so it is bought by the key carrying the id and by
      `writeFile` being create-only: the second write is refused with `CONFLICT`,
      and a `CONFLICT` at a key that ends in this meeting's id *is* this
      meeting's note.
    */
    const { gateway, calls } = writer({ refuseWith: "CONFLICT" });
    const ack = await gateway.finalize(null, session());

    expect(calls).toHaveLength(1);
    expect(ack.notePath).toBe(calls[0]!.path);
    expect(ack.state).toBe("complete");
  });

  test("the write is create-only, so it can never clobber a note", async () => {
    /*
      No `expectedEtag` in the call at all. `fileOps.writeFile` reads that as
      "create": it refuses when something is already there rather than
      overwriting it. A note somebody has since edited in Obsidian is not ours
      to replace with our copy of it, and the version being replaced is not
      snapshotted anywhere.
    */
    const { gateway, calls } = writer();
    await gateway.finalize(null, session());
    expect(Object.keys(calls[0]!).sort()).toEqual(["path", "text", "workspaceId"]);
  });
});

describe("a refusal is classified so the queue does the right thing with it", () => {
  test("a context this device cannot reach yet is retried, not parked", async () => {
    /*
      The workspace list lands after the controller is configured, so a finalize
      can genuinely arrive before this app knows the id. That is a race, not a
      refusal — `unavailable` is retried when something says the connection is
      back, and `invalid` would park somebody's meeting on a timing accident.
    */
    const { gateway } = writer({}, "");
    const failure = await gateway
      .finalize({ kind: "personalInbox", contextSlug: "gone", folder: "0-inbox" }, session())
      .catch((error: unknown) => error);

    expect((failure as { code: string }).code).toBe(ERRORS.unavailable);
    // And it does not read the slug back. A refusal that echoes what it was
    // sent is a reflection.
    expect((failure as { message: string }).message).not.toContain("gone");
  });

  test("a bucket that is not connected keeps the meeting, and says which", async () => {
    const { gateway } = writer({ refuseWith: "STORAGE_NOT_CONNECTED" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ERRORS.unavailable);
  });

  test("a refusal nobody recognises parks rather than retrying forever", async () => {
    // `classifySyncFailure`'s allowlist, at the other end of the same wire: an
    // unknown refusal retried on every reconnection spends somebody's quota on
    // a write that was never going to succeed.
    const { gateway } = writer({ refuseWith: "SOMETHING_NEW" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ERRORS.invalid);
  });

  /*
    THE CODES `files.writeNote` ACTUALLY SENDS.

    The first version of this mapping handled `FORBIDDEN` and `NOT_FOUND`, and
    that action produces neither: `canSee` refusing is `FILE_NOT_FOUND`
    (`fileOps.ts`'s deliberate not-found for "not yours to see"), a role failure
    is `INSUFFICIENT_ROLE`, no membership is `WORKSPACE_NOT_FOUND` and no
    session is `NOT_AUTHENTICATED`. So the branch was dead and every real
    refusal fell through to `invalid`, which parks the meeting permanently —
    including an `editor` in a context whose meetings folder defaults to
    `private`, a configuration `apps/mcp/test/meetings.test.mjs` names by hand,
    and including a `NOT_AUTHENTICATED` raised while a token was being
    refreshed.

    The split that matters is transient versus parked, because a parked meeting
    waits for a person to press retry.
  */
  test.each([
    ["NOT_AUTHENTICATED", ERRORS.unavailable],
    ["STORAGE_FAILED", ERRORS.unavailable],
    ["STORAGE_NOT_CONNECTED", ERRORS.unavailable],
    ["STORAGE_UNUSABLE", ERRORS.unavailable],
    ["PRIVACY_MANIFEST_BUSY", ERRORS.unavailable],
    ["FILE_NOT_FOUND", ERRORS.forbidden],
    ["INSUFFICIENT_ROLE", ERRORS.forbidden],
    ["WORKSPACE_NOT_FOUND", ERRORS.forbidden],
    ["PATH_INVALID", ERRORS.invalid],
    ["CONTENT_TOO_LARGE", ERRORS.invalid],
  ])("`%s` is classified %s", async (code, expected) => {
    const { gateway } = writer({ refuseWith: code });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect(`${code}: ${(failure as { code: string }).code}`).toBe(`${code}: ${expected}`);
  });

  test("a signed-out moment is retried, not a meeting parked forever", async () => {
    /*
      Named on its own because it is the one that costs a meeting for nothing.
      A token refresh is a window of a second or two in which `getAuthUserId`
      answers `null`; parking on it means somebody's meeting sits waiting for a
      press that has nothing to do with anything they did.
    */
    const { gateway } = writer({ refuseWith: "NOT_AUTHENTICATED" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ERRORS.unavailable);
  });

  test("a private meetings folder is refused with a sentence about the folder", async () => {
    /*
      `writeFile` calls `canSee` before it writes, and a path the caller's own
      scope cannot see is `FILE_NOT_FOUND` — "That file does not exist.", which
      is the right answer to a console and a lie on a meeting card. An `editor`
      is `team` scope, so a meetings folder defaulted to `private` produces
      exactly this, forever.
    */
    const { gateway } = writer({ refuseWith: "FILE_NOT_FOUND" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect((failure as { message: string }).message).toBe(MEETING_WRITE_SENTENCES.unreadableFolder);
    expect((failure as { message: string }).message).not.toContain("does not exist");
  });
});

describe("a meeting whose start time will not parse", () => {
  /**
   * The list grew a section for this record on the same branch that made the
   * writer throw a `TypeError` out of `finalize` over it.
   *
   * `meetingNotePath` validates `startedAt` before it touches the folder, so
   * `notePathFor`'s fallback — which exists for a refused *folder* — re-throws.
   * That escaped the try entirely: `sync.ts` classified it `UNKNOWN`, the
   * meeting parked, and `TypeError | session.startedAt is not an ISO 8601
   * timestamp` was the sentence on the card.
   *
   * Nothing this app writes produces such a record. `isSession` asks
   * `startedAt` for a string rather than a date, so a hand-edited one or one
   * from another build loads perfectly and reaches here.
   */
  const unreadable = () => session({ startedAt: "sometime on Tuesday" });

  test("is refused with a sentence, not a TypeError", async () => {
    const { gateway, calls } = writer();
    const failure = await gateway.finalize(null, unreadable()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { name: string }).name).toBe("MeetingGatewayError");
    expect((failure as { message: string }).message).toBe(
      MEETING_WRITE_SENTENCES.noReadableDate,
    );
    expect((failure as { message: string }).message).not.toContain("ISO 8601");
    // And nothing was sent: there was no path to send it to.
    expect(calls).toHaveLength(0);
  });

  test("and parks rather than retrying a date that will never parse", async () => {
    const { gateway } = writer();
    const failure = await gateway.finalize(null, unreadable()).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ERRORS.invalid);
  });

  test("the drain gives it the sentence rather than a developer's", async () => {
    /*
      The end-to-end shape, because the sentence's whole job is to be the one on
      the card. `asGatewayError` in `sync.ts` forwards a `MeetingGatewayError`'s
      message and invents one for anything else — so this is the difference
      between the two paths, measured through the real drain.
    */
    const { gateway } = writer();
    const { records } = await drainMeetings(
      [record({ session: unreadable() })],
      { gateway, now: () => 1 },
    );
    expect(records[0]!.rejection?.message).toBe(MEETING_WRITE_SENTENCES.noReadableDate);
  });
});

describe("what a refusal is allowed to say on somebody's screen", () => {
  /**
   * `browser.ts`'s rule, one feature over: **never a raw runtime string as the
   * headline — that is how a stack trace ends up in a screenshot.** The far
   * side of this write is a customer-configured storage endpoint reached with a
   * decrypted credential, and an adapter throw can carry a bucket name, a host,
   * a signed URL or a provider's raw XML.
   */
  test("the wire's own stack-trace message never reaches the record", async () => {
    const { gateway } = writer({ refuseWith: "STORAGE_FAILED" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    const message = (failure as { message: string }).message;
    expect(message).not.toContain("CONVEX");
    expect(message).not.toContain("Called by client");
    expect(message).not.toContain("example.net");
  });

  test("and neither does the server's own prose, vetted or not", async () => {
    /*
      Stronger than "not the stack trace", and deliberately: every sentence a
      meeting card can show is one of this module's own, so the set of things a
      person can be shown here is enumerable and readable in one place. The
      server's messages are written for a file editor — "That file does not
      exist." over a meeting is worse than useless.
    */
    const owned = new Set<string>(Object.values(MEETING_WRITE_SENTENCES));
    const codes = [
      "STORAGE_FAILED",
      "NOT_AUTHENTICATED",
      "FILE_NOT_FOUND",
      "INSUFFICIENT_ROLE",
      "WORKSPACE_NOT_FOUND",
      "PATH_INVALID",
      "SOMETHING_NEW",
    ];
    for (const code of codes) {
      const { gateway } = writer({ refuseWith: code, serverSays: "s3://bucket-name/key refused" });
      const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
      const message = (failure as { message: string }).message;
      expect(`${code}: ${owned.has(message)}`).toBe(`${code}: true`);
    }
  });

  test("a code is read off a ConvexError and off nothing else", async () => {
    /*
      The widening `browser.ts` names and refuses: reading `.data` off anything
      would surface the code — and then the classification — of any object that
      happens to have one. A bare `Error` with a `.data` bolted on is not a
      server answer, and there is exactly one thing it can honestly be treated
      as: a throw nobody evaluated, which is the offline case.
    */
    const { gateway } = writer({ refuseWith: "PATH_INVALID", throwAs: "plain" });
    const failure = await gateway.finalize(null, session()).catch((error: unknown) => error);
    expect((failure as { code: string }).code).toBe(ERRORS.unavailable);
    expect((failure as { message: string }).message).toBe(MEETING_WRITE_SENTENCES.unreachable);
  });
});

describe("the drain drives it end to end", () => {
  test("a finished meeting comes out of the queue with a path on it", async () => {
    /*
      The whole path, through the real `drainMeetings`: the three local acks,
      then the finalize, then the `written` event the reducer folds. Nothing
      here is a component and nothing is mocked but the one function that
      reaches the network.
    */
    const { gateway, calls } = writer();
    const events: Array<{ type: string }> = [];
    const { records, report } = await drainMeetings([record()], {
      gateway,
      now: () => 1,
      onEvents: (_id, produced) => events.push(...produced),
    });

    expect(report.synced).toEqual(["mtg_abcdefghjkmnpqrstv"]);
    expect(report.rejected).toEqual([]);
    expect(records[0]!.acked.finalized).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["written"]);
    expect(calls).toHaveLength(1);
  });

  test("a refused meeting stays on the device with its sentence", async () => {
    const { gateway } = writer({ refuseWith: "SOMETHING_NEW" });
    const { records, report } = await drainMeetings([record()], {
      gateway,
      now: () => 1,
    });
    expect(report.rejected).toEqual(["mtg_abcdefghjkmnpqrstv"]);
    expect(records[0]!.rejection).toBeDefined();
    expect(records[0]!.session.notePath).toBeNull();
  });
});

describe("Copy note and the file in the bucket", () => {
  /**
   * `MeetingNoteScreen`'s Copy is the only way a meeting gets off this device
   * when nothing filed it, and the claim made for it is that "what they paste
   * into their vault is the note they would have had". That is worth pinning
   * rather than asserting, because it was two different notes.
   */
  test("are the same note, once the meeting is one the bucket holds", async () => {
    /*
      They were not. The writer rendered from a `finalizing` session and the
      screen renders from the record — which, after the `written` event lands,
      is `complete`. So a person who copied their note out got `status:
      complete` over a bucket file that said `finalizing`, and the two answers
      to "what is a meeting note" disagreed on the one line that says whether
      the meeting is over.
    */
    const { gateway, calls } = writer();
    const finished = session();
    const ack = await gateway.finalize(null, finished);

    // What `MeetingNoteScreen` copies: the record's own session, which is what
    // the `written` fold leaves behind. Rendered at the same instant so the one
    // field that is genuinely a render timestamp is held still.
    const onScreen = renderMeetingNote(
      { ...finished, state: "complete", notePath: ack.notePath, recordingSince: null },
      { now: "2026-09-06T18:41:00.000Z" },
    );
    expect(onScreen).toBe(calls[0]!.text);
  });

  test("except for `updated`, which is a render stamp and cannot be the same twice", () => {
    /*
      The honest exception, named so the sentence above is not read as more than
      it is. `renderMeetingNote` stamps `updated` with the moment it ran, and
      Copy runs later than the write by definition — so a copy taken tomorrow
      differs from the bucket file on that one line and on nothing else.

      Left as it is rather than pinned to the write's time: `updated` means
      "when this text was produced", and a copy claiming the write's timestamp
      would be the invented-fact defect this feature has shipped twice.
    */
    const at = (now: string) => renderMeetingNote(session(), { now });
    const first = at("2026-09-06T18:41:00.000Z").split("\n");
    const second = at("2026-09-07T09:00:00.000Z").split("\n");

    const differing = first
      .map((line, index) => (line === second[index] ? null : line))
      .filter((line): line is string => line !== null);
    expect(differing).toHaveLength(1);
    expect(differing[0]!.startsWith("updated: ")).toBe(true);
  });
});

describe("the premise this file rests on", () => {
  test("the action a meeting writes through is the one every note save uses", () => {
    /*
      Asserted rather than assumed, because the tier rule is the thing a second
      writer is most likely to lose and this file cannot see the server. What is
      pinned is the *premise*: `writeNote` runs `authorizeFileAccess` at
      `editor` and then `runFileOperation` with a `write`, which is
      `fileOps.writeFile` — the function whose `canSee` check refuses any path
      the caller's own scope cannot see, over the context's own `privacy.md`. A
      meeting note is a note and the folder's rule decides it, with no meetings
      visibility model and no bypass.

      `storageCodePosition.test.ts` is the precedent for reading another app's
      source to hold a premise where it is relied on.
    */
    const source = readFileSync(
      join(__dirname, "..", "..", "convex", "functions", "files.ts"),
      "utf8",
    );
    const writeNoteBody = source.slice(source.indexOf("export const writeNote = action("));
    const body = writeNoteBody.slice(0, writeNoteBody.indexOf("\n});"));

    expect(body).toContain("authorizeFileAccess");
    expect(body).toContain('minimum: "editor"');
    expect(body).toContain("runFileOperation");
    expect(body).toContain('kind: "write"');

    // And the operation really is the shared one, with the visibility check in
    // it. If `writeFile` stops asking `canSee`, this fails here as well as in
    // the control plane's own tests.
    const ops = readFileSync(
      join(__dirname, "..", "..", "convex", "functions", "lib", "fileOps.ts"),
      "utf8",
    );
    const writeFile = ops.slice(ops.indexOf("export async function writeFile("));
    expect(writeFile.slice(0, 2000)).toContain("canSee(path, options.scope");
  });
});
