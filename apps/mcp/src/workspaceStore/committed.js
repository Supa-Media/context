/**
 * How long the object's storage took to make this call's writes durable (`store.settle`, the Durable Object's
 * `storage.sync()`), or `null` where it cannot say. The answer waits for that anyway (the output gate), so waiting here
 * moves the wait without adding to it, and a Durable Object's clock only moves across a wait like this one: the call's
 * own time (`took`) reads 0 without it.
 */
export async function committed(store) {
  if (typeof store.settle !== "function") return null;
  const at = Date.now();
  try {
    await store.settle();
  } catch {
    return null;
  }
  return Date.now() - at;
}
