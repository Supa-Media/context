/**
 * The live room for whatever is open, prose or canvas, as one call.
 *
 * `usePresence` is the socket; this is the wiring that decides which merge
 * strategy it runs and hands the canvas half to the drawing editor. It lives
 * here rather than in the route file for the reason the lint rule gives — a
 * route is a place, not a screen — but also because the two halves have to be
 * created in a fixed order: the channel exists before the socket, since the
 * socket takes its delivery functions as options and a channel built from the
 * presence it feeds would be a cycle.
 */

import { useEffect } from "react";
import { usePresence, type Presence } from "./usePresence";
import { useCollaboration } from "../collaboration/useCollaboration";
import type { CacheScope } from "../../offline/keys";
import { isDrawingPath } from "@context/drawings";
import {
  useDrawingChannel,
  useDrawingCollaboration,
  type DrawingCollaboration,
} from "../files/drawingCollaboration";

export function useNoteRoom(options: {
  workspaceId: string | null;
  endpoint: string | null;
  notePath: string | null;
  /** True while the open note is waiting on a conflict decision. */
  conflicted: boolean;
  /** The note as this device has it, for the one client that seeds the room. */
  textForSeed: () => string;
  legacyDraft?: () => { baseline: string; desired: string; baseEtag?: string | null } | undefined;
  /** A tool wrote the open note; move this editor onto the version it left. */
  onExternalWrite: (written: { path: string; etag: string | null }) => void;
  /** Listen for saves this console makes, so the room can be told. */
  onSaved: (handler: (written: { path: string; etag: string }) => void) => () => void;
  /** The durable prose controller owns note edits when present. */
  durable?: boolean;
  canEdit?: boolean;
  scope?: CacheScope;
  onCollaborationOwned?: (path: string, owned: boolean) => void;
  onCollaborationText?: (text: string) => void;
  onCollaborationState?: (state: { text: string; etag: string | null; status: "offline" | "storing" | "local" | "syncing" | "saved" | "error" | "unavailable" | "revoked"; pending: number; recovery?: { baseline: string; desired: string; baseEtag?: string | null }; legacyAdopted?: { path: string; text: string; baseEtag: string } }) => void;
}): { presence: Presence; drawingCollaboration: DrawingCollaboration | undefined } {
  const channel = useDrawingChannel();
  const path = options.notePath;
  /*
    A drawing merges as elements, a note as text.

    Chosen from the path rather than from what happens to be mounted: the
    socket opens before the editor does, and a `.excalidraw.md` seeded into a
    shared text document would put a multi-megabyte compressed payload into the
    room's log to no purpose — and then merge two people's base64 character by
    character, which produces a payload that is neither person's drawing.
  */
  const drawing = isDrawingPath(path ?? "");

  const collaboration = useCollaboration({
    workspaceId: options.workspaceId,
    endpoint: options.endpoint,
    path,
    scope: options.scope ?? "team",
    initialText: options.textForSeed,
    legacyDraft: options.legacyDraft,
    editable: options.canEdit === true,
    enabled: options.durable === true && !drawing && !options.conflicted,
    onText: (text) => options.onCollaborationText?.(text),
    onState: (state) => {
      if (state.status === "loading") return;
      options.onCollaborationState?.({
        text: state.text,
        etag: state.etag,
        status: state.status,
        pending: state.pending,
        ...(state.recovery === undefined ? {} : { recovery: state.recovery }),
        ...(state.legacyAdopted === undefined ? {} : { legacyAdopted: state.legacyAdopted }),
      });
    },
    onOwned: options.onCollaborationOwned,
  });
  const presence = usePresence({
    workspaceId: options.workspaceId,
    endpoint: options.endpoint,
    notePath: path,
    /*
      Off for everything that is not a saved markdown note somebody is looking
      at: a draft with no name yet has no path to key a room on, a locked note
      is not being read, and a conflict is a decision the person owes before
      anybody else's caret is worth drawing over it.
    */
    enabled:
      !options.conflicted &&
      path !== null &&
      path.endsWith(".md") &&
      collaboration?.status !== "revoked" && collaboration?.status !== "unavailable",
    textForSeed: options.textForSeed,
    onExternalWrite: options.onExternalWrite,
    mode: drawing ? "drawing" : options.durable ? "presence" : "text",
    durable: options.durable === true && !drawing,
    onCommitted: (frame) => {
      if (collaboration?.etag !== frame.etag) collaboration?.repair();
    },
    onDrawing: channel.deliverElements,
    onPeerPointers: channel.deliverPeers,
    onDrawingCompact: channel.deliverCompactRequest,
  });
  useEffect(() => {
    if (presence.phase !== "live" || collaboration === undefined || typeof window === "undefined") return;
    collaboration.repair();
    const repair = () => collaboration.repair();
    window.addEventListener("focus", repair);
    window.addEventListener("visibilitychange", repair);
    return () => {
      window.removeEventListener("focus", repair);
      window.removeEventListener("visibilitychange", repair);
    };
  }, [presence.phase]);

  /*
    A save this console made, told to the room.

    The other direction from `onExternalWrite`, and the reason both exist: the
    bucket can move because a tool wrote it (the gateway tells the room) or
    because somebody here pressed save (nothing else would). Either way every
    member has to end up on the new version, or the next one elected to save
    writes against one they never saw.

    Only the note it is for: a save that lands after somebody opened a
    different note describes a bucket this room is not about.
  */
  /*
    Optional in practice, whatever the type says: the suites that mount this
    screen stand in for `data.files` with the fields they care about, and a
    stub without this one is a fixture rather than a bug. It must not take the
    console down, and a console with nobody else in it loses nothing by it.
  */
  const { onSaved } = options;
  const announceSaved = presence.announceSaved;
  useEffect(() => {
    if (typeof onSaved !== "function") return;
    return onSaved((written) => {
      if (written.path === path) announceSaved(written.etag);
    });
  }, [onSaved, announceSaved, path]);

  return {
    presence: {
      ...presence,
      shared: collaboration?.shared ?? presence.shared,
      settled: collaboration?.ready ?? presence.settled,
      canWrite: collaboration === undefined ? presence.canWrite : options.canEdit === true,
      collaboration,
    },
    drawingCollaboration: useDrawingCollaboration(channel, presence, drawing),
  };
}
