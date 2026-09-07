/**
 * The menu bar, which is the entire always-on interface.
 *
 * Everything it draws comes from `core/tray/presentation.ts`, which is a pure
 * function with its own checks — including the one that matters: `indicator` is
 * true for exactly the states in which audio is open. This file may not draw
 * anything else for those states, and the reason it is so thin is so that
 * nobody can.
 *
 * The icons are drawn here rather than shipped as PNGs. Five 16pt template
 * marks in inline SVG: an unfilled ring when idle, a filled ring when armed, a
 * ring with a dot when a meeting is detected, and a solid disc for recording —
 * which macOS tints red because it is *not* a template image, and a recording
 * indicator that quietly inverts with the menu bar's theme is one nobody sees.
 */

import { Menu, Tray, nativeImage } from "electron";
import type { TrayPresentation } from "../core/tray/presentation.ts";

const RING = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="black" stroke-width="1.6"/></svg>`;
const RING_FILLED = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="black" stroke-width="1.6"/><circle cx="8" cy="8" r="2" fill="black"/></svg>`;
const RING_DETECTED = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="black" stroke-width="1.6"/><circle cx="8" cy="8" r="3.4" fill="black"/></svg>`;
/** Not a template image: this one keeps its red wherever the menu bar goes. */
const RECORDING = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="#DC2626"/></svg>`;

function image(svg: string, template: boolean): Electron.NativeImage {
  const icon = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
  );
  icon.setTemplateImage(template);
  return icon;
}

const ICONS = {
  idle: () => image(RING, true),
  armed: () => image(RING_FILLED, true),
  detected: () => image(RING_DETECTED, true),
  recording: () => image(RECORDING, false),
};

export interface TrayActions {
  togglePanel: (bounds: Electron.Rectangle) => void;
  openNotepad: () => void;
  /** "Record a meeting" — the yes, given about a meeting nothing detected. */
  record: () => void;
  end: () => void;
  toggleDetection: () => void;
  connect: () => void;
  disconnect: () => void;
  /** "Restart to update" — refused by `DesktopUpdater.install()` mid-meeting. */
  installUpdate: () => void;
  quit: () => void;
}

/** What the menu needs to know about the app, beyond what the icon draws. */
export interface TrayMenuState {
  recording: boolean;
  detectionEnabled: boolean;
  connected: boolean;
  /**
   * An update finished downloading and nothing is recording — `DesktopUpdater`
   * reached `"ready"`. False while idle, while a capture holds it at
   * `"deferred-for-recording"`, and once nothing more is armed at all.
   */
  updateReady: boolean;
}

export class AppTray {
  #tray: Tray;
  #actions: TrayActions;
  #state: TrayMenuState = { recording: false, detectionEnabled: false, connected: false, updateReady: false };

  constructor(actions: TrayActions) {
    this.#actions = actions;
    this.#tray = new Tray(ICONS.idle());
    this.#tray.on("click", (_event, bounds) => this.#actions.togglePanel(bounds));
    this.#tray.on("right-click", () => this.#tray.popUpContextMenu(this.#menu()));
  }

  /**
   * The menu, built fresh every time it opens.
   *
   * Built rather than kept, because every item in it is conditional: Record is
   * not offered during a recording, End is not offered outside one, and a
   * machine with no grant is asked to connect rather than offered a Disconnect
   * that would do nothing. A stale menu here is somebody pressing Record on a
   * meeting that is already being recorded.
   *
   * The checkbox once read `checked: true` unconditionally, which is the same
   * class of bug one line further on: a menu that says the app is watching for
   * meetings when it is not.
   */
  #menu(): Electron.Menu {
    const { recording, detectionEnabled, connected, updateReady } = this.#state;
    return Menu.buildFromTemplate([
      ...(recording
        ? [{ label: "End & write up", click: () => this.#actions.end() }]
        : [{ label: "Record a meeting", click: () => this.#actions.record() }]),
      { label: recording ? "Open notepad" : "Open the last meeting", click: () => this.#actions.openNotepad() },
      { type: "separator" as const },
      {
        label: "Watch for meetings",
        type: "checkbox" as const,
        checked: detectionEnabled,
        click: () => this.#actions.toggleDetection(),
      },
      { type: "separator" as const },
      connected
        ? { label: "Disconnect this machine…", click: () => this.#actions.disconnect() }
        : { label: "Connect this machine…", click: () => this.#actions.connect() },
      // Offered only once an update is actually ready to apply — never while a
      // meeting is recording, because `updateReady` cannot be true then (see
      // `DesktopUpdater`/`core/update/policy.ts`), and `install()` refuses the
      // click again regardless, in case this menu is ever stale.
      ...(updateReady
        ? [{ type: "separator" as const }, { label: "Restart to update", click: () => this.#actions.installUpdate() }]
        : []),
      { type: "separator" as const },
      { label: "Quit Context", click: () => this.#actions.quit() },
    ]);
  }

  /** What the menu offers next time it opens. Pushed on every state change. */
  setMenuState(state: TrayMenuState): void {
    this.#state = state;
  }

  /** Draw whatever the pure function said, and nothing else. */
  render(presentation: TrayPresentation): void {
    this.#tray.setImage(ICONS[presentation.icon]());
    this.#tray.setTitle(presentation.title, { fontType: "monospacedDigit" });
    this.#tray.setToolTip(presentation.tooltip);
    this.#tray.setContextMenu(null);
  }

  /** Where the icon is, so the panel can be put under it. */
  bounds(): Electron.Rectangle {
    return this.#tray.getBounds();
  }

  destroy(): void {
    this.#tray.destroy();
  }
}
