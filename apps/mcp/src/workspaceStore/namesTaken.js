/**
 * "Is that name taken?" for a write, from the workspace object's own rows: the control plane's `ask: "names"`
 * (`apps/convex/functions/lib/nodes/gatewayNames.ts`, `treeTaken.ts`) for a workspace whose rows live here. A write
 * that is not an edit asked it before it wrote, a round trip to the control plane (`cp:/gateway/tree/facts`) on every
 * new note and every unconditional save.
 *
 * **Unfiltered**, as the control plane's is: a name taken by a note this writer may not see is taken, and the gateway's
 * tools decide what to say about it with `canSee`. So only a writer may ask: the gateway attests `canWrite` (an owner
 * or editor whose grant carries `context:write`, the control plane's rule) and the object refuses any other call. The
 * object answers only to the gateway's own Worker, which is what makes that attestation the gateway's to give.
 *
 * - `files`: the asked paths a live file row sits at.
 * - `folders`: the asked paths a live folder row sits at, or anything live sits under (`path/…`).
 *
 * The write itself stays the atomic truth (`onlyIf: { absent: true }`, the object's `adopt` refusing a live path).
 */

import { WorkspaceRowRefused } from "./rows.js";

/** Names one ask may carry (`TAKEN_PATHS`). */
export const NAMES_PER_ASK = 100;
/** Longest path an ask may name. */
const PATH_LENGTH = 4096;

/** The paths of a names ask, or a refusal. */
function askedPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > NAMES_PER_ASK) {
    throw new WorkspaceRowRefused(`a names ask names 1 to ${NAMES_PER_ASK} paths`);
  }
  for (const path of value) {
    if (typeof path !== "string" || path === "" || path.length > PATH_LENGTH) throw new WorkspaceRowRefused("a names ask names paths");
  }
  return [...new Set(value)];
}

/** The first path in byte order past every `prefix…` key: `/` + 1 is `0`. */
const pastFolder = (path) => `${path}0`;

/**
 * `{served: true, files, folders}` for `fields.paths`, or `{served: false}` for a caller the gateway did not attest
 * as a writer.
 *
 * @param {{byPath: (path: string) => object|null}} rows
 * @param {{exec: Function}} sql
 * @param {{paths?: unknown, canWrite?: unknown}} fields
 */
export function namesTaken(rows, sql, fields) {
  if (fields.canWrite !== true) return { served: false };
  const paths = askedPaths(fields.paths);
  const files = [];
  const folders = [];
  for (const path of paths) {
    const row = rows.byPath(path);
    if (row !== null && row.kind !== "folder") {
      files.push(path);
      continue;
    }
    const under = sql.exec("SELECT 1 AS one FROM ws_rows WHERE gone = 0 AND path >= ? AND path < ? LIMIT 1", `${path}/`, pastFolder(path)).toArray();
    if (row !== null || under.length > 0) folders.push(path);
  }
  return { served: true, files, folders };
}
