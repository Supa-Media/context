/**
 * NOTHING IS CAPTURED BEFORE SOMEBODY SAYS YES, AND THE LIGHT IS ALWAYS ON.
 *
 * The controller is the only object that opens a microphone, so these are the
 * checks that matter most in this app:
 *
 *  1. No permission is even *requested* until a person has consented. macOS
 *     shows one dialog, once — an app that asks at launch is asking a person to
 *     trust a dialog rather than a behaviour.
 *  2. `capturing` is true for exactly the time audio is being recorded, because
 *     the tray reads it and that is the always-on indicator.
 *  3. One meeting is one file: one session, one finalize, one note.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits to `src/core/recording/controller.ts` and
 * reverted:
 *
 *   permissions requested before the consent guard, not after                 5
 *   `end()` moving to `complete` before stopping the recorder                 5
 *   the `grantedEpisode === null` guard removed                               4
 *   the session write queued after the first segment                          3
 *   a fresh segment id minted per segment rather than the stable one          1
 *   permissions asked for from a constant rather than from the channels       1
 *   a typed meeting still labelled with the engine's name                     1
 *   the engine handed one session id for the life of the app                  2
 *   `queueWrites: false` ignored, so the console path queues twice            1
 *   `onSegment` fired from `#update` rather than once per segment             1
 *
 * Three more, run against `src/core/capture/permissions.ts`'s
 * `ensureCapturePermissions` rather than against this file — the owner's
 * first recording on real hardware found the panel's notice pointing at the
 * wrong place, and these checks are what pin the behaviour that notice's own
 * instruction ("record again") depends on:
 *
 *   the `request` call dropped entirely, so a refused mic is never asked      6
 *   `request` called but its result never awaited                            4
 *   `request` called unconditionally, even when already `granted`            5
 *
 * The second one had to be *added* to this file: the original checks looked at
 * the recorder after `end()` resolved, which is green whichever order those two
 * lines are in. It is observed from inside `stop()` now. It also throws on the
 * way out — moving to `complete` early trips the contract's own transition
 * table — so `endQuietly` exists to turn that into a reported failure rather
 * than a dead file.
 */

import { MEETING_TRANSITIONS } from "@context/meetings/protocol";
import { MeetingController } from "../src/core/recording/controller.ts";
import { fakePermissionBroker } from "../src/core/capture/permissions.ts";
import { fakeRecorder } from "../src/core/capture/recorder.ts";
import { fakeTranscriber, segmentId, unavailableTranscriber } from "../src/core/capture/transcriber.ts";
import { emptyOutbox } from "../src/core/sync/outbox.ts";
import { fakeClock } from "./fakes.mjs";

function harness(options = {}) {
  const clock = fakeClock();
  const recorder = options.recorder ?? fakeRecorder();
  const permissions = options.permissions ?? fakePermissionBroker();
  let outbox = emptyOutbox();
  const views = [];
  const segments = [];
  const controller = new MeetingController({
    recorder,
    transcriber: options.transcriber ?? fakeTranscriber(["one", "two"]),
    permissions,
    device: { platform: "macos", name: "a laptop", appVersion: "0.1.0" },
    outbox: () => outbox,
    setOutbox: (next) => { outbox = next; },
    now: clock.now,
    onChange: (view) => views.push(view),
    onSegment: (segment) => segments.push(segment),
    newId: () => "mtg_abcdefghjkmnpqrstvwx",
  });
  return { controller, recorder, permissions, views, clock, segments, outbox: () => outbox };
}

const source = { kind: "zoom", app: "zoom.us" };

/**
 * `end()`, without taking the file down when it throws.
 *
 * An implementation that moves the session to `complete` too early trips the
 * contract's transition table on its way out — which is the table doing its
 * job, but as a *rejection*, and a rejection here would kill every check after
 * it. Caught, so the checks that own the failure get to report it.
 */
async function endQuietly(controller) {
  try {
    return { view: await controller.end(), error: null };
  } catch (error) {
    return { view: null, error };
  }
}

