/**
 * `window.desktop`, version 1, wired to the shell that is actually behind it.
 *
 * Deliberately four statements long. Everything the bridge *is* — the channels,
 * the normalisers, the unsubscribes, the closed set of sentences — lives in
 * `core/shell/bridge.ts`, which imports no Electron and is therefore driven end
 * to end by `test/consoleBridge.test.mjs`. What is left here is the part that
 * genuinely needs `electron`: two objects to hand it, and the two facts about
 * this document that decide whether it gets a bridge at all.
 *
 * Three properties this file must never lose, and none of them is enforced
 * here:
 *
 *  - **There is no generic `invoke`** — `bridge.ts` names one channel per verb.
 *  - **There is no way to read the gateway credential.** The token lives in
 *    `safeStorage` in the main process and every request that carries one is
 *    made there. `connection.get()` answers three words and a base URL.
 *  - **The bridge is exposed to exactly one document**: the pinned origin, in
 *    the top frame. `shouldExposeBridge` decides, the main process re-checks
 *    the sender on every channel it answers, and the two are separate checks
 *    because this one runs in the renderer — and a compromised renderer is the
 *    threat model.
 */

import { contextBridge, ipcRenderer } from "electron";
import { installDesktopBridge } from "../core/shell/bridge.ts";

/*
  Fail closed on a window that is not there.

  Written as `globalThis.window === globalThis.window?.top` this reads as a
  frame check and is one only while `window` exists — in a context where it does
  not, `undefined === undefined` is true and the frame guard silently passes.
  A preload with no window should expose nothing, so absence is a refusal.
*/
const frame = globalThis.window;

installDesktopBridge(contextBridge, ipcRenderer, {
  origin: globalThis.location?.origin ?? "",
  isTopFrame: frame !== undefined && frame !== null && frame === frame.top,
});
