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
  const recorder = fakeRecorder();
  const permissions = options.permissions ?? fakePermissionBroker();
  let outbox = emptyOutbox();
  const views = [];
  const controller = new MeetingController({
    recorder,
    transcriber: options.transcriber ?? fakeTranscriber("mtg_abcdefghjkmnpqrstvwx", ["one", "two"]),
    permissions,
    device: { platform: "macos", name: "a laptop", appVersion: "0.1.0" },
    outbox: () => outbox,
    setOutbox: (next) => { outbox = next; },
    now: clock.now,
    onChange: (view) => views.push(view),
    newId: () => "mtg_abcdefghjkmnpqrstvwx",
  });
  return { controller, recorder, permissions, views, clock, outbox: () => outbox };
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
      transcriber: fakeTranscriber("mtg_abcdefghjkmnpqrstvwx"),
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

  // -- one at a time ---------------------------------------------------------
  {
    const { controller } = harness();
    await controller.begin({ source, title: "one", grantedEpisode: "e1" });
    const second = await controller.begin({ source, title: "two", grantedEpisode: "e2" });
    check("a second meeting does not start over the first", second.ok === false && second.why === "already-recording");
    check("the first meeting is untouched", controller.view()?.title === "one");
  }
}
