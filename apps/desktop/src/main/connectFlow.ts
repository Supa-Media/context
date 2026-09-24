/**
 * Connecting this machine to a context, and the approval that grants it.
 *
 * Moved from `main()` verbatim: the three ways the approval is put in front of
 * the person — the page answering a parked request, the approve screen in this
 * window, the system browser — and the connect, transcription question and
 * disconnect around them. `core/shell/approval.ts` and `core/shell/autoGrant.ts`
 * hold the rules; this is the Electron half.
 */

import type { MachineApprovalResult } from "@context/desktop-bridge";
import { approvalTargetFor, returnAfterApproval } from "../core/shell/approval.ts";
import type { ApprovalTarget } from "../core/shell/approval.ts";
import { isParkingRedirect, parkedRequestFrom } from "../core/shell/autoGrant.ts";
import { consoleOrigin } from "../core/shell/console.ts";
import { connectMachine, openInSystemBrowser } from "./connect.ts";
import { askSomething } from "./dialogs.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createConnectFlow(ctx: MainContext): Pick<MainActions, "answerFromConsole" | "connectThisMachine" | "disconnectThisMachine"> {
  const { connection } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const push: MainActions["push"] = () => ctx.push();
  const update: MainActions["update"] = (patch) => ctx.update(patch);
  const drain: MainActions["drain"] = () => ctx.drain();
  const liveConsoleWindow: MainActions["liveConsoleWindow"] = () => ctx.liveConsoleWindow();

  /**
   * Show the approve screen **in this app's own window**, and say whether it
   * went.
   *
   * `false` is not a failure: it means this launch has no console window (the
   * tray-only mode still exists), or the authorization server named an
   * authorize URL this shell will not navigate its own window to, and the
   * caller falls back to the system browser — which is what this app did until
   * now and still does for everybody without a window.
   *
   * The whole of the rule is `core/shell/approval.ts`. What is here is the
   * Electron half: read where the window is so it can be put back, open the
   * allowance, navigate, and raise the window so the approve screen is in front
   * of the person who just pressed Connect rather than behind their editor.
   */
  async function approveInConsoleWindow(href: string): Promise<boolean> {
    const win = liveConsoleWindow();
    if (win === null || ctx.consoleAddress === null) return false;
    const target = approvalTargetFor(href);
    if (target === null) return false;

    let from = "";
    try {
      from = win.webContents.getURL();
    } catch {
      from = "";
    }
    const authorize = ctx.approval.begin(
      target,
      returnAfterApproval(from, ctx.consoleAddress, consoleOrigin(ctx.consoleAddress)),
    );
    try {
      await win.loadURL(authorize);
    } catch {
      /*
        A load this process replaced, or a network that went away mid-flight.
        The listener is still open and the URL has already been logged, so this
        is not the end of the flow — and `finally` puts the window back on the
        console either way.
      */
    }
    win.show();
    win.focus();
    return true;
  }

  /**
   * How long the page gets to answer a parked approval before this falls back.
   *
   * Not a guess at how fast a mutation is — the page answers either way, and
   * both answers arrive in milliseconds. It is for the pages that *cannot*
   * answer: a shell hosting a bundle older than version 3, a window serving the
   * offline mirror, a page mid-navigation when the push went out. Without it,
   * those wait out the loopback listener's five minutes staring at a console
   * that says "Connecting". Four seconds is far past a round trip and far
   * short of somebody giving up.
   */
  const APPROVAL_ANSWER_MS = 4_000;

  /**
   * Ask the page to approve this machine with the session it already has.
   *
   * `true` when the page has been handed the parked request and this connect is
   * now waiting on the loopback listener; `false` when there was nothing to
   * hand over, and the caller falls back to the approve screen in this window —
   * which is #312's flow, unchanged, and still the only thing a tray-only
   * launch has.
   *
   * The whole of what is new is the first three lines: the gateway's
   * `/oauth/authorize` **parks** the request and answers `302 Location:` the
   * consent screen, so following that one hop here — in the main process, with
   * no credential in the request and none in the answer — yields the request
   * id without sending the window anywhere. `core/shell/autoGrant.ts` carries
   * the argument, including why the id is read only from the pinned origin.
   */
  async function askConsoleToApprove(href: string, target: ApprovalTarget): Promise<boolean> {
    const win = liveConsoleWindow();
    if (win === null || ctx.consoleAddress === null || ctx.consoleBridge === null) return false;

    let parked: string | null = null;
    try {
      const response = await fetch(href, { redirect: "manual" });
      if (isParkingRedirect(response.status)) {
        parked = parkedRequestFrom(
          response.headers.get("location") ?? "",
          consoleOrigin(ctx.consoleAddress),
        );
      }
    } catch {
      /*
        The network, most likely, and the fallback is the same one it has
        always been: `approveInConsoleWindow` navigates the window to the same
        URL, which fails the same way and lands on the mirror or the failure
        page. Nothing is lost by having tried.
      */
      parked = null;
    }
    if (parked === null) return false;

    let from = "";
    try {
      from = win.webContents.getURL();
    } catch {
      from = "";
    }
    /*
      The loopback allowance is opened *before* the page is told, and it is the
      same allowance as ever: `approval.begin` holds this flow's own callback
      address and `endApproval` closes it on every path out of the connect. The
      page's navigation to the redirect the control plane hands it is the one
      navigation this feature makes, and it is bounded by exactly the rule
      #312's approve screen was.
    */
    ctx.approval.begin(target, returnAfterApproval(from, ctx.consoleAddress, consoleOrigin(ctx.consoleAddress)));
    ctx.handover.begin({ requestId: parked, authorize: target.authorize });
    ctx.consoleBridge.emitPendingApproval({ requestId: parked });
    // The window is not navigated and not raised: the person is already looking
    // at the console, and this is meant to be a thing that happened rather than
    // a thing they were interrupted by.
    setTimeout(() => {
      const stale = ctx.handover.take(parked);
      if (stale === null) return;
      // Nobody answered. That is a page that could not, so the person gets the
      // screen — the same one they would have got before any of this existed.
      void fallBackToApproveScreen(stale.authorize);
    }, APPROVAL_ANSWER_MS).unref?.();
    return true;
  }

  /**
   * The page has answered a parked approval.
   *
   * Only ever about the one this machine is waiting on: `take` answers `null`
   * for anything else, so a page that reloaded, a second window, or a message
   * about a connect that is already over does nothing at all.
   *
   * An `approved: true` closes the handover and waits — the code is on its way
   * to the loopback listener, and `connectMachine` is what receives it. An
   * `approved: false` is a page that could not, and the person gets the approve
   * screen rather than a dead end.
   */
  function answerFromConsole(result: MachineApprovalResult): void {
    const pending = ctx.handover.take(result.requestId);
    if (pending === null) return;
    ctx.consoleBridge?.emitPendingApproval(null);
    if (result.approved) return;
    void fallBackToApproveScreen(pending.authorize);
  }

  /**
   * Put #312's approve screen in this window after all.
   *
   * The parked request the page could not answer is left where it is — it
   * expires on its own in ten minutes and nothing can be spent against it —
   * and the window is navigated to the authorize URL, which parks a second
   * one. That is honest rather than tidy: the alternative is this process
   * inventing a way to un-park somebody else's row, and the flow already
   * survives a request nobody answers.
   */
  async function fallBackToApproveScreen(href: string): Promise<void> {
    ctx.consoleBridge?.emitPendingApproval(null);
    if (await approveInConsoleWindow(href)) return;
    await openInSystemBrowser(href).catch(() => {
      // A machine whose browser will not open is a real case. The URL was
      // logged when the flow started and the listener is still waiting.
    });
  }

  /**
   * Put the window back where it was, and close the loopback allowance with it.
   *
   * Both halves matter and they are one call because forgetting either is the
   * defect: an allowance left open is a standing permission for a page to walk
   * to a socket on this machine, and a window left on the loopback listener's
   * "Connected" page is a person stranded on a page whose server has closed.
   */
  function endApproval(): void {
    /*
      The handover closes with the allowance, and for the same reason: an
      approval this machine is no longer waiting on must not be answerable, and
      a card left offering to mint a grant for a connect that is over is a
      button whose only outcome is a refusal. Both are idempotent, so every
      path out of `connectThisMachine` can call this.
    */
    ctx.handover.end();
    ctx.consoleBridge?.emitPendingApproval(null);
    const back = ctx.approval.end();
    if (back === null) return;
    const win = liveConsoleWindow();
    if (win === null) return;
    void win.loadURL(back).catch(() => {
      // Offline, most likely. `consoleMirror` owns the failed load and serves
      // the mirrored console in its place.
    });
  }

  /**
   * Connect this machine to a context.
   *
   * The endpoint is the person's own: self-hosting is a supported path and
   * there is no hard-coded gateway anywhere in this app. Everything after it —
   * discovery, registration, the approval, the exchange — is `packages/hook`'s
   * reviewed flow, and the record it produces goes straight to the keychain
   * without passing through a renderer.
   *
   * **The approval happens in this window when there is one.** The person is
   * already signed in to the console here; sending them to a browser where they
   * are not was two sign-ins and a tab to close for one grant. The consent
   * dialog goes with it in that case — the approve screen the control plane
   * renders *is* the consent, it names the same scopes at more length, and a
   * modal in front of it was this app asking a question the next screen asks
   * properly. Tray-only launches have no window to approve in, so they keep
   * both the dialog and the browser.
   */
  async function connectThisMachine(): Promise<void> {
    if (ctx.connecting) return;
    ctx.connecting = true;
    ctx.connectError = null;
    push();
    try {
      if (liveConsoleWindow() === null || ctx.consoleAddress === null) {
        // A sheet on the window when there is one — see `explain()` for why a
        // parentless `showMessageBox` stops the whole main process. Reached
        // with a live window whenever `consoleAddress` is the half that is
        // missing, which is the case this argument is for.
        const answer = await askSomething(liveConsoleWindow(), {
          type: "question",
          title: "Connect this machine",
          message: `Connect this machine to ${ctx.settings.gatewayEndpoint}`,
          detail:
            "Your browser will open so you can approve this machine. It is registered as its own connection, so you can revoke this laptop on its own — and it asks only for what a meeting needs: to write notes, at your own privacy tier.",
          buttons: ["Open my browser", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer.response !== 0) return;
      }

      const record = await connectMachine({
        endpoint: ctx.settings.gatewayEndpoint,
        log: (message) => console.log(message),
        openBrowser: async (href) => {
          /*
            Three ways to put this in front of the person, in the order that
            asks them for the least.

            The first is new and is the whole of this change: the console in
            this window is signed in as them, so the parked request is handed
            to *it* and answered with that session — no screen, no browser, no
            second sign-in. `docs/decisions/desktop.md` is the argument and
            `core/shell/autoGrant.ts` is the mechanism.

            The second is #312's, unchanged, and is what every refusal falls
            back to: the approve screen, in this window. The third is the
            system browser, for a tray-only launch with no window to show
            anything in.
          */
          const target = approvalTargetFor(href);
          if (target !== null && (await askConsoleToApprove(href, target))) return;
          if (await approveInConsoleWindow(href)) return;
          await openInSystemBrowser(href);
        },
      });
      await connection.connect(record);
      /*
        Two settings move, and both are consequences of the same yes.

        `gatewayBaseUrl` is kept here as well as with the credential so the
        panel can name where meetings go without unlocking anything — it is not
        a credential and never one; the value the requests use is the one stored
        beside the token.

        `captureEnabled` is switched on, and this is the only place it is.

        Two things happened in the same breath: a person approved this machine
        against their own context, in a dialog that says it is for meetings, and
        the app got somewhere to put one. That is the yes `captureEnabled`
        records. It is not turned back off on disconnect — the meetings already
        in the queue are still theirs, and a machine that forgot the answer
        every time a grant expired would ask again for no reason.
      */
      await update({ gatewayBaseUrl: record.gatewayBaseUrl, captureEnabled: true });
      /*
        Here rather than only in `finally`, because everything below this line
        takes time a person would spend looking at the loopback listener's
        "Connected" page: the transcription question is a modal over it, and the
        drain can run for as long as the queue is long. `endApproval` is
        idempotent — the `finally` still runs it, and still matters, because
        every path that does not reach this line has to close the allowance too.
      */
      endApproval();
      await askAboutTranscription();
      // Whatever the queue is holding has been waiting for exactly this.
      await drain();
    } catch (error) {
      ctx.connectError = error instanceof Error ? error.message : "the connection could not be completed";
    } finally {
      // Before `push()`, so the console the window is being returned to draws
      // the state this connect ended in rather than the one it started from.
      endApproval();
      ctx.connecting = false;
      push();
    }
  }

  /**
   * Where the audio goes, asked once, in the one place a person can answer it.
   *
   * The default is `on-device`, which is the engine that does not exist yet —
   * chosen deliberately, because the alternative is an app whose first meeting
   * streams audio off the machine because nobody was asked. So this is the ask,
   * and it is made at the moment somebody has just connected a machine to their
   * own context rather than buried in a settings pane this app does not have.
   *
   * A "not now" is a real answer and leaves the app in the honest state it was
   * already in: meetings are typed, the panel says why, and the notes still
   * land in the bucket.
   */
  async function askAboutTranscription(): Promise<void> {
    if (ctx.settings.transcription === "cloud") return;
    // A sheet on the console window when there is one. This runs at the end of
    // a connect, so the queue behind it may already be holding meetings — and
    // an application-modal alert would stop the drain that is about to send
    // them. See `explain()` for the measurement.
    const answer = await askSomething(liveConsoleWindow(), {
      type: "question",
      title: "Transcribe meetings",
      message: "Transcribe meetings through your gateway?",
      detail:
        "Each twenty seconds of audio is sent to your own gateway, transcribed, and thrown away — it is never written to your bucket and never kept. Until you turn this on, meetings are typed: nothing opens your microphone.",
      buttons: ["Transcribe my meetings", "Not now"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0) await update({ transcription: "cloud" });
  }

  /**
   * Give the grant up.
   *
   * The outbox is deliberately left alone: somebody disconnecting has not asked
   * to lose the meetings that have not been sent yet, and connecting again
   * drains them. What goes is the credential.
   */
  async function disconnectThisMachine(): Promise<void> {
    await connection.disconnect();
    ctx.connectError = null;
    await update({ gatewayBaseUrl: null });
  }

  return { answerFromConsole, connectThisMachine, disconnectThisMachine };
}
