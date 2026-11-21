/**
 * Files on the chat page, both ways: a file the person picks is encoded for the route (name and base64), and a file the
 * route answers is saved to the device. Pure apart from the two browser calls at the end, which are web only: where
 * there is no document, a save is `false` and the caller says so.
 */
import { MAX_FILE_BYTES, type SendFileBody } from "./appChatGateway";
import { base64Of } from "./appChatPictures";

/** A file the person picked: a `File`, or any `Blob` that carries the name a picker gives one. */
export type PickedFile = Blob & { readonly name: string };

/**
 * Every file encoded as `{ name, data }`, in order; `null` when one is over 10 MB. The route checks the size again, so
 * this only keeps a big file from being read into memory and sent just to be refused.
 */
export async function encodeFiles(files: readonly PickedFile[]): Promise<SendFileBody[] | null> {
  const out: SendFileBody[] = [];
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) return null;
    out.push({ name: file.name, data: await base64Of(file) });
  }
  return out;
}

/** How long the object URL of a saved file lives: long enough for the browser to start the download. */
const SAVED_URL_MS = 10_000;

/**
 * Saves a file's bytes to the device as a download: an object URL and one click on a link that names it. `false` where
 * there is no document to click in (native, or a runtime without object URLs).
 */
export function saveBlob(blob: Blob, name: string): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), SAVED_URL_MS);
  return true;
}
