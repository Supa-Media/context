import type { DemoContextTree } from "./treeHelpers";
import { LK_TREE } from "./lk";
import { PUBLIC_WORSHIP_TREE } from "./publicWorship";
import { SEYI_TREE } from "./seyi";

/** The demo contexts, keyed by the id `useDemoConsoleData` gives them. */
export const DEMO_CONTEXT_TREES: Record<string, DemoContextTree> = {
  seyi: SEYI_TREE,
  lk: LK_TREE,
  pw: PUBLIC_WORSHIP_TREE,
};

/** The tree for a context, falling back to `@seyi` rather than to an empty pane. */
export function demoTreeFor(contextId: string | null): DemoContextTree {
  return (contextId !== null ? DEMO_CONTEXT_TREES[contextId] : undefined) ?? SEYI_TREE;
}
