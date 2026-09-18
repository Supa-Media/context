/**
 * Whether the recorder should try to send a chunk right now.
 *
 * Pushed in from above rather than read here, because the one source of truth
 * for reachability is `features/offline/reachability.ts`'s hook — NetInfo on a
 * phone — and only React can hold a hook. `useMeetingsSetup` mirrors it in.
 *
 * ## Why the recorder asks at all
 *
 * `ConvexReactClient.action()` has no client-side timeout. Offline it does not
 * reject; it waits for the socket to come back, holding its arguments — here,
 * a twenty-second chunk of base64 — in memory the whole time. A recorder that
 * sent every chunk regardless would, over an hour underground, hold an hour of
 * somebody's meeting in the heap behind a hundred and eighty requests that are
 * all going to be sent at once when the train surfaces. So an offline chunk is
 * kept on the device instead of being dispatched, and the drain sends it later
 * at a pace the transcription budget allows.
 *
 * Only `false` is trusted as offline, the same asymmetry the hook documents: an
 * unknown connection is tried, and a send that then fails keeps its chunk.
 */
let offline = false;

export function setCaptureOffline(value: boolean): void {
  offline = value;
}

export function captureOffline(): boolean {
  return offline;
}
