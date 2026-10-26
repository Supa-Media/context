import { useEffect, useState } from "react";
import {
  getDesktopBridge,
  type DesktopBridge,
  type ImessageStatus,
  type MessagesBackupDownload,
  type MessagesBackupFilesChoice,
} from "@context/desktop-bridge";

/**
 * The Messages backup on this Mac, as the Mac app reports it, kept live.
 *
 * `null` outside the Mac app, on a Mac app with no Messages member, and until
 * its first answer. Asked once and then subscribed, and the unsubscribe is
 * used: a settings page is opened and closed all day.
 */
export function useBackupStatus(): {
  bridge: DesktopBridge | null;
  status: ImessageStatus | null;
  changing: boolean;
  setEnabled: (enabled: boolean) => void;
  /** Null on a Mac app that cannot change what is copied. */
  setFiles: ((choice: MessagesBackupFilesChoice) => void) | null;
  /** Null on a Mac app that cannot download the backup, and off the Mac app. */
  download: (() => Promise<MessagesBackupDownload>) | null;
  openFullDiskAccess: () => void;
} {
  const [bridge] = useState(() => getDesktopBridge());
  const [status, setStatus] = useState<ImessageStatus | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    const member = bridge?.imessage;
    if (member === undefined) return;
    let live = true;
    void member.status().then(
      (value) => {
        if (live) setStatus(value);
      },
      () => {},
    );
    const off = member.onChange((value) => {
      if (live) setStatus(value);
    });
    return () => {
      live = false;
      off();
    };
  }, [bridge]);

  return {
    bridge,
    status,
    changing,
    setEnabled: (enabled) => {
      const member = bridge?.imessage;
      if (member === undefined) return;
      setChanging(true);
      void member
        .setEnabled(enabled)
        .then(() => member.status())
        .then(setStatus, () => {})
        .finally(() => setChanging(false));
    },
    setFiles:
      bridge?.imessage?.setFiles === undefined
        ? null
        : (choice) => {
            const member = bridge.imessage;
            if (member?.setFiles === undefined) return;
            setChanging(true);
            void member
              .setFiles(choice)
              .then(() => member.status())
              .then(setStatus, () => {})
              .finally(() => setChanging(false));
          },
    download:
      bridge?.imessage?.download === undefined
        ? null
        : () => bridge.imessage!.download!().catch((): MessagesBackupDownload => ({ ok: false, problem: "unavailable" })),
    openFullDiskAccess: () => {
      void bridge?.imessage?.requestFullDiskAccess().catch(() => {});
    },
  };
}
