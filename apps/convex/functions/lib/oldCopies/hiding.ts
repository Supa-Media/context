/**
 * The bucket half of hiding old copies (`functions/oldCopies.ts`): one pass
 * over a page of a keyed workspace's rows, run inside the credential barrier
 * because some copies can only be told from the person's own notes by reading
 * them, and because a hidden note's editing history and search rows follow it.
 *
 * Each copy's row moves to `.context/old-copies/<its path>`, as a trash does
 * (`rowTrash.ts`): nothing is copied or erased, the note keeps its id and its
 * bytes, and every listing, search and AI read drops it because the name is
 * plumbing. The person's own notes beside it are not touched.
 *
 * `readOldCopyTexts` is the other half Download as folders needs: the text of
 * hidden notes, for the owner, by their names under the old-copies folder.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { carryRowHistory } from "../nodes/rowHistory";
import { followInProjection, type ProjectionClient } from "../fileOps/search";
import { normalizePath } from "../fileOps/paths";
import { OLD_COPIES_ROOT, type FileStore } from "../fileOps/store";
import { objectFactRows, objectPropsAt } from "../nodes/objectFacts";
import { bodyVerdict, dayOf, rowVerdict } from "./classify";
import { hideInObject, type OldCopyMover } from "./hideInObject";
import { consoleWorkspaceClient } from "../workspaceObjects/door";

/** Rows one mutation hides: each is a row move, with its access and links followed. */
export const HIDE_BATCH = 25;

export interface HidePass {
  kind: "oldCopiesHidden";
  /** Where the next pass starts, or `null` when this one reached the end. */
  cursor: string | null;
  days: number;
  contacts: number;
  files: number;
  firstDay?: string;
  lastDay?: string;
  /** Why the pass stopped before the end of its page, so the next run tries again. */
  stopped?: string;
  /**
   * What the pass looked at, for the log: rows that might be copies, how many
   * of those could not be read, and how many were read and found the person's.
   */
  looked?: { rows: number; unread: number; theirs: number };
}

async function textAt(store: FileStore, path: string): Promise<string | null> {
  try {
    const object = await store.get(path);
    return object === null || object === undefined ? null : await object.text();
  } catch {
    return null;
  }
}

type Candidate = { path: string; verdict: "day" | "attachment" | "read" | "facts"; key?: string };

/**
 * Each note the page left to the object (`facts`) decided by its props there, as `rowVerdict` decides a row by the
 * control plane's: a copied day, one to read, or the person's (dropped). A note the object does not answer for is
 * decided by its name alone, as a row with no facts is.
 */
export async function decidedByObject(
  facts: Parameters<typeof objectPropsAt>[0],
  rows: readonly Candidate[],
): Promise<Array<Candidate & { verdict: "day" | "attachment" | "read" }>> {
  const asked = rows.filter((row) => row.verdict === "facts").map((row) => row.path);
  const held = asked.length === 0 ? null : await objectPropsAt(facts, asked);
  const decided: Array<Candidate & { verdict: "day" | "attachment" | "read" }> = [];
  for (const row of rows) {
    if (row.verdict !== "facts") {
      decided.push({ ...row, verdict: row.verdict });
      continue;
    }
    const props = held?.get(row.path)?.props ?? undefined;
    // Read at the note's current text, so its own version vouches for it.
    const verdict = rowVerdict({ path: row.path, kind: "file", ...(props === undefined || props === null ? {} : { props, parsed: "object", etag: "object" }) }, []);
    if (verdict === "day" || verdict === "read") decided.push({ ...row, verdict });
  }
  return decided;
}

