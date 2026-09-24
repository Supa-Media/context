/**
 * Everything a window may ask the main process for, and the whole of it.
 *
 * Moved from `main()` verbatim: the console window and the bridge registered
 * before it loads, and the renderer panel's and notepad's twelve commands.
 * Besides `consoleBridge.ts` and the capture window, this is the only module
 * that registers a channel, and `test/consoleBridge/ipcCensus.test.mjs` holds
 * it to that.
 */

import { app, ipcMain, session, shell } from "electron";
import { episodeKey, answered } from "../core/consent/gate.ts";
import {
  FULL_DISK_ACCESS_SETTINGS_URL,
  fullDiskAccessNotice,
} from "../core/imessage/permission.ts";
import { consoleOrigin, consoleUrl } from "../core/shell/console.ts";
import { createConsoleWindow } from "./windows.ts";
import { createConsoleBridge } from "./consoleBridge.ts";
import { createConsoleMirror } from "./consoleMirror.ts";
import { COMMANDS } from "./ipc.ts";
import { askSomething } from "./dialogs.ts";
import { CONSOLE_UI, RENDERER_DIR } from "./launchFlags.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createConsoleWindowOpener(ctx: MainContext): Pick<MainActions, "openConsoleWindowIfAsked"> {
  const { controller, imessage, localAgent } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const update: MainActions["update"] = (patch) => ctx.update(patch);
  const uiState: MainActions["uiState"] = () => ctx.uiState();
  const shellCapabilities: MainActions["shellCapabilities"] = () => ctx.shellCapabilities();
  const startFromConsole: MainActions["startFromConsole"] = (request) => ctx.startFromConsole(request);
  const stopFromConsole: MainActions["stopFromConsole"] = () => ctx.stopFromConsole();
  const connectThisMachine: MainActions["connectThisMachine"] = () => ctx.connectThisMachine();
  const disconnectThisMachine: MainActions["disconnectThisMachine"] = () =>
    ctx.disconnectThisMachine();
  const answerFromConsole: MainActions["answerFromConsole"] = (result) => ctx.answerFromConsole(result);
  const outboxStatus: MainActions["outboxStatus"] = () => ctx.outboxStatus();
  const drain: MainActions["drain"] = () => ctx.drain();
  const writeMeetingFromConsole: MainActions["writeMeetingFromConsole"] = (write) =>
    ctx.writeMeetingFromConsole(write);

  /**
   * Open the hosted console, when this launch was asked to.
   *
   * The bridge is registered **before** the window exists — `window` is a
   * getter for exactly that reason — because the preload's two synchronous
   * calls happen while the page is loading, and a handler registered after
   * `loadURL` is a race whose losing side is a window with no bridge on it.
   *
   * A misconfigured `CONTEXT_DESKTOP_UI_URL` throws in `consoleUrl` and is
   * caught here: the flag is a development aid today, and a typo in it must not
   * stop the tray, the detector and the queue from starting.
   */
  function openConsoleWindowIfAsked(): void {
    if (!CONSOLE_UI) return;
    let url: string;
    try {
      /*
        `app.isPackaged`, and it is the whole of the fix for a signed build that
        opened a blank window: the fallback used to be chosen by `NODE_ENV`,
        which nothing in this repository or in macOS ever sets, so an installed
        app pointed at `http://localhost:8081`. See `consoleUrl`'s own docblock.
      */
      url = consoleUrl(process.env, app.isPackaged);
    } catch (error) {
      console.error(`CONTEXT_DESKTOP_UI=console, but ${(error as Error).message}`);
      return;
    }
    ctx.consoleAddress = url;

    const origin = consoleOrigin(url);
    ctx.consoleMirror = createConsoleMirror({
      liveUrl: url,
      liveOrigin: origin,
      userDataDir: app.getPath("userData"),
      appVersion: app.getVersion(),
      // The console window's own partition, so `app://console` exists for that
      // window and for nothing else this app ever loads.
      session: session.fromPartition("persist:console"),
    });

    ctx.consoleBridge = createConsoleBridge({
      ipc: ipcMain,
      /*
        Read on every channel rather than captured once: the pin moves to
        `app://console` when the network goes and back when it returns, and a
        bridge holding the origin it was built with would answer the wrong one
        in both directions.
      */
      pinned: () => ctx.consoleMirror?.pinnedOrigin() ?? origin,
      window: () => ctx.consoleWindow,
      shell: () => ({ app: app.getName(), version: app.getVersion(), platform: "macos" }),
      capabilities: shellCapabilities,
      startCapture: startFromConsole,
      /*
        Guarded on the state, so an out-of-order press is a no-op rather than a
        transition error.

        `#moveTo` asserts the contract's table and throws on an illegal move —
        which is right, and is checked — but the string it throws
        ("illegal meeting transition idle -> paused") is written for whoever is
        debugging this process, and `createConsoleBridge` would put it in an
        answer bound for a page served over the network. The page already
        guards its own state; this is the same guard on the side that owns the
        recorder, so the developer sentence has no way to cross.
      */
      pauseCapture: async () => {
        if (controller.view()?.state !== "recording") return;
        await controller.pause();
        push();
      },
      resumeCapture: async () => {
        if (controller.view()?.state !== "paused") return;
        await controller.resume();
        push();
      },
      stopCapture: stopFromConsole,
      connection: () => uiState().connection,
      connect: () => void connectThisMachine(),
      disconnect: () => void disconnectThisMachine(),
      pendingApproval: () => {
        const pending = ctx.handover.pending();
        return pending === null ? null : { requestId: pending.requestId };
      },
      resolveApproval: (result) => answerFromConsole(result),
      outbox: outboxStatus,
      drain: () => void drain(),
      writeMeeting: writeMeetingFromConsole,
      imessage: () => imessage.status(),
      setImessageEnabled: (enabled) => void update({ imessageEnabled: enabled }),
      requestImessageFullDiskAccess: async () => {
        const parent = ctx.consoleWindow === null || ctx.consoleWindow.isDestroyed() ? null : ctx.consoleWindow;
        const answer = await askSomething(parent, {
          type: "info",
          title: "Allow iMessage import",
          message: fullDiskAccessNotice(app.getName()),
          detail: `After turning it on, quit and reopen ${app.getName()}, then return to Settings → Chats.`,
          buttons: ["Open System Settings", "Not now"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (answer.response === 0) await shell.openExternal(FULL_DISK_ACCESS_SETTINGS_URL);
      },
      localAgent: () => localAgent.status(),
      askLocalAgent: (request) => localAgent.ask(request),
    });

    ctx.consoleWindow = createConsoleWindow(url, RENDERER_DIR, {
      approvalCallback: () => ctx.approval.callback(),
    });
    // Before the load can finish or fail: the mirror owns `did-fail-load`, and
    // a fallback wired after the first load is a fallback that misses it.
    ctx.consoleMirror.attach(ctx.consoleWindow);
    /*
      Registered here, at creation, rather than wherever `--smoke-load` reads
      it: the window's `loadURL` is already under way inside
      `createConsoleWindow`, so a listener attached any later than this is a
      listener that can lose the race to a fast local load. `.once` on both
      events, so whichever fires first is the answer — a later navigation to
      the mirror or the failure page is the fallback taking over and is
      deliberately not what this promise reports.
    */
    const settlingWindow = ctx.consoleWindow;
    ctx.consoleLoadSettled = new Promise<boolean>((resolveSettled) => {
      let settled = false;
      const finish = (loaded: boolean): void => {
        if (settled) return;
        settled = true;
        resolveSettled(loaded);
      };
      settlingWindow.webContents.once("did-finish-load", () => finish(true));
      settlingWindow.webContents.once(
        "did-fail-load",
        (_event, _errorCode, _errorDescription, _failedUrl, isMainFrame) => {
          if (isMainFrame) finish(false);
        },
      );
      settlingWindow.once("closed", () => finish(false));
    });
    ctx.consoleWindow.once("ready-to-show", () => ctx.consoleWindow?.show());
    ctx.consoleWindow.on("closed", () => {
      /*
        The window is gone, so the channels go with it.

        Not merely tidiness: `handle` throws if a channel is registered twice,
        and leaving ten handlers behind whose only behaviour is to refuse
        everything is a surface that looks answered and is not. The bridge is
        rebuilt with the window if one is ever opened again.
      */
      ctx.consoleWindow = null;
      ctx.consoleBridge?.dispose();
      ctx.consoleBridge = null;
      ctx.consoleMirror = null;
    });
  }

  return { openConsoleWindowIfAsked };
}

/**
 * The renderer panel's and notepad's commands, registered once per launch.
 *
 * Called by `main()` at the point these registrations always ran — after the
 * tray, before the console window is opened — so the registration order is
 * unchanged.
 */
export function registerWindowCommands(ctx: MainContext): void {
  const { controller, panel } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const update: MainActions["update"] = (patch) => ctx.update(patch);
  const pressed: MainActions["pressed"] = (command, run) => ctx.pressed(command, run);
  const beginMeeting: MainActions["beginMeeting"] = (...args) => ctx.beginMeeting(...args);
  const recordNow: MainActions["recordNow"] = () => ctx.recordNow();
  const endMeeting: MainActions["endMeeting"] = () => ctx.endMeeting();
  const connectThisMachine: MainActions["connectThisMachine"] = () => ctx.connectThisMachine();
  const disconnectThisMachine: MainActions["disconnectThisMachine"] = () =>
    ctx.disconnectThisMachine();

  /* --- what a window is allowed to ask for ------------------------------ */

  ipcMain.on(COMMANDS.accept, (_event, episode: string) => {
    // See the header: an answer to a meeting that is over is not consent for
    // the one that is happening now.
    const current = ctx.lastUpdate ? episodeKey(ctx.lastUpdate.state) : null;
    if (current === null || current !== episode) return;
    ctx.consent = answered(episode, "granted");
    void pressed("accept", () => beginMeeting(episode));
  });
  ipcMain.on(COMMANDS.decline, (_event, episode: string) => {
    ctx.consent = answered(episode, "declined");
    panel?.hide();
    push();
  });
  ipcMain.on(COMMANDS.pause, () => void pressed("pause", () => controller.pause().then(push)));
  ipcMain.on(COMMANDS.resume, () => void pressed("resume", () => controller.resume().then(push)));
  ipcMain.on(COMMANDS.end, () => void pressed("end", () => endMeeting()));
  ipcMain.on(COMMANDS.notes, (_event, markdown: string) => controller.notes(String(markdown)));
  ipcMain.on(COMMANDS.title, (_event, title: string) => controller.title(String(title).slice(0, 200)));
  ipcMain.on(COMMANDS.setAskBeforeEveryMeeting, (_event, value: boolean) =>
    void update({ askBeforeEveryMeeting: Boolean(value) }),
  );
  ipcMain.on(COMMANDS.setBlocklist, (_event, list: string[]) =>
    void update({
      blocklist: Array.isArray(list) ? list.map(String).filter((entry) => entry.trim() !== "") : [],
    }),
  );
  ipcMain.on(COMMANDS.record, () => void pressed("record", () => recordNow()));
  ipcMain.on(COMMANDS.connect, () => void connectThisMachine());
  ipcMain.on(COMMANDS.disconnect, () => void disconnectThisMachine());
}
