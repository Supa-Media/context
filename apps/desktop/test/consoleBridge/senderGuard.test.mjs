/**
 * The machine approval hand-off, and the main process re-checking the sender
 * on every channel — the second of the two independent guards
 * `preloadContract.test.mjs`'s header describes. Split out of
 * `consoleBridge.test.mjs`; see that file's header for the full rationale
 * and the sabotage record, and `fixtures.mjs` for the shared fakes.
 */

import { BRIDGE_CHANNELS, BRIDGE_CHANNEL_NAMES } from "@context/desktop-bridge";
import { isBridgeSender } from "../../src/main/consoleBridge.ts";
import { MIRROR_ORIGIN } from "../../src/core/shell/mirror.ts";
import {
  PINNED,
  installed,
  mainBridge,
  sender,
  captureWindowSender,
  disposedSender,
  contamination,
  HANDLED,
  WRITE,
  CONNECTED,
  QUEUE,
} from "./fixtures.mjs";

export async function runSenderGuardChecks(check) {
  /* --- the machine approval the page answers ------------------------------ */
  //
  // Version 3. The shell hands the page a parked authorization request and the
  // page answers it with the session it already holds — `core/shell/autoGrant.ts`
  // is the argument. What this file owns is the boundary: what the page is
  // handed is one field, and what it hands back is read against the contract
  // before it reaches the process that owns the credential.

  {
    const { ipc } = mainBridge({ pending: { requestId: "req_this_mac" } });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.connectionPendingApproval)(
      sender(),
      null,
    );
    check(
      "the page is handed the parked request, and one field of it",
      answer.ok === true && Object.keys(answer.value).join() === "requestId",
    );
    check("...and its value is the id the shell is waiting on", answer.value.requestId === "req_this_mac");
  }

  {
    const { ipc } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.connectionPendingApproval)(
      sender(),
      null,
    );
    check(
      "a shell with nothing in flight hands over nothing",
      answer.ok === true && answer.value === null,
    );
  }

  {
    const { ipc, answered } = mainBridge({ pending: { requestId: "req_this_mac" } });
    await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), {
      requestId: "req_this_mac",
      approved: true,
      // A third field, which must not reach the main process.
      code: "an-authorization-code",
    });
    check(
      "AN ANSWER REACHES THE SHELL AS TWO FIELDS AND NEVER THREE",
      answered.length === 1 &&
        Object.keys(answered[0]).sort().join() === "approved,requestId",
    );
    check("...carrying what the page said", answered[0].requestId === "req_this_mac" && answered[0].approved === true);
  }

  {
    const { ipc, answered } = mainBridge({ pending: { requestId: "req_this_mac" } });
    for (const payload of [null, {}, { approved: true }, { requestId: 42 }, { requestId: "x".repeat(300) }]) {
      await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), payload);
    }
    check(
      "A MALFORMED ANSWER IS DROPPED RATHER THAN FORWARDED",
      answered.length === 0,
    );
    // `approved` is read with `=== true`, like every other boolean crossing
    // this boundary: a truthy string is not an approval.
    await ipc.handlers.get(BRIDGE_CHANNELS.connectionResolveApproval)(sender(), {
      requestId: "req_this_mac",
      approved: "yes",
    });
    check(
      "...and a truthy answer that is not `true` is a refusal",
      answered.length === 1 && answered[0].approved === false,
    );
  }

  /* --- the main process re-checks the sender ----------------------------- */

  {
    const { ipc } = mainBridge();
    check(
      "every channel the contract names is handled or listened for",
      BRIDGE_CHANNEL_NAMES.filter(
        (name) => !ipc.handlers.has(name) && !ipc.listeners.has(name) && !name.startsWith("context:on-"),
      ).length === 0,
    );
    check("the ten asked-for channels are `handle`, not `on`", HANDLED.every((name) => ipc.handlers.has(name)));
    check(
      "the two synchronous ones are `on`",
      ipc.listeners.has(BRIDGE_CHANNELS.origin) && ipc.listeners.has(BRIDGE_CHANNELS.shell),
    );
  }

  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(sender({ id: 99 }), { sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: false });
      } catch {
        refusals += 1;
      }
    }
    check("A FOREIGN WEBCONTENTS IS REFUSED ON EVERY CHANNEL", refusals === HANDLED.length);
    check("...and nothing behind the bridge was asked to do anything", calls.length === 0);
  }

  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(sender({ url: "https://attacker.invalid/console" }), {
          sessionId: "mtg_abcdefghjkmnpqrstvwx",
          mic: true,
          systemAudio: false,
        });
      } catch {
        refusals += 1;
      }
    }
    check(
      "THE CONSOLE WINDOW ON A PAGE WE DID NOT PIN IS REFUSED TOO",
      refusals === HANDLED.length && calls.length === 0,
    );
  }

  /* ------------------------------------------------------------------ *
   * The id the page mints is a ROUTE, not a name.
   * ------------------------------------------------------------------ */

  /*
    `ROUTES.transcribe/segments/notes/finalize` interpolate the session id into
    a path with no encoding, and `core/sync/client.ts` and `main/transcribe.ts`
    concatenate that into `${baseUrl}${route}` and send it with
    `authorization: Bearer <this machine's grant>`. `fetch` then normalises the
    URL — so whoever picks the id picks the endpoint. MEASURED with `new URL`:

        a/../../../inbox#        ->  POST /inbox
        a/../../../mcp#          ->  POST /mcp
        a/../../../oauth/token#  ->  POST /oauth/token
        a#frag                   ->  /meetings/sessions/a, dropping /finalize

    The gateway saved the bucket key — `matchMeetingRoute` runs `isMeetingId`
    before `sessionKey` interpolates anything, so `.context/meetings/sessions/<id>.json`
    is never built from a malformed id — and the outbox saved the disk, keying
    entries `${sessionId}:${kind}` inside one JSON structure rather than as
    filenames. Nothing saved the URL.

    So the id is validated where it enters, with the same predicate the gateway
    already applies to the same value. Both readers, because `startCapture` and
    `meetingsWrite` each take one from the page and the write path needs no
    recording at all.
  */
  const POISONED = [
    "a/../../../inbox#",
    "a/../../../mcp#",
    "a/../../../oauth/token#",
    "x?q=1",
    "a#frag",
    "../../x",
    "a/b",
  ];

  {
    const { ipc, calls } = mainBridge();
    const answers = [];
    for (const sessionId of POISONED) {
      answers.push(
        await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
          sessionId,
          mic: true,
          systemAudio: false,
        }),
      );
    }
    check(
      "AN ID THAT WOULD REDIRECT THE SHELL'S CREDENTIALLED REQUEST IS REFUSED",
      answers.every((answer) => answer?.ok === false),
    );
    check(
      "...and the capture never began, so nothing downstream ever held it",
      !calls.includes("startCapture"),
    );
  }

  {
    const { ipc, written } = mainBridge();
    const answers = [];
    for (const sessionId of POISONED) {
      answers.push(
        await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, sessionId }),
      );
    }
    check(
      "AND ON THE WRITE CHANNEL, which reaches the queue with no recording at all",
      answers.every((answer) => answer?.ok === false),
    );
    check("...and nothing was queued", written.length === 0);
  }

  {
    // The other direction, so the fix cannot be "refuse everything".
    const { ipc, calls, written } = mainBridge();
    const good = "mtg_abcdefghjkmnpqrstvwx";
    const started = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      sessionId: good,
      mic: true,
      systemAudio: false,
    });
    const wrote = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), {
      ...WRITE,
      sessionId: good,
    });
    check(
      "a well-formed id is still adopted on both channels",
      started?.ok === true &&
        started.value.sessionId === good &&
        wrote?.ok === true &&
        calls.includes("startCapture") &&
        written.length === 1,
    );
  }

  {
    const { ipc, calls } = mainBridge();
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender({ top: false }), {
        sessionId: "mtg_abcdefghjkmnpqrstvwx",
        mic: true,
        systemAudio: false,
      });
    } catch {
      refused = true;
    }
    check("a subframe of the console window is refused", refused && calls.length === 0);
  }

  /*
    The other window in this app, which is the one that matters most.

    `main/capture.ts` opens a hidden `BrowserWindow` holding a live microphone.
    It has its own narrow preload and no reason to touch any of this — but it is
    a webContents in the same process, so "is this an internal window" is not a
    question worth asking and "is this THE console window" is. Every handled
    channel, and both synchronous ones.
  */
  {
    const { ipc, calls } = mainBridge();
    let refusals = 0;
    for (const channel of HANDLED) {
      try {
        await ipc.handlers.get(channel)(captureWindowSender(), {
          sessionId: "mtg_abcdefghjkmnpqrstvwx",
          mic: true,
          systemAudio: false,
        });
      } catch {
        refusals += 1;
      }
    }
    check(
      "THE HIDDEN CAPTURE WINDOW IS REFUSED ON EVERY CHANNEL — it holds a microphone, not a bridge",
      refusals === HANDLED.length && calls.length === 0,
    );

    const origin = captureWindowSender();
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(origin);
    const shell = captureWindowSender();
    ipc.listeners.get(BRIDGE_CHANNELS.shell)(shell);
    check(
      "...and told neither the pin nor the shell on the synchronous channels",
      origin.returnValue === null && shell.returnValue === null,
    );
  }

  {
    const { ipc } = mainBridge();
    const framed = sender({ top: false });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(framed);
    check("a subframe is not told the pin either", framed.returnValue === null);
  }

  /*
    A frame that went away while the call was in flight.

    Electron's `event.senderFrame` is a getter over a live object and it *throws*
    — "Render frame was disposed before WebFrameMain could be accessed" — for a
    frame that navigated, reloaded or closed. That is an ordinary event, not an
    attack, and it must land as a refusal: a throw out of the guard is a
    rejection carrying Electron's own text on `handle`, and on a synchronous
    channel it is a listener that never sets `returnValue` while the renderer
    blocks on `sendSync` at document start.
  */
  {
    // Called through a `try` so that a guard which *does* throw is reported as
    // one failed check rather than as a suite that stopped running.
    let guarded = null;
    try {
      guarded = isBridgeSender(disposedSender(), { webContentsId: 7, pinned: PINNED });
    } catch {
      guarded = "threw";
    }
    check("A FRAME THAT WENT AWAY MID-CALL IS REFUSED, NOT A THROW OUT OF THE GUARD", guarded === false);

    const { ipc, calls } = mainBridge();
    let answered = null;
    let threw = false;
    try {
      answered = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(disposedSender(), {
        sessionId: "mtg_abcdefghjkmnpqrstvwx",
        mic: true,
        systemAudio: false,
      });
    } catch {
      threw = true;
    }
    check(
      "...and `handle` refuses it as it refuses any other sender",
      threw && answered === null && calls.length === 0,
    );

    const event = disposedSender();
    let syncThrew = false;
    try {
      ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    } catch {
      syncThrew = true;
    }
    check(
      "...and the synchronous channel answers `null` rather than leaving `sendSync` waiting",
      !syncThrew && event.returnValue === null,
    );
  }

  /*
    The same rule for the *answer* and not only for the guard.

    `answerSync` calls into the shell to produce its value — `app.getName()` on
    a shell mid-quit is the real case — and a synchronous listener that throws
    is the one shape with a worse failure than a refusal: the renderer is
    blocked inside `sendSync` at document start, so the window never paints
    rather than merely losing its bridge. `null` is what the preload already
    reads as "no shell", and it fails closed there.
  */
  {
    const { ipc } = mainBridge({
      deps: {
        shell: () => {
          throw new Error("Object has been destroyed");
        },
      },
    });
    const event = sender();
    let threw = false;
    try {
      ipc.listeners.get(BRIDGE_CHANNELS.shell)(event);
    } catch {
      threw = true;
    }
    check(
      "A SHELL THAT CANNOT ANSWER SYNCHRONOUSLY ANSWERS `null` — never a blocked renderer",
      !threw && event.returnValue === null,
    );
  }

  check(
    "a sender id that is not a number is refused, however it compares",
    isBridgeSender({ sender: { id: "7" }, senderFrame: { url: `${PINNED}/console`, parent: null } }, {
      webContentsId: 7,
      pinned: PINNED,
    }) === false,
  );

  /*
    The guard on its own, for the shapes a fake `ipcMain` cannot stage.

    Every one of these is an event Electron really can hand a handler — a frame
    that has gone away mid-call, a url that is not a URL, a sender with no id —
    and every one of them has to be a refusal rather than a throw inside the
    guard, because a throw there is an unhandled rejection at the moment
    somebody presses Record.
  */
  check(
    "a sender with no frame at all is refused",
    isBridgeSender({ sender: { id: 7 } }, { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "a frame whose url is not a URL is refused rather than throwing",
    isBridgeSender(sender({ url: "not a url" }), { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "an `about:blank` frame is refused — its origin is the string `null`",
    isBridgeSender(sender({ url: "about:blank" }), { webContentsId: 7, pinned: PINNED }) === false,
  );
  check(
    "a suffixed lookalike origin is refused",
    isBridgeSender(sender({ url: "https://context.lc.attacker.invalid/console" }), {
      webContentsId: 7,
      pinned: PINNED,
    }) === false,
  );
  check(
    "no console window means no sender is the console window",
    isBridgeSender(sender(), { webContentsId: null, pinned: PINNED }) === false,
  );
  check(
    "an unset pin answers nobody, rather than matching an unset origin",
    isBridgeSender(sender(), { webContentsId: 7, pinned: "" }) === false,
  );
  check(
    "the console window's own top frame at the pinned origin is answered",
    isBridgeSender(sender(), { webContentsId: 7, pinned: PINNED }) === true,
  );

  {
    const { ipc } = mainBridge();
    const event = sender({ id: 99 });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("a foreign webContents is not even told the pin", event.returnValue === null);
  }

  {
    const { ipc } = mainBridge();
    const event = sender();
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("the console window is told the origin it is pinned to", event.returnValue === PINNED);
    const shellEvent = sender();
    ipc.listeners.get(BRIDGE_CHANNELS.shell)(shellEvent);
    check("...and what to call this shell", shellEvent.returnValue.app === "Context");

    /*
      Deliberate, and written down so it is not mistaken for the origin check
      leaking: the console window is told the pin whatever page it is on,
      because it is calling to find out *what* the pin is and asking whether it
      matches would be circular. Both values are public — the origin is in the
      window's own URL bar — and the exposure decision is still the renderer's,
      against `location.origin`. Every channel that *does* something re-asks.
    */
    const wandered = sender({ url: "https://attacker.invalid/console" });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(wandered);
    check(
      "the console window off-origin is still told the pin — it is public, and the acting channels refuse it",
      wandered.returnValue === PINNED,
    );
  }

  /* --- the pin moves, and exactly one origin is trusted at a time -------- */

  {
    /*
      The shell falls back to the offline mirror, so `app://console` is what it
      is serving and the live origin is not. Both halves are checked, because a
      pin that merely *added* the mirror would leave a window that has gone
      offline still answering a frame claiming the origin it can no longer
      reach — which is the one shape a stale renderer takes.
    */
    const { ipc, movePin } = mainBridge();
    movePin(MIRROR_ORIGIN);
    const mirrored = sender({ url: `${MIRROR_ORIGIN}/console` });
    // Caught rather than awaited bare: a refusal here is a *throw*, and a check
    // that lets it out reports zero failures by taking the run down with it.
    let mirroredAnswer = null;
    try {
      mirroredAnswer = await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(mirrored, null);
    } catch {
      mirroredAnswer = null;
    }
    check(
      "THE MIRRORED CONSOLE IS ANSWERED, so an offline page can say what is queued",
      mirroredAnswer?.ok === true && mirroredAnswer.value.pending === QUEUE.pending,
    );

    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(sender(), null);
    } catch {
      refused = true;
    }
    check("...AND THE LIVE ORIGIN IS REFUSED WHILE THE MIRROR IS THE ONE BEING SERVED", refused);

    const event = sender({ url: `${MIRROR_ORIGIN}/console` });
    ipc.listeners.get(BRIDGE_CHANNELS.origin)(event);
    check("...and the pin the preload is told is the mirror's", event.returnValue === MIRROR_ORIGIN);

    /*
      An opaque origin reports `"null"`, and so does a second one — which is why
      the pin is never that string and why this guard refuses it by name. Worth
      a check on this side as well as in `shell.test.mjs`: this is the half that
      runs in the main process, where `app://console` being a real origin is the
      whole reason a pin can be a scheme no ordinary page can claim.
    */
    let opaqueRefused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(
        sender({ url: "data:text/html,<script>fetch('x')</script>" }),
        null,
      );
    } catch {
      opaqueRefused = true;
    }
    check(
      "AN OPAQUE ORIGIN IS REFUSED WHILE THE MIRROR IS PINNED — a data: page is not app://console",
      opaqueRefused,
    );
  }

  {
    // And the other way round: the live page is loaded, so a frame claiming the
    // mirror is somebody's idea rather than this shell's.
    const { ipc } = mainBridge();
    let refused = false;
    try {
      await ipc.handlers.get(BRIDGE_CHANNELS.outboxStatus)(
        sender({ url: `${MIRROR_ORIGIN}/console` }),
        null,
      );
    } catch {
      refused = true;
    }
    check("A FRAME CLAIMING THE MIRROR IS REFUSED WHILE THE LIVE CONSOLE IS LOADED", refused);
  }

  /* --- and answers the console window ------------------------------------ */

  {
    const { ipc, calls } = mainBridge();
    const answers = [];
    for (const channel of HANDLED) {
      const payload =
        channel === BRIDGE_CHANNELS.meetingsWrite
          ? { ...WRITE }
          : channel === BRIDGE_CHANNELS.connectionResolveApproval
            ? { requestId: "a-parked-request-id", approved: false }
            : { sessionId: "mtg_abcdefghjkmnpqrstvwx", mic: true, systemAudio: true };
      answers.push(await ipc.handlers.get(channel)(sender(), payload));
    }
    check("the pinned console window is answered on every channel", answers.every((answer) => answer?.ok === true));
    check("...and every verb behind it ran", calls.length === HANDLED.length);
    check(
      "NO ANSWER THE MAIN PROCESS RETURNS CARRIES ANYTHING CREDENTIAL-SHAPED",
      answers.flatMap((answer) => contamination(answer)).length === 0,
    );
  }

  {
    const { ipc } = mainBridge({
      deps: {
        startCapture: async () => {
          throw new Error("This machine is not connected to a context yet.");
        },
      },
    });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      sessionId: "mtg_abcdefghjkmnpqrstvwx",
      mic: true,
      systemAudio: false,
    });
    check(
      "a verb that refused answers a sentence rather than throwing across the boundary",
      answer.ok === false && answer.message === "This machine is not connected to a context yet.",
    );
  }

  {
    const { ipc, requested } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), {
      // Whitespace still trims — the id is validated AFTER the trim, so a
      // well-formed id padded by a client is read rather than refused.
      sessionId: "  mtg_abcdefghjkmnpqrstvwx  ",
      mic: "yes",
      systemAudio: 1,
    });
    check(
      "a request from the page is read rather than trusted — only `true` opens an input",
      /*
        READ OFF THE REQUEST THE READER BUILT, not off the answer. This check
        asserted `answer.ok` and the session id only — and the stub behind it
        returns hard-coded `mic: true, systemAudio: false` whatever it is
        asked, so `mic: "yes"` and `systemAudio: 1` were inert. MEASURED:
        replacing `=== true` with `Boolean(...)` in both readers left the suite
        at 781 PASS, 0 FAIL. Half of this check's name was a claim about a line
        nothing exercised.
      */
      answer.ok === true &&
        answer.value.sessionId === "mtg_abcdefghjkmnpqrstvwx" &&
        requested.length === 1 &&
        requested[0].sessionId === "mtg_abcdefghjkmnpqrstvwx" &&
        requested[0].mic === false &&
        requested[0].systemAudio === false,
    );
  }

  {
    const { ipc } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.startCapture)(sender(), { sessionId: "", mic: true, systemAudio: false });
    check("a capture with no meeting to file it under is refused", answer.ok === false);
  }

  /* --- the meeting is written by the machine's own grant ------------------ */

  /*
    THE VERSION-2 ADDITION, AND THE ONE THING IT MUST NOT BECOME.

    `meetings.write` is the page handing a write to this machine's queue, and
    its body is the meetings protocol's own JSON — which this file deliberately
    does not read. What stops that being a generic `invoke` is that the body
    never chooses an address: the route comes from `kind`, which is one of four
    words, and the context from `context`, which the queue checks against the
    gateway's own slug pattern. A payload that fails either is refused here
    rather than queued and discovered at drain time.
  */
  {
    const { ipc, written } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE });
    check("a well-formed write reaches the queue", answer.ok === true && written.length === 1);
    check("...as the four fields the contract declares", Object.keys(written[0]).sort().join() === "body,context,kind,sessionId");
    check("...and the ack says the shell is holding it", answer.value.queued === true);
  }
  {
    const { ipc, written } = mainBridge();
    const answers = [];
    for (const bad of [
      { ...WRITE, sessionId: "" },
      { ...WRITE, sessionId: "   " },
      { ...WRITE, kind: "enhance" },
      { ...WRITE, kind: undefined },
      { ...WRITE, body: "folder=5-meetings" },
      { ...WRITE, body: [1, 2, 3] },
      { ...WRITE, body: null },
      "not an object at all",
    ]) {
      answers.push(await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), bad));
    }
    check(
      "A WRITE THE CONTRACT DOES NOT DESCRIBE IS REFUSED, NOT QUEUED",
      answers.every((answer) => answer.ok === false) && written.length === 0,
    );
    check(
      "...with a sentence rather than a channel name",
      answers.every((answer) => !answer.message.includes("context:")),
    );
  }
  {
    const { ipc, written } = mainBridge();
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), {
      ...WRITE,
      context: "acme",
      extra: "a field nobody agreed to",
    });
    check("a context the page named is carried as a name", written[0]?.context === "acme");
    check(
      "...and a field the contract does not declare is not passed on to the queue",
      written[0] !== undefined && !("extra" in written[0]),
    );
  }

  /*
    ABSENT IS AN ADDRESS; UNREADABLE IS NOT. THEY MUST NOT COLLAPSE HERE.

    `routableContext` in the queue draws exactly that line: `null` means this
    machine's own context, which is where everything the tray records goes, and
    a name it cannot read is refused rather than dropped from the front of the
    URL. A boundary that turned `""` into `null` on the way in would decide that
    question before the queue ever saw it, and the answer it gives is the wrong
    one — a meeting filed in whatever context the credential defaults to.
  */
  {
    const { ipc, written } = mainBridge();
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: "" });
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: null });
    await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE, context: undefined });
    check(
      "AN EMPTY CONTEXT IS NOT THIS MACHINE'S OWN — the queue is left to refuse it",
      written[0]?.context === "",
    );
    check(
      "...and an absent one is, which is what everything the tray records means",
      written[1]?.context === null && written[2]?.context === null,
    );
  }

  /*
    And the preload does not repair either of them on the way out.

    It runs in the renderer, so a value it "fixes" is a value the guard in the
    main process never gets to refuse. `kind` is a route and `context` is a
    bucket; a default for the first is a body posted to a collection nobody
    named, and a default for the second is the wrong-tenant write above.
  */
  {
    const shell = installed({ replies: { [BRIDGE_CHANNELS.meetingsWrite]: { ok: true, value: {} } } });
    await shell.bridge.meetings.write({ sessionId: "mtg_abcdefghjkmnpqrstvwx", kind: "enhance", context: "", body: {} });
    const sent = shell.invoked.find((one) => one.channel === BRIDGE_CHANNELS.meetingsWrite)?.args[0];
    check(
      "A KIND THE CONTRACT DOES NOT NAME IS NOT REWRITTEN INTO ONE THAT ROUTES",
      sent?.kind === "enhance",
    );
    check("...and an empty context crosses as itself", sent?.context === "");

    const { ipc, written } = mainBridge();
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), sent);
    check(
      "...so the process that owns the queue is the one that refuses it",
      answer.ok === false && written.length === 0,
    );
  }
  {
    const { ipc } = mainBridge({
      deps: {
        writeMeeting: async (write) => ({
          sessionId: write.sessionId,
          queued: false,
          notePath: "5-meetings/standup.md",
          rejected: null,
        }),
      },
    });
    const answer = await ipc.handlers.get(BRIDGE_CHANNELS.meetingsWrite)(sender(), { ...WRITE });
    check(
      "a finalize that reached the bucket answers with the path the gateway chose",
      answer.value.notePath === "5-meetings/standup.md",
    );
    check("...and nothing credential-shaped came back with it", contamination(answer).length === 0);
  }

  /* --- pushing to the console window ------------------------------------- */

  {
    const { bridge, window } = mainBridge();
    bridge.push({
      captureState: { state: "recording", capturing: true, fault: null },
      connection: { ...CONNECTED },
      outbox: { ...QUEUE },
      detection: null,
    });
    const channels = window.sent.map((entry) => entry.channel);
    check("a push reaches the console window on the contract's channels", channels.includes(BRIDGE_CHANNELS.captureState) && channels.includes(BRIDGE_CHANNELS.connectionChange));
    check(
      "NOTHING PUSHED TO A REMOTE ORIGIN IS CREDENTIAL-SHAPED",
      window.sent.flatMap((entry) => contamination(entry.payload)).length === 0,
    );

    bridge.emitSegment({ id: "s", startMs: 0, endMs: 1, text: "hi", speaker: null, channel: "mic", confidence: null });
    bridge.emitTrayCommand("record");
    check("segments and tray commands reach it too", window.sent.some((e) => e.channel === BRIDGE_CHANNELS.segment) && window.sent.some((e) => e.channel === BRIDGE_CHANNELS.trayCommand));
  }
}
