/**
 * The specialist door nodes, `fdQuick`, `fdRead` and `fdAct` (on the shelf, `texNodeShelf.json`: a Lab draft wires them
 * from the Front door, `fd -> fdQuick|fdRead|fdAct`, and main's config has none). Each is the door the router picked
 * (`../../doorTools.js`): its output says which tools the door holds and the prompt words it is given, and the turn
 * runs through it (`../../doorTurn.js`). Input `{ route, sure }`. Pure: no model and no reads.
 */

/** A door's node: what the turn is told about it, as the node's output. */
export function doorNode(route) {
  return async () => ({ door: route, kind: `door-${route}`, tools: route === "quick" ? "none" : route === "read" ? "read" : "all", when: [route] });
}

export const fdQuickNode = doorNode("quick");
export const fdReadNode = doorNode("read");
export const fdActNode = doorNode("act");
