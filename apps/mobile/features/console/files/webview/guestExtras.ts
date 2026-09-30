/**
 * Comments and folder lists in the iOS app's editor, so a note there reads as
 * it does on the web (phone artboard 6: "the iOS app renders the same way").
 *
 * Before this the guest built the editor without either: a commented note
 * showed its `<!--c:…-->` markers and its ```comments log as raw text, and a
 * ```list block showed as source, because the guest had no way to learn who
 * is commenting and no notes to list. Both now cross the bridge:
 *
 *  - **Comments** are the web's own extension (`comments/extension.ts`), fed
 *    the viewer's handle by a `commenter` message. The markers and the log are
 *    hidden and the words highlighted whatever arrives; with a handle, a
 *    thread can be replied to, resolved and started from a selection. There is
 *    no margin on a phone, so a thread opens in the sheet (`comments/sheet.ts`)
 *    in its "inline" placement: the web view is as tall as its note, so the
 *    bottom of the page is the bottom of the note and not of the screen.
 *  - **Lists** are the web's widget, fed through `list-load`: the host reads
 *    the same `FolderListSource` the web editor does and hands the notes over.
 *    A row opens its note through `open-link`, as a link in the note does.
 *
 * Kept out of `guest.ts`, which is the bridge's one reader for everything
 * else and close to the size limit. Everything here is a value and two
 * functions, so `webviewBridge` tests drive it without a device.
 */

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { comments } from "../comments/extension";
import { commentSheet } from "../comments/sheet";
import { listHost, type ListHostRef, type ListNote, type ListSource, type PropertyValue } from "../listBlock/model";
import type { NoteLinkRef } from "../noteLinks";
import { PROTOCOL_VERSION, type ToGuest, type ToHost } from "./protocol";

export interface GuestExtras {
  /** Installed beside `editorStateFor`'s own. */
  extensions: Extension;
  /** Take one message meant for comments or lists. False when it was not one. */
  receive: (message: ToGuest, view: EditorView) => boolean;
  /** A different note is in the editor; every list is drawn again for it. */
  documentReplaced: () => void;
}

export function guestExtras(post: (message: ToHost) => void, links: NoteLinkRef): GuestExtras {
  let author: string | null = null;
  let moderator = false;
  const lists: ListHostRef = { current: null, generation: 0 };
  const listeners = new Set<() => void>();
  const pendingLoads = new Map<string, (source: ListSource | null) => void>();
  const pendingSets = new Map<string, (error: string | null) => void>();
  let token = 0;

  const host = (editable: boolean): ListHostRef["current"] => ({
    load: (folder, subfolders) =>
      new Promise((resolve) => {
        const id = `l${++token}`;
        pendingLoads.set(id, resolve);
        post({ v: PROTOCOL_VERSION, type: "list-load", token: id, folder, subfolders });
      }),
    open: (path, background) => links.current.onOpen(path, background ? "background" : "foreground"),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ...(editable
      ? {
          setProperty: (path: string, key: string, value: string | null) =>
            new Promise<string | null>((resolve) => {
              const id = `w${++token}`;
              pendingSets.set(id, resolve);
              post({ v: PROTOCOL_VERSION, type: "list-set", token: id, path, key, value });
            }),
        }
      : {}),
    // The note that holds the block, which a list never lists.
    get selfPath() {
      return links.current.path;
    },
  });

  /** Draw every list again: the widget compares this number. */
  const redraw = (view: EditorView) => {
    lists.generation = (lists.generation ?? 0) + 1;
    // The decorations rebuild on a selection; the same selection is enough.
    view.dispatch({ selection: view.state.selection });
  };

  return {
    extensions: [
      comments({ author: () => author, moderator: () => moderator }),
      commentSheet({ placement: "inline" }),
      listHost.of(lists),
    ],
    documentReplaced: () => {
      lists.generation = (lists.generation ?? 0) + 1;
    },
    receive: (message, view) => {
      switch (message.type) {
        case "commenter":
          author = typeof message.author === "string" && message.author.startsWith("@") ? message.author : null;
          moderator = author !== null && message.moderator === true;
          // Nothing in the document changed, but who may comment did.
          view.dispatch({});
          return true;
        case "lists": {
          const next = message.available === true ? host(message.editable === true) : null;
          if (next === null && lists.current === null) return true;
          lists.current = next;
          redraw(view);
          return true;
        }
        case "list-loaded": {
          const settle = pendingLoads.get(message.token);
          pendingLoads.delete(message.token);
          settle?.(listSource(message.source));
          return true;
        }
        case "list-set-result": {
          const settle = pendingSets.get(message.token);
          pendingSets.delete(message.token);
          settle?.(typeof message.error === "string" ? message.error : null);
          return true;
        }
        case "lists-changed":
          for (const listener of [...listeners]) listener();
          return true;
        default:
          return false;
      }
    },
  };
}

/**
 * The notes off the wire, checked field by field: they are drawn as rows, and
 * a value that is not a string would be drawn as `[object Object]`. A note
 * with no usable path is dropped; a property that is not text is dropped.
 */
export function listSource(value: unknown): ListSource | null {
  if (typeof value !== "object" || value === null) return null;
  const { notes, complete } = value as { notes?: unknown; complete?: unknown };
  if (!Array.isArray(notes)) return null;
  const read: ListNote[] = [];
  for (const item of notes) {
    if (typeof item !== "object" || item === null) continue;
    const note = item as Record<string, unknown>;
    if (typeof note.path !== "string" || note.path === "") continue;
    const properties: Record<string, PropertyValue> = {};
    if (typeof note.properties === "object" && note.properties !== null) {
      for (const [key, raw] of Object.entries(note.properties as Record<string, unknown>)) {
        if (typeof raw === "string") properties[key] = raw;
        else if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) properties[key] = raw as string[];
      }
    }
    read.push({
      path: note.path,
      properties,
      ...(typeof note.updatedAt === "number" ? { updatedAt: note.updatedAt } : {}),
      ...(typeof note.heading === "string" || note.heading === null ? { heading: note.heading as string | null } : {}),
      ...(typeof note.lede === "string" || note.lede === null ? { lede: note.lede as string | null } : {}),
    });
  }
  return { notes: read, complete: complete === true };
}
