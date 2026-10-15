/**
 * A move's destination check, asked of the Convex tree rather than the bucket
 * (`tree/names.js`). An early answer only: every destination the move tools
 * write is written `onlyIf: { absent: true }`, which catches a note the tree
 * has not heard of yet.
 */

import { TreeUnavailable } from "../../tree/served.js";
import { takenInTree } from "../../tree/names.js";
import { toolError } from "../results.js";

/**
 * The refusal for destinations the tree already draws something at, or null
 * when every one is free. A tree that cannot answer refuses in its own words:
 * the move is not made on a guess.
 *
 * @param {object} store
 * @param {string | string[]} destinations
 * @param {string} [message] the refusal for a single taken destination
 */
export async function destinationRefusal(store, destinations, message = "conflict: destination already exists") {
  const paths = Array.isArray(destinations) ? destinations : [destinations];
  let taken;
  try {
    taken = await takenInTree(store, paths);
  } catch (error) {
    if (error instanceof TreeUnavailable) return toolError(error.message);
    throw error;
  }
  const first = paths.find((path) => taken.files.has(path) || taken.folders.has(path));
  if (first === undefined) return null;
  return toolError(Array.isArray(destinations) ? `conflict: destination already exists: ${first}` : message);
}
