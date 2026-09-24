import type { PresenceMember } from "./protocol";
import type { SharedDoc } from "./sharedDoc";
import type { PresencePhase } from "./session";
import type { DurableCollaboration, LiveUpdate } from "../collaboration/durable";

/*
  What `usePresence` takes and what it answers. Moved out of `usePresence.ts`,
  which re-exports `Presence`; `PresenceOptions` is the parameter type that
  used to be written inline on the hook, unchanged.
*/

export interface Presence {
  members: PresenceMember[];
  phase: PresencePhase;
  /** "2 here", "Reconnecting", or "" when there is nothing worth saying. */
  summary: string;
  /** Tell the room where this editor's caret is. Safe to call on every change. */
  report: (anchor: number, head: number) => void;
  /**
   * The document every editor in this room shares, once there is one.
   *
   * `null` until the room has answered, and on every surface with no room at
   * all — the editor then holds its own text exactly as it did before this
   * feature, which is what makes the whole thing safe to switch off.
   */
  shared: SharedDoc | null;
  /**
   * Whether the room has told this client everything it holds for this note.
   *
   * **`shared` says a document exists; this says the room has spoken.** The
   * two are not the same question and the gap between them is where a note
   * goes missing: the document is created when the hook runs, before a socket
   * connects and whether or not one ever does, while this turns true only when
   * one of the three things that can settle a joiner has happened — this
   * client was told to seed, the room replayed its log, or a peer answered the
   * state vector this client sent on connect.
   *
   * The editor needs it because an **empty** document is ambiguous on its own:
   * a brand-new note and a room that has not answered yet look identical, and
   * binding in the second case means the seed arrives a moment later as an
   * insert of text the editor is already showing — the duplicated note. So the
   * editor waits for text *or* for this, and an empty note stops being a room
   * nobody is ever wired into.
   *
   * False again on a reconnect, and correctly so: the exchange runs from the
   * start on every connect, and until it has this client cannot say the room
   * holds nothing.
   */
  settled: boolean;
  /**
   * Whether this client is the one that writes the merged text to the bucket.
   *
   * Exactly one member is, and the rest deliberately leave their local draft
   * clean so the existing autosave cannot fire for them. Two savers would race
   * against one etag and conflict with each other, which is the failure this
   * whole feature exists to remove — reintroduced from the other end.
   */
  canWrite: boolean;
  /** Durable prose synchronization, when the open note uses collaboration v2. */
  collaboration?: DurableCollaboration;
  /**
   * Tell the room this client just wrote the note to the bucket at `etag`.
   *
   * Safe to call when there is no room: it drops the message. Every other
   * member moves onto that version, so the next person elected to save is not
   * writing against a version two edits old.
   */
  announceSaved: (etag: string) => void;
  /**
   * The canvas half, present in `drawing` mode and inert otherwise.
   *
   * Both calls are safe to make when there is no room: they drop the message,
   * which is what keeps a drawing opened alone behaving exactly as it did
   * before any of this existed.
   */
  drawing: {
    /** Put these elements — this person's own changes — on the wire. */
    share: (elements: unknown[]) => void;
    /** Tell the room where this person's pointer is. */
    point: (x: number, y: number, selected: string[]) => void;
    /** The whole scene, when the room asked for a compaction. */
    compact: (elements: unknown[]) => void;
  };
}

/** The options `usePresence` is called with. */
export interface PresenceOptions {
  workspaceId: string | null;
  /** The MCP endpoint the console already shows, e.g. `https://…/mcp`. */
  endpoint: string | null;
  /** The note on screen, or `null` when none is. */
  notePath: string | null;
  /** Off for an unsaved draft, a drawing, a locked note, or a folder. */
  enabled: boolean;
  /**
   * The note as the bucket has it, for the one client that seeds the room.
   *
   * Read through a ref rather than a dependency: it changes on every keystroke
   * and re-opening the socket for that would reset the room on every letter.
   * Only the seeding client reads it, and only once.
   */
  textForSeed: () => string;
  /**
   * A tool wrote this note while it was open, and the shared document has just
   * been merged onto it.
   *
   * The etag is what makes this more than a redraw: the bucket has moved, so
   * the next conditional save from this client must be checked against the
   * version the tool left behind rather than the one this editor opened. Fired
   * only on the client the room asked to merge.
   */
  onExternalWrite?: (written: { path: string; etag: string | null }) => void;
  /**
   * What kind of thing is open: prose, or a canvas.
   *
   * A note merges as text through a shared document; a drawing merges as
   * *elements*, through Excalidraw's own reconciliation, because merging two
   * people's serialized scenes character by character produces a payload that
   * is neither person's drawing. One socket, one room, one roster — two merge
   * strategies, chosen by what the file is.
   *
   * In `drawing` mode no shared document is created at all. Seeding a
   * `.excalidraw.md` into one would put a multi-megabyte compressed payload in
   * the room's log to no purpose.
   */
  mode?: "text" | "drawing" | "presence";
  /** Durable prose relays transient updates separately from confirmed HTTP saves. */
  durable?: boolean;
  documentId?: string | null;
  /**
   * A document owned by the durable collaboration controller, used only to
   * encode this editor's caret. The presence socket never creates or destroys
   * this document. Durable updates arrive through the separate subscription.
   */
  shared?: SharedDoc | null;
  subscribeLiveUpdates?: (listener: (frame: LiveUpdate) => void) => () => void;
  onLiveUpdate?: (documentId: string, update: string) => void;
  /** A v2 commit notification triggers an authorized HTTP read repair. */
  onCommitted?: (frame: { documentId: string; update?: string; etag: string }) => void;
  /** Elements from a peer, or replayed on join. Drawing mode only. */
  onDrawing?: (elements: unknown[]) => void;
  /** The room is asking for a full scene, because the log is getting long. */
  onDrawingCompact?: () => void;
  /** Who else is on the canvas and where their pointers are. Drawing mode only. */
  onPeerPointers?: (
    peers: { id: string; name: string; color: string | null; x: number; y: number; selected: string[] }[],
  ) => void;
}
