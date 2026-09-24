/**
 * THE BRIDGE, BOTH ENDS OF IT, WITH NO ELECTRON ANYWHERE.
 *
 * `window.desktop` is the only route from a page this app did not write to this
 * app's microphone, its queue and its grant. `docs/decisions/desktop.md` asks
 * for three independent guards around that, and two of them are in this file:
 * the preload's `shouldExposeBridge` (checked in `shell.test.mjs`, driven here
 * through the real installer) and **the main process re-checking the sender on
 * every channel**, which exists precisely because the first one runs inside the
 * renderer and a compromised renderer is the threat model.
 *
 * Both halves are written as pure modules over injected hosts — a
 * `contextBridge`/`ipcRenderer` pair on one side, an `ipcMain` on the other —
 * so the whole surface is exercised here rather than by launching an app and
 * pointing it at a hostile server. That is the same choice `shell.test.mjs`
 * made and it is the reason either guard is checked at all.
 *
 * ## What is checked, and why each one is not obvious
 *
 *  - **The real bridge passes the package's validator.** `getDesktopBridge()`
 *    refuses a surface that is incomplete, unfrozen, or carrying a
 *    credential-shaped member, and until this file the shell had never been run
 *    against it — the preload answered three members and was refused, which was
 *    correct and meant nothing downstream was proven.
 *  - **Every subscription detaches.** A handler that cannot be removed is a
 *    leak per navigation in a React tree and a second copy of every segment on
 *    the next meeting. The count is asserted, not the intention.
 *  - **Nothing credential-shaped crosses, on any channel.** Both directions are
 *    walked recursively — every answer the main process returns and every
 *    payload the page is handed — because "there is no `getToken`" is a
 *    property of the *payloads* as well as of the method names.
 *  - **The page cannot pass a field through.** The preload rebuilds every
 *    payload from the keys the contract declares, so a main process that grew a
 *    field does not silently start shipping it to a remote origin.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are FAIL lines across the
 * whole `apps/desktop` suite.
 *
 *   the sender check dropped from `handle` (any webContents answered)         9
 *   the sender check keeping identity but dropping the origin comparison      4
 *   ...keeping the origin comparison but dropping the webContents identity    4
 *   the sender check dropping the top-frame test                              2
 *   `unsubscribe` returning a no-op instead of removing the listener          3
 *   the preload passing the main process's object through unnormalised        2
 *   `installDesktopBridge` exposing regardless of `shouldExposeBridge`        4
 *   the exposed object not frozen                                             3
 *   `systemAudioCapability` ignoring the probe's `false`                      1
 *   ...ignoring `packaged`, so a dev build claims a loopback tap              1
 *   ...ignoring `signed`, so an unsigned packaged build claims one            1
 *   the guard reading Electron's live getters unprotected again               1
 *   a synchronous channel letting its own answer throw                       1
 *   the bridge taking a hidden-capture-window channel name back              1
 *   the closed console window leaving its handlers registered                1
 *   `meetingWriteFrom` trusting the payload rather than reading it           1
 *   the capture-state normaliser dropping `notice`                            2
 *   the summary normaliser dropping `frames`                                  1
 *   ...accepting a `kind` outside the protocol's four routes                  1
 *   the preload defaulting an unknown `kind` to `session`                     2
 *   an empty `context` read as this machine's own, in the main process        1
 *   ...and in the preload                                                     1
 *   the bridge capturing the pin once instead of reading it per call         3
 *   the sender check reading `app://console` as an opaque origin             1
 *   the sender check accepting an opaque origin while the mirror is pinned  1
 *   `emitLevel` sending nothing, with the member itself left in place       4
 *   `emitLevel` removed from the bridge altogether                          4
 *   nothing in `main/index.ts` calling `emitLevel`                          1
 *   `unit` not clamping, so a level past full scale reaches the page        1
 *
 * The two `emitLevel` rows are the reason the producer census exists, and the
 * first is the sharper of the pair: a member that is *present*, typed, exported
 * and reached by nothing is exactly the state `onLevel` was in for the whole
 * life of this app, and no check that existed could see it. The third row is
 * the same question one process out — an implemented producer the shell never
 * calls — which is a separate arm and reddens alone.
 *
 * Four of these were measured before `#281` added three mirror checks and are
 * re-measured here on the head that carries them: the whole-guard row was 6,
 * the origin row 2 and the top-frame row 1. **A number in a table is a claim
 * about a tree, and somebody else's merge is enough to falsify it.**
 *
 * The identity row is 4 rather than 3 since the hidden capture window was
 * added as an attacker in its own right: it is the second window in this
 * process, it holds a live microphone, and "one of ours" is not a reason to
 * answer it.
 *
 * The last three rows are one rule with two boundaries: `kind` is a route and
 * `context` is a bucket, and a value either boundary *repairs* is a value the
 * guard that owns the queue never gets to refuse. A default of `session` posts
 * a body to a collection nobody named; reading `""` as "no context" files a
 * meeting in whatever context the credential defaults to.
 *
 * Rows two and three are the pair that had to be measured rather than assumed:
 * the identity check and the origin check are two different refusals of two
 * different attacks — a *different window* in this app, and *this window* on a
 * page it was navigated to — and a single check standing in for both is the
 * shape that looks complete and is not. Neither is zero, so neither is
 * decoration, and neither subsumes the other.
 *
 * The three `app://console` rows are about the offline mirror moving the pin. A bridge that
 * read `deps.pinned()` once would keep trusting the live origin after the shell
 * had fallen back to `app://console` — and answer the page it is itself serving
 * with nothing. The second row is subtler and cost an afternoon: **Node's `URL`
 * answers `"null"` for `app://console/...`**, because nothing told it the scheme
 * is standard, while Chromium — which `registerSchemesAsPrivileged` did tell —
 * reports `location.origin` as `app://console`. Written as `new URL(...).origin`
 * the sender check reads the mirrored console as an opaque origin and refuses
 * it; `originOfUrl` is the one place that difference is reconciled. The third
 * is the other side of that reconciliation: `app://console` is a real origin
 * here, `"null"` is not one, and a `data:` or `about:blank` document reporting
 * the second must not be answered while the first is what is pinned.
 *
 * The unfrozen row reports three rather than one because `getDesktopBridge`
 * refuses an unfrozen bridge outright: the validator check goes red and so do
 * the two that read the object through it. That is the right shape — the
 * package's refusal is doing the work — and it is written down so nobody reads
 * one number as three independent guards.
 *
 * ## This file, split
 *
 * The suite grew past the size ceiling and was split by behaviour into this
 * folder. `ipcCensus.test.mjs` covers the `ipcMain` census and the version-7
 * local-agent channels. This module covers the preload's contract exposure,
 * every channel's request/response shape, refusals, subscription teardown,
 * capture-state notices and the preload's payload rebuilding.
 * `senderGuard.test.mjs` covers the machine approval hand-off and the main
 * process's sender re-check (the id-as-route guard, the hidden capture
 * window, disposed frames, and the offline-mirror pin). `producerCensus.test.mjs`
 * covers the producer-side census, the end-to-end level meter, disposal and
 * the channel-name collision checks. `fixtures.mjs` holds the fakes and
 * constants all four share.
 */

