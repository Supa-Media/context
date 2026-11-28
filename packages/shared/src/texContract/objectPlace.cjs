/**
 * Where the gateway Worker's Durable Objects are placed: eastern North America,
 * every one of them (decided by the owner, 2026-11-01). Moved from
 * `apps/mcp/src/objectPlace.js`, which re-exports it, so Tex's code makes its
 * own objects' stubs without reaching a gateway module.
 *
 * An object is placed once, near whatever first asks for it, and never moves.
 * Tex's objects had no hint, and the first calls to the six busiest came from
 * gateway requests that ran in London on 2026-10-31, so those objects live in
 * London and Amsterdam while the gateway runs in Virginia, and every call to
 * them crosses the Atlantic. The hint only places an object that does not
 * exist yet; one already placed elsewhere has to be copied to a new name.
 *
 * `scripts/check-durable-object-location.mjs` fails CI on any
 * `idFromName`/`idFromString` outside this file and the other placers it lists.
 */
"use strict";

/** The one location hint every object in this Worker is created with. */
const OBJECT_LOCATION = "enam";

/** The stub for the object named `name` in `namespace`, placed in eastern North America if it is new. */
function objectByName(namespace, name) {
  return namespace.get(namespace.idFromName(name), { locationHint: OBJECT_LOCATION });
}

/** The id the object named `name` has, as Cloudflare's analytics show it: for logs that tie a name to its object. Makes no stub. */
function objectIdOf(namespace, name) {
  return String(namespace.idFromName(name));
}

module.exports = { OBJECT_LOCATION, objectByName, objectIdOf };