/** One page of the workspace's rows looked at, and its copies hidden. */
export async function hideOldCopiesPass(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  projection: ProjectionClient | null,
  cursor: string | null,
  openMover: () => OldCopyMover | null = () => consoleWorkspaceClient(ctx, workspaceId, { caller: "hiding" }),
): Promise<HidePass> {
  // Where the notes live in their object, the object hides each copy (`hideInObject.ts`), and with no way to reach it
  // nothing is hidden this pass: Convex's row move would push the move back to the object.
  const inObject = (await ctx.runQuery(internal.functions.workspaceObjectsRows.homeOf, { workspaceId }).catch(() => null)) === "object";
  const mover = inObject ? openMover() : null;
  if (inObject && mover === null) {
    return { kind: "oldCopiesHidden", cursor, days: 0, contacts: 0, files: 0, stopped: "not_served" };
  }
  // Where the notes live in their object, it says what each note's front matter is, read at its current text.
  const facts = await objectFactRows(ctx, workspaceId);
  const page = await ctx.runQuery(internal.functions.oldCopies.candidatePage, { workspaceId, cursor, ...(facts === null ? {} : { everyNote: true }) });
  const rows = await decidedByObject(facts, page.rows);
  const looked = { rows: rows.length, unread: 0, theirs: 0 };
  const pass: HidePass = { kind: "oldCopiesHidden", cursor: page.done ? null : page.cursor, days: 0, contacts: 0, files: 0, looked };

  const hide: { path: string; as: "day" | "contact" | "file" }[] = [];
  for (const row of rows) {
    if (row.verdict === "day") hide.push({ path: row.path, as: "day" });
    else if (row.verdict === "attachment") hide.push({ path: row.path, as: "file" });
    else {
      // A note the facts could not vouch for: its own words decide, and one that cannot be read stays.
      const text = await textAt(store, row.key ?? row.path);
      const verdict = text === null ? null : bodyVerdict(text);
      if (text === null) looked.unread += 1;
      else if (verdict === null) looked.theirs += 1;
      if (verdict !== null) hide.push({ path: row.path, as: verdict });
    }
  }

  for (let at = 0; at < hide.length; at += HIDE_BATCH) {
    const batch = hide.slice(at, at + HIDE_BATCH);
    const paths = batch.map((entry) => entry.path);
    const answer =
      mover !== null ? await hideInObject(mover, paths) : await ctx.runMutation(internal.functions.oldCopies.hideRows, { workspaceId, paths, now: Date.now() });
    const moved = new Set(answer.moved.map((pair) => pair.from));
    for (const entry of batch) {
      if (!moved.has(entry.path)) continue;
      if (entry.as === "day") {
        pass.days += 1;
        const day = dayOf(entry.path);
        if (day !== null && (pass.firstDay === undefined || day < pass.firstDay)) pass.firstDay = day;
        if (day !== null && (pass.lastDay === undefined || day > pass.lastDay)) pass.lastDay = day;
      } else if (entry.as === "contact") pass.contacts += 1;
      else pass.files += 1;
    }
    // In the object, the tree mirror follows the moved files and a head is filed by note id: nothing to carry here.
    if (mover === null) await carryRowHistory(store, answer.moved);
    if (mover === null && projection !== null && answer.moved.length > 0) {
      await followInProjection(store, { written: [], gone: answer.moved.map((pair) => pair.from) }, projection);
    }
    if (answer.stopped !== null) {
      // Something else is moving rows here, or the workspace is not keyed: this page again, next time.
      return { ...pass, cursor, stopped: answer.stopped };
    }
  }
  return pass;
}

/** One hidden note, as `files.readNotes` answers one, under its name inside the old-copies folder. */
export type OldCopyText =
  | { path: string; outcome: "read"; note: { text: string } }
  | { path: string; outcome: "error"; code: string; message: string };

/**
 * The text of hidden notes, by their names under `.context/old-copies/`. Only
 * Markdown, only names that stay inside that folder, and only what the tree
 * says is there, read at the key its row names: a name the tree has no keyed
 * row for is not read.
 */
export async function readOldCopyTexts(ctx: ActionCtx, workspaceId: Id<"workspaces">, store: FileStore, paths: readonly string[]): Promise<OldCopyText[]> {
  const asked = paths.map((path) => ({ path, clean: normalizePath(path) }));
  const named = asked.flatMap(({ clean }) => (clean !== null && clean.endsWith(".md") ? [`${OLD_COPIES_ROOT}/${clean}`] : []));
  const rows = await ctx.runQuery(internal.functions.oldCopies.heldRows, { workspaceId, paths: named });
  const held = new Map(rows.map((row: { path: string; key: string }) => [row.path, row.key]));
  const results: OldCopyText[] = [];
  for (const { path, clean } of asked) {
    // Read at the note's own key: a hidden name is plumbing, and the key is where a keyed note's bytes are.
    const key = clean === null || clean !== path ? undefined : held.get(`${OLD_COPIES_ROOT}/${clean}`);
    const text = key === undefined ? null : await textAt(store, key);
    results.push(
      text === null
        ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "That old copy is not there." }
        : { path, outcome: "read", note: { text } },
    );
  }
  return results;
}
