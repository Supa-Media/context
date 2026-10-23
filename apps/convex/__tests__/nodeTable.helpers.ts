/**
 * An in-memory `NodeTable` and `NodeSink` for the tree's pure tests. The same
 * rules run here as in the Convex mutations (`functions/nodes.ts`): the sink
 * calls the very functions the mutations call, so a test over this helper
 * tests the production rules, not a copy of them.
 *
 * Patch semantics match Convex: a key passed as `undefined` clears that
 * field, and a key left out keeps it. Reads return copies, so a caller that
 * mutates what it was handed cannot reach the stored row by accident.
 */

import { applyObservation } from "../functions/lib/nodes/observe";
import type { NodeTable, Observation, StoredNode } from "../functions/lib/nodes/table";

const copy = (node: StoredNode): StoredNode => ({ ...node });

function byPathOrder(a: StoredNode, b: StoredNode): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export function memoryNodeTable(): NodeTable & { rows(): StoredNode[]; log(): { path: string; gone: boolean }[] } {
  const changes: { path: string; gone: boolean }[] = [];
  const byId = new Map<string, StoredNode>();
  const idByPath = new Map<string, string>();
  let counter = 0;

  const all = (): StoredNode[] => [...byId.values()];

  return {
    async byPath(path) {
      const id = idByPath.get(path);
      return id === undefined ? null : copy(byId.get(id) as StoredNode);
    },

    async insert(node) {
      if (idByPath.has(node.path)) throw new Error(`duplicate path ${node.path}`);
      counter += 1;
      const id = `n${counter}`;
      byId.set(id, { ...node, id });
      idByPath.set(node.path, id);
      return id;
    },

    async patch(id, fields) {
      const node = byId.get(id);
      if (node === undefined) throw new Error(`no node ${id}`);
      // Object.assign copies keys whose value is `undefined`: that clears them, as Convex does.
      Object.assign(node, fields);
    },

    async remove(id) {
      const node = byId.get(id);
      if (node === undefined) return;
      byId.delete(id);
      idByPath.delete(node.path);
    },

    async hasLiveChild(parentId) {
      return all().some((node) => node.parentId === parentId && node.goneAt === undefined);
    },

    async idHeldElsewhere(noteId, exceptId) {
      return all().some((node) => node.id !== exceptId && node.noteId === noteId && node.goneAt === undefined);
    },

    async logChange(path, gone) {
      changes.push({ path, gone });
    },

    rows() {
      return all().sort(byPathOrder).map(copy);
    },

    log() {
      return changes.map((change) => ({ ...change }));
    },
  };
}

/** Applies one seam observation. Returns how many writes it took (kept for the callers' shape). */
/**
 * A test row stands for the seam's keyed write of a note: each file row gets its
 * own note and key, as the copy pass gives. Folder markers are left as they are.
 */
export function seamRows<R extends { path: string; keyed?: { noteId: string; storageKey: string } }>(rows: R[]): R[] {
  return rows.map((row) =>
    row.keyed !== undefined || row.path.endsWith("/")
      ? row
      : { ...row, keyed: { noteId: `note:${row.path}`, storageKey: `notes/note:${row.path}.md` } },
  );
}

export async function applyAll(table: NodeTable, observation: Observation): Promise<number> {
  await applyObservation(table, { ...observation, rows: seamRows(observation.rows) });
  return 1;
}
