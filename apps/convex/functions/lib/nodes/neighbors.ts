/**
 * One note's links and backlinks for `related_notes`: the resolver lives in
 * the gateway (`apps/mcp/src/tree/neighbors.js`), one copy for the control
 * plane's facts and a workspace object's own, so the two answer alike.
 */

import { resolveNeighbors as resolve } from "../../../../mcp/src/tree/neighbors.js";

export { bareNameOf } from "../../../../mcp/src/tree/links.js";

export type NeighborRows = {
  links: Array<{ kind: "path" | "name"; target: string }>;
  byPath: string[];
  byName: string[];
};

export function resolveNeighbors(seed: string, rows: NeighborRows, visible: ReadonlySet<string>): { links: string[]; backlinks: string[] } {
  return resolve(seed, rows, visible);
}
