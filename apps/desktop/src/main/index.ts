/**
 * The app: a tray, two windows, a poll loop, and one object that may open a
 * microphone.
 *
 * This file is deliberately the only place where the pieces meet, and it holds
 * no rules of its own. The detector judges (`packages/meetings/src/detect.js`),
 * the gate decides (`core/consent/gate.ts`), the controller records
 * (`core/recording/controller.ts`), the queue sends (`core/sync/*`), and this
 * is the wiring between them. Everything worth arguing about is in a pure
 * function with a check beside it; what is left here is Electron.
 *
 * ## The one behaviour that lives here
 *
 * **Consent is answered against an episode, not against "now".** The panel
 * echoes back the episode it was raised for, and a `accept` for an episode that
 * has already been superseded — the meeting ended while the panel was up — is
 * dropped rather than starting a recording of whatever is happening instead.
 */

import { app } from "electron";
import { DRAIN_INTERVAL_MS } from "../core/sync/drain.ts";
import { AppTray } from "./tray.ts";
import { markQuitting, positionPanelUnderTray, revealNotepadQuietly } from "./windows.ts";
import { registerMirrorScheme } from "./consoleMirror.ts";
import {
  CONSOLE_UI,
  EFFECTIVE_SMOKE_DEADLINE_MS,
  RENDERER_UI,
  SMOKE,
  endSmoke,
} from "./launchFlags.ts";
import { CONSOLE_NOTICES } from "./notices.ts";
import { showNativeNotification, showUpdateCheckMessage } from "./dialogs.ts";
import { installApplicationMenu, setCheckForUpdatesFromMenu } from "./appMenu.ts";
import { createMainContext } from "./context.ts";
import type { MainServices } from "./context.ts";
import { prepareLaunch } from "./startup.ts";
import { createServices } from "./services.ts";
import { createShellView } from "./shellView.ts";
import { createSurfaces } from "./surfaces.ts";
import { createMeetings } from "./meetings.ts";
import { createOutboxDrain } from "./outboxDrain.ts";
import { createConsoleCapture } from "./consoleCapture.ts";
import { createConsoleWindowOpener, registerWindowCommands } from "./windowIpc.ts";
import { createConnectFlow } from "./connectFlow.ts";
import { reportSmoke } from "./smokeReport.ts";

