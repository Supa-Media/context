/**
 * A bench bucket's objects as text, keyed by path: what `world.mjs` takes before and after a turn to tell what the turn
 * wrote. A body is a string, bytes, or anything else as its string form.
 */

export function bodyText(object) {
  const body = object?.body;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  return String(body ?? "");
}

export function snapshot(bucket) {
  return new Map([...bucket].map(([key, object]) => [key, bodyText(object)]));
}
