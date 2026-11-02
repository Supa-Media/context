/**
 * The triage desk's facts from the pinned context's workspace object (`texTriage.ts`; decided by the owner,
 * 2026-11-02, `docs/decisions/storage-and-credentials/facts-in-objects.md`). Actions only: a query cannot ask the
 * object. The control plane's rows have already decided which notes are on the desk and that the caller may see
 * each; this asks only what each of those notes says now. A note the object does not answer for keeps the control
 * plane's facts.
 */

import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { objectFactRows, objectPropsAt } from "../nodes/objectFacts";
import { deskFrom, type DeskNotes } from "./texTriage";

export async function deskFromObject(ctx: ActionCtx, workspaceId: Id<"workspaces">, notes: DeskNotes) {
  const paths = [...notes.bugs, ...notes.themes, ...notes.reviews].map((note) => note.path);
  const held = paths.length === 0 ? null : await objectPropsAt(await objectFactRows(ctx, workspaceId), paths);
  return deskFrom(notes, held);
}
