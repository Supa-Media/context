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

import {
  applyObservation,
  beginState,
  dirtyState,
  failState,
  finishState,
  privacyIsNewer,
  progressState,
  pruneUnobserved,
  unsupportedState,
  type VanishCursor,
} from "../functions/lib/nodes/observe";
import type {
  NodeSink,
  NodeTable,
  NodeTreeState,
  Observation,
  PrivacyMirror,
  StoredNode,
} from "../functions/lib/nodes/table";

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

    async underPrefix(prefix, { after, limit }) {
      return all()
        .filter((node) => node.path.startsWith(prefix) && (after === undefined || node.path > after))
        .sort(byPathOrder)
        .slice(0, limit)
        .map(copy);
    },

    async observedBefore(before, limit) {
      return all()
        .filter((node) => node.observedAt < before)
        .sort((a, b) => a.observedAt - b.observedAt || byPathOrder(a, b))
        .slice(0, limit)
        .map(copy);
    },

    async hasLiveChild(parentId) {
      return all().some((node) => node.parentId === parentId && node.goneAt === undefined);
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

/** Applies one observation to completion, as a caller re-sending `more` would. */
export async function applyAll(table: NodeTable, observation: Observation): Promise<number> {
  let cursor: VanishCursor | undefined;
  let calls = 0;
  for (;;) {
    calls += 1;
    if (calls > 10_000) throw new Error("observation did not converge");
    const result = await applyObservation(table, observation, cursor);
    if (!result.more) return calls;
    cursor = result.next;
  }
}

/**
 * The in-memory sink. `observe` loops until the vanish scan is done, the way a
 * production caller loops over the `observe` mutation. `finish` counts the live
 * files itself, where production counts them with `countLive` first.
 */
export function memoryNodeSink(
  table: NodeTable & { rows(): StoredNode[] } = memoryNodeTable(),
  initial: NodeTreeState | null = null,
): NodeSink & { table: NodeTable & { rows(): StoredNode[] }; treeState(): NodeTreeState | null } {
  let current: NodeTreeState | null = initial === null ? null : { ...initial };
  let privacyRow: (PrivacyMirror & { observedAt: number }) | null = null;

  const countLiveFiles = async (): Promise<number> => {
    let count = 0;
    let after: string | undefined;
    for (;;) {
      const page = await table.underPrefix("", { after, limit: 1000 });
      for (const node of page) if (node.kind === "file" && node.goneAt === undefined) count += 1;
      if (page.length < 1000) return count;
      after = page[page.length - 1].path;
    }
  };

  return {
    table,
    treeState: () => (current === null ? null : { ...current }),

    async state() {
      return current === null ? null : { ...current };
    },

    async begin(at) {
      const result = beginState(current, at);
      current = result.state;
      return { cursor: result.cursor, startedAt: result.startedAt };
    },

    async observe(observation) {
      await applyAll(table, observation);
    },

    async progress(cursor, at) {
      current = progressState(current, cursor, at);
    },

    async prune(startedAt) {
      const { more } = await pruneUnobserved(table, startedAt);
      return { more };
    },

    async finish(at) {
      current = finishState(current, at, await countLiveFiles());
    },

    async unsupported() {
      current = unsupportedState(current);
    },

    async dirty() {
      current = dirtyState(current);
    },

    async fail(label) {
      current = failState(current, label);
    },

    async privacy() {
      if (privacyRow === null) return null;
      const { observedAt: _observedAt, ...rules } = privacyRow;
      return { ...rules, folders: [...rules.folders], notes: [...rules.notes] };
    },

    async savePrivacy(mirror, at) {
      if (privacyRow !== null && !privacyIsNewer(privacyRow.observedAt, at)) return;
      privacyRow = { ...mirror, observedAt: at };
    },
  };
}