import { getDesktopBridge, inspectDesktopBridge, BRIDGE_CHANNELS } from "@context/desktop-bridge";
import { installed, contamination, CONNECTED, QUEUE } from "./fixtures.mjs";

export async function runPreloadContractChecks(check) {
  /* --- the preload exposes the contract, or nothing at all --------------- */

  {
    const shell = installed();
    check("the pinned origin in the top frame gets a bridge", shell.exposed === true);
    check("...on `window.desktop`, and nowhere else", Object.keys(shell.world).join() === "desktop");
    check("...frozen, as `getDesktopBridge` requires", Object.isFrozen(shell.bridge));
    check(
      "THE REAL BRIDGE PASSES THE PACKAGE'S VALIDATOR",
      getDesktopBridge({ desktop: shell.bridge }) === shell.bridge,
    );
    check(
      "...with no refusal recorded against it",
      inspectDesktopBridge({ desktop: shell.bridge }).refusal === null,
    );
    check("its sub-objects are frozen too", Object.isFrozen(shell.bridge.connection) && Object.isFrozen(shell.bridge.outbox));
  }

  check(
    "A FOREIGN ORIGIN GETS NOTHING EXPOSED AT ALL",
    installed({ origin: "https://attacker.invalid" }).exposed === false,
  );
  check(
    "a subframe on the pinned origin gets nothing exposed",
    installed({ isTopFrame: false }).exposed === false,
  );
  check(
    "a pin the main process would not answer exposes nothing",
    installed({ pinned: "" }).exposed === false,
  );
  check(
    "nothing is put on the world when the bridge is refused",
    Object.keys(installed({ origin: "https://attacker.invalid" }).world).length === 0,
  );

  /* --- the shell descriptor --------------------------------------------- */

  {
    const shell = installed();
    check("the shell is named from the main process, synchronously", shell.bridge.shell?.app === "Context");
    check("...and reports the platform the contract knows", shell.bridge.shell?.platform === "macos");
  }
  check(
    "a shell descriptor the main process would not give reads as `null`",
    installed({ shell: null }).bridge.shell === null,
  );
  check(
    "a platform this contract does not know is refused rather than passed through",
    installed({ shell: { app: "Context", version: "1", platform: "haiku" } }).bridge.shell === null,
  );

  /* --- every channel's request and response ------------------------------ */

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.capabilities]: { ok: true, value: { mic: true, systemAudio: "yes" } },
        [BRIDGE_CHANNELS.startCapture]: (request) => ({
          ok: true,
          value: {
            sessionId: request.sessionId,
            mic: true,
            systemAudio: false,
            startedAtMs: 5,
            transcribesAt: "cloud",
            notice: "only your microphone",
          },
        }),
        [BRIDGE_CHANNELS.stopCapture]: {
          ok: true,
          value: { sessionId: "m_1", endedAtMs: 9, durationMs: 4, segments: 2, frames: 7, pending: 1 },
        },
        [BRIDGE_CHANNELS.connectionGet]: { ok: true, value: { ...CONNECTED } },
        [BRIDGE_CHANNELS.outboxStatus]: { ok: true, value: { ...QUEUE } },
        [BRIDGE_CHANNELS.pauseCapture]: { ok: true, value: null },
        [BRIDGE_CHANNELS.resumeCapture]: { ok: true, value: null },
        [BRIDGE_CHANNELS.connectionConnect]: { ok: true, value: null },
        [BRIDGE_CHANNELS.connectionDisconnect]: { ok: true, value: null },
        [BRIDGE_CHANNELS.outboxDrain]: { ok: true, value: null },
      },
    });

    const capabilities = await shell.bridge.capabilities();
    check(
      "`capabilities()` asks the channel the package names",
      shell.invoked.some((call) => call.channel === BRIDGE_CHANNELS.capabilities),
    );
    check("...and only `true` is true, however the shell answered", capabilities.systemAudio === false && capabilities.mic === true);
    check("...with every capability the contract declares present", Object.keys(capabilities).length === 6);

    const started = await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: true });
    const startCall = shell.invoked.find((call) => call.channel === BRIDGE_CHANNELS.startCapture);
    check("`startCapture` sends the request the page made", startCall?.args[0]?.sessionId === "mtg_abcdefghjkmnpqrstvwx");
    check("...as three declared fields and nothing else", Object.keys(startCall.args[0]).length === 3);
    check("...and answers with what was actually opened", started.mic === true && started.systemAudio === false);
    check("...carrying the shell's own sentence about what it is not doing", started.notice === "only your microphone");

    await shell.bridge.pauseCapture();
    await shell.bridge.resumeCapture();
    const summary = await shell.bridge.stopCapture();
    check("`stopCapture` answers a summary with counts and no audio in it", summary.segments === 2 && summary.durationMs === 4);
    /*
      FRAMES AND SEGMENTS ARE TWO NUMBERS, AND THE PAIR IS THE DIAGNOSIS.

      `frames: 0` is a microphone that produced nothing; `frames: 7,
      segments: 0` is audio the far end would not take. Different faults,
      different fixes, and indistinguishable from this payload until the field
      existed — which is why finding the SEGMENT_MS/DRAIN_INTERVAL_MS race
      needed `fetch` patched by hand in the main process.
    */
    check("...including how much audio was produced, separately from how much came back", summary.frames === 7);
    check(
      "pause and resume reach their own channels",
      shell.invoked.some((c) => c.channel === BRIDGE_CHANNELS.pauseCapture) &&
        shell.invoked.some((c) => c.channel === BRIDGE_CHANNELS.resumeCapture),
    );

    const view = await shell.bridge.connection.get();
    check("`connection.get()` answers state, a base URL and two booleans", view.state === "connected" && view.gateway === "https://gateway.invalid");
    check("...and exactly the five fields the contract declares", Object.keys(view).length === 5);

    const status = await shell.bridge.outbox.status();
    check("`outbox.status()` answers counts", status.pending === 2 && status.parked === 0);

    shell.bridge.connection.connect();
    shell.bridge.connection.disconnect();
    shell.bridge.outbox.drain();
    await Promise.resolve();
    for (const channel of [
      BRIDGE_CHANNELS.connectionConnect,
      BRIDGE_CHANNELS.connectionDisconnect,
      BRIDGE_CHANNELS.outboxDrain,
    ]) {
      check(
        `the fire-and-forget verb reaches ${channel}`,
        shell.invoked.some((call) => call.channel === channel),
      );
    }
  }

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.meetingsWrite]: (write) => ({
          ok: true,
          value: {
            sessionId: write.sessionId,
            queued: false,
            notePath: "5-meetings/standup.md",
            rejected: null,
            accessToken: "sk-live-should-never-arrive",
          },
        }),
      },
    });
    const ack = await shell.bridge.meetings.write({
      sessionId: "mtg_1",
      kind: "finalize",
      context: "acme",
      body: { folder: "5-meetings" },
      cookie: "should not be forwarded",
    });
    const call = shell.invoked.find((one) => one.channel === BRIDGE_CHANNELS.meetingsWrite);
    check("`meetings.write` sends the four declared fields and nothing else", Object.keys(call.args[0]).sort().join() === "body,context,kind,sessionId");
    check("...carrying the protocol's own body untouched", call.args[0].body.folder === "5-meetings");
    check("...and the note path comes back", ack.notePath === "5-meetings/standup.md");
    check("A FIELD THE MAIN PROCESS ADDED IS NOT HANDED TO THE PAGE", contamination(ack).length === 0);
  }
  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.meetingsWrite]: {
          ok: true,
          value: {
            sessionId: "mtg_1",
            queued: false,
            notePath: null,
            rejected: { code: "meeting_forbidden", message: "your context would not take it" },
          },
        },
      },
    });
    const ack = await shell.bridge.meetings.write({ sessionId: "mtg_1", kind: "finalize", context: null, body: {} });
    check(
      "a parked meeting comes back as a refusal a person can read",
      ack.rejected?.code === "meeting_forbidden" && ack.queued === false,
    );
  }
  {
    const shell = installed();
    check(
      "the version-2 member is on the surface the shell exposes",
      typeof shell.bridge.meetings?.write === "function" && Object.isFrozen(shell.bridge.meetings),
    );
  }

  /* --- a refusal is a sentence, never Electron's own wrapper -------------- */

  {
    const shell = installed({
      replies: {
        [BRIDGE_CHANNELS.startCapture]: { ok: false, message: "This machine is not connected to a context yet." },
      },
    });
    let message = "";
    try {
      await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
    } catch (error) {
      message = error.message;
    }
    check("A REFUSED CAPTURE THROWS THE SHELL'S OWN SENTENCE", message === "This machine is not connected to a context yet.");
  }

  {
    const shell = installed({ rejectInvoke: true });
    let message = "";
    try {
      await shell.bridge.startCapture({ sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
    } catch (error) {
      message = error.message;
    }
    check("a channel nobody answers becomes a sentence, not `Error invoking remote method`", !message.includes("remote method") && message.length > 0);
    check("...and `capabilities()` answers everything false rather than rejecting", (await shell.bridge.capabilities()).mic === false);
  }

  /* --- every subscription detaches --------------------------------------- */

  {
    const shell = installed();
    const seen = [];
    const offs = [
      shell.bridge.onSegment((segment) => seen.push(segment)),
      shell.bridge.onLevel(() => seen.push("level")),
      shell.bridge.onCaptureState(() => seen.push("state")),
      shell.bridge.onDetection(() => seen.push("detection")),
      shell.bridge.onTrayCommand(() => seen.push("tray")),
      shell.bridge.connection.onChange(() => seen.push("connection")),
      shell.bridge.outbox.onChange(() => seen.push("outbox")),
    ];
    check("seven subscriptions attach seven listeners", shell.listenerCount() === 7);
    check("every one of them hands back a function", offs.every((off) => typeof off === "function"));

    shell.emit(BRIDGE_CHANNELS.segment, {
      id: "seg-1",
      startMs: 0,
      endMs: 10,
      text: "hello",
      speaker: null,
      channel: "mic",
      confidence: null,
    });
    check("a pushed segment reaches the handler", seen[0]?.text === "hello");

    for (const off of offs) off();
  }

  /* --- and the sentence a meeting acquires reaches the page ---------------- */
  //
  // `CaptureStateUpdate` was `{state, capturing, fault}`, and a notice is not a
  // fault — so `CAPTURE_NOTICES.refused`, "this meeting is not being
  // transcribed", had no member to travel on. The shell said it to its own tray
  // while the console drew a perfectly healthy recording, which is why a defect
  // that killed the transcript of every desktop recording survived a day of
  // use. The field is read through the real normaliser here, not a fake.
  {
    const shell = installed();
    const seen = [];
    const off = shell.bridge.onCaptureState((update) => seen.push(update));

    shell.emit(BRIDGE_CHANNELS.captureState, {
      state: "recording",
      capturing: true,
      fault: null,
      notice: "This meeting is not being transcribed.",
    });
    check(
      "A NOTICE THE SHELL RAISES MID-MEETING REACHES THE PAGE",
      seen[0]?.notice === "This meeting is not being transcribed.",
    );
    check("...without being mistaken for a fault, which would end the recording", seen[0]?.fault === null);

    /*
      And every notice, not only the refusal. The transcriber raises three —
      `dropped`, `failed` and `refused` — and `capturePlan` raises its own about
      system audio. All four are one field on the shell's `SessionView`, so all
      four cross; a field that carried only the worst one would be a second
      decision about which sentences matter, made in the wrong process.
    */
    for (const sentence of ["a few seconds were not transcribed", "only your microphone", ""]) {
      shell.emit(BRIDGE_CHANNELS.captureState, { state: "recording", capturing: true, fault: null, notice: sentence });
    }
    check(
      "...and it is the shell's sentence verbatim, whichever of them it is",
      seen[1]?.notice === "a few seconds were not transcribed" && seen[2]?.notice === "only your microphone",
    );
    check("...with nothing to say reading as nothing to say", seen[3]?.notice === null);

    /*
      A shell older than the field says nothing rather than breaking the page.
      `MIN_BRIDGE_VERSION` is still 1, so this is a build in the estate today.
    */
    shell.emit(BRIDGE_CHANNELS.captureState, { state: "recording", capturing: true, fault: null });
    check("a shell built before the field simply has no notice", seen[4]?.notice === null);

    off();
    check("UNSUBSCRIBING REMOVES THE IPC LISTENER — the count returns to zero", shell.listenerCount() === 0);

    const before = seen.length;
    shell.emit(BRIDGE_CHANNELS.segment, { id: "seg-2", startMs: 0, endMs: 1, text: "after", speaker: null, channel: "mic", confidence: null });
    check("...and nothing arrives after it", seen.length === before);
  }

  {
    const shell = installed();
    const off = shell.bridge.onSegment(() => {});
    off();
    off();
    check("unsubscribing twice is harmless", shell.listenerCount() === 0);
  }

  /* --- the preload rebuilds every payload -------------------------------- */

  {
    const shell = installed();
    const seen = [];
    shell.bridge.onSegment((segment) => seen.push(segment));
    shell.emit(BRIDGE_CHANNELS.segment, {
      id: "seg-1",
      startMs: 0,
      endMs: 10,
      text: "hello",
      speaker: null,
      channel: "mic",
      confidence: null,
      accessToken: "sk-live-should-never-arrive",
    });
    check(
      "A FIELD THE CONTRACT DOES NOT DECLARE NEVER REACHES THE PAGE",
      seen.length === 1 && contamination(seen[0]).length === 0,
    );
    check("...and the declared fields all arrived", seen[0].id === "seg-1" && seen[0].channel === "mic");

    const badChannel = [];
    shell.bridge.onSegment((segment) => badChannel.push(segment));
    shell.emit(BRIDGE_CHANNELS.segment, { id: "x", startMs: 0, endMs: 1, text: "t", speaker: null, channel: "elsewhere", confidence: null });
    check("a channel the contract does not know is normalised rather than passed on", badChannel[0]?.channel === "mixed");

    const trays = [];
    shell.bridge.onTrayCommand((command) => trays.push(command));
    shell.emit(BRIDGE_CHANNELS.trayCommand, "record");
    shell.emit(BRIDGE_CHANNELS.trayCommand, "launch-a-shell");
    check("a tray command outside the contract's list is dropped", trays.length === 1 && trays[0] === "record");
  }
}
