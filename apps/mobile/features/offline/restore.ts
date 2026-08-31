import type { Draft } from "./cache";
import type { PendingWrite } from "./outbox";
import type { RestoredDraft } from "../console/files/editor";
import type { OpenNote } from "../console/files/types";

/**
 * What to put in the editor when a note is opened and there is work waiting.
 *
 * Pure, because the case it exists for is the one nobody can reproduce by hand:
 * a note opened hours after it was typed into, on a bucket that has moved on
 * since. Everything about it is a decision, and every decision here can lose
 * somebody's work if it is made the other way.
 *
 * Two sources of waiting work, and they are not the same thing:
 *
 *  - **A queued write.** Save was pressed, there was no connection, and the
 *    draft is in the outbox. Its own state says what happened next.
 *  - **A draft.** Typed and never saved, written down so the tab closing or the
 *    OS reclaiming the app does not throw it away. Nothing has tried to send it.
 *
 * The queue wins when both exist, because it is the later of the two by
 * construction — a draft is written as you type and cleared when a save is
 * queued.
 *
 * ## The case that makes this more than a lookup
 *
 * A draft carries the etag it was typed against. If the note has moved on since
 * — somebody's Obsidian synced, an AI client wrote to it, the person edited it
 * from another browser — then restoring that draft as ordinary unsaved changes
 * would arm a Save that overwrites a version nobody has seen. So a draft whose
 * base etag no longer matches is restored **as a conflict**: the text is kept,
 * the current version is offered, and nothing is written until a person picks
 * one. That is the same answer the online editor gives when a save is refused,
 * given before the save rather than after it.
 */
export function restoreFor(input: {
  note: OpenNote;
  pending?: PendingWrite;
  draft?: Draft | null;
}): RestoredDraft | undefined {
  const { note, pending, draft } = input;

  if (pending !== undefined) {
    if (pending.state === "conflicted") {
      return {
        text: pending.text,
        status: "conflict",
        message: pending.conflict?.message,
        conflictEtag: pending.conflict?.currentEtag,
        /*
          The queue entry's own base — the version this text was typed on top
          of — and **not** `note.etag`, which is whatever the bucket holds now.
          This is what a three-way merge needs an ancestor for, and it is the
          only place that still knows it: the note was just re-read at a
          different version, and the editor's `etag` is that one.
        */
        baseEtag: pending.baseEtag,
      };
    }
    if (pending.state === "rejected") {
      return { text: pending.text, status: "error", message: pending.rejection?.message };
    }
    return {
      text: pending.text,
      status: "queued",
      message: "Waiting for a connection. Not in your bucket yet.",
    };
  }

  if (draft == null || draft.text === note.text) return undefined;

  if (draft.baseEtag === note.etag) {
    return { text: draft.text, status: "dirty" };
  }

  return {
    text: draft.text,
    status: "conflict",
    conflictEtag: note.etag,
    baseEtag: draft.baseEtag,
    message:
      "This note changed somewhere else after you typed these unsaved changes. Nothing has been overwritten — load theirs, or keep yours.",
  };
}
