/**
 * A ciphertext transition announced to the other open consoles on this
 * device.
 *
 * The message contains only routing metadata. In particular it never carries
 * the passphrase, derived key, plaintext, or envelope. `BroadcastChannel`
 * deliberately does not persist the message, and posting on the same channel
 * object does not deliver it back to the sender — the tab that performed the
 * lock is allowed to stay unlocked while every other tab forgets its copy.
 *
 * This closes the synchronous cross-tab window. Another device cannot hear a
 * browser channel; it still purges a stale draft when it next reads the now
 * encrypted note (see `useFileBrowser.openNote`). A durable cross-device push
 * needs a server-side revision signal and is a separate protocol, not
 * something this local message pretends to provide.
 */

import { useCallback, useEffect, useRef } from "react";

const CHANNEL_NAME = "context.note-encryption.v1";

interface LockMessage {
  v: 1;
  type: "note-encrypted";
  workspaceId: string;
  path: string;
}

interface ChannelLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
}

type ChannelConstructor = new (name: string) => ChannelLike;

function channelConstructor(): ChannelConstructor | null {
  const candidate = (globalThis as { BroadcastChannel?: ChannelConstructor })
    .BroadcastChannel;
  return typeof candidate === "function" ? candidate : null;
}

function lockMessage(value: unknown): LockMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const message = value as Partial<LockMessage>;
  if (
    message.v !== 1 ||
    message.type !== "note-encrypted" ||
    typeof message.workspaceId !== "string" ||
    message.workspaceId.length === 0 ||
    typeof message.path !== "string" ||
    message.path.length === 0
  ) {
    return null;
  }
  return message as LockMessage;
}

export function useNoteLockPropagation(
  workspaceId: string | null,
  onLock: (path: string) => void,
): (path: string) => void {
  const channelRef = useRef<ChannelLike | null>(null);
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  useEffect(() => {
    const Channel = channelConstructor();
    if (Channel === null || workspaceId === null) {
      channelRef.current = null;
      return;
    }

    const channel = new Channel(CHANNEL_NAME);
    channel.onmessage = (event) => {
      const message = lockMessage(event.data);
      if (message?.workspaceId === workspaceId) onLockRef.current(message.path);
    };
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, [workspaceId]);

  return useCallback(
    (path: string) => {
      if (workspaceId === null || path.length === 0) return;
      channelRef.current?.postMessage({
        v: 1,
        type: "note-encrypted",
        workspaceId,
        path,
      } satisfies LockMessage);
    },
    [workspaceId],
  );
}
