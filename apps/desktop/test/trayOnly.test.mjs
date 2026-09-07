/**
 * A WHOLE MEETING, FROM THE MENU BAR, WITH NO WINDOW ANYWHERE.
 *
 * `docs/decisions/desktop.md` rests on this sentence — *"A person can record a
 * whole meeting with the window never having loaded"* — and until step 4 it was
 * a property nobody had to hold on to: the panel existed, so the tray was a
 * convenience over a UI that was always there. Flipping the default makes it
 * load-bearing. On a default launch there is no panel and no notepad, the
 * console window may be closed, offline, or never opened at all, and what is
 * left is a menu bar, a microphone and a queue.
 *
 * So this file walks the whole path with nothing that could be a window in it:
 *
 *   detection → `decideConsent` → a person's yes → `capturePlan` →
 *   `MeetingController` → the outbox
 *
 * Every module in that line is imported directly here, which is the check: if
 * any of them ever needs a `BrowserWindow`, this file stops running rather than
 * quietly starting to depend on one. The second half reads `main/index.ts` as
 * text, because the wiring that *chooses* not to build a window is Electron's
 * and cannot be run in this suite — the same technique, and for the same
 * reason, as the console-window checks in `consoleBridge.test.mjs`.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite.
 *
 *   the panel created in console mode as well                                1
 *   the menu-bar click doing nothing when the console window is gone         2
 *   `explain` assembling a sentence rather than reading the closed set       1
 *
 * The third row is a note about *this file* as much as about the source. Read
 * the first way, the closed-set check filtered call sites by what the argument
 * looked like — and an assembled sentence does not look like a name, so it was
 * excluded rather than caught, and the sabotage went green. It matches the `);`
 * that ends the statement instead, which is a property of a call rather than of
 * the thing being said.
 *
 * The second is the defect this file was written for. The console window is
 * *destroyed* when somebody closes it — `closed` sets `consoleWindow` to `null`
 * — so a tray whose click only raises an existing window is a tray that does
 * nothing for the rest of the run, and a person whose app has no UI and no way
 * to ask for one. It is the same silent press the step's own message box exists
 * to prevent, one level up.
 */

import { readFileSync } from "node:fs";

import {
  IDLE_CONSENT,
  answered,
  asked,
  decideConsent,
  episodeKey,
  forgetEpisode,
} from "../src/core/consent/gate.ts";
import { capturePlan, isNotesOnly } from "../src/core/capture/plan.ts";
import { normalizeSettings } from "../src/core/settings.ts";
import { MeetingController } from "../src/core/recording/controller.ts";
import { fakePermissionBroker } from "../src/core/capture/permissions.ts";
import { fakeRecorder } from "../src/core/capture/recorder.ts";
import { fakeTranscriber } from "../src/core/capture/transcriber.ts";
import { emptyOutbox } from "../src/core/sync/outbox.ts";
import { trayPresentation } from "../src/core/tray/presentation.ts";
import { fakeClock } from "./fakes.mjs";

const SOURCE = { kind: "zoom", app: "zoom.us" };

const detected = {
  active: true,
  positives: 2,
  negatives: 0,
  source: SOURCE,
  since: "2026-09-05T08:25:00.000Z",
};

const cleared = { active: false, positives: 0, negatives: 4, source: null, since: null };

/** The shell's capture half, with no window and nothing that could open one. */
function trayOnlyShell() {
  const clock = fakeClock();
  const recorder = fakeRecorder();
  let outbox = emptyOutbox();
  const controller = new MeetingController({
    recorder,
    transcriber: fakeTranscriber(["we should ship it", "agreed"]),
    permissions: fakePermissionBroker(),
    device: { platform: "macos", name: "a laptop", appVersion: "0.1.0" },
    outbox: () => outbox,
    setOutbox: (next) => {
      outbox = next;
    },
    now: clock.now,
    onChange: () => {},
    onSegment: () => {},
    newId: () => "mtg_abcdefghjkmnpqrstvwx",
  });
  return { controller, recorder, outbox: () => outbox };
}

