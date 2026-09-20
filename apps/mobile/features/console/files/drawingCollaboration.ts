/**
 * The seam between the presence socket and the canvas.
 *
 * `usePresence` announces what arrives by calling handlers it was given;
 * `DrawingEditor` wants to subscribe to them, and is mounted a long way below
 * the screen that owns the socket. A channel in between is the smallest thing
 * that satisfies both, and it is a plain emitter rather than React state on
 * purpose: a pointer frame lands on every mouse move of every person on the
 * canvas, and putting that through a render would redraw the console at the
 * frame rate of everybody else's mouse.
 *
 * Nothing here merges anything. The elements pass through untouched — the
 * reconciliation is Excalidraw's `reconcileElements`, and it runs in the editor
 * page because Excalidraw does. This console deliberately holds no second copy
 * of the scene: a copy is a thing that can be stale, and a stale scene spliced
 * into a file is somebody's diagram losing a shape.
 */

import { useMemo, useRef } from "react";
import type { PeerPointer, Presence } from "../presence/usePresence";

/** What `DrawingEditor` is handed when the canvas is shared with a room. */
export interface DrawingCollaboration {
  /** These elements changed here; put them on the wire. */
  share: (elements: unknown[]) => void;
  /** This person's pointer moved. */
  point: (x: number, y: number, selected: string[]) => void;
  /** The whole scene, because the room asked for a compaction. */
  compact: (elements: unknown[]) => void;
  /** Elements from a peer, or replayed on join. Returns an unsubscribe. */
  onRemoteElements: (handler: (elements: unknown[]) => void) => () => void;
  /** Who else is here and where their pointers are. Returns an unsubscribe. */
  onPeers: (handler: (peers: PeerPointer[]) => void) => () => void;
  /** The room wants a full scene. Returns an unsubscribe. */
  onCompactRequest: (handler: () => void) => () => void;
}

export interface DrawingChannel {
  /* Handed to `usePresence` as its drawing callbacks. Stable across renders. */
  deliverElements: (elements: unknown[]) => void;
  deliverPeers: (peers: PeerPointer[]) => void;
  deliverCompactRequest: () => void;
  onRemoteElements: DrawingCollaboration["onRemoteElements"];
  onPeers: DrawingCollaboration["onPeers"];
  onCompactRequest: DrawingCollaboration["onCompactRequest"];
}

function emitter<T extends unknown[]>() {
  const handlers = new Set<(...args: T) => void>();
  return {
    emit: (...args: T) => {
      for (const handler of [...handlers]) {
        try {
          handler(...args);
        } catch {
          // One subscriber that throws must not stop the others, and must not
          // take the socket's message handler down with it.
        }
      }
    },
    on: (handler: (...args: T) => void) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

/**
 * One channel for the life of the screen.
 *
 * Created before the socket and independent of it, because `usePresence` needs
 * these callbacks as *options* — a channel built from the presence it feeds
 * would be a cycle.
 */
export function useDrawingChannel(): DrawingChannel {
  const held = useRef<DrawingChannel | null>(null);
  if (held.current === null) {
    const elements = emitter<[unknown[]]>();
    const peers = emitter<[PeerPointer[]]>();
    const compact = emitter<[]>();
    held.current = {
      deliverElements: elements.emit,
      deliverPeers: peers.emit,
      deliverCompactRequest: compact.emit,
      onRemoteElements: elements.on,
      onPeers: peers.on,
      onCompactRequest: compact.on,
    };
  }
  return held.current;
}

/**
 * The canvas's half of a live room, or `undefined` when there is not one.
 *
 * `undefined` rather than an object whose methods do nothing, because the
 * editor treats its absence as "nobody else can be here" and passes that to
 * Excalidraw as `isCollaborating` — which decides whether undo reverts this
 * person's own work or the last thing that happened. A stub would get that
 * wrong quietly.
 */
export function useDrawingCollaboration(
  channel: DrawingChannel,
  presence: Presence | undefined,
  enabled: boolean,
): DrawingCollaboration | undefined {
  /*
    Optional all the way down. `Presence` is a hook's return value, and the
    suites that mount this screen stand in for it with the fields they care
    about — so a `presence` with no `drawing` on it is a fixture, not a bug,
    and reading through it must not take the console down.
  */
  const share = presence?.drawing?.share;
  const point = presence?.drawing?.point;
  const compact = presence?.drawing?.compact;
  const live = enabled && presence !== undefined && presence.phase === "live";
  return useMemo(() => {
    if (!live || !share || !point || !compact) return undefined;
    return {
      share,
      point,
      compact,
      onRemoteElements: channel.onRemoteElements,
      onPeers: channel.onPeers,
      onCompactRequest: channel.onCompactRequest,
    };
  }, [live, share, point, compact, channel]);
}
