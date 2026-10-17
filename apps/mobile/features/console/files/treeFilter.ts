/**
 * ⌘K's Tab, carried to the file tree: "show only these names in the tree".
 *
 * The tree had its own filter field behind a magnifier, beside ⌘K's bar with
 * the same magnifier, and the leadership weekly (2026-10-17) asked for one
 * search bar. The field went; what it did is Tab in ⌘K. The palette and the
 * tree are far apart in the component tree and share nothing else, so this is
 * a one-way signal rather than lifted state: the palette asks, the mounted
 * tree listens (`useExplorer`), and with no tree mounted nothing happens.
 */

type Listener = (query: string) => void;

const listeners = new Set<Listener>();

/** Narrow the tree to names matching `query`. */
export function narrowTree(query: string): void {
  for (const listener of listeners) listener(query);
}

/** Subscribe the tree; returns the unsubscribe. */
export function onNarrowTree(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a tree is listening, so the palette offers Tab only where it does something. */
export function treeListening(): boolean {
  return listeners.size > 0;
}
