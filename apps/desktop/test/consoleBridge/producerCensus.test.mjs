/**
 * Every channel the contract declares has a producer, the level meter crosses
 * the whole bridge end to end, disposal, and the channel-name collision
 * checks against the old renderer and the hidden capture window. Split out
 * of `consoleBridge.test.mjs`; see that file's header for the full
 * rationale and the sabotage record, and `fixtures.mjs` for the shared
 * fakes.
 */

import { readFileSync } from "node:fs";
import { BRIDGE_CHANNELS, BRIDGE_CHANNEL_NAMES } from "@context/desktop-bridge";
import { darwinMajorFrom, systemAudioCapability } from "../../src/core/shell/capabilities.ts";
import { CHANNELS, COMMANDS } from "../../src/main/ipc.ts";
import { installed, mainBridge, fakeWindow, contamination, HANDLED, CONNECTED, QUEUE } from "./fixtures.mjs";

export async function runProducerCensusChecks(check) {
  /* --- EVERY CHANNEL THE CONTRACT DECLARES HAS A PRODUCER ----------------- */
  //
  // THE CHECK THAT WOULD HAVE CAUGHT THE LEVEL METER YEARS EARLIER.
  //
  // `onLevel` was on the contract, wired through the preload's normaliser,
  // subscribed by the console and implemented in the package's fake — and
  // **nothing in the main process had ever sent it.** Every check that existed
  // looked at the channels it was already on, so a channel with a consumer and
  // no producer was invisible to all of them. What the owner saw was a control
  // that looks identical whether the microphone is live, denied, or nothing is
  // running at all, on every build ever shipped.
  //
  // So the census here is not of guards but of *ends*: every name in
  // `BRIDGE_CHANNELS` is either answered by a handler this file registered or
  // actually sent by exercising every producer the bridge object exposes.
  // Nothing is enumerated by hand except the arguments, and a producer this
  // check does not know how to drive reddens on its own line rather than
  // quietly not being driven — which is the shape of hole every earlier census
  // in this file has had.
  {
    const { bridge, ipc, window } = mainBridge();
    const PRODUCER_ARGS = {
      push: [
        {
          captureState: { state: "recording", capturing: true, fault: null, notice: null },
          connection: { ...CONNECTED },
          outbox: { ...QUEUE },
          detection: null,
        },
      ],
      emitSegment: [
        { id: "s", startMs: 0, endMs: 1, text: "hi", speaker: null, channel: "mic", confidence: null },
      ],
      emitLevel: [{ mic: 0.5, systemAudio: 0.25 }],
      emitPendingApproval: [null],
      emitTrayCommand: ["record"],
      emitImessage: [{ enabled: true, permission: "granted", lastSyncedAt: 1, lastError: null }],
    };
    // `dispose` unregisters rather than produces, and is checked below.
    const producers = Object.keys(bridge).filter((name) => name !== "dispose");
    const undriveable = producers.filter((name) => PRODUCER_ARGS[name] === undefined);
    for (const name of producers) {
      try {
        bridge[name](...(PRODUCER_ARGS[name] ?? []));
      } catch {
        // A producer that threw sent nothing, which the orphan list below is
        // what reports. Swallowed so one broken member cannot take the census
        // down with it and turn a clean red into a crash.
      }
    }
    const answered = new Set([...ipc.handlers.keys(), ...ipc.listeners.keys()]);
    const sent = new Set(window.sent.map((entry) => entry.channel));
    const orphans = BRIDGE_CHANNEL_NAMES.filter(
      (name) => !answered.has(name) && !sent.has(name),
    );
    check(
      `EVERY CHANNEL IN BRIDGE_CHANNELS HAS A PRODUCER IN consoleBridge.ts${
        orphans.length ? ` — ${orphans.join(", ")} is declared and nobody sends it` : ""
      }`,
      orphans.length === 0,
    );
    check(
      `...and every producer on the bridge is one this census drives${
        undriveable.length ? ` — ${undriveable.join(", ")}` : ""
      }`,
      undriveable.length === 0,
    );

    /*
      AND THE SAME QUESTION ONE PROCESS OUT, which is where the defect actually
      lived: `emitSegment` existing is not the same fact as the shell calling
      it. A bridge whose members are all implemented and none of them reached
      is the identical failure — a channel the page subscribes to that is never
      going to carry anything — and the only thing that can answer it is the
      file that owns the shell's wiring. Read as text because it imports
      Electron at the top level and this suite cannot load it.
    */
    const wiring = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    const uncalled = [...producers, "dispose"].filter(
      (name) => !new RegExp(`consoleBridge\\??\\.${name}\\(`).test(wiring),
    );
    check(
      `...AND THE SHELL ACTUALLY CALLS EACH ONE${
        uncalled.length ? ` — nothing in main/index.ts reaches ${uncalled.join(", ")}` : ""
      }`,
      uncalled.length === 0,
    );
  }

  /* --- and a level crosses the whole bridge, end to end ------------------- */
  //
  // Both halves joined: the main process's `emitLevel`, its window's `send`,
  // the preload's `ipcRenderer` listener and `levelFrom`'s normaliser, with
  // nothing faked in between. This is the check that fails if the producer
  // built here is wired to a channel the page is not listening on — which is
  // exactly the state the app was in, in the other direction, for its whole
  // life.
  {
    const page = installed();
    const relay = {
      isDestroyed: () => false,
      webContents: { id: 7, send: (channel, payload) => page.emit(channel, payload) },
    };
    const { bridge } = mainBridge({ window: relay });
    const seen = [];
    const off = page.bridge.onLevel((level) => seen.push(level));

    bridge.emitLevel({ mic: 0.42, systemAudio: 0.17 });
    check(
      "A LEVEL THE RECORDER PRODUCES REACHES THE PAGE — the whole point, and it never did",
      seen.length === 1 && seen[0].mic === 0.42 && seen[0].systemAudio === 0.17,
    );

    bridge.emitLevel({ mic: 9, systemAudio: -3 });
    check(
      "...as a fraction of full scale, whatever the recorder handed over",
      seen[1]?.mic === 1 && seen[1]?.systemAudio === 0,
    );

    bridge.emitLevel({ mic: Number.NaN, systemAudio: "loud", accessToken: "sk-never" });
    check(
      "...with a reading that is not a number read as silence, not as a bar of unknown height",
      seen[2]?.mic === 0 && seen[2]?.systemAudio === 0,
    );
    check(
      "...and nothing the contract does not declare travelling with it",
      seen.flatMap((level) => contamination(level)).length === 0 &&
        seen.every((level) => Object.keys(level).join() === "mic,systemAudio"),
    );

    off();
    const quiet = seen.length;
    bridge.emitLevel({ mic: 1, systemAudio: 1 });
    check("...and unsubscribing really detaches the meter", seen.length === quiet);
  }

  {
    const window = fakeWindow();
    window.destroyed = true;
    const { bridge } = mainBridge({ window });
    bridge.push({ captureState: { state: "idle", capturing: false, fault: null }, connection: { ...CONNECTED }, outbox: { ...QUEUE }, detection: null });
    check("a destroyed window is not sent to", window.sent.length === 0);
  }

  {
    const { bridge, ipc } = mainBridge();
    bridge.dispose();
    check("disposing removes every handler", ipc.handlers.size === 0 && ipc.listeners.size === 0);
  }

  /*
    And the window closing is what calls it.

    `dispose()` being right is checked above; that it is *reached* is a line in
    `main/index.ts`, which imports Electron and cannot be run here. Left
    unchecked it is the leak the contract's own unsubscribe rule exists to
    prevent, one process over: ten handlers left registered against a window
    that is gone refuse everything and look answered, and `ipcMain.handle`
    throws outright if the channel is registered a second time.
  */
  {
    const source = readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
    const closed = source.match(/consoleWindow\.on\("closed",[\s\S]{0,800}?\n {4}\}\);/)?.[0] ?? "";
    check(
      "THE CONSOLE WINDOW CLOSING UNREGISTERS THE BRIDGE — no channel outlives the window it answers",
      closed.includes("consoleBridge?.dispose()") && closed.includes("consoleBridge = null"),
    );
  }

  /* --- the channel names do not collide with the old renderer's ---------- */

  {
    const old = new Set([...Object.values(COMMANDS), ...Object.values(CHANNELS)]);
    check(
      "no bridge channel shares a name with a channel the panel and notepad use",
      BRIDGE_CHANNEL_NAMES.every((name) => !old.has(name)),
    );
  }

  /*
    THE BRIDGE AND THE HIDDEN CAPTURE WINDOW SHARE NO CHANNEL NAME AT ALL.

    They used to share four — `context:capture-{start,pause,resume,stop}` — and
    that was safe for a reason neither file said out loud: `handle`
    (renderer→main, reached by `invoke`) and `send` (main→renderer) are separate
    registries, so a name in both is answered by whichever direction asked. It
    is a true reason and a bad one to rely on, because the guard is a fact about
    Electron's dispatch rather than anything either author can see. The day
    somebody answers one of those names with `ipcMain.on` in the capture file,
    the console's Pause is answered by a window holding a live microphone.

    So `BRIDGE_CHANNELS` carries the `console-` prefix on its four capture verbs
    and the names are disjoint by construction. The check reads both capture
    sources — the main process's and the capture window's preload — for every
    `context:` string in them and asserts no bridge channel is among them, which
    is a check that keeps working whatever either side is renamed to.
  */
  {
    const captureSources = [
      readFileSync(new URL("../../src/main/capture.ts", import.meta.url), "utf8"),
      readFileSync(new URL("../../src/preload/capture.ts", import.meta.url), "utf8"),
    ].join("\n");
    const captureChannels = new Set(captureSources.match(/context:[a-z-]+/g) ?? []);
    const shared = BRIDGE_CHANNEL_NAMES.filter((name) => captureChannels.has(name));
    check(
      "THE HIDDEN CAPTURE WINDOW SHARES NO CHANNEL NAME WITH THE BRIDGE — no dispatch rule is load-bearing",
      captureChannels.size >= 4 && shared.length === 0,
    );
    check(
      "...and the capture window's own channels stay send-only, which is a second reason rather than the only one",
      !/ipcMain\.handle\s*\(/.test(captureSources) &&
        !/ipcMain\.(on|once)\s*\(\s*(CAPTURE_(START|STOP|PAUSE|RESUME)\b|["'`]context:(console-)?capture-(start|stop|pause|resume))/.test(
          captureSources,
        ),
    );
    check(
      "...and the bridge answers its four with `handle`",
      HANDLED.every((name) => mainBridge().ipc.handlers.has(name)),
    );
  }

  /* --- what this build can actually do ----------------------------------- */

  check(
    "system audio is refused outright on anything but macOS",
    systemAudioCapability({ platform: "win32", packaged: true, signed: true, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "AN UNPACKAGED BUILD CLAIMS NO LOOPBACK TAP — macOS will not give one to a build it has not verified",
    systemAudioCapability({ platform: "darwin", packaged: false, signed: true, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "macOS older than 13 claims none either",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 21, probed: null }) === false,
  );
  check(
    "a packaged, signed build on macOS 13 or later claims one until something asks",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 22, probed: null }) === true,
  );
  check(
    "A PACKAGED BUT UNSIGNED BUILD CLAIMS NONE — a dmg built on a laptop is packaged and gets no tap",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: false, darwinMajor: 24, probed: null }) === false,
  );
  check(
    "THE PROBE OVERRULES THE GUESS — a build that was refused a tap reports none",
    systemAudioCapability({ platform: "darwin", packaged: true, signed: true, darwinMajor: 24, probed: false }) === false,
  );
  check(
    "...and a build that was given one reports it, packaged or not",
    systemAudioCapability({ platform: "darwin", packaged: false, signed: false, darwinMajor: 24, probed: true }) === true,
  );
  check("the Darwin major is read off `os.release()`", darwinMajorFrom("23.6.0") === 23);
  check("...and a release string this build cannot read is `0`, which is below every floor", darwinMajorFrom("") === 0);
}
