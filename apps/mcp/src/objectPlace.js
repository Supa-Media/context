/**
 * Where this gateway's Durable Objects are placed: eastern North America,
 * every one of them (decided by the owner, 2026-11-01).
 *
 * An object is placed once, near whatever first asks for it, and never moves.
 * Tex's objects had no hint, and the first calls to the six busiest came from
 * gateway requests that ran in London on 2026-10-31, so those objects live in
 * London and Amsterdam while the gateway runs in Virginia, and every call to
 * them crosses the Atlantic. The hint only places an object that does not
 * exist yet; one already placed elsewhere has to be copied to a new name.
 *
 * Every stub in this Worker comes from here or from the contract it re-exports,
 * so no object is ever created without the hint. `scripts/check-durable-object-location.mjs` fails CI on
 * any `idFromName`/`idFromString` outside this file.
 */

// The placing itself is a contract Tex's code reads too (`packages/shared/src/texContract/objectPlace.cjs`).
import { objectByName } from "../../../packages/shared/src/texContract/objectPlace.cjs";
export { OBJECT_LOCATION, objectByName, objectIdOf } from "../../../packages/shared/src/texContract/objectPlace.cjs";

/**
 * The live-typing room or activity room keyed `key`, under a name placed in
 * eastern North America (`enam:<key>`). Rooms made before the hint existed
 * were placed near their first caller, about half of them in Europe and Asia
 * (Cloudflare analytics, 2026-10-25 to 11-02), and a room keeps its place
 * forever under the same name. A room holds nothing lasting (it is never the
 * only copy, and it empties when its last person leaves), so a new name moves
 * it with no copy: someone already connected at a deploy stays in the old room
 * until they reconnect, and the note merges both.
 */
export function roomByName(namespace, key) {
  return objectByName(namespace, `enam:${key}`);
}
