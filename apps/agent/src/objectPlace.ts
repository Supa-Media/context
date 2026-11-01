/**
 * Where this Worker's Durable Objects are placed: eastern North America, every
 * one of them (decided by the owner, 2026-11-01), beside the gateway it calls.
 *
 * An object is placed once, near whatever first asks for it, and never moves,
 * so a stub made without the hint can pin a person's inbox to another
 * continent for good. Every stub in this Worker comes from here;
 * `scripts/check-durable-object-location.mjs` fails CI on any
 * `idFromName`/`idFromString` outside this file. The hint changes nothing for
 * an object that already exists.
 */

/** The one location hint every object in this Worker is created with. */
export const OBJECT_LOCATION = "enam" as const;

/** The stub for the object named `name`, placed in eastern North America if it is new. */
export function objectByName(namespace: DurableObjectNamespace, name: string): DurableObjectStub {
  return namespace.get(namespace.idFromName(name), { locationHint: OBJECT_LOCATION });
}

/** The stub for an object by its id as text, or `null` when the text is not one of this namespace's ids. */
export function objectById(namespace: DurableObjectNamespace, id: string): DurableObjectStub | null {
  let parsed: DurableObjectId;
  try {
    parsed = namespace.idFromString(id);
  } catch {
    return null;
  }
  return namespace.get(parsed, { locationHint: OBJECT_LOCATION });
}
