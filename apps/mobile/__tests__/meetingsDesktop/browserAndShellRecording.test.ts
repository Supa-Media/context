/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";
import type { StartCaptureRequest } from "@context/desktop-bridge";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

import {
  DESKTOP_MESSAGES,
  MIC_ONLY_SENTENCE,
  desktopState,
  installShell,
  resetDesktop,
  resolveRecorder,
  teardownDesktop,
} from "./fixtures";

/**
 * A browser with no shell is unchanged, and inside the shell the shell
 * records. See `fixtures.ts` for the fake shell, fake browser and the
 * sabotage record that proves it.
 */

beforeEach(() => {
  resetDesktop();
});

afterEach(() => {
  teardownDesktop();
});

describe("a browser with no shell is unchanged", () => {
  test("the web build still drives MediaRecorder", async () => {
    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(true);
    expect(recorder.capability.systemAudio).toBe(false);

    await recorder.start({ sessionId: "mtg_web", systemAudio: false });
    expect(desktopState.getUserMediaCalls).toBe(1);
    expect(desktopState.recorderInstances).toBe(1);
    await recorder.stop();
  });

  /**
   * The honest sentence a browser has always made, now in the one place
   * somebody reads before pressing Record rather than only in a file header.
   */
  test("...and says the far side of a call is not in the recording", () => {
    expect(MIC_ONLY_SENTENCE).toMatch(/far side of a call/i);
  });

  test("a phone asked of the web module is still a phone", async () => {
    const recorder = await resolveRecorder("ios");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);
  });

  /**
   * ...and it stays a phone with a shell sitting right there.
   *
   * The detection rule is `Platform.OS === "web" && getDesktopBridge() !== null`
   * and the first half is not decoration: `window.desktop` is a web-only
   * concept by construction — on a phone the Expo binary *is* the native
   * surface — so a bridge that somehow existed there must change nothing. The
   * check above passes with no shell on the page at all, which means it would
   * go on passing if the platform half of the rule were deleted. This one puts
   * a real, valid shell in front of it first, and nothing about the answer
   * moves.
   */
  test("...and a shell on the page does not turn a phone into a desktop", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true, systemAudio: true } });
    installShell(shell);

    const recorder = await resolveRecorder("ios");
    expect(recorder.capability.audio).toBe(false);
    expect(recorder.capability.systemAudio).toBe(false);

    await recorder.start({ sessionId: "mtg_phone", systemAudio: true });
    expect(shell.calls).toEqual([]);
  });

  /**
   * And the native half of the split cannot reach the shell recorder at all.
   *
   * Read off the source rather than driven, because what is being asserted is
   * about a bundle Metro builds rather than about a call: `capture/desktop.ts`
   * is reached only through `audio.web.ts`, which Metro hands to the web build
   * and never to a phone. A `./desktop` import in any other capture module puts
   * an Electron-shaped surface in the iOS bundle to describe a global that
   * cannot exist there — and no runtime check inside this app would notice,
   * because on a phone the answer would simply be `null` forever.
   */
  test("only the web half of the split imports the shell recorder", () => {
    const dir = join(__dirname, "..", "..", "features", "meetings", "capture");
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && name !== "audio.web.ts" && name !== "desktop.ts")
      .filter((name) => /from\s+"\.\/desktop"/.test(readFileSync(join(dir, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  /**
   * Detection is `getDesktopBridge()`, not `"desktop" in window`.
   *
   * An object a page put there itself is not a shell: it is not frozen, and the
   * validator refuses it. Without this the browser path would be replaced by a
   * recorder wired to whatever a compromised page decided to expose — and the
   * person would be told they were recording.
   */
  test("an object pretending to be a shell gets the browser path", async () => {
    (globalThis as Record<string, unknown>).desktop = {
      version: 1,
      capabilities: async () => ({ mic: true, systemAudio: true }),
      startCapture: async () => ({}),
    };
    const recorder = await resolveRecorder("web");
    await recorder.start({ sessionId: "mtg_web", systemAudio: false });
    expect(desktopState.getUserMediaCalls).toBe(1);
    await recorder.stop();
  });
});

describe("inside the shell, the shell records", () => {
  test("start goes over the bridge and never touches the microphone", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);

    const recorder = await resolveRecorder("web");
    expect(recorder.capability.audio).toBe(true);
    expect(recorder.capability.transcribesAt).toBe("cloud");

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });

    expect(shell.calls).toContain("startCapture");
    expect(shell.lastStart?.sessionId).toBe("mtg_desktop");
    expect(shell.lastStart?.mic).toBe(true);
    // The whole claim: no getUserMedia, no MediaRecorder, no stream on the page.
    expect(desktopState.getUserMediaCalls).toBe(0);
    expect(desktopState.recorderInstances).toBe(0);
  });

  test("segments the shell produces reach the app", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const heard: string[] = [];
    recorder.onSegment((segment) => heard.push(segment.text));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    shell.emitSegment({
      id: "seg-1",
      startMs: 0,
      endMs: 2_000,
      text: "we should ship it",
      speaker: null,
      channel: "mic",
      confidence: null,
    });

    expect(heard).toEqual(["we should ship it"]);
  });

  /**
   * Ending a meeting detaches, and this is why every bridge subscription
   * returns its own unsubscribe: the controller keeps one recorder for many
   * meetings, so a subscription left attached would deliver the next meeting's
   * segments through the previous meeting's listeners as well.
   */
  test("ending detaches from the shell", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const heard: string[] = [];
    recorder.onSegment((segment) => heard.push(segment.text));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    await recorder.stop();
    expect(shell.calls).toContain("stopCapture");
    expect(shell.listenerCount()).toBe(0);

    shell.emitSegment({
      id: "seg-2",
      startMs: 0,
      endMs: 1_000,
      text: "after the end",
      speaker: null,
      channel: "mic",
      confidence: null,
    });
    expect(heard).toEqual([]);
  });

  /**
   * THREE MEETINGS IN ONE RUN, AND EVERY SEGMENT CROSSES THE BRIDGE ONCE.
   *
   * The comment this file's subject sits under — `capture/desktop.ts`,
   * `attach()` — states the hazard in its own words: *"a recorder is created
   * per configuration and `stop()` must genuinely detach, or a second meeting
   * is fed by two subscriptions and every segment is emitted twice."* Until
   * this test the only check on it ran **one** meeting, which is the one
   * length at which a per-meeting leak is invisible.
   *
   * So the shape here is deliberate and is the one that was asked for after a
   * hardware measurement of the same failure at the layer above (#353): three
   * meetings, and a ratio of deliveries to unique ids of exactly one at each.
   * Two meetings would not do it — a fix that halved a leak would pass — and
   * counting deliveries is not enough on its own either, so the subscription
   * count is asserted back at its baseline between meetings. A leak that
   * accumulates is a leak whether or not this run happened to observe a
   * duplicate.
   *
   * What it proves about the shipped code, stated plainly because it matters
   * for the report this came from: **the recorder-to-bridge detachment is
   * correct and always was.** The duplicate deliveries measured on the owner's
   * Mac were the controller-to-recorder leak fixed in #353, on a signed build
   * whose commit predates that merge. This is the guard that was missing, not
   * the fix that was.
   */
  test("THREE MEETINGS IN ONE RUN, AND EACH SEGMENT IS DELIVERED EXACTLY ONCE", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    // One recorder for the whole run, which is what a real app has: it is made
    // per configuration and `retainedRecorder` deliberately keeps it across
    // re-configures, so its subscriptions are what accumulate.
    const recorder = await resolveRecorder("web");
    const delivered: string[] = [];
    recorder.onSegment((segment) => delivered.push(segment.id));

    // Nothing is attached before a meeting, and that is the baseline every
    // meeting has to come back to.
    const idle = shell.listenerCount();
    expect(idle).toBe(0);

    for (const index of [1, 2, 3]) {
      const sessionId = `mtg_run_${index}`;
      await recorder.start({ sessionId, systemAudio: false });
      const attached = shell.listenerCount();

      delivered.length = 0;
      for (const n of [0, 1, 2]) {
        shell.emitSegment({
          id: `${sessionId}-mic-c00000-s${n}`,
          startMs: n * 1_000,
          endMs: (n + 1) * 1_000,
          text: `meeting ${index}, segment ${n}`,
          speaker: null,
          channel: "mic",
          confidence: null,
        });
      }

      // The ratio the hardware measurement reported as equal to the meeting
      // index. One, at every index, is the whole property.
      expect({ meeting: index, deliveries: delivered.length }).toEqual({
        meeting: index,
        deliveries: 3,
      });
      expect(new Set(delivered).size).toBe(3);

      await recorder.stop();
      // The stricter half: a run that leaks one subscription per meeting would
      // pass a delivery count that happened not to duplicate, and would fail
      // this. `attached` is read rather than typed, so adding a subscription to
      // `attach()` does not silently loosen the check.
      expect({ meeting: index, betweenMeetings: shell.listenerCount() }).toEqual({
        meeting: index,
        betweenMeetings: idle,
      });
      expect(attached).toBeGreaterThan(idle);
    }
  });

  /**
   * TWO STARTS THAT OVERLAP ATTACH ONCE, WHICH IS WHAT `attach()` OPENS WITH.
   *
   * `attach()` begins `detach?.()`, and nothing checked it. Three meetings that
   * each end properly do not: `stop()` has already released the subscriptions
   * by the time the next `attach()` runs, so that line is dead on every path
   * this suite drove — deleting it failed nothing.
   *
   * It is not dead on the path it was written for. `start()` returns early only
   * once `state === "recording"`, and the state does not move until the awaited
   * `startCapture` comes back — so two starts that overlap (a double press of
   * Record, a screen that mounts twice while the shell is answering) both reach
   * `attach()`, and the second one's `detach?.()` is the only thing between one
   * subscription and two for the rest of the app's run.
   *
   * Staged with a shell that holds `startCapture` open, because that is the
   * window the race lives in and there is no other way into it.
   */
  test("TWO OVERLAPPING STARTS LEAVE ONE SUBSCRIPTION, NOT TWO", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    /*
      The fake shell with one method slowed down. Rebuilt and re-frozen rather
      than mutated, because `getDesktopBridge` refuses a bridge that is not
      frozen — so a wrapper that forgot to freeze would silently be tested as a
      browser, and the test would pass having exercised nothing.
    */
    const slow = Object.freeze({
      ...shell.bridge,
      startCapture: async (request: StartCaptureRequest) => {
        await held;
        return shell.bridge.startCapture(request);
      },
    });
    (globalThis as Record<string, unknown>).desktop = slow;

    const recorder = await resolveRecorder("web");
    const delivered: string[] = [];
    recorder.onSegment((segment) => delivered.push(segment.id));

    const first = recorder.start({ sessionId: "mtg_race", systemAudio: false });
    const second = recorder.start({ sessionId: "mtg_race", systemAudio: false });
    release();
    await Promise.all([first, second]);

    shell.emitSegment({
      id: "mtg_race-mic-c00000-s0",
      startMs: 0,
      endMs: 1_000,
      text: "said once",
      speaker: null,
      channel: "mic",
      confidence: null,
    });
    expect(delivered).toEqual(["mtg_race-mic-c00000-s0"]);

    await recorder.stop();
    // And the whole of it comes off, so the race costs nothing after the fact
    // either — a leaked pair here would outlive every later meeting.
    expect(shell.listenerCount()).toBe(0);
  });

  /**
   * The other consumer of the same channel, checked rather than assumed.
   *
   * The duplicates were called benign downstream because the meeting
   * projection keys a map on the segment id — but that argument is about one
   * consumer, and the bridge's subscriptions are shared machinery. The level
   * meter subscribes to the same shell, and a recorder that leaked would leak
   * *its* subscription too if the two were ever taken together. They are not:
   * `capture/level.ts` attaches on its own effect and detaches in the effect's
   * cleanup, and it is on `onLevel` rather than `onSegment`. What this checks
   * is the property that makes that safe — a recorder's whole subscription set
   * is released by `stop()`, so nothing it took outlives a meeting.
   */
  test("a recorder releases every subscription it took, not only the segment one", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    // More than one: `attach()` takes the capture-state stream as well, and a
    // detach that released only the segments would leave the notice handler of
    // every past meeting attached to the shell for the life of the app.
    expect(shell.listenerCount()).toBeGreaterThan(1);
    await recorder.stop();
    expect(shell.listenerCount()).toBe(0);
  });

  /**
   * Ending a meeting is not a failure, and must not be reported as one.
   *
   * The shell pushes a final `{ state: "stopped", capturing: false }` on its
   * way out, which is byte-identical to the shell giving up on its own. Read
   * without knowing who asked, every single End produced "The Context app
   * stopped recording" — the kind of noise that teaches somebody to ignore the
   * one time it is true. The stop is not awaited before the event so that the
   * event lands where a real one does: inside the stop, before the recorder has
   * detached.
   */
  test("a normal End reports nothing", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    const stopping = recorder.stop();
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null, notice: null });
    await stopping;

    expect(errors).toEqual([]);
  });

  /** ...and a shell that gives up on its own still says so. */
  test("a shell that stops by itself is reported", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    shell.emitCaptureState({ state: "stopped", capturing: false, fault: null, notice: null });

    expect(errors).toEqual([DESKTOP_MESSAGES.lost]);
    await recorder.stop();
  });

  /**
   * A MEETING THAT STOPS BEING TRANSCRIBED SAYS SO ON THE SCREEN.
   *
   * The sentence exists — `CAPTURE_NOTICES.refused`, "this meeting is not being
   * transcribed" — and the shell has always raised it. It had nowhere to go:
   * `CaptureStateUpdate` was `{state, capturing, fault}` and a notice is not a
   * fault, so the shell said it to its own tray and the console drew a recording
   * that looked perfectly healthy. That is why a defect which killed the
   * transcript of *every* desktop recording stayed invisible for a day — the
   * only place it surfaced was an empty transcript, afterwards.
   *
   * Once, not per push: the shell pushes this on every move of its recorder,
   * which is every segment.
   */
  test("a notice the shell raises mid-meeting reaches the screen, once", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");
    const errors: string[] = [];
    recorder.onError((error) => errors.push(error.message));

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    const refused = "This meeting is not being transcribed — the gateway would not accept the audio.";
    shell.emitCaptureState({ state: "recording", capturing: true, fault: null, notice: refused });
    shell.emitCaptureState({ state: "recording", capturing: true, fault: null, notice: refused });

    expect(errors).toEqual([refused]);
    await recorder.stop();
  });

  /**
   * The rule the lifted state machine holds — for the three recorders that
   * answer to it. The two that hold a real device still hold it by hand, each
   * with its own test of the same name; `packages/meetings/src/recorder.js`
   * says why and names converting them as the next step.
   */
  test("a meeting that ended does not reopen the microphone", async () => {
    const shell = fakeDesktopBridge({ capabilities: { mic: true } });
    installShell(shell);
    const recorder = await resolveRecorder("web");

    await recorder.start({ sessionId: "mtg_desktop", systemAudio: false });
    await recorder.stop();
    await recorder.resume();

    expect(shell.calls).not.toContain("resumeCapture");
    expect(recorder.state).toBe("stopped");
  });

  test("a refused start is reported rather than thrown away", async () => {
    const shell = fakeDesktopBridge({
      capabilities: { mic: true },
      refuseStart: "Microphone access is off for Context in System Settings.",
    });
    installShell(shell);
    const recorder = await resolveRecorder("web");

    await expect(
      recorder.start({ sessionId: "mtg_desktop", systemAudio: false }),
    ).rejects.toThrow(/System Settings/);
  });
});

