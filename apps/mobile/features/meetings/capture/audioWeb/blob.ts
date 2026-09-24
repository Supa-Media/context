import { WEB_MIME_CANDIDATES, FALLBACK_MIME } from "./messages";

/**
 * Turning a `MediaRecorder`'s output into bytes a transcriber can read.
 *
 * Split out of `audio.web.ts`: none of this touches the recording in
 * progress, only the blob it hands over on the way out.
 */

/**
 * The best container this browser will actually produce.
 *
 * `null` means "let the browser choose", which is what an implementation with
 * no `isTypeSupported` needs — asking for a type it cannot make throws, and a
 * `MediaRecorder` that throws at construction is a meeting that never records.
 */
export function pickMimeType(): string | null {
  const supported = MediaRecorder.isTypeSupported;
  if (typeof supported !== "function") return null;
  for (const candidate of WEB_MIME_CANDIDATES) {
    if (supported.call(MediaRecorder, candidate)) return candidate;
  }
  return null;
}

/** Stop, and resolve with everything the recorder handed over on the way out. */
export function stopAndCollect(recorder: MediaRecorder, collected: Blob[]): Promise<Blob> {
  const assemble = (): Blob =>
    new Blob(collected, { type: recorder.mimeType || collected[0]?.type || FALLBACK_MIME });
  if (recorder.state === "inactive") return Promise.resolve(assemble());
  return new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(assemble());
    try {
      recorder.stop();
    } catch {
      resolve(assemble());
    }
  });
}

/**
 * The blob's bytes, base64-encoded, and nothing kept afterwards.
 *
 * `arrayBuffer()` + `btoa` rather than `FileReader.readAsDataURL`, which is the
 * more obvious spelling and the wrong one twice over. A `FileReader` delivers
 * its result through a **task** on the event loop rather than a microtask, so
 * the send is at the mercy of whatever else is queued — and under a controlled
 * clock it does not complete at all, which makes this the one step in the
 * capture path nothing could deterministically prove. It also builds a `data:`
 * URL, so the whole recording exists a second time as a string with a prefix
 * that then has to be sliced back off.
 *
 * `String.fromCharCode` is applied in slices because it is a spread call and
 * has an argument-count limit — a twenty-second recording passed whole throws
 * `RangeError` on some engines, which would be a failure that only appears once
 * meetings get long enough.
 */
const BINARY_SLICE = 8_192;

export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += BINARY_SLICE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BINARY_SLICE));
  }
  return btoa(binary);
}