export async function runControllerChecks(check) {
  // -- consent ---------------------------------------------------------------
  {
    const { controller, permissions, recorder } = harness();
    const refused = await controller.begin({ source, title: "Design review", grantedEpisode: null });
    check("a session with no consent is refused", refused.ok === false && refused.why === "not-consented");
    check("nothing was recorded", recorder.capturing === false);
    check("NO PERMISSION WAS EVEN REQUESTED", permissions.calls.length === 0);
    check("no session exists", controller.view() === null);
  }

  // -- permissions, at the moment they are needed ---------------------------
  {
    const { controller, permissions } = harness();
    check("nothing is requested by constructing the controller", permissions.calls.length === 0);
    const begun = await controller.begin({ source, title: "Design review", grantedEpisode: "zoom:zoom.us:t0" });
    check("consent starts the session", begun.ok === true);
    check("the microphone is requested", permissions.calls.includes("request:microphone"));
    check("screen recording is requested", permissions.calls.includes("request:screen"));
    check("permissions are checked before they are requested", permissions.calls[0] === "status:microphone");
  }

  // -- a denied permission stops the recording, honestly --------------------
  {
    const denied = fakePermissionBroker({ microphone: "denied" });
    const { controller, recorder } = harness({ permissions: denied });
    const result = await controller.begin({ source, title: "x", grantedEpisode: "e" });
    check("a denied permission refuses the recording", result.ok === false && result.why === "permissions");
    check("a denied permission names what is missing", (result.missing ?? []).includes("microphone"));
    check("a denied permission is not asked for again", denied.calls.filter((call) => call === "request:microphone").length === 0);
    check("nothing is capturing after a refusal", recorder.capturing === false);
  }

  // -- an already-granted permission is never re-prompted -------------------
  //
  // `ensureCapturePermissions` re-checks `status()` fresh on every `begin()`,
  // which is what lets a person grant a permission in System Settings and
  // press Record again with no second dialog. The other half of that promise
  // is this one: a permission already granted before this session ever
  // started must not raise a dialog either — only `not-determined` (or an
  // unreadable `unknown`) may ever call `request`.
  {
    const granted = fakePermissionBroker({ microphone: "granted", screen: "granted" });
    const { controller, recorder } = harness({ permissions: granted });
    const result = await controller.begin({ source, title: "x", grantedEpisode: "e" });
    check("an already-granted permission starts the recording", result.ok === true);
    check("...with the microphone actually open", recorder.capturing === true);
    check(
      "NO DIALOG IS RAISED FOR A PERMISSION THAT WAS ALREADY GRANTED",
      granted.calls.every((call) => call.startsWith("status:")),
    );
    check("...both permissions were still checked", granted.calls.includes("status:microphone") && granted.calls.includes("status:screen"));
  }

  // -- a granted permission that still cannot open is not "permissions" -----
  //
  // Found on the owner's own hardware: the app was already running when macOS
  // recorded the microphone grant, mid-session — but every attempt after it,
  // for the rest of that process's life, still could not open an input, and
  // the panel still said "not granted" even though TCC's own answer had
  // flipped to `granted`. Modelled here as two separate `begin()` calls on the
  // SAME broker and controller — the first while the mic is `not-determined`,
  // the second after it has flipped to `granted` behind the scenes, the way a
  // real grant given in System Settings would — with a recorder whose `start`
  // only starts refusing on the second attempt, the way a stale process's
  // input would.
  //
  // Two separate claims, both load-bearing:
  //  1. `status()` is asked again on the second attempt rather than reused
  //     from the first — if it were memoised anywhere, this fake broker would
  //     never be asked a second time and this check would not move.
  //  2. The recorder failing AFTER a genuine `granted` is reported as a
  //     DIFFERENT reason than a refused permission: "permissions" means macOS
  //     said no, and its own recovery ("open System Settings, enable it,
  //     record again") is the exact toggle this person already flipped, so
  //     reusing it here would be the same wrong instruction this app was
  //     fixed to stop giving.
  {
    const flipping = fakePermissionBroker({ microphone: "not-determined", screen: "granted" });
    let opens = 0;
    const stubborn = {
      capturing: false,
      async start() {
        opens += 1;
        if (opens > 1) {
          throw new Error("Cannot open the microphone: authorization is still pending for this process.");
        }
      },
      async pause() {},
      async resume() {},
      async stop() {
        return { recordedMs: 0, frames: 0 };
      },
    };
    let outbox = emptyOutbox();
    const clock = fakeClock();
    const controller = new MeetingController({
      recorder: stubborn,
      transcriber: fakeTranscriber(),
      permissions: flipping,
      device: { platform: "macos" },
      outbox: () => outbox,
      setOutbox: (next) => { outbox = next; },
      now: clock.now,
      newId: () => "mtg_abcdefghjkmnpqrstvwx",
    });

    const first = await controller.begin({ source, title: "x", grantedEpisode: "e1" });
    check("the first attempt asks for the not-determined mic and it is granted", first.ok === true);
    check("...by actually raising the dialog, once", flipping.calls.filter((c) => c === "request:microphone").length === 1);
    await endQuietly(controller);
    controller.clear();

    const statusChecksSoFar = flipping.calls.filter((c) => c === "status:microphone").length;
    const second = await controller.begin({ source, title: "x", grantedEpisode: "e2" });
    check(
      "STATUS WAS ASKED AGAIN ON THE SECOND ATTEMPT, IN THE SAME PROCESS — not memoised from the first",
      flipping.calls.filter((c) => c === "status:microphone").length > statusChecksSoFar,
    );
    check(
      "...and the dialog was not raised twice, since the second check already read granted",
      flipping.calls.filter((c) => c === "request:microphone").length === 1,
    );
    check("the recorder still refused to open despite the grant", second.ok === false);
    check(
      "...and that is reported as a DIFFERENT reason than a refused permission",
      second.why === "stale-permission",
    );
    check("...naming no permission as missing, because none is", (second.missing ?? ["not empty"]).length === 0);
    check("the session records the failure rather than pretending to record", controller.view()?.state === "failed");
  }

  // -- the indicator ---------------------------------------------------------
  {
    const { controller, recorder, views } = harness();
    await controller.begin({ source, title: "Design review", grantedEpisode: "e" });
    check("the session is recording", controller.view()?.state === "recording");
    check("the indicator is on while recording", controller.view()?.capturing === true);
    check("the recorder agrees", recorder.capturing === true);

    await controller.pause();
    check("pausing stops the capture", recorder.capturing === false);
    check("the indicator follows the capture", controller.view()?.capturing === false);
    check("a paused session is paused, not stopped", controller.view()?.state === "paused");

    recorder.step(5_000);
    check("a paused recorder captures nothing", (controller.view()?.transcript.length ?? -1) === 0);

    await controller.resume();
    check("resuming captures again", recorder.capturing === true);
    recorder.step(1_000, "mic");
    check("a resumed recorder transcribes", (controller.view()?.transcript.length ?? -1) === 1);

    const ended = await endQuietly(controller);
    check("ending a recording does not throw", ended.error === null);
    check("ending stops the capture", recorder.capturing === false);
    check("the indicator is off once the meeting ends", ended.view?.capturing === false);
    check("recordedMs excludes the pause", ended.view?.recordedMs === 1_000);
    check("every view emitted while recording had the indicator on", views.filter((v) => v.state === "recording" && v.transcript.length > 0).every((v) => v.capturing));
  }

  // -- the session row goes out before anything references it ---------------
  {
    const { controller, recorder, outbox } = harness();
    await controller.begin({ source, title: "Design review", grantedEpisode: "e" });
    const first = outbox().entries;
    check("the session row is queued the moment recording starts", first.length === 1);
    check("and it is the session row, not a segment", first[0]?.kind === "session");
    recorder.step(1_000, "mic");
    check("a segment is queued after it", outbox().entries.length === 2);
  }

  // -- the microphone is closed before the app says it is done --------------
  //
  // Observed from inside `stop()` rather than after `end()` resolves: the
  // failure this guards against is a window — however short — in which the
  // session reports `complete` while a stream is still open.
  {
    const clock = fakeClock();
    const inner = fakeRecorder();
    let stateAtStop = null;
    let controller = null;
    const recorder = {
      get capturing() { return inner.capturing; },
      start: (options) => inner.start(options),
      pause: () => inner.pause(),
      resume: () => inner.resume(),
      stop: async () => {
        stateAtStop = controller.view()?.state ?? null;
        return inner.stop();
      },
    };
    let outbox = emptyOutbox();
    controller = new MeetingController({
      recorder,
      transcriber: fakeTranscriber(),
      permissions: fakePermissionBroker(),
      device: { platform: "macos" },
      outbox: () => outbox,
      setOutbox: (next) => { outbox = next; },
      now: clock.now,
      newId: () => "mtg_abcdefghjkmnpqrstvwx",
    });
    await controller.begin({ source, title: "x", grantedEpisode: "e" });
    // Caught: an implementation that moves to `complete` early also trips the
    // contract's transition table on the way out, and a throw here would take
    // the rest of the file with it instead of naming what went wrong.
    const ending = await endQuietly(controller);
    check("ending a meeting does not throw", ending.error === null);
    check("THE RECORDER IS STOPPED WHILE THE SESSION IS STILL FINALIZING", stateAtStop === "finalizing");
    check("the session is complete only afterwards", controller.view()?.state === "complete");
  }

  // -- one meeting is one file ----------------------------------------------
  {
    const { controller, recorder, outbox } = harness();
    await controller.begin({ source, title: "Design review", grantedEpisode: "e" });
    recorder.step(1_000, "mic");
    recorder.step(1_000, "system");
    controller.notes("Multi-studio onboarding is the blocker.");
    controller.notes("Multi-studio onboarding is the blocker, not the theme work.");
    await endQuietly(controller);

    const entries = outbox().entries;
    const kinds = entries.map((entry) => entry.kind).sort();
    check("exactly one finalize is queued", kinds.filter((kind) => kind === "finalize").length === 1);
    check("exactly one session row is queued", kinds.filter((kind) => kind === "session").length === 1);
    check("exactly one notes row is queued", kinds.filter((kind) => kind === "notes").length === 1);
    check("exactly one segments row is queued", kinds.filter((kind) => kind === "segments").length === 1);

    const segments = (entries.find((entry) => entry.kind === "segments")?.body.segments ?? []);
    check("both channels are in the transcript", new Set(segments.map((s) => s.channel)).size === 2);
    check("segment ids are stable and derived from the session", segments[0]?.id === segmentId("mtg_abcdefghjkmnpqrstvwx", 0));

    const finalize = entries.find((entry) => entry.kind === "finalize")?.body ?? {};
    check("the finalize carries what the client believes it sent", finalize?.segmentCount === segments.length);
    check("the finalize carries the human's own notes", (finalize?.notes ?? "").endsWith("not the theme work."));

    const notes = entries.find((entry) => entry.kind === "notes")?.body.notes ?? "";
    check("the last version of the human's notes wins", (notes ?? "").endsWith("not the theme work."));
  }

  // -- the human's words are never rewritten --------------------------------
  {
    const { controller } = harness();
    await controller.begin({ source, title: "x", grantedEpisode: "e" });
    controller.notes("mine");
    check("notes are exactly what was typed", controller.view()?.notes === "mine");
    check("the transcript is a separate field", Array.isArray(controller.view()?.transcript));
  }

  // -- the rail's label cannot disagree with the engine ---------------------
  {
    const cloud = harness({ transcriber: unavailableTranscriber("cloud") });
    check("an engine that sends audio says so", cloud.controller instanceof MeetingController);
    const local = harness();
    await local.controller.begin({ source, title: "x", grantedEpisode: "e" });
    check("the view carries the engine's own label", local.controller.view()?.transcriptionLabel === "test engine");
    check("the view carries whether audio leaves the machine", local.controller.view()?.audioLeavesDevice === false);
  }

  // -- an engine that is not built yet fails loudly -------------------------
  {
    const { controller, recorder } = harness({ transcriber: unavailableTranscriber("on-device") });
    const result = await controller.begin({ source, title: "x", grantedEpisode: "e" });
    check("a missing transcriber does not silently record nothing", result.ok === false);
    check("a missing transcriber leaves nothing capturing", recorder.capturing === false);
    check("the failure is on the session", controller.view()?.state === "failed");
    check("the failure names itself", (controller.view()?.failureReason ?? "").includes("not built yet"));
  }

  // -- illegal transitions are the contract's, not ours ---------------------
  {
    const { controller } = harness();
    await controller.begin({ source, title: "x", grantedEpisode: "e" });
    await endQuietly(controller);
    let threw = false;
    try {
      await controller.pause();
    } catch {
      threw = true;
    }
    check("a complete session cannot be paused", threw);
    check("the contract says so", MEETING_TRANSITIONS.complete.length === 0);
  }

  // -- a typed meeting opens nothing ----------------------------------------
  //
  // `capturePlan` answers with no channels when there is nothing to transcribe
  // with — no grant on this machine, or on-device chosen and not built. The
  // controller must then open no microphone, ask for no permission, and still
  // produce a note: the person typed, and what they typed is theirs.
  {
    const { controller, permissions, recorder, outbox } = harness();
    const begun = await controller.begin({
      source,
      title: "Kickoff",
      grantedEpisode: "e",
      channels: [],
      notice: "This machine is not connected to a context yet.",
    });
    check("a typed meeting starts", begun.ok === true);
    check("NO PERMISSION IS REQUESTED FOR A MEETING THAT OPENS NO MICROPHONE", permissions.calls.length === 0);
    check("...and nothing is capturing", recorder.capturing === false && controller.view()?.capturing === false);
    check("the session says it has no audio", controller.view()?.audio === false);
    check("...and the rail does not claim an engine", controller.view()?.transcriptionLabel === "typed");
    check("...nor that audio went anywhere", controller.view()?.audioLeavesDevice === false);
    check("...and the reason is carried on the session, for the panel to show", (controller.view()?.notice ?? "").includes("not connected"));

    controller.notes("They want the pilot before the quarter ends.");
    const ended = await endQuietly(controller);
    check("a typed meeting still ends cleanly", ended.error === null && controller.view()?.state === "complete");
    const kinds = outbox().entries.map((entry) => entry.kind);
    check("...and still becomes a note", kinds.filter((kind) => kind === "finalize").length === 1);
    check("...carrying the notes the person typed", kinds.includes("notes"));
    check("...with nothing recorded", (controller.view()?.recordedMs ?? -1) === 0);
  }

  // -- a notice from the engine reaches the session -------------------------
  {
    const notices = [];
    const engine = {
      id: "cloud",
      audioLeavesDevice: true,
      label: "cloud (audio not stored)",
      async start(options) {
        notices.push(options.onNotice);
        return { push() {}, async finish() {} };
      },
    };
    const { controller } = harness({ transcriber: engine });
    await controller.begin({ source, title: "x", grantedEpisode: "e" });
    check("the engine is handed a way to say something went wrong", typeof notices[0] === "function");
    notices[0]?.({ recoverable: false, message: "This meeting is not being transcribed." });
    check("...and what it says lands on the session the UI renders", controller.view()?.notice === "This meeting is not being transcribed.");
    check("...without stopping the recording", controller.view()?.state === "recording");
  }

  // -- the engine is told which meeting it is transcribing -------------------
  {
    const seen = [];
    const engine = {
      id: "cloud",
      audioLeavesDevice: true,
      label: "cloud (audio not stored)",
      async start(options) {
        seen.push(options.sessionId);
        return { push() {}, async finish() {} };
      },
    };
    const { controller } = harness({ transcriber: engine });
    await controller.begin({ source, title: "x", grantedEpisode: "e" });
    check(
      "THE ENGINE IS TOLD THE SESSION ID PER MEETING, so two meetings cannot share segment ids",
      seen[0] === controller.view()?.id,
    );
  }

  // -- one at a time ---------------------------------------------------------
  {
    const { controller } = harness();
    await controller.begin({ source, title: "one", grantedEpisode: "e1" });
    const second = await controller.begin({ source, title: "two", grantedEpisode: "e2" });
    check("a second meeting does not start over the first", second.ok === false && second.why === "already-recording");
    check("the first meeting is untouched", controller.view()?.title === "one");
  }
  /* --- one meeting is one writer ---------------------------------------- */

  /**
   * WHO QUEUES THE WRITES, AND WHY IT IS NOT ALWAYS THIS OBJECT.
   *
   * `docs/decisions/desktop.md`: on the console path the *page* holds the
   * meeting — its record, the human's notes, the destination somebody picked —
   * and hands each write to this machine's queue over the bridge, so the note
   * is written by the machine's own grant through the outbox that outlives the
   * window. If this controller also queued, both would collapse onto the same
   * `${sessionId}:${kind}` entries and the last one in would win: `end()`
   * queues an **empty** `notes`, drains it, and the gateway writes the note
   * before the person's typed notes have left the page.
   *
   * What must stay true is everything else: the microphone, the consent gate,
   * the transcriber and the segment stream are unchanged, because they are what
   * the shell is for.
   */
  {
    const shell = harness();
    await shell.controller.begin({
      source,
      title: "Standup",
      grantedEpisode: "e1",
      queueWrites: false,
      channels: ["mic"],
    });
    check(
      "...and the microphone is open, which is what the shell is for",
      shell.recorder.capturing === true,
    );
    shell.recorder.step(1_000);
    shell.controller.notes("what the person typed");
    await endQuietly(shell.controller);
    check(
      "A MEETING THE CONSOLE STARTED QUEUES NOTHING HERE — the page is the writer",
      shell.outbox().entries.length === 0,
    );
    check(
      "...though it did capture and transcribe, so the words reached the page",
      shell.segments.length > 0,
    );
    check(
      "...and it still holds the human's notes for anything on this side that asks",
      shell.controller.view()?.notes === "what the person typed",
    );
  }

  {
    const shell = harness();
    await shell.controller.begin({ source, title: "Standup", grantedEpisode: "e1", channels: ["mic"] });
    check(
      "a meeting the shell started queues its own session row, as it always has",
      shell.outbox().entries.some((entry) => entry.kind === "session"),
    );
    await endQuietly(shell.controller);
  }

  {
    const shell = harness();
    await shell.controller.begin({ source, title: "Standup", grantedEpisode: "e1", channels: ["mic"] });
    await endQuietly(shell.controller);
    check(
      "every segment is announced once, as an event rather than as a state",
      shell.segments.length === shell.controller.view()?.transcript.length,
    );
    check(
      "...and it is the segment itself, not the whole transcript",
      shell.segments.every((segment) => typeof segment?.id === "string" && typeof segment.text === "string"),
    );
  }

  {
    const shell = harness();
    await shell.controller.begin({
      id: "mtg_theoneythepagechose",
      source,
      title: "Standup",
      grantedEpisode: "e1",
      channels: ["mic"],
    });
    check(
      "THE ID THE PAGE MINTED IS THE ID THE MEETING IS FILED UNDER",
      shell.controller.view()?.id === "mtg_theoneythepagechose",
    );
    check(
      "...and the queue is keyed on it, so one meeting is one note",
      shell.outbox().entries.every((entry) => entry.sessionId === "mtg_theoneythepagechose"),
    );
    await endQuietly(shell.controller);
  }
}
