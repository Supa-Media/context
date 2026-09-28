/** The face an owner line is drawn with on a card or in the side panel. */

import type { Face } from "./Glyphs";
import { ownerLabel, type ItemActions } from "./items";

/** A person's initials, an AI helper's robot, or nobody's dashed "?" when there is no owner. */
export function faceFor(actions: Pick<ItemActions, "faceOf" | "owners">, owner: string | undefined): Face {
  if (owner === undefined) return { kind: "nobody" };
  return actions.faceOf?.(owner) ?? { kind: "person", name: ownerLabel(actions.owners, owner) };
}
