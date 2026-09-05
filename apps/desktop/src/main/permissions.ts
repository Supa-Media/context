/**
 * The Electron implementation of `PermissionBroker`.
 *
 * Thin, and worth reading for the two macOS facts it encodes.
 *
 * **The microphone can be asked for; Screen Recording cannot.**
 * `systemPreferences.askForMediaAccess("microphone")` shows the system dialog
 * and resolves with the answer. There is no equivalent for screen capture: the
 * only way to raise that prompt is to *attempt a capture*, which macOS
 * intercepts. So `request("screen")` reports the status and leaves the prompt
 * to the first `getDisplayMedia` call, and the panel says what will happen next
 * rather than pretending a dialog is coming from us.
 *
 * **`not-determined` is the only status worth asking about.** A `denied`
 * permission cannot be re-prompted at all — macOS ignores the call — so the app
 * must send the person to System Settings instead of spinning on a dialog that
 * will never appear. `ensureCapturePermissions` never calls `request` for a
 * denied permission; this file would be harmless if it did, but the reason the
 * two halves are split is that this one cannot be tested and that one can.
 */

import { shell, systemPreferences } from "electron";
import type { PermissionBroker, PermissionKind, PermissionStatus } from "../core/capture/permissions.ts";

const PANES: Readonly<Record<PermissionKind, string>> = Object.freeze({
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
});

function translate(status: string): PermissionStatus {
  switch (status) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    case "restricted":
      return "restricted";
    case "not-determined":
      return "not-determined";
    default:
      return "unknown";
  }
}

export function electronPermissionBroker(): PermissionBroker {
  return {
    async status(kind) {
      if (process.platform !== "darwin") return "unknown";
      if (kind === "microphone") return translate(systemPreferences.getMediaAccessStatus("microphone"));
      return translate(systemPreferences.getMediaAccessStatus("screen"));
    },
    async request(kind) {
      if (process.platform !== "darwin") return "unknown";
      if (kind === "microphone") {
        const granted = await systemPreferences.askForMediaAccess("microphone");
        return granted ? "granted" : "denied";
      }
      // See the header: there is no API that raises this prompt. The status is
      // reported as it stands and the capture attempt raises the dialog.
      return translate(systemPreferences.getMediaAccessStatus("screen"));
    },
  };
}

/** Open the right System Settings pane for a permission the person refused. */
export async function openPermissionSettings(kind: PermissionKind): Promise<void> {
  if (process.platform !== "darwin") return;
  await shell.openExternal(PANES[kind]);
}
