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
 * Every stub in this Worker comes from here, so no object is ever created
 * without the hint. `scripts/check-durable-object-location.mjs` fails CI on
 * any `idFromName`/`idFromString` outside this file.
 */

/** The one location hint every object in this Worker is created with. */
export const OBJECT_LOCATION = "enam";

/** The stub for the object named `name` in `namespace`, placed in eastern North America if it is new. */
export function objectByName(namespace, name) {
  return namespace.get(namespace.idFromName(name), { locationHint: OBJECT_LOCATION });
}
