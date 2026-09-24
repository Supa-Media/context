/**
 * What the shell looks like right now, and the one function that publishes it.
 *
 * Moved from `main()` verbatim: `push()` renders the tray, sends the renderer
 * windows their `UiState` and the console its four narrow views; `update()`
 * is the only writer of the settings file.
 */

import type { TrayCommand } from "@context/desktop-bridge";
import { episodeKey } from "../core/consent/gate.ts";
import { MEETING_TIER_REFUSAL, grantCoversMeetings } from "../core/sync/connection.ts";
import { trayPresentation } from "../core/tray/presentation.ts";
import type { TrayState } from "../core/tray/presentation.ts";
import type { DesktopSettings } from "../core/settings.ts";
import { CHANNELS } from "./ipc.ts";
import type { UiState } from "./ipc.ts";
import type { MainActions, MainContext } from "./context.ts";

export function createShellView(ctx: MainContext): Pick<MainActions, "pressed" | "uiState" | "push" | "update"> {
  const { controller, connection, tokens, tray, updater, panel, notepad, store, imessage } = ctx;
  // Late-bound: these live in other modules and are read from `ctx` at call time.
  const captureStateUpdate: MainActions["captureStateUpdate"] = () => ctx.captureStateUpdate();
  const outboxStatus: MainActions["outboxStatus"] = () => ctx.outboxStatus();

  /**
   * A verb somebody pressed in the shell's own UI, done and announced.
   *
   * The tray is a complete capture surface on its own — a person can record a
   * whole meeting with the console never having loaded — so these are not the
   * page's only route to these verbs. They are told to the page so that a
   * console that *is* open agrees with the menu bar instead of drawing a stale
   * Record button, which is the whole of what `onTrayCommand` is for.
   *
   * Announced *before* the work rather than after it: `end()` awaits a drain,
   * and a page that learned about the press only once the queue had emptied
   * would show the old state for as long as the network took.
   */
  function pressed(command: TrayCommand, run: () => Promise<unknown>): Promise<unknown> {
    ctx.consoleBridge?.emitTrayCommand(command);
    return run();
  }

  function trayState(): TrayState {
    const view = controller.view();
    if (view?.state === "failed") return "failed";
    if (view?.state === "finalizing") return "finalizing";
    if (view?.state === "recording" || view?.state === "paused") return "recording";
    if (ctx.lastUpdate?.state.active) return "detected";
    return ctx.settings.detectionEnabled ? "armed" : "idle";
  }

  function uiState(): UiState {
    const view = controller.view();
    const presentation = trayPresentation({
      state: trayState(),
      elapsedMs: controller.elapsedMs(),
      title: view?.title ?? ctx.lastUpdate?.result.suggestedTitle ?? null,
      pending: new Set(ctx.outbox.entries.map((entry) => entry.sessionId)).size,
      degraded: ctx.lastUpdate?.degraded ?? [],
    });
    return {
      tray: {
        state: presentation.state,
        title: presentation.title,
        tooltip: presentation.tooltip,
        indicator: presentation.indicator,
      },
      detection:
        ctx.lastUpdate && ctx.lastUpdate.state.active
          ? {
              active: true,
              episode: episodeKey(ctx.lastUpdate.state),
              suggestedTitle: ctx.lastUpdate.result.suggestedTitle,
              sourceLabel: ctx.lastUpdate.state.source?.app ?? ctx.lastUpdate.state.source?.kind ?? "a meeting",
              summary: ctx.lastUpdate.summary,
              evidence: ctx.lastUpdate.evidence,
              degradedNotice: ctx.lastUpdate.degradedNotice,
              attendees: ctx.lastUpdate.result.suggestedAttendees.length,
            }
          : null,
      session: view
        ? {
            id: view.id,
            title: view.title,
            state: view.state,
            elapsedMs: controller.elapsedMs(),
            notes: view.notes,
            transcript: view.transcript.map((segment) => ({
              id: segment.id,
              startMs: segment.startMs,
              text: segment.text,
              speaker: segment.speaker,
              channel: segment.channel,
            })),
            transcriptionLabel: view.transcriptionLabel,
            audioLeavesDevice: view.audioLeavesDevice,
            capturing: view.capturing,
            audio: view.audio,
            notice: view.notice,
          }
        : null,
      settings: {
        askBeforeEveryMeeting: ctx.settings.askBeforeEveryMeeting,
        blocklist: ctx.settings.blocklist,
        captureEnabled: ctx.settings.captureEnabled,
        detectionEnabled: ctx.settings.detectionEnabled,
      },
      connection: {
        state: connection.state(),
        gateway: connection.baseUrl(),
        // Said out loud rather than hidden: a machine with no encrypted storage
        // holds its credential for this launch only, and a person who sees the
        // app ask to be connected after every restart is owed the reason.
        encrypted: tokens.encrypted,
        connecting: ctx.connecting,
        /*
          The last attempt's failure, or the standing one: a machine connected
          at the narrower tier is a machine holding its meetings, and the reason
          has to be readable *whenever* that is true rather than only in the
          seconds after the connect that caused it. So it is derived from the
          grant on every push rather than latched into `connectError` once —
          a restart, a refresh, or a grant that predates the tier existing all
          reach this line and all say the same thing. `connectError` still wins
          when there is one: it is newer and more specific.
        */
        error:
          ctx.connectError ??
          (connection.state() === "connected" && !grantCoversMeetings(connection.scope())
            ? MEETING_TIER_REFUSAL
            : null),
      },
      pending: new Set(ctx.outbox.entries.map((entry) => entry.sessionId)).size,
      missingPermissions: ctx.missingPermissions,
    };
  }

  function push(): void {
    const state = uiState();
    tray.setMenuState({
      recording: controller.recording,
      detectionEnabled: ctx.settings.detectionEnabled,
      imessageEnabled: ctx.settings.imessageEnabled,
      connected: state.connection.state === "connected",
      updateReady: updater.state === "ready",
    });
    tray.render(
      trayPresentation({
        state: trayState(),
        elapsedMs: controller.elapsedMs(),
        title: state.session?.title ?? state.detection?.suggestedTitle ?? null,
        pending: state.pending,
        degraded: ctx.lastUpdate?.degraded ?? [],
      }),
    );
    for (const window of [panel, notepad]) {
      if (window !== null && !window.isDestroyed()) window.webContents.send(CHANNELS.state, state);
    }
    /*
      The same change, in the vocabulary the contract uses.

      Four narrow views rather than the whole `UiState`, and that is not an
      optimisation: `UiState` is this app's internal shape and the console is a
      *remote origin*. Sending it whole would mean every field ever added to
      the panel's state is also published to whatever `CONTEXT_DESKTOP_UI_URL`
      points at, which is precisely the accident the bridge exists to make
      impossible.
    */
    ctx.consoleBridge?.push({
      captureState: captureStateUpdate(),
      connection: { ...state.connection },
      outbox: outboxStatus(),
      detection: state.detection,
    });
  }

  async function update(patch: Partial<DesktopSettings>): Promise<void> {
    ctx.settings = { ...ctx.settings, ...patch };
    await store.writeSettings(ctx.settings);
    if ("imessageEnabled" in patch) imessage.reconfigure();
    push();
  }

  return { pressed, uiState, push, update };
}
