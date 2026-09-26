/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import {
  DESKTOP_MESSAGES,
  DESKTOP_WRITE_SENTENCES,
  MIC_ONLY_SENTENCE,
  MeetingGatewayError,
  MeetingsController,
  createDesktopGateway,
  defaultMachineAudio,
  desktopState,
  fakeGateway,
  fakeRecorder,
  installShell,
  meetingsWriterFor,
  memoryStore,
  recallMachineAudio,
  recallSystemAudio,
  rememberMachineAudio,
  resetDesktop,
  resolveRecorder,
  teardownDesktop,
} from "./fixtures";

/**
 * System audio offered only where it exists, the whole-call switch with no
 * sheet to put it on, the meeting's own id going to the shell, and the shell
 * writing what it records. See `fixtures.ts` for the fake shell, fake browser
 * and the sabotage record that proves it.
 */

beforeEach(() => {
  resetDesktop();
});

afterEach(() => {
  teardownDesktop();
});

describe("system audio is offered only where it exists", () => {
  test("a shell without it reports it, and the capability says so", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.systemAudio).toBe(false);
  });

  test("a shell with it asks for it, and only when the person did", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true, systemAudio: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.systemAudio).toBe(true);

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    expect(shell.lastStart?.systemAudio).toBe(false);

    await recorder.stop();
    await recorder.start({ sessionId: "mtg_desktop_2", systemAudio: true });
    expect(shell.lastStart?.systemAudio).toBe(true);
  });

  /**
   * Asked for the whole call, given half of it — an unsigned build, or one
   * macOS has stopped trusting. The recording is fine and the *claim* would not
   * have been, so it is reported rather than rendered silently.
   */
  test("a shell that grants less than was asked says so", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true, systemAudio: true },
      started: { systemAudio: false },
    });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: true });
    expect(errors).toContain(DESKTOP_MESSAGES.micOnly);
  });

  /**
   * A shell that can hear nothing is a typed session with a sentence about
   * *this machine* — not about "this browser", which would send somebody to the
   * wrong settings screen entirely.
   */
  test("a shell that can hear nothing is honest about it", async () => {
    const shell = fakeDesktopBridge();
    installShell(shell);
    const recorder = await resolveRecorder("web");

    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.transcribesAt).toBe("nowhere");
    expect(recorder.capability.unavailableReason).toBe(DESKTOP_MESSAGES.noAudio);

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    expect(shell.calls).not.toContain("startCapture");
    // The clock still runs and the notepad still works: a refused microphone
    // must not cost somebody their notes.
    expect(recorder.state).toBe("recording");
  });

  /*
    These two replace the probe rather than configuring the fake, so they build
    a bridge of their own: the reference fake is **frozen**, exactly as the
    preload's object is, and assigning over one of its methods does nothing at
    all. The first version of both tests did that and passed while asserting
    nothing.
  */
  const shellAnswering = (capabilities: () => Promise<unknown>) =>
    Object.freeze({ ...fakeDesktopBridge().bridge, capabilities }) as never;

  /** A shell answering rubbish is a shell that can do nothing. */
  test("a capability that is not `true` is not a capability", async () => {
    (globalThis as Record<string, unknown>).desktop = shellAnswering(async () => ({
      mic: "yes",
      systemAudio: 1,
    }));
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);
  });

  test("a shell that will not answer at all is not believed either", async () => {
    (globalThis as Record<string, unknown>).desktop = shellAnswering(async () => {
      throw new Error("no channel");
    });
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(false);
    /*
      ...and the sentence is still the shell's rather than the browser's. This
      page is inside a shell; telling somebody their browser cannot record would
      send them to the wrong settings screen entirely.
    */
    expect(recorder.capability.unavailableReason).toBe(DESKTOP_MESSAGES.noAudio);
  });
});

