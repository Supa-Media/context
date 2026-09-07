/**
 * `window.desktop`, version 1, with nothing behind it yet.
 *
 * This is the first step of `docs/decisions/desktop.md`'s order: the shell can
 * host the console, the page can tell it is running inside a shell, and every
 * capability answers `false`. A web bundle that already knows how to degrade —
 * `features/meetings/capture/audio.web.ts` is microphone-only and says so —
 * therefore behaves in this shell exactly as it does in a browser, which is
 * what makes this step shippable on its own.
 *
 * Two properties it shares with `preload/index.ts` and must never lose: there
 * is no generic `invoke`, and there is no way to read the gateway credential.
 * The token lives in `safeStorage` in the main process and every request that
 * carries one is made there.
 *
 * ## Why the origin is fetched synchronously
 *
 * The bridge has to be on `window` before the page's first script runs, so the
 * pin cannot be awaited. `sendSync` is the one call in this file and it returns
 * a public value — knowing which origin the shell pinned tells an attacker
 * nothing they could not read off the window's own URL. What it buys is that
 * the pin is the *main process's* answer rather than something baked into a
 * bundle, so a self-hoster's `CONTEXT_DESKTOP_UI_URL` is honoured by one file.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_VERSION,
  NO_CAPABILITIES,
  shouldExposeBridge,
  type DesktopCapabilities,
} from "../core/shell/console.ts";

/** Answered by the main process with the origin this window is pinned to. */
export const CONSOLE_ORIGIN_CHANNEL = "context:console-origin";

/** Answered with `{ app, version, platform }`. No credential, no paths. */
export const CONSOLE_SHELL_CHANNEL = "context:console-shell";

export interface DesktopShellInfo {
  app: string;
  version: string;
  platform: "macos" | "windows" | "linux";
}

function pinnedOrigin(): string {
  try {
    return String(ipcRenderer.sendSync(CONSOLE_ORIGIN_CHANNEL) ?? "");
  } catch {
    // A window whose main process will not answer is a window that gets no
    // bridge. Failing closed is the only safe direction here.
    return "";
  }
}

function shellInfo(): DesktopShellInfo | null {
  try {
    return (ipcRenderer.sendSync(CONSOLE_SHELL_CHANNEL) as DesktopShellInfo) ?? null;
  } catch {
    return null;
  }
}

/*
  Fail closed on a window that is not there.

  Written as `globalThis.window === globalThis.window?.top` this reads as a
  frame check and is one only while `window` exists — in a context where it does
  not, `undefined === undefined` is true and the frame guard silently passes.
  A preload with no window should expose nothing, so absence is a refusal.
*/
const frame = globalThis.window;
const exposed = shouldExposeBridge({
  pinned: pinnedOrigin(),
  origin: globalThis.location?.origin ?? "",
  isTopFrame: frame !== undefined && frame !== null && frame === frame.top,
});

if (exposed) {
  const shell = shellInfo();
  contextBridge.exposeInMainWorld(
    "desktop",
    Object.freeze({
      version: BRIDGE_VERSION,
      shell,
      /*
        Async on purpose, and it is a promise this step does not need.

        What a build can do is discovered rather than declared — whether macOS
        hands over a loopback tap is only knowable by asking for one — so the
        answer has to be able to come from the main process. Making it sync now
        would make step 2 a breaking change to a surface that has already
        shipped in a binary people cannot be made to update.
      */
      capabilities: async (): Promise<DesktopCapabilities> => ({ ...NO_CAPABILITIES }),
    }),
  );
}
