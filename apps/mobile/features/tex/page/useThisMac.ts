import { useCallback, useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import { getDesktopBridge, type MachineRunStatus } from "@context/desktop-bridge";

/**
 * "Let Tex use this Mac", when the page runs inside the Mac app (bridge
 * version 10). `null` everywhere else: a browser, a phone, or an older app,
 * where the switch is not drawn at all, because a switch that cannot do
 * anything is never shown (design audit, finding 1).
 */
export interface ThisMac {
  status: MachineRunStatus;
  setEnabled: (on: boolean) => void;
  /**
   * The folders Tex may work in, chosen in the Mac's own picker (bridge
   * version 11), or `null` on an older app, where no folder row is drawn.
   * `list` is `null` until it is read (the Mac registers when first turned on).
   */
  folders: { list: string[] | null; choose: () => void } | null;
}

export function useThisMac(): ThisMac | null {
  const machine = Platform.OS === "web" ? (getDesktopBridge()?.machine ?? null) : null;
  const [status, setStatus] = useState<MachineRunStatus | null>(null);
  const [folders, setFolders] = useState<string[] | null>(null);
  /** Turned on just now: once its folders read empty, the picker opens by itself (Dev2, 2026-11-04). */
  const pickWhenEmpty = useRef(false);
  const readFolders = machine?.folders;
  const chooseFolders = machine?.chooseFolders;
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
  const online = status?.enabled === true && status.state === "online";
  const choose = useCallback(() => {
    if (!chooseFolders) return;
    pickWhenEmpty.current = false;
    void chooseFolders().then((list) => setFolders(list));
  }, [chooseFolders]);
  useEffect(() => {
    if (!online || !readFolders) return;
    let live = true;
    void readFolders().then((list) => {
      if (!live) return;
      setFolders(list);
      if (list !== null && list.length === 0 && pickWhenEmpty.current) choose();
    });
    return () => {
      live = false;
    };
  }, [online, readFolders, choose]);
  const setEnabled = useCallback(
    (on: boolean) => {
      if (machine === null) return;
      pickWhenEmpty.current = on;
      // Show the answer at once; the shell's own status follows.
      setStatus((s) => (s ? { ...s, enabled: on, state: on ? "starting" : "off" } : s));
      void machine.setEnabled(on).then(setStatus);
    },
    [machine],
  );
  if (machine === null || status === null) return null;
  return { status, setEnabled, folders: readFolders && chooseFolders ? { list: folders, choose } : null };
}

/** A folder as the owner reads it: their home folder as `~`. */
export function folderLabel(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");
}

/** The folder row's line: which folders, or what having none means. */
export function foldersLine(list: string[] | null): string {
  if (list === null) return "Checking…";
  if (list.length === 0) return "None yet. Tex can't start a job here until you choose one.";
  return list.map(folderLabel).join(" · ");
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
