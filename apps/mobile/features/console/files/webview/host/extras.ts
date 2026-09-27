/**
 * The host's half of comments and folder lists in the iOS editor; the guest's
 * is `../guestExtras.ts`, which carries the argument for both.
 *
 * Two pieces of desired state — who is commenting, and whether lists can be
 * read here — resent on every `ready` like the rest, and one request/reply
 * pair per list. Every request is answered on every branch, the absent
 * capability included, for the reason `onSubmitForm` gives in `bridge.ts`: a
 * request nobody answers is a list that says "Loading…" forever.
 */

import { PROTOCOL_VERSION, type ToGuest, type ToHost, type WireListSource } from "../protocol";

export interface ExtrasSink {
  /** The notes under `folder` (and its subfolders), as the web editor's lists read them. */
  onLoadList?: (folder: string, subfolders: boolean) => Promise<WireListSource | null>;
  /** Change one property of one listed note: `null` once written, or why not. */
  onSetListProperty?: (path: string, key: string, value: string | null) => Promise<string | null>;
}

export interface HostExtras {
  setCommenter: (author: string | null) => void;
  setLists: (available: boolean, editable: boolean) => void;
  listsChanged: () => void;
  /** Everything the guest should hold, for a `ready`. */
  resend: (send: (message: ToGuest) => void) => void;
  /** Take a message about lists. False when it was not one. */
  receive: (message: ToHost, reply: (message: ToGuest) => void) => boolean;
}

/**
 * A `ListSource` as JSON: plain arrays and only the fields a row draws. The
 * source's notes can carry more than that, and nothing crosses the bridge
 * that the guest has no use for.
 */
export function wireListSource(source: {
  readonly notes: ReadonlyArray<{
    readonly path: string;
    readonly updatedAt?: number;
    readonly properties: Readonly<Record<string, string | readonly string[]>>;
    readonly heading?: string | null;
    readonly lede?: string | null;
  }>;
  readonly complete: boolean;
}): WireListSource {
  return {
    complete: source.complete,
    notes: source.notes.map((note) => ({
      path: note.path,
      properties: Object.fromEntries(
        Object.entries(note.properties).map(([key, value]) => [key, typeof value === "string" ? value : [...value]]),
      ),
      ...(note.updatedAt === undefined ? {} : { updatedAt: note.updatedAt }),
      ...(note.heading === undefined ? {} : { heading: note.heading }),
      ...(note.lede === undefined ? {} : { lede: note.lede }),
    })),
  };
}

export function hostExtras(post: (message: ToGuest) => void, sink: ExtrasSink): HostExtras {
  let author: string | null = null;
  let lists = { available: false, editable: false };
  /*
    The notes a list has been handed. A `list-set` may only name one of these:
    the web view is the least trusted thing in the app, and a write whose path
    it could choose freely would let it pick which file a write touches — the
    rule `form-submit` follows by carrying no path at all. This is a bound,
    not a wall: `list-load` names its own folder, so the set is at most what
    the person could open and edit by hand. It is emptied when the web view
    starts over (`ready`) and when lists stop being available, so a path
    handed to one page of the editor is not still writable from the next.
  */
  const listed = new Set<string>();
  const commenter = (): ToGuest => ({ v: PROTOCOL_VERSION, type: "commenter", author });
  const listing = (): ToGuest => ({ v: PROTOCOL_VERSION, type: "lists", ...lists });

  return {
    setCommenter: (next) => {
      if (next === author) return;
      author = next;
      post(commenter());
    },
    setLists: (available, editable) => {
      const next = { available, editable: available && editable };
      if (next.available === lists.available && next.editable === lists.editable) return;
      if (!next.editable) listed.clear();
      lists = next;
      post(listing());
    },
    listsChanged: () => {
      if (lists.available) post({ v: PROTOCOL_VERSION, type: "lists-changed" });
    },
    resend: (send) => {
      // A `ready` is a fresh page: whatever lists it draws, it loads again.
      listed.clear();
      send(commenter());
      send(listing());
    },
    receive: (message, reply) => {
      switch (message.type) {
        case "list-load": {
          const { token } = message;
          const answer = (source: WireListSource | null) => {
            for (const note of source?.notes ?? []) listed.add(note.path);
            reply({ v: PROTOCOL_VERSION, type: "list-loaded", token, source });
          };
          const load = lists.available ? sink.onLoadList : undefined;
          if (load === undefined || typeof message.folder !== "string") {
            answer(null);
            return true;
          }
          load(message.folder, message.subfolders === true).then(answer, () => answer(null));
          return true;
        }
        case "list-set": {
          const { token } = message;
          const answer = (error: string | null) => reply({ v: PROTOCOL_VERSION, type: "list-set-result", token, error });
          const set = lists.editable ? sink.onSetListProperty : undefined;
          const valid =
            typeof message.path === "string" &&
            listed.has(message.path) &&
            typeof message.key === "string" &&
            (message.value === null || typeof message.value === "string");
          if (set === undefined || !valid) {
            answer("This list can’t be changed here.");
            return true;
          }
          set(message.path, message.key, message.value).then(answer, (error: unknown) =>
            answer(error instanceof Error ? error.message : "That change wasn’t saved."),
          );
          return true;
        }
        default:
          return false;
      }
    },
  };
}
