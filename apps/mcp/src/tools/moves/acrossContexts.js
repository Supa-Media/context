/**
 * `move_note` from one context to another the caller can write.
 *
 * Every workspace keeps its notes under their ids, so a move into another
 * workspace is the control plane's engine (`acrossKeyed.js`): the note lands
 * as a new note in the destination and the source's goes to its trash. Who
 * may move what is decided there. No path is read or retired here, and a
 * store with no engine refuses.
 */

import { isPlumbing } from "../../privacy/engine.js";
import { moveNoteAcrossKeyed } from "./acrossKeyed.js";
import { normalizePath } from "../../notes/paths.js";
import { toolError } from "../results.js";

export async function toolMoveNoteAcrossContexts(
  sourceStore,
  sourceSession,
  destinationSession,
  sourceArg,
  destinationArg,
  expectedSourceEtag
) {
  const source = normalizePath(sourceArg);
  const destination = normalizePath(destinationArg);
  if (!source || !destination || !source.endsWith(".md") || !destination.endsWith(".md")) {
    return toolError("invalid path (source and destination must end in .md)");
  }
  if (isPlumbing(source) || isPlumbing(destination)) return toolError("that path is reserved");
  return await moveNoteAcrossKeyed(sourceStore, sourceSession, destinationSession, source, destination, expectedSourceEtag);
}
