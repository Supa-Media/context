import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createConvexGateway } from "../features/meetings/convexGateway";
import { drainMeetings } from "../features/meetings/sync";
import { emptyAck, type MeetingRecord } from "../features/meetings/record";
import { seedSession } from "../features/meetings/session";
import { ERRORS, PROTOCOL_VERSION, type MeetingSession } from "../features/meetings/protocol";
import { parseMeetingNote } from "@context/meetings/note";

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

/** A `writeNote` that records what it was asked to write, and can refuse. */
function spyWriteNote(options: { refuseWith?: string } = {}) {
  const calls: Array<{ workspaceId: string; path: string; text: string }> = [];
  const write = async (args: { workspaceId: string; path: string; text: string }) => {
    calls.push(args);
    if (options.refuseWith !== undefined) {
      const error = new Error("refused") as Error & { data: { code: string } };
      error.data = { code: options.refuseWith };
      throw error;
    }
    return { path: args.path };
  };
  return { calls, write };
}

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