describe("the whole-call switch, now that there is no sheet to put it on", () => {
  /**
   * THE SWITCH OUTLIVED THE SHEET, AND IT HAD TO.
   *
   * It used to be a row on the destination sheet, answered per meeting. The
   * sheet is gone — pressing New meeting records — and on a phone or inside the
   * desktop shell that costs nothing: the shell's loopback tap is silent and a
   * phone cannot do this at all. **In a browser it would have been a capability
   * deleted**, because taking the far side of a call there needs
   * `getDisplayMedia`, which costs a source picker, and somebody who never
   * wants the picker needs somewhere to say so.
   *
   * So the answer is a per-device setting (`machineAudio.ts`), read at the
   * press, and these are its halves. What it does to a recording is
   * `meetingsFlow.test.ts`'s; what the settings pane says about it is prose
   * beside the switch.
   */
  test("nobody's answer means both sides of the call, picker or not", async () => {
    // A picker in front of every meeting is the price; a transcript with one
    // side of a call in it is the cost it avoids.
    expect(defaultMachineAudio()).toBe(true);
    await expect(recallSystemAudio(memoryStore())).resolves.toBe(true);
  });

  test("a device that has never been asked says so, rather than guessing", async () => {
    await expect(recallMachineAudio(memoryStore())).resolves.toBeNull();
  });

  test("an answer survives the device it was given on", async () => {
    const store = memoryStore();
    await rememberMachineAudio(store, true);
    await expect(recallMachineAudio(store)).resolves.toBe(true);
    await rememberMachineAudio(store, false);
    await expect(recallMachineAudio(store)).resolves.toBe(false);
  });

  test("a stored answer beats the default, in both directions", async () => {
    const store = memoryStore();
    await rememberMachineAudio(store, false);
    await expect(recallSystemAudio(store)).resolves.toBe(false);
    await rememberMachineAudio(store, true);
    await expect(recallSystemAudio(store)).resolves.toBe(true);
  });

  test("and the sentence a mic-only build shows is still about the far side of a call", () => {
    expect(MIC_ONLY_SENTENCE).toMatch(/far side of a call/i);
  });
});

describe("the meeting's own id goes to the shell", () => {
  /**
   * The desktop shell queues writes in another process, keyed by session. A
   * capture started under any other name would be a second meeting in
   * somebody's bucket that nothing on this device ever reconciles.
   */
  test("the controller hands the recorder the id it minted", async () => {
    const recorder = fakeRecorder({ systemAudio: true });
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup", systemAudio: true });

    expect(recorder.startedWith?.sessionId).toBe(id);
    expect(recorder.startedWith?.systemAudio).toBe(true);
  });

  test("...and where nobody was asked, the build's own answer is used", async () => {
    const recorder = fakeRecorder();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: fakeGateway(),
      recorder,
      device: { platform: "web" },
    });

    await controller.start({ title: "Standup" });
    expect(recorder.startedWith?.systemAudio).toBe(false);
  });
});

