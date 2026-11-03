/**
 * Old copies hidden in the workspace object, where its notes live there (`ws.write.move` with `trash: true`,
 * `apps/mcp/src/workspaceStore/moveWrites.js`): each copy's row moves to `.context/old-copies/<its path>` in the object,
 * which is the record, and the tree mirror moves Convex's copy and follows the moved files (search, links). Convex's
 * own row move (`oldCopies.hideRows`) is not run for such a workspace: it would push the move back to the object.
 *
 * A note's editing history needs no carrying there: its head is filed by note id, and every row in the object is keyed.
 */

import { isPlumbing } from "../privacy";
import { OLD_COPIES_ROOT } from "../fileOps/store";

export type OldCopyMover = {
  write: { move: (body: { from: string; to: string; trash: true; scope: "private" }) => Promise<unknown> };
};

type MoveAnswer = { ok?: unknown; code?: unknown; files?: unknown };

/** A copy already gone, or one whose hidden name is taken: nothing to hide, and the page goes on. */
const PASSED_OVER: ReadonlySet<string> = new Set(["NOT_FOUND", "TAKEN"]);

/**
 * Each path hidden in the object, in order. Answers the files moved and, when the object would not take one for a
 * reason a later pass may not have (it is busy, out of reach, or wants the control plane), why the page stopped.
 */
export async function hideInObject(
  mover: OldCopyMover,
  paths: readonly string[],
): Promise<{ moved: { from: string; to: string }[]; stopped: string | null }> {
  const moved: { from: string; to: string }[] = [];
  for (const path of paths) {
    if (isPlumbing(path)) continue;
    let answer: MoveAnswer | null = null;
    try {
      answer = (await mover.write.move({ from: path, to: `${OLD_COPIES_ROOT}/${path}`, trash: true, scope: "private" })) as MoveAnswer | null;
    } catch {
      return { moved, stopped: "not_served" };
    }
    if (answer?.ok === true) {
      const files = Array.isArray(answer.files) ? (answer.files as { from?: unknown; to?: unknown }[]) : [];
      for (const file of files) if (typeof file.from === "string" && typeof file.to === "string") moved.push({ from: file.from, to: file.to });
      continue;
    }
    const code = typeof answer?.code === "string" ? answer.code : "refused";
    if (PASSED_OVER.has(code)) continue;
    return { moved, stopped: code === "BUSY" ? "busy" : code.toLowerCase() };
  }
  return { moved, stopped: null };
}