export async function runTrayOnlyChecks(check) {
  /* --- the whole meeting, with no window ---------------------------------- */

  {
    const shell = trayOnlyShell();
    const settings = normalizeSettings({ version: 1, captureEnabled: true, transcription: "cloud" });
    let consent = IDLE_CONSENT;

    const episode = episodeKey(detected);
    const first = decideConsent({ detector: detected, consent, settings, recording: false });
    check("A DETECTED MEETING ASKS, WITH NO PANEL TO ASK ON", first.kind === "ask");

    // The ask is a state, not a window: the tray carries it, and the answer
    // comes back from the menu bar exactly as it would from a popover.
    consent = asked(episode);
    check(
      "...and the menu bar can say what is happening while it waits",
      typeof trayPresentation({ state: "detected", title: "Design review" }).tooltip === "string",
    );

    consent = answered(episode, "granted");
    const yes = decideConsent({ detector: detected, consent, settings, recording: false });
    check("A YES FROM THE MENU BAR IS THE SAME YES", yes.kind === "start" && yes.episode === episode);

    const plan = capturePlan({ settings, connected: true, systemAudio: true });
    check(
      "...and the plan it starts is the ordinary one, not a degraded no-window one",
      isNotesOnly(plan) === false && plan.channels.includes("mic"),
    );

    const begun = await shell.controller.begin({
      source: SOURCE,
      title: "Design review",
      grantedEpisode: episode,
      channels: plan.channels,
    });
    check("THE MICROPHONE OPENS WITH NO WINDOW IN THE PROCESS", begun.ok === true && shell.recorder.capturing === true);
    check(
      "...and the menu bar shows the indicator, which is the whole always-on rule",
      trayPresentation({ state: "recording", elapsedMs: 1_000 }).indicator === true,
    );

    shell.recorder.step(1_000, "mic");
    await shell.controller.end();

    const kinds = shell.outbox().entries.map((entry) => entry.kind);
    check(
      "A WHOLE MEETING RECORDED FROM THE MENU BAR STILL BECOMES A NOTE",
      kinds.filter((kind) => kind === "finalize").length === 1 &&
        kinds.filter((kind) => kind === "session").length === 1,
    );
    check(
      "...and the transcript went with it, so what is queued is the meeting rather than a stub",
      (shell.outbox().entries.find((entry) => entry.kind === "segments")?.body.segments ?? []).length > 0,
    );

    consent = forgetEpisode(consent, episode);
    const after = decideConsent({ detector: cleared, consent, settings, recording: false });
    check("...and the decision is forgotten with the meeting", after.kind === "hold" && consent.episode === null);
  }

  {
    // The refusals a tray-only launch can hit are still refusals, and they are
    // still the gate's rather than the window's.
    const settings = normalizeSettings({ version: 1, captureEnabled: false });
    const off = decideConsent({ detector: detected, consent: IDLE_CONSENT, settings, recording: false });
    check(
      "CAPTURE SWITCHED OFF IS STILL A HOLD WITH NO PANEL TO SHOW IT",
      off.kind === "hold" && off.why === "capture-disabled",
    );
    const blocked = normalizeSettings({ version: 1, captureEnabled: true, blocklist: ["zoom.us"] });
    const held = decideConsent({ detector: detected, consent: IDLE_CONSENT, settings: blocked, recording: false });
    check("...and a blocked app is still a hold, whatever is on screen", held.kind === "hold");
  }

  /* --- and the shell really does not build the windows -------------------- */

  const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");

  check(
    "IN CONSOLE MODE THE PANEL AND THE NOTEPAD ARE NOT CREATED AT ALL",
    /const panel = RENDERER_UI \? createPanel\(RENDERER_DIR\) : null;/.test(source) &&
      /const notepad = RENDERER_UI \? createNotepad\(RENDERER_DIR\) : null;/.test(source),
  );
  /*
    There is no check here that every *use* of `panel` is guarded, and that is
    deliberate rather than an omission: `panel` is `BrowserWindow | null` and
    `tsc --noEmit` runs on this app, so an unguarded read is a type error before
    it is a runtime one. A regex that re-checked it would be a second, worse
    typechecker — and the sabotage that matters (creating the panel anyway) is
    the one above.
  */

  {
    /*
      A closed console window is the ordinary case, not an edge one: `closed`
      sets `consoleWindow` to `null`, so a menu-bar click that only raises an
      existing window is a click that does nothing for the rest of the run.
    */
    const opener = source.match(/function openConsoleWindow\(\)[\s\S]{0,400}?\n {2}\}/)?.[0] ?? "";
    check(
      "A CLOSED CONSOLE WINDOW IS OPENED AGAIN, so the red button is not a one-way door",
      opener.includes("openConsoleWindowIfAsked()") && opener.includes("showConsoleWindow()"),
    );
    const tray = source.match(/const tray = new AppTray\(\{[\s\S]{0,1600}?\n {4}record:/)?.[0] ?? "";
    check(
      "...and both menu-bar routes to it say why when there is none to open",
      (tray.match(/openConsoleWindow\(\)/g) ?? []).length === 2 &&
        (tray.match(/explain\(CONSOLE_NOTICES\.noConsole\)/g) ?? []).length === 2,
    );
  }

  {
    /*
      Every sentence `explain` puts in a message box comes from a closed set.
      The same rule `CONSOLE_NOTICES` and `PLAN_NOTICES` are frozen for: a
      sentence assembled at the call site is how a channel name or a fragment of
      somebody's payload ends up in a dialog.
    */
    /*
      Calls only, and matched through the `);` that ends a statement: the
      declaration reads `explain(sentence: string): void {` and the comments say
      `explain()`, so neither is a sentence being said to anybody. Written the
      other way round — filtering on what the argument *looks* like — the check
      passes an assembled string by excluding it, which is the shape of a guard
      that measures zero.
    */
    const explained = source.match(/(?<!function )explain\([^)]*\);/g) ?? [];
    check(
      "EVERY SENTENCE THE TRAY EXPLAINS COMES FROM THE CLOSED SET, none is assembled",
      explained.length >= 5 &&
        explained.every((call) => /^explain\((CONSOLE_NOTICES|PLAN_NOTICES)\.[a-zA-Z]+\);$/.test(call)),
    );
    check(
      "...and a launch with a panel still shows the panel instead of a dialog",
      /function explain\(sentence: string\): void \{\s*if \(panel !== null\) \{\s*showPanel\(\);/.test(source),
    );
  }
}