describe("the shell records it, and the shell writes it", () => {
  /**
   * ONE MEETING IS ONE CREDENTIAL, AND ON A MAC IT IS THE MACHINE'S.
   *
   * Step 3 replaced the *recorder* and nothing else, so a meeting in the shell
   * took two: the shell's machine grant for the audio it captured and
   * transcribed, and the **page's** control-plane session for the note. What
   * that cost is what `convexGateway.ts` already lists — no enhancement pass, no
   * `.meetings/` session record, no `list_meetings` — plus one thing that was
   * only true here: the shell's window-less outbox was not on the path, so a
   * meeting was written by the page that happened to be open rather than by the
   * queue that survives it.
   *
   * `desktopGateway.ts` is that half. The page composes and the **shell**
   * writes, through the same outbox the tray-only recording uses, so a meeting
   * recorded with the window closed and one recorded from the console take the
   * same path with the same credential.
   *
   * The test the decision names is `the page does not write directly in desktop
   * mode`: it fails the moment `useMeetingsSetup` stops swapping the writer, or
   * a screen starts calling the control-plane one behind its back.
   */
  const segment = (id: string, text: string) => ({
    id,
    startMs: 0,
    endMs: 2_000,
    text,
    speaker: null,
    channel: "mic" as const,
    confidence: null,
  });

  /** A shell whose queue drains: every finalize comes back with a note path. */
  function writingShell(notePath = "5-meetings/2026-09-07-standup.md") {
    return fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) =>
        write.kind === "finalize"
          ? { sessionId: write.sessionId, queued: false, notePath, rejected: null }
          : { sessionId: write.sessionId, queued: true, notePath: null, rejected: null },
    });
  }

  test("A MEETING RECORDED FROM THE CONSOLE IS WRITTEN BY THE MACHINE'S OWN GRANT", async () => {
    const shell = writingShell();
    installShell(shell);

    const recorder = await resolveRecorder("web");
    const page = fakeGateway();
    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      // The one line `useMeetingsSetup` runs, with the browser's writer as the
      // fallback it would have used outside a shell.
      gateway: meetingsWriterFor(page),
      recorder,
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup" });
    shell.emitSegment(segment("seg-1", "we should ship it"));
    await controller.end();

    // The shell held the input, and this page never asked for one.
    expect(shell.lastStart?.sessionId).toBe(id);
    expect(shell.calls).toContain("stopCapture");
    expect(desktopState.getUserMediaCalls).toBe(0);
    expect(desktopState.recorderInstances).toBe(0);

    // THE PAGE DID NOT WRITE. Every write went to the machine's queue.
    expect(page.calls).toEqual([]);
    expect(page.notesWritten()).toBe(0);

    const kinds = shell.writes.map((write) => write.kind);
    expect(kinds).toContain("session");
    expect(kinds).toContain("segments");
    expect(kinds).toContain("finalize");
    expect(shell.writes.every((write) => write.sessionId === id)).toBe(true);
    // ...and the transcript the shell produced went back to the shell to be
    // filed, under the id the page minted, so one meeting is one note.
    const segments = shell.writes.find((write) => write.kind === "segments");
    expect((segments?.body.segments as { text: string }[])[0].text).toBe("we should ship it");
  });

  /**
   * THE EMPTY-NOTES RACE, AS CLOSE TO END-TO-END AS THIS SIDE OF THE IPC GOES.
   *
   * This is what `BeginInput.queueWrites: false` exists to prevent, seen from
   * the page: with two writers on one meeting, the shell's `end()` queues an
   * **empty** `notes` and a finalize and drains them, and the gateway writes the
   * note before the person's typed Markdown has left this process. The note
   * somebody opens afterwards has the transcript and none of their notes in it.
   *
   * The shell half is checked in `apps/desktop`'s controller suite — a
   * console-started meeting queues nothing there. This is the other half: one
   * meeting, one session id, and the writes that reach the machine carry the
   * transcript *and* the typed notes, with exactly one finalize behind them.
   */
  test("ONE MEETING, ONE SESSION, AND BOTH THE TRANSCRIPT AND THE TYPED NOTES REACH IT", async () => {
    const shell = writingShell();
    installShell(shell);

    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: meetingsWriterFor(fakeGateway()),
      recorder: await resolveRecorder("web"),
      device: { platform: "web" },
    });

    const id = await controller.start({ title: "Standup" });
    shell.emitSegment(segment("seg-1", "we should ship it"));
    controller.setNotes(id, "- ship it\n- tell everyone");
    await controller.end();

    const sessions = new Set(shell.writes.map((write) => write.sessionId));
    expect([...sessions]).toEqual([id]);

    const segments = shell.writes.filter((write) => write.kind === "segments");
    const notes = shell.writes.filter((write) => write.kind === "notes");
    const finalizes = shell.writes.filter((write) => write.kind === "finalize");

    expect(
      segments.flatMap((write) => (write.body.segments as { text: string }[]) ?? []).map((one) => one.text),
    ).toContain("we should ship it");
    expect(notes.map((write) => write.body.markdown)).toContain("- ship it\n- tell everyone");
    // Not an empty one before them, which is the race written as an assertion.
    expect(notes.every((write) => write.body.markdown !== "")).toBe(true);
    expect(finalizes).toHaveLength(1);
  });

  test("...and the note path the gateway chose is what the record ends up holding", async () => {
    const shell = writingShell("5-meetings/2026-09-07-standup.md");
    installShell(shell);

    const controller = new MeetingsController();
    await controller.configure({
      workspaceId: "ws_1",
      store: memoryStore(),
      gateway: meetingsWriterFor(fakeGateway()),
      recorder: await resolveRecorder("web"),
      device: { platform: "web" },
    });
    const id = await controller.start({ title: "Standup" });
    controller.setNotes(id, "- daily standup notes");
    await controller.end();

    const record = controller.getSnapshot().records.find((one) => one.session.id === id);
    expect(record?.session.notePath).toBe("5-meetings/2026-09-07-standup.md");
  });

  /**
   * The parity the decision asks for, stated as one assertion rather than as
   * prose: the writes a console-recorded meeting produces are the meetings
   * protocol's four, addressed the same way the tray's own recording addresses
   * them — same routes, same credential, same queue.
   */
  test("a meeting from the console reaches the queue as the protocol's own four writes", async () => {
    const shell = writingShell();
    installShell(shell);

    const gateway = createDesktopGateway(shell.bridge.meetings!);
    const session = {
      id: "mtg_abcdefghjkmnpqrstvwx",
      state: "finalizing",
      transcript: [segment("seg-1", "hello")],
      startedAt: "2026-09-07T10:00:00.000Z",
    } as never;

    await gateway.putSession(null, session);
    await gateway.putSegments(null, "mtg_abcdefghjkmnpqrstvwx", [segment("seg-1", "hello")]);
    await gateway.putNotes(null, "mtg_abcdefghjkmnpqrstvwx", "my notes");
    await gateway.finalize(null, session);

    expect(shell.writes.map((write) => write.kind)).toEqual([
      "session",
      "segments",
      "notes",
      "finalize",
    ]);
    // The bodies are `createHttpGateway`'s, because this is the same request
    // made with the same credential — the shell is transport, not a protocol.
    expect(shell.writes[1].body).toEqual({ segments: [segment("seg-1", "hello")] });
    expect(shell.writes[2].body).toEqual({ markdown: "my notes" });
    expect(shell.writes[3].body).toEqual({});
    expect(shell.writes.every((write) => write.context === null)).toBe(true);
  });

  test("a destination rides as a context name, never as a path", async () => {
    const shell = writingShell();
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await gateway.putNotes({ kind: "personalInbox" as const, contextSlug: "acme", folder: "5-meetings" }, "mtg_1", "notes");
    expect(shell.writes[0].context).toBe("acme");

    await gateway.finalize(
      { kind: "personalInbox" as const, contextSlug: "acme", folder: "5-meetings" },
      { id: "mtg_1", transcript: [] } as never,
    );
    expect(shell.writes[1].body).toEqual({ folder: "5-meetings" });
  });

  /**
   * A slug the gateway's own selector would not read falls off the front of the
   * path and the request is served by whatever context the credential defaults
   * to — a meeting written into the wrong tenant, in silence. Refusing to send
   * is the only answer that is not that.
   */
  test("A DESTINATION THE GATEWAY WOULD IGNORE IS REFUSED RATHER THAN SENT", async () => {
    const shell = writingShell();
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(
      gateway.putNotes({ kind: "personalInbox" as const, contextSlug: "Acme Corp", folder: "5-meetings" }, "mtg_1", "notes"),
    ).rejects.toBeInstanceOf(MeetingGatewayError);
    expect(shell.writes).toEqual([]);
  });

  /**
   * The rule `docs/decisions/app-and-console.md` states: the UI must never claim
   * a write it has not seen acknowledged. A queued finalize is the shell holding
   * a meeting, not a note in a bucket, so it is a transient refusal — the record
   * keeps asking, and re-finalizing is answered with the note that already
   * exists once it lands.
   */
  test("a finalize the shell has only queued is not an acknowledgement", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(
      gateway.finalize(null, { id: "mtg_1", transcript: [] } as never),
    ).rejects.toMatchObject({ message: DESKTOP_WRITE_SENTENCES.queued });
  });

  test("...and a finalize that landed carries the path the gateway chose", async () => {
    const shell = writingShell("5-meetings/x.md");
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    const ack = await gateway.finalize(null, { id: "mtg_1", transcript: [] } as never);
    expect(ack.notePath).toBe("5-meetings/x.md");
    expect(ack.state).toBe("complete");
    // Nothing was written conditionally, and this ack does not claim it was.
    expect(ack.conflictSafe).toBe(false);
  });

  test("a meeting the shell's queue parked is parked here too, with the shell's sentence", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) => ({
        sessionId: write.sessionId,
        queued: false,
        notePath: null,
        rejected: { code: "meeting_forbidden", message: "your context would not take it" },
      }),
    });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(gateway.putSession(null, { id: "mtg_1", transcript: [] } as never)).rejects.toMatchObject({
      code: "meeting_forbidden",
      message: "your context would not take it",
    });
  });

  test("...and a code this build does not know parks rather than retrying forever", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      write: (write) => ({
        sessionId: write.sessionId,
        queued: false,
        notePath: null,
        rejected: { code: "meeting_teapot", message: "no" },
      }),
    });
    const gateway = createDesktopGateway(shell.bridge.meetings!);
    await expect(gateway.putSession(null, { id: "mtg_1", transcript: [] } as never)).rejects.toMatchObject({
      code: "meeting_invalid",
    });
  });

  /* --- which writer, and when it is not this one ------------------------- */

  test("a browser keeps the writer it had", () => {
    const page = fakeGateway();
    expect(meetingsWriterFor(page, null)).toBe(page);
  });

  test("A SHELL OLDER THAN THIS BUNDLE KEEPS IT TOO — version 1 has no `meetings`", () => {
    const page = fakeGateway();
    const old = fakeDesktopBridge({ noMeetings: true, capabilities: { mic: true } });
    expect(old.bridge.version).toBe(1);
    expect(meetingsWriterFor(page, old.bridge)).toBe(page);
  });

  test("...and a shell that offers one does not", () => {
    const page = fakeGateway();
    const shell = writingShell();
    expect(meetingsWriterFor(page, shell.bridge)).not.toBe(page);
  });
});

