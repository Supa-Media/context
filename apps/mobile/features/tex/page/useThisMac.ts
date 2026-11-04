import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import { getDesktopBridge, type MachineRunStatus } from "@context/desktop-bridge";

/**
 * "Let Tex use this Mac", when the page runs inside the Mac app (bridge
 * version 10). `null` everywhere else: a browser, a phone, or an older app,
 * where the switch is not drawn at all, because a switch that cannot do
 * anything is never shown (design audit, finding 1).
 */
export function useThisMac(): { status: MachineRunStatus; setEnabled: (on: boolean) => void } | null {
  const machine = Platform.OS === "web" ? (getDesktopBridge()?.machine ?? null) : null;
  const [status, setStatus] = useState<MachineRunStatus | null>(null);
  useEffect(() => {
    if (machine === null) return;
    let live = true;
    void machine.status().then((s) => live && setStatus(s));
    const off = machine.onChange((s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, [machine]);
  const setEnabled = useCallback(
    (on: boolean) => {
      if (machine === null) return;
      // Show the answer at once; the shell's own status follows.
      setStatus((s) => (s ? { ...s, enabled: on, state: on ? "starting" : "off" } : s));
      void machine.setEnabled(on).then(setStatus);
    },
    [machine],
  );
  return machine !== null && status !== null ? { status, setEnabled } : null;
}

/** The switch row's line under "Let Tex use this Mac". */
export function thisMacLine(s: MachineRunStatus): string {
  if (!s.available) return "This version of the app can't run Tex's jobs yet";
  if (s.message) return s.message;
  switch (s.state) {
    case "off":
      return "Tex runs coding jobs here with your Claude Code";
    case "starting":
      return "Starting…";
    case "online":
      return `Ready · ${s.busy} of ${s.slots} busy${s.awake ? " · stays awake while plugged in" : ""}`;
    case "paused":
      return "Paused · today's limit is used up";
    case "notReady":
      return "Sign in to Claude Code or Codex on this Mac";
    case "offline":
      return "Can't reach Context right now; trying again";
    default:
      return "Tex can't use this Mac right now";
  }
}