async function main(): Promise<void> {
  /*
    A Dock tile, an app-switcher entry and a menu bar — and the tray as well.

    This app hid from the Dock (`app.dock.hide()` here, `LSUIElement: true` in
    `electron-builder.yml`) because it began as a menu-bar app with no window of
    its own. Step 4 ended that: *"the console is what a launch opens"*, and a
    windowed application with no Dock tile and no app-switcher entry is one the
    person who installed it cannot find. The owner's words, holding the first
    signed build: **"I dont even see a launched app, I should be able to open
    the app locally like all these other apps."**

    Nothing about the menu bar changes — the tray is still built below, still
    records with no window open, and is still the whole app on a launch whose
    window could not be built. This is a Dock tile *as well as*, never instead
    of. `docs/decisions/desktop.md`, "The app is in the Dock", is the argument.

    **And it is conditional on the UI this launch hosts, not unconditional.**
    `CONTEXT_DESKTOP_UI=renderer` is still the panel and the notepad — a popover
    under the menu-bar icon, with no window a person opens — and that really is
    an accessory app. It keeps `app.dock.hide()` and gets no application menu,
    because macOS shows an accessory app's menu bar to nobody. The one escape
    hatch step 5 is waiting to remove goes on behaving exactly as it did.
  */
  if (RENDERER_UI) app.dock?.hide();
  else installApplicationMenu();
  // The state every function below shares, created once for this launch.
  // See `main/context.ts`.
  const ctx = createMainContext();

  const prepared = await prepareLaunch(ctx);
  const { store, tokens, connection } = prepared;
  const { localAgent, imessage, panel, notepad, capture, controller, updater, loop } = await createServices(
    ctx,
    prepared,
  );

  const checkForUpdatesFromMenu = () => {
    const result = updater.checkNow();
    ctx.push();
    // `install()` is handed to the dialog rather than called for it: the
    // person decides, `mayInstall()` re-checks the meeting, and `push()`
    // refreshes the tray when an install was refused after all.
    const installNow = () => {
      const installing = updater.install();
      if (!installing) ctx.push();
      return installing;
    };
    if (!result.started) {
      void showUpdateCheckMessage(result.outcome, installNow);
      return;
    }
    showNativeNotification("Checking for updates...");
    void result.outcome.then((outcome) => showUpdateCheckMessage(outcome, installNow));
  };
  setCheckForUpdatesFromMenu(checkForUpdatesFromMenu);

  const tray = new AppTray({
    togglePanel: (bounds) => {
      /*
        No panel means the console is the window this app has, so the menu-bar
        click raises that — and says why when there is none to raise, which is
        the only way this launch can have no UI: `consoleUrl` refused the
        address it was given, and that was logged where nobody is looking.
      */
      if (panel === null) {
        if (!ctx.openConsoleWindow()) ctx.explain(CONSOLE_NOTICES.noConsole);
        return;
      }
      if (panel.isVisible()) {
        panel.hide();
        return;
      }
      positionPanelUnderTray(panel, bounds);
      panel.showInactive();
    },
    openNotepad: () => {
      if (notepad !== null) {
        revealNotepadQuietly(notepad);
        return;
      }
      if (!ctx.openConsoleWindow()) ctx.explain(CONSOLE_NOTICES.noConsole);
    },
    record: () => void ctx.pressed("record", () => ctx.recordNow()),
    end: () => void ctx.pressed("end", () => ctx.endMeeting()),
    connect: () => void ctx.connectThisMachine(),
    disconnect: () => void ctx.disconnectThisMachine(),
    toggleDetection: () => void ctx.update({ detectionEnabled: !ctx.settings.detectionEnabled }),
    toggleImessage: () => void ctx.update({ imessageEnabled: !ctx.settings.imessageEnabled }),
    installUpdate: () => {
      // A stray click cannot install mid-meeting: `install()` re-checks
      // `controller.recording` itself, regardless of what this menu currently
      // shows — see `DesktopUpdater.install()` and `mayInstall()`.
      if (!updater.install()) ctx.push();
    },
    quit: () => app.quit(),
  });

  // Every service exists now, the tray last of them, so the functions that
  // read them can be built — and nothing has been started yet.
  const services: MainServices = {
    store,
    tokens,
    connection,
    localAgent,
    imessage,
    panel,
    notepad,
    capture,
    controller,
    updater,
    loop,
    tray,
  };
  Object.assign(ctx, services);
  Object.assign(
    ctx,
    createShellView(ctx),
    createSurfaces(ctx),
    createMeetings(ctx),
    createOutboxDrain(ctx),
    createConsoleCapture(ctx),
    createConsoleWindowOpener(ctx),
    createConnectFlow(ctx),
  );
  const { push, drain, endMeeting, showPanel, openConsoleWindow, explain, openConsoleWindowIfAsked } = ctx;

  registerWindowCommands(ctx);

  openConsoleWindowIfAsked();
  loop.start();
  updater.start();
  /*
    Down here with the other services, and not beside its own constructor.

    `reconfigure()` can reach `onChange`, `onChange` calls `push()`, and `push()`
    reads `controller`, `tray` and `updater` — all declared *below* where this
    service is built. Called at construction it therefore threw
    `ReferenceError: Cannot access 'controller' before initialization`, through a
    promise, so it surfaced as an unhandled rejection with no stack at the call
    site and the app exited 1 about a second after launch. `main` shipped that
    way from #329 until this, because the only thing that starts the app is the
    release workflow's gate, which does not run on a pull request.
  */
  imessage.reconfigure();
  setInterval(() => void drain(), DRAIN_INTERVAL_MS);
  push();

  // A recording that is still open when somebody quits is stopped first. The
  // transcript is already in the queue; the microphone is what must not be left
  // behind.
  app.on("before-quit", (event) => {
    markQuitting();
    imessage.stop();
    if (!controller.recording) return;
    event.preventDefault();
    void endMeeting().then(() => app.quit());
  });

  /*
    Clicking the Dock tile brings the app back, which is the other half of
    having one.

    On macOS `activate` fires for a Dock click, an app-switcher pick and a
    double-click on the `.app` while it is already running. The window is
    *destroyed* when it is closed rather than hidden (see
    `openConsoleWindowIfAsked`), so this has to be able to build it again — a
    handler that only raised an existing window would leave the Dock tile inert
    for the rest of the run, which is the same bug `openConsoleWindow` was
    written for one level up, arriving through a different door.

    On a `CONTEXT_DESKTOP_UI=renderer` launch there is no console window and the
    panel is the UI, so that is what a Dock click raises.
  */
  app.on("activate", () => {
    if (panel !== null) {
      showPanel();
      return;
    }
    if (!openConsoleWindow()) explain(CONSOLE_NOTICES.noConsole);
  });

  /*
    `--smoke`: say what a running app can say, and exit with the verdict.

    Reported from the last line of `main()` on purpose — every fact below is
    only true once the whole startup path has run, and reaching this line at all
    is what proves the module graph evaluated. The exit code is the contract the
    release step reads; see the flag's own comment above.
  */
  await reportSmoke(ctx);
}

/*
  Before `whenReady`, because `registerSchemesAsPrivileged` may not be called
  after it — and without it `app://console` is an opaque origin, which
  `shouldExposeBridge` refuses (correctly), so the offline console would load
  with no bridge and nothing to say about the queue.
*/
if (CONSOLE_UI) registerMirrorScheme();

/*
  A `--smoke` run always ends, and it ends with a verdict.

  Armed before `whenReady` so it covers the whole of a launch: a `main()` that
  never resolves, a promise nobody caught, an exception after load. A hung smoke
  run is a hung release job, and the one thing this flag exists to promise is
  that the process stops on its own.

  What it cannot cover is the crash it was written for — that threw while the
  module graph was still evaluating, before this line existed to run — so the
  caller keeps its own limit. See the flag's docblock.
*/
if (SMOKE) {
  // Never cleared: every way out of a `--smoke` run goes through `endSmoke`,
  // which exits the process. A timer that outlives that has nothing to fire in.
  setTimeout(
    () => endSmoke(1, `nothing finished within ${EFFECTIVE_SMOKE_DEADLINE_MS}ms`),
    EFFECTIVE_SMOKE_DEADLINE_MS,
  );
  process.on("uncaughtException", (error) => endSmoke(1, `uncaught exception: ${error.message}`));
  process.on("unhandledRejection", (reason) => endSmoke(1, `unhandled rejection: ${String(reason)}`));
}

app.whenReady().then(main);

/*
  Closing the window does not end the app, and it must not end a meeting.

  Electron's default is to quit when the last window closes on every platform
  but macOS; this handler overrides it everywhere, and the reason is stronger
  than the platform convention. The recorder, the detector, the outbox and the
  tray all live in this process and none of them needs a window: somebody who
  closes the console mid-meeting keeps their recording, the menu bar goes on
  saying it is recording, and *End & write up* still writes the note. Quitting
  is `before-quit` above, which stops the microphone first.

  Reopening is `activate` above — the Dock tile, the app switcher — and the
  menu-bar click, which is why closing the window is not a way to lose the app.
*/
app.on("window-all-closed", () => undefined);
